'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVps } = require('../src/vps');
const { classify } = require('../src/cmdTool');

// ssh/ssh-keygen giả: ghi lại lệnh, tạo tệp khóa giả
function mk(role, dir) {
  const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'vps-')); const calls = [];
  const run = async (bin, args) => {
    calls.push([bin].concat(args));
    if (bin === 'ssh-keygen') { const f = args[args.indexOf('-f') + 1]; fs.writeFileSync(f, 'PRIV-' + path.basename(f)); fs.writeFileSync(f + '.pub', 'ssh-ed25519 PUB-' + path.basename(f) + ' x'); return { code: 0, out: '', err: '' }; }
    return { code: 0, out: 'kết quả', err: '' };
  };
  const v = createVps({ role, file: d + '/data/vps.json', keyFull: d + '/vps-full.key', keyRo: d + '/vps-ro.key', known: d + '/kh', run });
  return { d, v, calls };
}

test('bot quản lý: thêm VPS, sinh 2 khóa, /vps khoa đưa lệnh cài (chỉ khóa CÔNG KHAI, không lộ khóa riêng)', async () => {
  const { v, calls, d } = mk('full');
  const out = await v.command('them sv1 203.0.113.5 2222 root'); assert.match(out, /ĐÚNG MỘT dòng/);
  assert.ok(fs.existsSync(d + '/vps-full.key') && fs.existsSync(d + '/vps-ro.key'));
  const t = out;
  assert.match(t, /PUB-vps-full\.key/); assert.match(t, /PUB-vps-ro\.key/); assert.ok(!t.includes('PRIV-')); assert.match(t, /agentos-ro/); assert.equal(t.split('authorized_keys').length - 1, 4);
  assert.equal(v.list()[0].port, 2222); assert.match(await v.command('them sv2 1.2.3.4'), /root/); assert.equal(v.list().find((x) => x.name === 'sv2').port, 22); assert.match(await v.command('khoa sv1'), /ĐÚNG MỘT dòng/);
  assert.match(await v.command('them sv1 bad_host! 22 root'), /Địa chỉ/);
  assert.match(await v.command('them x 1.2.3.4 99999 root'), /Cổng/);
});

test('bot quản lý chạy lệnh bằng khóa + tài khoản ĐỦ QUYỀN, lệnh ghi cũng chạy được', async () => {
  const { v, calls } = mk('full'); await v.command('them sv1 1.2.3.4 22 root');
  const r = await v.exec('sv1', 'systemctl restart nginx'); assert.equal(r.ok, true);
  const ssh = calls.filter((c) => c[0] === 'ssh').pop();
  assert.ok(ssh.some((x) => /vps-full\.key$/.test(x))); assert.ok(ssh.includes('root@1.2.3.4')); assert.equal(ssh[ssh.length - 1], 'systemctl restart nginx'); assert.ok(ssh.includes('BatchMode=yes'));
});

test('bot thường: dùng khóa + tài khoản CHỈ-ĐỌC, lệnh ghi/xóa bị chặn trước khi chạy, lệnh xem chạy được', async () => {
  const f = mk('full'); await f.v.command('them sv1 1.2.3.4 22 root');
  const { v, calls } = mk('ro', f.d);                      // bot thường đọc cùng danh sách VPS
  for (const bad of ['rm -rf /var/www', 'systemctl restart nginx', 'echo x > /etc/a', 'mysql -e "DROP TABLE a"', 'mysql -e "UPDATE t SET a=1"', 'sudo cat /etc/shadow', 'pm2 restart all', 'sed -i s/a/b/ f', 'git pull', 'cat a | tee b', 'mysql -e "delete from t"']) {
    const r = await v.exec('sv1', bad); assert.equal(r.ok, false, bad); assert.match(r.text, /chỉ có quyền XEM/);
  }
  assert.equal(calls.filter((c) => c[0] === 'ssh').length, 0);
  for (const good of ['ls -la /var/www', 'df -h', 'tail -n 50 /var/log/app.log', 'mysql -e "SELECT * FROM thu_chi LIMIT 5"', 'grep -i loi log.txt | head -20', 'pm2 list 2>&1', 'cat a.txt']) { const r = await v.exec('sv1', good); assert.equal(r.ok, true, good); }
  const ssh = calls.filter((c) => c[0] === 'ssh').pop();
  assert.ok(ssh.some((x) => /vps-ro\.key$/.test(x)) && !ssh.some((x) => /vps-full/.test(x))); assert.ok(ssh.includes('agentos-ro@1.2.3.4'));
});

test('bot thường không thêm/xóa/lấy khóa; chưa nhận khóa chỉ-đọc thì báo rõ; không vào được VPS (255) thì chỉ cách xử lý', async () => {
  const f = mk('full'); await f.v.command('them sv1 1.2.3.4 22 root');
  const { v } = mk('ro', f.d);
  assert.match(await v.command('them a 1.1.1.1 22 root'), /bot quản lý/); assert.match(await v.command('xoa sv1'), /bot quản lý/); assert.match(await v.command('khoa sv1'), /bot quản lý/);
  fs.rmSync(f.d + '/vps-ro.key'); assert.match((await v.exec('sv1', 'ls')).text, /chưa nhận khóa/);
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-')); const w = createVps({ role: 'full', file: d2 + '/vps.json', keyFull: d2 + '/k', keyRo: d2 + '/r', known: d2 + '/kh', run: async (bin, a) => { if (bin === 'ssh-keygen') { const p = a[a.indexOf('-f') + 1]; fs.writeFileSync(p, 'x'); fs.writeFileSync(p + '.pub', 'p'); return { code: 0, out: '', err: '' }; } return { code: 255, out: '', err: 'Permission denied (publickey)' }; } });
  await w.command('them s 1.1.1.1 22 root'); const r = await w.exec('s', 'ls'); assert.equal(r.ok, false); assert.match(r.text, /Không vào được/); assert.match(r.text, /\/vps khoa/);
});

test('AI qua bot_command: /vps xem + lệnh đọc = thường; thêm/xóa hoặc lệnh phá hoại = nhạy cảm (phải bấm duyệt)', () => {
  assert.equal(classify('/vps').level, 'normal');
  assert.equal(classify('/vps chay sv1 df -h').level, 'normal');
  assert.equal(classify('/vps chay sv1 mysql -e "SELECT 1"').level, 'normal');
  for (const bad of ['/vps them a 1.1.1.1 22 root', '/vps xoa sv1']) assert.equal(classify(bad).level, 'danger', bad);
  for (const free of ['/vps chay sv1 rm -rf /data', '/vps chay sv1 systemctl stop nginx', '/vps chay sv1 grep -rl x /etc/nginx 2>/dev/null; ls /var/www; uptime; df -h /', '/vps chay sv1 sudo reboot']) assert.equal(classify(free).level, 'normal', 'chạy lệnh trên VPS không hỏi (quyền do Cài đặt → VPS): ' + free);
});

test('kênh Zalo: /vps trên bot quản lý luôn dùng khóa + tài khoản CHỈ-ĐỌC và chặn lệnh ghi; không thêm/xóa/lấy khóa được; Telegram vẫn đủ quyền', async () => {
  const { v, calls } = mk('full');
  await v.command('them sv1 203.0.113.5 22 root');
  const RO = { bot: 'zalobot', noManage: true };
  assert.match(await v.command('chay sv1 cat /opt/mo-qua/backend/data/db.json', RO), /kết quả/);
  let c = calls[calls.length - 1]; assert.ok(c.includes('agentos-ro@203.0.113.5')); assert.ok(c.some((x) => /vps-ro\.key$/.test(x)), 'dùng khóa ro');
  assert.match(await v.command('chay sv1 rm -rf /opt/x', RO), /chỉ có quyền XEM/); assert.match(await v.command('chay sv1 pm2 restart all', RO), /chỉ có quyền XEM/);
  const n = calls.length;
  for (const t of ['them sv9 1.2.3.4', 'khoa sv1', 'xoa sv1']) assert.match(await v.command(t, RO), /chỉ XEM VPS/);
  assert.equal(calls.length, n); assert.equal(v.list().length, 1, 'không thêm/xóa được từ Zalo');
  assert.match(await v.command('thu sv1', RO), /chỉ-đọc/);
  assert.match(await v.command('ds', RO), /XEM \(chỉ-đọc\)/);
  await v.command('chay sv1 whoami'); c = calls[calls.length - 1]; assert.ok(c.includes('root@203.0.113.5'), 'Telegram (không readOnly) vẫn đủ quyền');
});

test('bot: lệnh /vps từ chat Zalo (zl:…) mang danh bot Zalo và không được quản lý VPS; từ Telegram thì không', async () => {
  const { createBot } = require('../src/bot'); const got = [];
  const db = { addJob: () => 1, aheadOf: () => 0, kvGet: () => null, kvSet() {}, runningInChat: () => 0, addAudit() {}, recentJobs: () => [] };
  const worker = { engineNames: () => ['claude'], wake() {}, engineStatus: () => [] };
  const vps = { command: async (a, o) => { got.push([a, !!(o && o.noManage), o && o.bot]); return 'ok'; } };
  const bot = createBot({ vps, db, worker, allowed: new Set(['zl:g1', '1']), isAdmin: () => true, quietAck: true, quick: { has: () => false, match: () => null, run: async () => '' } });
  await bot.handle({ from: { id: 'zl:g1' }, chat: { id: 'zl:g1', type: 'private' }, text: '/vps chay sv1 df -h', message_id: 1 });
  await bot.handle({ from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/vps chay sv1 df -h', message_id: 2 });
  assert.deepEqual(got, [['chay sv1 df -h', true, 'zalobot'], ['chay sv1 df -h', false, undefined]]);
});

test('quyền theo từng bot: chưa tích = bot quản lý đủ quyền, bot khác chỉ xem; tích "Không" chặn; "đủ quyền/sudo" chỉ cho bot quản lý và bot Zalo, bot phụ tối đa chỉ xem', async () => {
  const { v, calls } = mk('full'); await v.command('them sv1 203.0.113.5 22 root');
  assert.equal(v.levelOf('sv1', 'main'), 'full'); assert.equal(v.levelOf('sv1', 'zalobot'), 'ro'); assert.equal(v.levelOf('sv1', 'a1'), 'ro');
  assert.deepEqual(v.setAccess('sv1', { main: 'full', zalobot: 'full', a1: 'full', a2: 'none' }), { main: 'full', zalobot: 'full', a1: 'ro', a2: 'none' }, 'bot phụ không được đủ quyền');
  await v.exec('sv1', 'whoami', { bot: 'zalobot' }); assert.ok(calls[calls.length - 1].includes('root@203.0.113.5'), 'bot Zalo được tích đủ quyền → khóa đủ quyền');
  assert.match((await v.exec('sv1', 'whoami', { bot: 'a2' })).text, /không được phép/);
  assert.deepEqual(v.list({ bot: 'a2' }), []); assert.equal(v.list({ bot: 'a1' }).length, 1);
  v.setAccess('sv1', { zalobot: 'none' }); assert.match((await v.exec('sv1', 'whoami', { bot: 'zalobot' })).text, /không được phép/);
  assert.throws(() => v.setAccess('sv1', { evil: 'ro' }), /không hợp lệ/); assert.throws(() => v.setAccess('sv1', { main: 'root' }), /Quyền không hợp lệ/);
  const ag = mk('ro'); ag.v.put; // bot phụ (role ro) không đổi quyền được
  assert.throws(() => ag.v.setAccess('x', {}), /bot quản lý/);
});

test('đăng nhập VPS bằng mật khẩu MỘT lần: tự cài khóa; mật khẩu chỉ ở biến môi trường (+stdin sudo), không vào dòng lệnh/tệp/nhật ký; lỗi thì không lưu VPS', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vpspw-')); const calls = [], logs = []; let fail = 0;
  const run = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (bin === 'ssh-keygen') { const f = args[args.indexOf('-f') + 1]; fs.writeFileSync(f, 'PRIV'); fs.writeFileSync(f + '.pub', 'ssh-ed25519 PUB-' + path.basename(f) + ' x'); return { code: 0, out: '', err: '' }; }
    if (opts && opts.env && opts.env.SSH_ASKPASS) { assert.ok(fs.existsSync(opts.env.SSH_ASKPASS), 'có tệp askpass lúc chạy'); assert.equal(fs.readFileSync(opts.env.SSH_ASKPASS, 'utf8').includes('MatKhauBiMat'), false, 'mật khẩu không nằm trong tệp askpass'); if (fail) return { code: 255, out: '', err: 'Permission denied MatKhauBiMat' }; }
    return { code: 0, out: 'OK', err: '' };
  };
  const mkv = () => createVps({ role: 'full', file: d + '/data/vps.json', keyFull: d + '/f.key', keyRo: d + '/r.key', known: d + '/kh', run, tmpDir: d, log: (m) => logs.push(m) });
  let v = mkv();
  const r = await v.addWithPassword({ name: 'vps2', host: '203.0.113.9', port: 22185, user: 'root', password: 'MatKhauBiMat' });
  assert.equal(r.name, 'vps2'); assert.equal(v.list().length, 1);
  const inst = calls.find((c) => c.bin === 'ssh' && c.opts && c.opts.env && c.opts.env.SSH_ASKPASS);
  assert.equal(inst.opts.env.AGENTOS_VPS_PW, 'MatKhauBiMat'); assert.equal(inst.opts.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.ok(!inst.args.join(' ').includes('MatKhauBiMat'), 'không có mật khẩu trong dòng lệnh'); assert.match(inst.args[inst.args.length - 1], /authorized_keys/); assert.match(inst.args[inst.args.length - 1], /agentos-ro/); assert.ok(inst.args.includes('-p') && inst.args.includes('22185'));
  assert.ok(!logs.join('\n').includes('MatKhauBiMat'), 'không ghi mật khẩu vào nhật ký');
  assert.ok(!fs.readFileSync(d + '/data/vps.json', 'utf8').includes('MatKhauBiMat'), 'không lưu mật khẩu');
  assert.deepEqual(fs.readdirSync(d).filter((x) => /askpass/.test(x)), [], 'tệp askpass tạm đã xóa');
  // dùng tài khoản thường: chạy bằng sudo, mật khẩu qua stdin
  calls.length = 0; await v.addWithPassword({ name: 'vps3', host: '203.0.113.10', user: 'ubuntu', password: 'MatKhauBiMat' });
  const sd = calls.find((c) => c.bin === 'ssh' && c.opts && c.opts.env && c.opts.env.SSH_ASKPASS); assert.match(sd.args[sd.args.length - 1], /^sudo -S -p ''/); assert.equal(sd.opts.input, 'MatKhauBiMat\n'); assert.ok(!sd.args.join(' ').includes('MatKhauBiMat'));
  // lỗi (sai mật khẩu): báo rõ, KHÔNG lưu VPS, mật khẩu bị che trong thông báo
  fail = 1; await assert.rejects(v.addWithPassword({ name: 'vps4', host: '203.0.113.11', user: 'root', password: 'MatKhauBiMat' }), (e) => /Chưa lưu VPS/.test(e.message) && !e.message.includes('MatKhauBiMat'));
  assert.equal(v.list().map((x) => x.name).includes('vps4'), false);
  await assert.rejects(v.addWithPassword({ name: 'vps5', host: '1.2.3.4', user: 'root', password: '' }), /mật khẩu/);
  assert.equal(v.list().map((x) => x.name).includes('vps5'), false, 'thiếu mật khẩu không để lại VPS nửa vời');
});
