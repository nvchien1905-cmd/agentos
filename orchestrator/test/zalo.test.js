'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createZalo, decide, consumeGrant, defaults } = require('../src/zalo');
const deskMcp = require('../src/desk-mcp');
const { classify } = require('../src/cmdTool');

let curNow = Date.now;
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-')), 'zalo.json');
const at = (h, m) => new Date(2026, 10, 15, h, m || 0).getTime();       // 15/11/2026
function mk(extra) {
  const file = tmp(); let t = at(10, 0); const sent = [], asks = [], jobs = []; curNow = () => t;
  const z = createZalo(Object.assign({ file, now: () => t, admin: () => 'owner', notify: async (c, x) => { sent.push(x); }, ask: async (c, x, b) => { asks.push({ x, b }); }, submit: (p) => { jobs.push(p); return 77; } }, extra || {}));
  return { z, file, sent, asks, jobs, setT: (v) => { t = v; }, adv: (ms) => { t += ms; } };
}
function fakeDesk(active) {
  const calls = [];
  return { calls, call: async (req) => { calls.push(req); if (req.cmd === 'info') return { ok: true, width: 1, height: 1, active }; if (req.cmd === 'screenshot') return { ok: true, file: '/x.png' }; return { ok: true }; } };
}
const mkDesk = (desk, file, extra) => deskMcp.createHandler(Object.assign({ desk, zaloFile: file, readFile: () => Buffer.from('P'), rm: () => {}, sleep: async () => {}, settleMs: 0, rand: () => 0.5, now: () => curNow() }, extra || {}));

test('zalo: mặc định TẮT — không cấp phiếu; bật rồi chế độ nháp vẫn không tự gửi (cần chủ máy duyệt)', () => {
  const { z } = mk();
  assert.match(z.request('Nhóm A', 'xin chào'), /TỪ CHỐI: Trợ lý Zalo đang TẮT/);
  assert.match(z.command('bat'), /rủi ro|khóa tạm/);
  assert.match(z.request('Nhóm A', 'xin chào'), /CHỜ CHỦ DUYỆT/);
});

test('zalo: chế độ tự động cấp phiếu 1 lần; hạn mức giờ, nhịp giữa hai tin, khung giờ, danh sách chặn', () => {
  const { z, file, adv, setT } = mk(); z.command('bat'); z.command('tudong');
  assert.match(z.request('Nhóm A', 'tin 1'), /ĐƯỢC GỬI/);
  assert.match(z.request('Nhóm A', 'tin 2'), /TỪ CHỐI: Vừa gửi tin trước/);       // chưa qua 30 giây
  adv(31000); assert.match(z.request('Nhóm A', 'tin 2'), /ĐƯỢC GỬI/);
  z.command('chan Phương Đình'); adv(31000);
  assert.match(z.request('phuong dinh', 'chào'), /TỪ CHỐI: .*KHÔNG tự gửi/);       // chặn không phân biệt dấu/hoa thường
  z.command('bochan Phương Đình'); assert.match(z.request('Phương Đình', 'chào'), /ĐƯỢC GỬI/);
  z.command('gioihan 3'); adv(31000);
  assert.match(z.request('Nhóm B', 'x'), /TỪ CHỐI: Đã gửi 3 tin trong 1 giờ/);
  setT(at(23, 30)); assert.match(z.request('Nhóm C', 'x'), /TỪ CHỐI: Ngoài khung giờ/);
  const c = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(c.history.length, 3);
  assert.equal((fs.statSync(file).mode & 0o077), process.platform === 'win32' ? (fs.statSync(file).mode & 0o077) : 0, 'tệp riêng tư');
});

test('zalo: hạn mức ngày; nội dung mật khẩu/OTP/số thẻ không tự gửi mà chờ duyệt; nội dung rỗng/quá dài bị từ chối', () => {
  const c = Object.assign(defaults(), { enabled: true, mode: 'tudong', perHour: 100, perDay: 2, minGap: 5 });
  const t = at(10, 0);
  assert.equal(decide(c, 'A', 'ok', t).ok, true);
  c.history = [{ at: t - 7200000 }, { at: t - 3600001 * 2 }];
  assert.match(decide(c, 'A', 'ok', t).reason, /24 giờ qua/);
  c.history = [];
  for (const bad of ['mật khẩu của em là 123', 'mã OTP là 4821', 'số thẻ 4111 1111 1111 1111', 'cvv 123']) { const d = decide(c, 'A', bad, t); assert.equal(d.ok, false, bad); assert.equal(d.needApproval, true, bad); }
  assert.equal(decide(c, 'A', '', t).ok, false); assert.equal(decide(c, 'A', 'x'.repeat(2001), t).ok, false); assert.equal(decide(c, '', 'x', t).ok, false);
  assert.equal(decide(c, 'A', 'mật khẩu wifi', t, { byOwner: true }).ok, true, 'chủ máy tự ra lệnh thì được');
});

test('zalo: nháp → thẻ có nút; ✅ cấp phiếu + tạo việc gửi gõ chậm; bấm đúp không gửi hai lần; ❌ bỏ', async () => {
  const { z, asks, jobs, adv } = mk(); z.command('bat');
  assert.match(z.request('Nhóm A', 'Chào cả nhà'), /CHỜ CHỦ DUYỆT.*nháp #1/);
  assert.equal(asks.length, 1); assert.match(asks[0].x, /Nhóm A/); assert.equal(asks[0].b[0][0].data, 'zl:1:y');
  assert.equal(z.isCallback('zl:1:y'), true); assert.equal(z.isCallback('fb:1:y'), false);
  assert.match(await z.answerCallback('zl:1:y'), /Đang gửi cho "Nhóm A".*#77/);
  assert.equal(jobs.length, 1); assert.ok(jobs[0].startsWith('[ZALO-GỬI]')); assert.match(jobs[0], /Chào cả nhà/); assert.match(jobs[0], /CHẬM/);
  assert.match(await z.answerCallback('zl:1:y'), /đã xử lý/);
  assert.equal(jobs.length, 1);
  adv(31000); z.request('Nhóm B', 'tin B'); assert.match(await z.answerCallback('zl:2:n'), /Đã bỏ/); assert.equal(jobs.length, 1);
  assert.match(await z.answerCallback('zl:9:y'), /hết hạn/);
});

test('zalo: chủ máy ra lệnh /zalo gui — bỏ qua chế độ nháp và khung giờ nhưng vẫn theo hạn mức; tắt thì từ chối', () => {
  const { z, jobs, setT } = mk();
  assert.match(z.command('gui Nhóm A | xin chào'), /đang TẮT/);
  z.command('bat'); setT(at(23, 50));
  assert.match(z.command('gui Nhóm A | xin chào'), /Đang gửi cho "Nhóm A"/); assert.equal(jobs.length, 1);
  assert.match(z.command('gui Nhóm A | tin nữa'), /⛔.*Vừa gửi tin trước/);
  assert.match(z.command('gui thiếu dấu'), /Cách dùng/);
});

test('zalo: màn hình — Zalo TẮT: Enter/Gửi bị chặn; BẬT: cần phiếu, mỗi phiếu dùng đúng 1 lần, hết hạn thì không dùng được', async () => {
  const { z, file, adv } = mk();
  const off = mkDesk(fakeDesk('Zalo'), file);
  let r = await off('screen_key', { key: 'Return', screenshot: false }); assert.equal(r.isError, true); assert.match(r.content[0].text, /TẮT/);
  z.command('bat'); z.command('tudong');
  const d = fakeDesk('Zalo - Google Chrome'); const on = mkDesk(d, file);
  r = await on('screen_key', { key: 'Return', screenshot: false }); assert.equal(r.isError, true); assert.match(r.content[0].text, /phiếu gửi/);
  assert.ok(!d.calls.some((c) => c.cmd === 'key'));
  assert.match(z.request('Nhóm A', 'chào'), /ĐƯỢC GỬI/);
  r = await on('screen_key', { key: 'Return', screenshot: false }); assert.equal(r.isError, undefined); assert.ok(d.calls.some((c) => c.cmd === 'key' && c.key === 'Return'));
  r = await on('screen_key', { key: 'Return', screenshot: false }); assert.equal(r.isError, true, 'phiếu đã dùng');
  assert.match(z.request('Nhóm A', 'chào 2'), /TỪ CHỐI/);                 // chưa đủ nhịp
  adv(31000); assert.match(z.request('Nhóm A', 'chào 2'), /ĐƯỢC GỬI/);
  adv(11 * 60000); r = await on('screen_key', { key: 'Return', screenshot: false }); assert.equal(r.isError, true, 'phiếu hết hạn sau 10 phút');
  // phiếu cũ không dùng được khi tắt trợ lý
  adv(31000); z.request('Nhóm A', 'chào 3'); z.command('tat'); r = await on('screen_key', { key: 'Return', screenshot: false }); assert.equal(r.isError, true);
  assert.equal(consumeGrant(file, Date.now()).ok, false);
});

test('zalo: màn hình — nút "Gửi" theo chữ cũng cần phiếu; ứng dụng chat khác (Gmail/Messenger) vẫn chặn kể cả khi Zalo bật; trang đăng nhập vẫn chặn', async () => {
  const { z, file } = mk(); z.command('bat'); z.command('tudong');
  let r = await mkDesk(fakeDesk('Zalo'), file)('screen_click_text', { text: 'Gửi', screenshot: false }); assert.equal(r.isError, true);
  for (const title of ['Gmail - Google Chrome', 'Messenger']) { r = await mkDesk(fakeDesk(title), file)('screen_key', { key: 'Return', screenshot: false }); assert.equal(r.isError, true, title); }
  r = await mkDesk(fakeDesk('Zalo - Đăng nhập'), file)('screen_type', { text: 'abc', screenshot: false }); assert.equal(r.isError, true);
  assert.match(z.request('Nhóm', 'x'), /ĐƯỢC GỬI/);
  r = await mkDesk(fakeDesk('Zalo'), file)('screen_click_text', { text: 'Gửi', screenshot: false }); assert.equal(r.isError, undefined);
});

test('zalo: màn hình — gõ vào Zalo như người thật (nghỉ rồi từng cụm 2–3 từ, mỗi phím chậm); chưa bật thì gõ một lần như cũ', async () => {
  const { z, file } = mk();
  let d = fakeDesk('Zalo'); await mkDesk(d, file)('screen_type', { text: 'a b c d e f', screenshot: false });
  assert.equal(d.calls.filter((c) => c.cmd === 'type').length, 1); assert.equal(d.calls.find((c) => c.cmd === 'type').delay, undefined);
  z.command('bat');
  const waits = []; d = fakeDesk('Zalo');
  const call = mkDesk(d, file, { sleep: async (ms) => { waits.push(ms); } });
  const text = 'Chào cả nhà, hôm nay cửa hàng nghỉ sớm nhé mọi người ơi';
  const r = await call('screen_type', { text, screenshot: false }); assert.equal(r.isError, undefined);
  const typed = d.calls.filter((c) => c.cmd === 'type');
  assert.ok(typed.length >= 4, 'chia thành nhiều cụm'); assert.equal(typed.map((c) => c.text).join(''), text, 'ghép lại đúng nguyên văn');
  assert.ok(typed.every((c) => c.delay >= 60 && c.delay <= 150), 'mỗi phím chậm 60–150 ms');
  assert.ok(waits[0] >= 1000 && waits[0] <= 3000, 'nghĩ 1–3 giây trước khi gõ'); assert.equal(waits.length, typed.length, 'nghỉ giữa các cụm');
  assert.match(r.content[0].text, /Chưa gửi/);
});

test('zalo: cổng duyệt trình duyệt — chỉ việc [ZALO-GỬI] được tự bấm/gõ, tối đa 60 thao tác', () => {
  const { z } = mk();
  const job = { id: 5, prompt: '[ZALO-GỬI] vào chat.zalo.me' };
  assert.equal(z.allowInteract({ id: 6, prompt: 'việc khác' }, 'mcp__browser__browser_type'), false);
  assert.equal(z.allowInteract(job, 'mcp__browser__browser_evaluate'), false);
  assert.equal(z.allowInteract(job, 'Bash'), false);
  for (let i = 0; i < 59; i++) z.allowInteract(job, 'mcp__browser__browser_click');
  assert.equal(z.allowInteract(job, 'mcp__browser__browser_type'), true);          // thao tác thứ 60
  assert.equal(z.allowInteract(job, 'mcp__browser__browser_click'), false);        // thứ 61
});

test('zalo: lệnh cấu hình và cách AI gọi lệnh qua bot_command (duyet an toàn, gui phải hỏi chủ máy)', () => {
  const { z } = mk();
  assert.match(z.command('gioihan 5 20'), /5 tin\/giờ, 20 tin\/ngày/); assert.match(z.command('gioihan 0'), /Cách dùng/); assert.match(z.command('gioihan 50 10'), /Cách dùng/);
  assert.match(z.command('nhip 45'), /45 giây/); assert.match(z.command('nhip 1'), /Cách dùng/);
  assert.match(z.command('gio 8-21'), /08:00–21:00/); assert.match(z.command('gio 9'), /Cách dùng/);
  assert.match(z.command('chidan nói giá lẻ, hẹn gọi lại'), /Đã lưu/); assert.match(z.command(''), /Chỉ dẫn: nói giá lẻ/);
  assert.match(z.command('duyet thiếu'), /cú pháp/); assert.match(z.command('nhatky'), /Chưa gửi/); assert.match(z.command('dangnhap'), /QR/);
  assert.equal(classify('/zalo duyet Nhóm A | chào').level, 'safe');
  assert.equal(classify('/zalo gui Nhóm A | chào').level, 'danger');
  assert.equal(classify('/zalo bat').level, 'normal'); assert.equal(classify('/zalo tudong').level, 'normal');
});
