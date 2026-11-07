'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const cp = require('child_process');

// HOÀN TÁC TRẠNG THÁI HỆ THỐNG (bổ sung cho journal.js, vốn chỉ hoàn tác TỆP): trước khi AI chạy lệnh đổi gói/dịch vụ/git/crontab/giải nén, lưu lại trạng thái trước đó
// rồi /hoantac đưa về đúng như cũ:
//   apt/dpkg  → danh sách gói đã cài; hoàn tác: gỡ gói AI cài thêm, cài lại gói AI đã gỡ (tối đa 30 gói; không bao giờ gỡ gói bắt buộc/hạ tầng)
//   systemctl/service → từng dịch vụ được nhắc tới: bật/tắt tự khởi động + đang chạy/dừng
//   git (checkout/reset/clean/restore/stash/rebase/merge/pull/switch/revert/cherry-pick/apply/am) → HEAD, nhánh, thay đổi chưa commit (git stash create); hoàn tác: reset --hard + stash apply
//   crontab → bản crontab trước đó
//   tar/unzip giải nén → danh sách tệp trong gói được đưa cho journal.js lưu bản gốc từng tệp sẽ bị ghi đè (và đánh dấu tệp mới để xóa khi hoàn tác)
// Lệnh chạy bằng `sudo -n` khi cần quyền (máy ở chế độ toàn quyền có sudo). Không làm được thì báo thật, không đoán.
const KEEP_PKGS = /^(sudo|systemd.*|libc6|dpkg|apt|apt-.*|bash|coreutils|login|passwd|openssh-.*|network-manager|netplan.*|nodejs|npm|agentos.*|grub.*|linux-image.*|linux-base|base-files|init|libpam.*|util-linux|mount|tailscale|ca-certificates)$/;
const MAX_PKGS = 30;
const SAFE_UNIT = /^[\w@:.\\-]{1,100}$/;

function defaultRun(cmd, args, o) {
  return new Promise((resolve) => {
    cp.execFile(cmd, args, Object.assign({ timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, o || {}), (err, out, errOut) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(errOut || '') }));
  });
}

function createStateUndo(o) {
  const dir = o.dir, run = o.run || defaultRun, log = o.log || (() => {});
  const sudo = o.sudo === undefined ? true : o.sudo;
  const as = (cmd, args) => (sudo && process.getuid && process.getuid() !== 0 ? run('sudo', ['-n', cmd].concat(args)) : run(cmd, args));
  const file = (id) => path.join(dir, String(id).replace(/[^\w.-]/g, '_'), 'state.json');
  const read = async (id) => { try { return JSON.parse(await fsp.readFile(file(id), 'utf8')); } catch (e) { return { items: [] }; } };
  const save = async (id, v) => { await fsp.mkdir(path.dirname(file(id)), { recursive: true, mode: 0o700 }); await fsp.writeFile(file(id), JSON.stringify(v), { mode: 0o600 }); };
  const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

  async function installedPkgs() {
    const r = await run('dpkg-query', ['-W', '-f=${Package} ${Status}\\n']);
    if (r.code !== 0) throw new Error('không đọc được danh sách gói');
    return lines(r.out).filter((l) => /\sinstalled$/.test(l)).map((l) => l.split(' ')[0]).sort();
  }
  const unitName = (u) => (/\.[a-z]+$/.test(u) ? u : u + '.service');
  async function unitState(u) {
    const en = await run('systemctl', ['is-enabled', u]), ac = await run('systemctl', ['is-active', u]);
    return { unit: u, enabled: en.out.trim(), active: ac.out.trim() };
  }

  return {
    // items: [{kind:'apt'|'systemd'|'git'|'cron'|'archive', ...}] → trả { paths: [tệp journal.js cần lưu bản gốc], notes }
    async capture(id, items, cwd) {
      const st = await read(id), paths = [], notes = [];
      for (const it of items) {
        try {
          if (it.kind === 'apt' && !st.items.some((x) => x.kind === 'apt')) { const p = await installedPkgs(); st.items.push({ kind: 'apt', pkgs: p }); notes.push('đã lưu danh sách ' + p.length + ' gói'); }
          else if (it.kind === 'systemd') { for (const u0 of it.units.slice(0, 10)) { const u = unitName(u0); if (!SAFE_UNIT.test(u) || st.items.some((x) => x.kind === 'systemd' && x.unit === u)) continue; st.items.push(Object.assign({ kind: 'systemd' }, await unitState(u))); } }
          else if (it.kind === 'git' && !st.items.some((x) => x.kind === 'git' && x.cwd === cwd)) {
            const head = await run('git', ['-C', cwd, 'rev-parse', 'HEAD']);
            if (head.code === 0) {
              const br = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']), sh = await run('git', ['-C', cwd, 'stash', 'create']);
              st.items.push({ kind: 'git', cwd, head: head.out.trim(), branch: br.out.trim(), stash: sh.out.trim() });
              if (it.clean) { const un = await run('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard']); for (const f of lines(un.out).slice(0, 2000)) paths.push(path.join(cwd, f)); }
            }
          }
          else if (it.kind === 'cron' && !st.items.some((x) => x.kind === 'cron')) { const c = await run('crontab', ['-l']); st.items.push({ kind: 'cron', text: c.code === 0 ? c.out : null }); }
          else if (it.kind === 'archive') {
            const base = path.resolve(cwd, it.dir || '.'), arc = path.resolve(cwd, it.file);
            const r = it.tool === 'unzip' ? await run('unzip', ['-Z1', arc]) : await run('tar', ['-tf', arc]);
            if (r.code === 0) for (const m of lines(r.out).slice(0, 20000)) { const rel = m.replace(/^\.\//, ''); if (!rel || rel.startsWith('/') || rel.split('/').includes('..') || rel.endsWith('/')) continue; paths.push(path.join(base, rel)); }
          }
        } catch (e) { notes.push('không lưu được trạng thái ' + it.kind + ': ' + e.message); log('stateUndo ' + it.kind + ': ' + e.message); }
      }
      await save(id, st);
      return { paths, notes };
    },
    async has(id) { return (await read(id)).items.length > 0; },
    // Những việc sẽ làm nếu quay lại (để hiện trước)
    async plan(id) {
      const st = await read(id), out = [];
      for (const it of st.items) {
        try {
          if (it.kind === 'apt') { const now = await installedPkgs(), add = now.filter((p) => !it.pkgs.includes(p)), gone = it.pkgs.filter((p) => !now.includes(p)); if (add.length) out.push({ p: '(gói hệ thống)', act: 'gỡ ' + add.length + ' gói mới cài: ' + add.slice(0, 6).join(', ') }); if (gone.length) out.push({ p: '(gói hệ thống)', act: 'cài lại ' + gone.length + ' gói đã gỡ: ' + gone.slice(0, 6).join(', ') }); }
          else if (it.kind === 'systemd') { const n = await unitState(it.unit); if (n.enabled !== it.enabled || n.active !== it.active) out.push({ p: '(dịch vụ ' + it.unit + ')', act: 'đưa về ' + it.enabled + '/' + it.active }); }
          else if (it.kind === 'git') { const h = await run('git', ['-C', it.cwd, 'rev-parse', 'HEAD']); if (h.out.trim() !== it.head) out.push({ p: '(git ' + it.cwd + ')', act: 'về lại commit ' + it.head.slice(0, 8) + (it.branch && it.branch !== 'HEAD' ? ' trên nhánh ' + it.branch : '') }); }
          else if (it.kind === 'cron') { const c = await run('crontab', ['-l']); if ((c.code === 0 ? c.out : null) !== it.text) out.push({ p: '(crontab)', act: 'trả lại crontab cũ' }); }
        } catch (e) { /* bỏ qua mục không kiểm được */ }
      }
      return out;
    },
    async restore(id) {
      const st = await read(id), res = { done: [], failed: [] };
      for (const it of st.items.slice().reverse()) {
        try {
          if (it.kind === 'apt') {
            const now = await installedPkgs(), add = now.filter((p) => !it.pkgs.includes(p) && !KEEP_PKGS.test(p)), gone = it.pkgs.filter((p) => !now.includes(p));
            if (add.length > MAX_PKGS || gone.length > MAX_PKGS) { res.failed.push('apt: quá ' + MAX_PKGS + ' gói thay đổi — làm tay (apt/dpkg)'); continue; }
            if (add.length) { const r = await as('apt-get', ['remove', '-y'].concat(add)); (r.code === 0 ? res.done : res.failed).push(r.code === 0 ? 'đã gỡ ' + add.length + ' gói' : 'gỡ gói lỗi: ' + r.err.slice(-120)); }
            if (gone.length) { const r = await as('apt-get', ['install', '-y', '--no-install-recommends'].concat(gone)); (r.code === 0 ? res.done : res.failed).push(r.code === 0 ? 'đã cài lại ' + gone.length + ' gói' : 'cài lại gói lỗi: ' + r.err.slice(-120)); }
          } else if (it.kind === 'systemd') {
            const n = await unitState(it.unit); const acts = [];
            if (n.enabled !== it.enabled && /^(enabled|disabled)$/.test(it.enabled)) acts.push([it.enabled === 'enabled' ? 'enable' : 'disable']);
            if (n.active !== it.active && /^(active|inactive)$/.test(it.active)) acts.push([it.active === 'active' ? 'start' : 'stop']);
            for (const a of acts) { const r = await as('systemctl', a.concat([it.unit])); (r.code === 0 ? res.done : res.failed).push(r.code === 0 ? it.unit + ': ' + a[0] : it.unit + ' ' + a[0] + ' lỗi'); }
          } else if (it.kind === 'git') {
            const h = await run('git', ['-C', it.cwd, 'rev-parse', 'HEAD']);
            if (h.out.trim() !== it.head) {
              if (it.branch && it.branch !== 'HEAD') await run('git', ['-C', it.cwd, 'checkout', '-f', it.branch]);
              const r = await run('git', ['-C', it.cwd, 'reset', '--hard', it.head]); (r.code === 0 ? res.done : res.failed).push(r.code === 0 ? 'git: về commit ' + it.head.slice(0, 8) : 'git reset lỗi: ' + r.err.slice(-120));
              if (it.stash) { const s = await run('git', ['-C', it.cwd, 'stash', 'apply', it.stash]); if (s.code === 0) res.done.push('git: khôi phục thay đổi chưa commit'); else res.failed.push('git stash apply lỗi'); }
            }
          } else if (it.kind === 'cron') {
            if (it.text === null) { const r = await run('crontab', ['-r']); res.done.push(r.code === 0 ? 'crontab: đã xóa (trước đó trống)' : 'crontab: không có gì để xóa'); }
            else { const t = path.join(dir, 'cron-restore.txt'); await fsp.mkdir(dir, { recursive: true }); await fsp.writeFile(t, it.text); const r = await run('crontab', [t]); (r.code === 0 ? res.done : res.failed).push(r.code === 0 ? 'crontab: đã trả lại' : 'crontab lỗi'); await fsp.rm(t, { force: true }); }
          }
        } catch (e) { res.failed.push(it.kind + ': ' + e.message); }
      }
      return res;
    },
    async forget(id) { await fsp.rm(path.dirname(file(id)), { recursive: true, force: true }).catch(() => {}); },
  };
}

module.exports = { createStateUndo, KEEP_PKGS };
