'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createBackup } = require('../src/backup');
const { createSelfTest } = require('../src/selftest');
const { createQuick } = require('../src/quick');

const ROOT = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
function files(extra) {
  const d = tmp(); const f = { statusFile: path.join(d, 'st.json'), confFile: path.join(d, 'conf.json'), triggerFile: path.join(d, 'now') };
  return Object.assign({ d }, f, extra || {});
}
const NOW = Date.parse('2026-10-27T12:00:00+07:00');

test('sao lưu ngoài: trạng thái — chưa bật / chưa chạy / thành công / lỗi / quá hạn', () => {
  const F = files(); const b = createBackup(Object.assign({ now: () => NOW }, F));
  assert.equal(b.status().configured, false); assert.match(b.text(), /Chưa bật sao lưu/);
  fs.writeFileSync(F.confFile, JSON.stringify({ target: 'AAAA-1111', keepDays: 30 }));
  assert.equal(b.status().ok, null); assert.match(b.text(), /chưa sao lưu lần nào/);
  fs.writeFileSync(F.statusFile, JSON.stringify({ ok: true, at: '2026-10-27T03:31:00+0700', ts: NOW / 1000 - 8 * 3600, message: 'ok', bytes: 5 * 1048576, files: 12, secs: 9 }));
  const s = b.status(); assert.equal(s.ok, true); assert.match(b.text(), /✅.*thành công.*5.0 MB.*12 tệp/);
  fs.writeFileSync(F.statusFile, JSON.stringify({ ok: false, at: 'x', ts: NOW / 1000 - 3600, message: 'chưa cắm ổ sao lưu' })); assert.equal(b.status().ok, false); assert.match(b.text(), /LỖI.*chưa cắm ổ/);
  fs.writeFileSync(F.statusFile, JSON.stringify({ ok: true, at: 'cũ', ts: NOW / 1000 - 50 * 3600, message: 'ok', bytes: 1, files: 0, secs: 1 })); assert.equal(b.status().ok, false); assert.equal(b.status().stale, true); assert.match(b.text(), /quá 40 giờ/);
});

test('sao lưu ngoài: yêu cầu chạy ngay chỉ gửi khi đã cấu hình', () => {
  const F = files(); const b = createBackup(Object.assign({ now: () => NOW }, F));
  assert.equal(b.request(), false); assert.ok(!fs.existsSync(F.triggerFile));
  fs.writeFileSync(F.confFile, '{"target":"AAAA-1111","keepDays":7}'); assert.equal(b.request(), true); assert.ok(fs.existsSync(F.triggerFile));
});

test('tự chẩn đoán: chưa bật = cảnh báo (không báo động), lỗi/quá hạn = ❌ để chủ máy được nhắn', async () => {
  const F = files(); const backup = createBackup(Object.assign({ now: () => NOW }, F));
  const st = createSelfTest({ backup, engines: [], run: async () => ({ code: 0, out: '' }) });
  const one = async () => (await st.light()).find((r) => r.id === 'backup');
  assert.equal((await one()).status, 'warn');
  fs.writeFileSync(F.confFile, '{"target":"AAAA-1111","keepDays":7}');
  fs.writeFileSync(F.statusFile, JSON.stringify({ ok: true, at: 'a', ts: NOW / 1000 - 3600, message: 'ok', bytes: 1048576, files: 1, secs: 1 })); assert.equal((await one()).status, 'ok');
  fs.writeFileSync(F.statusFile, JSON.stringify({ ok: false, at: 'a', ts: NOW / 1000 - 3600, message: 'ổ không đủ chỗ' })); const bad = await one(); assert.equal(bad.status, 'fail'); assert.match(bad.detail, /không đủ chỗ/);
  fs.writeFileSync(F.statusFile, JSON.stringify({ ok: true, at: 'a', ts: NOW / 1000 - 60 * 3600, message: 'ok', bytes: 1, files: 0, secs: 1 })); assert.equal((await one()).status, 'fail');
});

test('/saoluudia: xem trạng thái và chạy ngay', async () => {
  const F = files(); const backup = createBackup(Object.assign({ now: () => NOW }, F));
  const q = createQuick({ backup });
  assert.ok(q.has('saoluudia'));
  assert.match(await q.run('saoluudia', '', {}), /Chưa bật sao lưu/);
  assert.match(await q.run('saoluudia', 'chay', {}), /Chưa bật sao lưu/);
  fs.writeFileSync(F.confFile, '{"target":"AAAA-1111","keepDays":7}');
  assert.match(await q.run('saoluudia', 'chạy', {}), /Đã yêu cầu sao lưu ngay/); assert.ok(fs.existsSync(F.triggerFile));
});

test('tập lệnh agentos-backup: cú pháp đúng và có đủ các rào an toàn (cùng ổ, đủ chỗ, mã lỗi rsync, tháo ổ khi lỗi, che bí mật)', { skip: process.platform === 'win32' }, () => {
  const f = path.join(ROOT, 'iso/config/includes.chroot/usr/local/sbin/agentos-backup');
  execFileSync('bash', ['-n', f]);
  const t = fs.readFileSync(f, 'utf8');
  for (const must of ['same_disk_as_system', 'không đủ chỗ', 'trap close_target EXIT', 'badrc', '--backup-dir', '***da-che***', 'cloud.json', 'phien-ban', 'umount "$MNT"']) assert.ok(t.includes(must), 'thiếu ' + must);
  assert.match(t, /\[ "\$\(id -u\)" = 0 \]/, 'chỉ chạy bằng root');
  // dịch vụ: mã thoát 3 (chưa cắm ổ) không làm dịch vụ "lỗi"
  assert.match(fs.readFileSync(path.join(ROOT, 'iso/config/includes.chroot/etc/systemd/system/agentos-backup.service'), 'utf8'), /SuccessExitStatus=3/);
});
