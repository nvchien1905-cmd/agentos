'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const lib = require('./lib');

// Bộ cập nhật chạy bằng ROOT (lệnh agentos-update). Quy trình: tải manifest + chữ ký -> kiểm chữ ký -> so phiên bản -> tải gói -> kiểm sha256/kích thước ->
// kiểm danh sách tệp trong gói (đường dẫn cho phép, không liên kết) -> sao lưu tệp sắp bị thay -> ghi từng tệp (nguyên tử) -> apply.sh (nếu có) ->
// khởi động lại dịch vụ -> kiểm sức khỏe -> lỗi ở bất kỳ bước nào thì KHÔI PHỤC bản cũ và báo.
const DEFAULT_URL = 'https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/updates/';

const defaultRun = (cmd, args, opts) => new Promise((resolve) => {
  cp.execFile(cmd, args, Object.assign({ timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, opts || {}), (err, out, errOut) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(errOut || '') }));
});
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function createUpdater(o) {
  o = o || {};
  const root = o.root || '/';
  const url = String(o.url || DEFAULT_URL).replace(/\/?$/, '/');
  const stateDir = o.stateDir || '/var/lib/agentos-update';
  const pubFile = o.pubFile || path.join(root, 'etc/agentos/update-pubkey.pem');
  const resultFile = o.resultFile === undefined ? '/var/lib/agentos/update-result.json' : o.resultFile;
  const f = o.fetch || fetch;
  const run = o.run || defaultRun;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now || (() => Date.now());
  const log = o.log || ((m) => console.log(m));
  const units = o.units || ['agentos-orchestrator', 'agentos-deskd'];
  const systemd = o.systemd !== false;
  const healthWaits = o.healthWaitsMs || [10000, 15000];
  const TAR = o.tar || 'tar';
  const P = (rel) => path.join(root, rel);

  const installed = () => { try { return fs.readFileSync(P('opt/agentos/VERSION'), 'utf8').trim() || '0'; } catch (e) { return '0'; } };

  async function get(name) {
    const r = await f(url + name, { signal: AbortSignal.timeout(60000), headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) throw new Error('Không tải được ' + name + ' (HTTP ' + r.status + ')');
    return Buffer.from(await r.arrayBuffer());
  }
  async function fetchSigned() {
    let pub;
    try { pub = fs.readFileSync(pubFile, 'utf8'); } catch (e) { throw new Error('Máy chưa có khóa công khai của nhà phát hành (' + pubFile + ')'); }
    const mbuf = await get('manifest.json');
    const sig = (await get('manifest.json.sig')).toString('utf8');
    const v = lib.verifyManifest(mbuf, sig, pub);
    if (!v.ok) throw new Error(v.error);
    return v.manifest;
  }

  async function check() {
    const m = await fetchSigned();
    const inst = installed();
    return { installed: inst, latest: m.version, newer: lib.cmpVersion(m.version, inst) > 0, notes: m.notes || '', date: m.date || '' };
  }

  function writeResult(res) {
    res.at = new Date(now()).toISOString();
    const text = JSON.stringify(res);
    try { fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(stateDir, 'last.json'), text, { mode: 0o600 }); } catch (e) { /* bỏ qua */ }
    if (resultFile) { try { fs.mkdirSync(path.dirname(resultFile), { recursive: true }); fs.writeFileSync(resultFile, text, { mode: 0o644 }); } catch (e) { /* thư mục chưa có */ } }
    return res;
  }

  const sctl = async (...args) => (systemd ? run('systemctl', args) : { code: 0, out: '', err: '' });
  async function activeUnits() {
    const out = [];
    if (!systemd) return out;
    for (const u of units) if ((await run('systemctl', ['is-active', '--quiet', u + '.service'])).code === 0) out.push(u);
    return out;
  }
  async function restartAndCheck(list) {
    if (!systemd || !list.length) return { ok: true };
    await sctl('daemon-reload');
    for (const u of list) { const r = await sctl('restart', u + '.service'); if (r.code !== 0) return { ok: false, error: 'Không khởi động lại được ' + u + ': ' + r.err.trim().slice(0, 150) }; }
    for (const w of healthWaits) {
      await sleep(w);
      for (const u of list) if ((await run('systemctl', ['is-active', '--quiet', u + '.service'])).code !== 0) return { ok: false, error: 'Dịch vụ ' + u + ' không chạy ổn sau khi cập nhật' };
    }
    return { ok: true };
  }

  function copyAtomic(src, rel) {
    const dest = P(rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.agentos-new';
    fs.copyFileSync(src, tmp);
    try { fs.chmodSync(tmp, lib.modeFor(rel)); } catch (e) { /* Windows */ }
    fs.renameSync(tmp, dest);
  }

  async function rollback(ctx) {
    try {
      if (ctx.existing.length && fs.existsSync(ctx.backup)) await run(TAR, ['-xzf', ctx.backup, '-C', root]);
      for (const n of ctx.created) fs.rmSync(P(n), { force: true });
      await restartAndCheck(ctx.active);
      return true;
    } catch (e) { log('KHÔI PHỤC lỗi: ' + e.message); return false; }
  }

  async function applyLocked(opts) {
    const from = installed();
    let manifest;
    try { manifest = await fetchSigned(); } catch (e) { return writeResult({ ok: false, code: 'fetch', from, error: e.message }); }
    if (!opts.force && lib.cmpVersion(manifest.version, from) <= 0) return { ok: true, upToDate: true, from, latest: manifest.version };
    const base = { from, to: manifest.version, notes: manifest.notes || '' };
    const fail = (code, error, extra) => writeResult(Object.assign({ ok: false, code, error }, base, extra || {}));

    const dl = path.join(stateDir, 'dl');
    fs.rmSync(dl, { recursive: true, force: true });
    fs.mkdirSync(path.join(dl, 'x'), { recursive: true });
    let buf;
    try { buf = await get(manifest.file); } catch (e) { return fail('download', e.message); }
    if (buf.length !== manifest.size || sha256(buf) !== manifest.sha256) return fail('hash', 'Gói tải về không khớp sha256/kích thước trong manifest đã ký (hỏng hoặc bị sửa) — không cài.');
    const bundle = path.join(dl, manifest.file);
    fs.writeFileSync(bundle, buf);

    const names = (await run(TAR, ['-tzf', bundle])).out.split(/\r?\n/).filter(Boolean).map((s) => s.replace(/^\.\//, ''));
    const verbose = (await run(TAR, ['-tzvf', bundle])).out.split(/\r?\n/).filter(Boolean);
    if (!names.length || verbose.some((l) => !/^[-d]/.test(l))) return fail('bundle', 'Gói chứa liên kết/tệp đặc biệt hoặc rỗng — không cài.');
    const entries = names.filter((n) => !n.endsWith('/'));
    const chk = lib.checkEntries(entries);
    if (!chk.ok) return fail('bundle', 'Gói chứa đường dẫn không được phép: ' + chk.bad.slice(0, 3).join(', '));
    const staging = path.join(dl, 'x');
    const ex = await run(TAR, ['-xzf', bundle, '-C', staging, '--no-same-owner']);
    if (ex.code !== 0) return fail('bundle', 'Giải nén gói lỗi: ' + ex.err.trim().slice(0, 150));

    const files = entries.filter((n) => n !== 'apply.sh');
    const existing = files.filter((n) => fs.existsSync(P(n)));
    const created = files.filter((n) => !fs.existsSync(P(n)));
    const backup = path.join(stateDir, 'backup-' + from + '.tar.gz');
    const ctx = { existing, created, backup, active: await activeUnits() };
    if (existing.length) {
      const list = path.join(stateDir, 'backup.list');
      fs.writeFileSync(list, existing.join('\n') + '\n');
      const b = await run(TAR, ['-czf', backup, '-C', root, '-T', list]);
      if (b.code !== 0) return fail('backup', 'Không sao lưu được bản cũ — dừng, chưa đổi gì: ' + b.err.trim().slice(0, 150));
    }
    try { for (const n of files) copyAtomic(path.join(staging, n), n); }
    catch (e) { const rb = await rollback(ctx); return fail('copy', 'Ghi tệp lỗi: ' + e.message, { rolledBack: rb }); }

    if (entries.includes('apply.sh')) {
      const a = await run('bash', [path.join(staging, 'apply.sh')], { cwd: staging, timeout: 600000, env: Object.assign({}, process.env, { AGENTOS_ROOT: root, AGENTOS_FROM: from, AGENTOS_TO: manifest.version }) });
      if (a.code !== 0) { const rb = await rollback(ctx); return fail('apply.sh', 'apply.sh lỗi (mã ' + a.code + '): ' + (a.err || a.out).trim().slice(-200), { rolledBack: rb }); }
    }
    const h = await restartAndCheck(ctx.active);
    if (!h.ok) { const rb = await rollback(ctx); return fail('health', h.error + (rb ? ' — đã khôi phục bản ' + from : ' — KHÔI PHỤC CŨNG LỖI, cần kiểm tra tay'), { rolledBack: rb }); }
    // giữ 2 bản sao lưu gần nhất
    try { fs.readdirSync(stateDir).filter((x) => /^backup-.*\.tar\.gz$/.test(x)).map((x) => [x, fs.statSync(path.join(stateDir, x)).mtimeMs]).sort((a, b) => b[1] - a[1]).slice(2).forEach(([x]) => fs.rmSync(path.join(stateDir, x), { force: true })); } catch (e) { /* bỏ qua */ }
    fs.rmSync(dl, { recursive: true, force: true });
    return writeResult(Object.assign({ ok: true, files: files.length }, base));
  }

  async function apply(opts) {
    opts = opts || {};
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const lock = path.join(stateDir, 'lock');
    try { if (now() - fs.statSync(lock).mtimeMs > 30 * 60000) fs.rmSync(lock, { force: true }); } catch (e) { /* chưa có */ }
    let fd;
    try { fd = fs.openSync(lock, 'wx'); } catch (e) { return { ok: false, code: 'busy', error: 'Đang có một lần cập nhật khác chạy.' }; }
    try { return await applyLocked(opts); }
    finally { try { fs.closeSync(fd); } catch (e) { /* đã đóng */ } fs.rmSync(lock, { force: true }); }
  }

  return { check, apply, installed, fetchSigned };
}

module.exports = { createUpdater, DEFAULT_URL };
