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
  for (const bad of ['/vps them a 1.1.1.1 22 root', '/vps xoa sv1', '/vps chay sv1 rm -rf /data', '/vps chay sv1 systemctl stop nginx', '/vps chay sv1 mysql -e "DROP DATABASE x"', '/vps chay sv1 sudo reboot', '/vps chay sv1 pm2 delete all']) assert.equal(classify(bad).level, 'danger', bad);
});
