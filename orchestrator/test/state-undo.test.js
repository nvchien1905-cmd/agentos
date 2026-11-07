'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createStateUndo } = require('../src/stateUndo');
const { createJournal } = require('../src/journal');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'su-'));
const hasGit = (() => { try { cp.execFileSync('git', ['--version']); return true; } catch (e) { return false; } })();

// Hệ thống giả: gói, dịch vụ, crontab — mọi lệnh ghi lại để kiểm
function fakeSys() {
  const s = { pkgs: ['bash', 'coreutils', 'vlc'], units: { nginx: { enabled: 'enabled', active: 'active' } }, cron: null, cmds: [] };
  const run = async (cmd, args) => {
    s.cmds.push([cmd].concat(args).join(' '));
    if (cmd === 'sudo') { args = args.slice(1); cmd = args.shift(); s.cmds[s.cmds.length - 1] = 'sudo ' + [cmd].concat(args).join(' '); }
    if (cmd === 'dpkg-query') return { code: 0, out: s.pkgs.map((p) => p + ' install ok installed').join('\n') + '\n', err: '' };
    if (cmd === 'apt-get' && args[0] === 'remove') { s.pkgs = s.pkgs.filter((p) => !args.slice(2).includes(p)); return { code: 0, out: '', err: '' }; }
    if (cmd === 'apt-get' && args[0] === 'install') { s.pkgs.push(...args.slice(3)); return { code: 0, out: '', err: '' }; }
    const key = (u) => String(u).replace(/\.service$/, '');
    if (cmd === 'systemctl' && args[0] === 'is-enabled') return { code: 0, out: (s.units[key(args[1])] || { enabled: 'disabled' }).enabled + '\n', err: '' };
    if (cmd === 'systemctl' && args[0] === 'is-active') return { code: 0, out: (s.units[key(args[1])] || { active: 'inactive' }).active + '\n', err: '' };
    if (cmd === 'systemctl') { const u = s.units[key(args[1])] = s.units[key(args[1])] || { enabled: 'disabled', active: 'inactive' }; ({ enable: () => { u.enabled = 'enabled'; }, disable: () => { u.enabled = 'disabled'; }, start: () => { u.active = 'active'; }, stop: () => { u.active = 'inactive'; } })[args[0]](); return { code: 0, out: '', err: '' }; }
    if (cmd === 'crontab' && args[0] === '-l') return s.cron === null ? { code: 1, out: '', err: 'no crontab' } : { code: 0, out: s.cron, err: '' };
    if (cmd === 'crontab' && args[0] === '-r') { s.cron = null; return { code: 0, out: '', err: '' }; }
    if (cmd === 'crontab') { s.cron = fs.readFileSync(args[0], 'utf8'); return { code: 0, out: '', err: '' }; }
    return { code: 1, out: '', err: 'lệnh lạ ' + cmd };
  };
  return { s, run };
}

test('hoàn tác gói: gỡ gói AI cài thêm, cài lại gói AI đã gỡ; không bao giờ gỡ gói hạ tầng; quá nhiều gói thì từ chối', async () => {
  const { s, run } = fakeSys(); const su = createStateUndo({ dir: tmp(), run, sudo: false });
  await su.capture('7', [{ kind: 'apt' }, { kind: 'apt' }], '/w');
  s.pkgs = s.pkgs.filter((p) => p !== 'vlc').concat(['cowsay', 'sudo', 'systemd-resolved']);           // AI gỡ vlc, cài cowsay (và kéo theo gói hạ tầng)
  const plan = await su.plan('7'); assert.match(plan.map((x) => x.act).join('|'), /gỡ 3 gói mới cài[\s\S]*cài lại 1 gói đã gỡ: vlc/);
  const r = await su.restore('7'); assert.deepEqual(r.failed, []);
  assert.ok(s.cmds.some((c) => /apt-get remove -y cowsay$/.test(c)), 'chỉ gỡ cowsay: ' + s.cmds.join(' ; ')); assert.ok(!s.cmds.some((c) => /remove.*(sudo|systemd-resolved)/.test(c)), 'không đụng gói hạ tầng');
  assert.ok(s.pkgs.includes('vlc') && !s.pkgs.includes('cowsay'));
  const big = fakeSys(); const su2 = createStateUndo({ dir: tmp(), run: big.run, sudo: false }); await su2.capture('8', [{ kind: 'apt' }], '/w');
  big.s.pkgs.push(...Array.from({ length: 40 }, (_, i) => 'goi' + i)); const r2 = await su2.restore('8'); assert.match(r2.failed.join(), /quá 30 gói/); assert.equal(big.s.cmds.filter((c) => /apt-get/.test(c)).length, 0);
});

test('hoàn tác dịch vụ và crontab: về đúng bật/tắt + chạy/dừng cũ; crontab trống thì xóa lại', async () => {
  const { s, run } = fakeSys(); const su = createStateUndo({ dir: tmp(), run, sudo: false });
  await su.capture('9', [{ kind: 'systemd', units: ['nginx', 'khac'] }, { kind: 'systemd', units: ['nginx'] }, { kind: 'systemd', units: ['../../etc/passwd'] }, { kind: 'cron' }], '/w');
  s.units.nginx = { enabled: 'disabled', active: 'inactive' }; s.units.khac = { enabled: 'enabled', active: 'active' }; s.cron = '* * * * * echo hi\n';
  const plan = (await su.plan('9')).map((x) => x.p + ' ' + x.act).join('|'); assert.match(plan, /nginx\.service[\s\S]*enabled\/active/); assert.match(plan, /crontab/);
  const r = await su.restore('9'); assert.deepEqual(r.failed, []);
  assert.deepEqual(s.units.nginx, { enabled: 'enabled', active: 'active' }); assert.deepEqual(s.units.khac, { enabled: 'disabled', active: 'inactive' }, 'khac trước đó chưa có → về tắt/dừng'); assert.equal(s.cron, null, 'crontab trước đó trống → xóa');
  assert.ok(!s.cmds.some((c) => /passwd/.test(c)), 'tên dịch vụ lạ bị bỏ');
});

test('hoàn tác git thật: checkout sang nhánh khác + sửa chưa commit + xóa tệp chưa theo dõi → về đúng nhánh, commit, thay đổi và tệp', { skip: !hasGit }, async () => {
  const repo = tmp(); const g = (...a) => cp.execFileSync('git', ['-C', repo].concat(a), { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'bản 1'); g('add', '.'); g('commit', '-qm', 'một');
  g('checkout', '-qb', 'phu'); fs.writeFileSync(path.join(repo, 'b.txt'), 'trên nhánh phụ'); g('add', '.'); g('commit', '-qm', 'hai'); g('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'sửa chưa commit'); fs.writeFileSync(path.join(repo, 'rac.txt'), 'chưa theo dõi');
  const jd = path.join(repo, '..', 'j-' + path.basename(repo)); const su = createStateUndo({ dir: path.join(jd, 'st') });
  const j = createJournal({ dir: path.join(jd, 'jr'), cwdOf: () => repo, stateUndo: su, scan: false });
  const head0 = g('rev-parse', 'HEAD');
  await j.before({ id: 5, prompt: 'dọn kho' }, 'Bash', { command: 'git checkout phu -f && git clean -fd' });
  g('checkout', '-qf', 'phu'); g('clean', '-qfd');                                         // AI làm thật
  assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'phu'); assert.equal(fs.existsSync(path.join(repo, 'rac.txt')), false);
  assert.ok((await j.plan(5)).some((x) => /git/.test(x.p)));
  const r = await j.restore(5); assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'main'); assert.equal(g('rev-parse', 'HEAD'), head0);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'sửa chưa commit', 'thay đổi chưa commit được khôi phục');
  assert.equal(fs.readFileSync(path.join(repo, 'rac.txt'), 'utf8'), 'chưa theo dõi', 'tệp chưa theo dõi bị git clean xóa được khôi phục (nhờ nhật ký tệp)');
  const ls = await j.list(); assert.equal(ls.find((x) => x.id === '5').state, true);
});

test('hoàn tác giải nén: tệp bị ghi đè trả về bản cũ, tệp do giải nén tạo mới bị xóa', async () => {
  const root = tmp(), work = path.join(root, 'w'); fs.mkdirSync(path.join(work, 'goi'), { recursive: true });
  fs.writeFileSync(path.join(work, 'goi', 'a.txt'), 'AAA bản mới'); fs.writeFileSync(path.join(work, 'goi', 'b.txt'), 'BBB');
  cp.execFileSync('tar', ['-czf', path.join(work, 'goi.tgz'), '-C', work, 'goi']);
  fs.writeFileSync(path.join(work, 'goi', 'a.txt'), 'AAA bản CŨ của khách'); fs.rmSync(path.join(work, 'goi', 'b.txt'));            // trước khi giải nén: a.txt có bản cũ, b.txt chưa có
  const su = createStateUndo({ dir: path.join(root, 'st') });
  const j = createJournal({ dir: path.join(root, 'jr'), cwdOf: () => work, stateUndo: su, scan: false });
  await j.before({ id: 6, prompt: 'giải nén' }, 'Bash', { command: 'tar -xzf goi.tgz' });
  cp.execFileSync('tar', ['-xzf', path.join(work, 'goi.tgz'), '-C', work]);
  assert.equal(fs.readFileSync(path.join(work, 'goi', 'a.txt'), 'utf8'), 'AAA bản mới'); assert.equal(fs.existsSync(path.join(work, 'goi', 'b.txt')), true);
  const r = await j.restore(6); assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(work, 'goi', 'a.txt'), 'utf8'), 'AAA bản CŨ của khách'); assert.equal(fs.existsSync(path.join(work, 'goi', 'b.txt')), false);
});

test('cuối việc: dò tệp bị đổi bởi script mà nhật ký không có bản gốc và báo thật', async () => {
  const root = tmp(), work = path.join(root, 'w'); fs.mkdirSync(work);
  const j = createJournal({ dir: path.join(root, 'jr'), cwdOf: () => work, scanRoots: [work] });
  await j.before({ id: 3, prompt: 'chạy script' }, 'Bash', { command: 'python3 tinh.py' });                  // không hiểu được tệp nào
  await new Promise((r) => setTimeout(r, 1100));
  fs.writeFileSync(path.join(work, 'ket-qua.csv'), 'x'); fs.writeFileSync(path.join(work, 'khac.txt'), 'y');
  const r = await j.finish({ id: 3 }); assert.equal(r.unrecorded, 2);
  const m = await j.get(3); assert.ok(m.unsafe.some((x) => /đã đổi 2 tệp mà bot không có bản gốc/.test(x))); assert.equal((await j.list())[0].unsafe.length, 1);
  assert.equal(await j.finish({ id: 99 }), null, 'việc không chạy Bash thì không dò');
});
