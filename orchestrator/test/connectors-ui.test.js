'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConnectors } = require('../src/connectors');
const { createConnectorsUi } = require('../src/connectorsUi');
const { decideGuard } = require('../src/policy');

const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cu-'));
const txt = (r) => (r && typeof r === 'object' ? r.text : String(r));

function env() {
  const sent = [], deleted = []; let changes = 0;
  const C = createConnectors({ file: path.join(tmp(), 'c.json'), testTimeoutMs: 15000 });
  const U = createConnectorsUi({ connectors: C, isAdmin: (u) => String(u) === '1', send: async (c, r) => { sent.push(r); }, deleteMessage: async (c, m) => { deleted.push([c, m]); }, onChange: () => { changes++; } });
  const press = (data, uid) => U.callback({ data, from: { id: uid || 1 }, message: { chat: { id: 9 } } });
  return { C, U, sent, deleted, press, changes: () => changes, all: () => sent.map(txt).join('\n') };
}

test('/dichvu: chỉ chủ máy; danh sách trống có nút thêm từ danh mục; thêm Notion → hỏi khóa; tin không giống khóa thì thôi chờ (không nuốt mất tin thường)', async () => {
  const E = env();
  assert.match(await E.U.command('9', '2', ''), /Chỉ chủ máy/); assert.equal(await E.press('cn:add:notion', 2), 'Chỉ chủ máy dùng được.');
  const card = await E.U.command('9', '1', '');
  assert.match(card.text, /Kết nối dịch vụ[\s\S]*Chưa có kết nối nào/); assert.deepEqual(card.buttons.flat().map((b) => b.data), ['cn:add:notion', 'cn:add:lich', 'cn:add:gmail']);
  assert.equal(await E.press('cn:add:notion'), 'Đã thêm');
  assert.match(E.all(), /Đã thêm Notion[\s\S]*NOTION_TOKEN[\s\S]*XÓA tin đó/);
  assert.equal(E.C.pendingOf('9').name, 'NOTION_TOKEN');
  assert.equal(E.U.wants('9', 'ok'), false, 'tin ngắn không phải khóa'); assert.equal(E.C.pendingOf('9'), null, 'bỏ chờ');
  await E.press('cn:key:notion:NOTION_TOKEN'); assert.equal(E.U.wants('9', 'Nhờ em soạn thư chào khách mới nhé'), false, 'câu có dấu cách không phải khóa'); assert.equal(E.C.pendingOf('9'), null);
  assert.equal(E.U.wants('9', 'ntn_abcdefgh'), false, 'không còn chờ thì không nhận');
  assert.equal(await E.press('cn:add:notion'), 'Notion đã được thêm rồi.');
});

test('nhập khóa: tin chứa khóa bị XÓA, khóa không hiện lại ở bất kỳ tin nào; đủ khóa thì tự thử thật và tự bật; kết nối được đưa vào tools khi onChange', async () => {
  const E = env(); const SECRET = 'sk-rat-bi-mat-123456';
  const { id } = E.C.addCustom({ label: 'May thu', command: 'node', args: [FAKE] });
  assert.match(txt(await E.U.command('9', '1', 'khoa ' + id + ' SECRET_TOKEN')), /Gửi giá trị của SECRET_TOKEN/);
  assert.equal(E.U.wants('9', SECRET), true);
  const r = txt(await E.U.takeSecret('9', SECRET, { message_id: 55 }));
  assert.deepEqual(E.deleted, [['9', 55]]); assert.match(r, /chạy tốt, 3 công cụ[\s\S]*Đã BẬT/); assert.equal(E.C.get(id).enabled, true); assert.equal(E.changes(), 2, 'đổi khóa + tự bật đều cập nhật cấu hình');
  assert.doesNotMatch(E.all() + r + JSON.stringify(await E.U.command('9', '1', '')), /sk-rat-bi-mat/, 'không tin nào nhắc lại khóa');
  assert.match(txt(await E.U.command('9', '1', '')), /✅ May thu \(maythu\) — đang bật · thử \d\d:\d\d: OK, 3 công cụ/);
  // khóa gõ thẳng trong lệnh: tin lệnh cũng bị xóa
  E.deleted.length = 0; const before = E.changes();
  await E.U.command('9', '1', 'khoa ' + id + ' FAKE_MODE crashhhhh', { message_id: 66 }); assert.deepEqual(E.deleted, [['9', 66]]);
  assert.ok(E.changes() > before, 'đổi khóa của kết nối đang bật → cấu hình đang chạy được cập nhật'); assert.equal(E.C.get(id).last.ok, true, 'đủ khóa thì tự thử lại');
});

test('thử/bật/tắt/xóa qua lệnh và nút: lỗi hiển thị rõ ràng (không lộ khóa), xóa có bước xác nhận, thiếu khóa thì hỏi', async () => {
  const E = env();
  const { id } = E.C.addCustom({ label: 'May loi', command: 'node', args: [FAKE] });
  E.C.setSecret(id, 'FAKE_MODE', 'crash'); E.C.setSecret(id, 'SECRET_TOKEN', 'tok-bi-mat-5678');
  const bad = txt(await E.U.command('9', '1', 'thu ' + id)); assert.match(bad, /thử LỖI[\s\S]*dừng ngay/); assert.doesNotMatch(bad, /tok-bi-mat/); assert.match(E.all(), /Đang thử/);
  assert.match(txt(await E.U.command('9', '1', '')), /⚠️ May loi.*LỖI/);
  assert.match(txt(await E.U.command('9', '1', 'bat ' + id)), /Đã bật May loi/); assert.equal(E.changes(), 1);
  assert.match(txt(await E.U.command('9', '1', 'tat ' + id)), /Đã tắt/); assert.equal(E.changes(), 2);
  assert.match(txt(await E.U.command('9', '1', 'bat khong-co')), /Không có kết nối/); assert.match(txt(await E.U.command('9', '1', 'thu')), /Cách dùng/); assert.match(txt(await E.U.command('9', '1', 'lung tung ' + id)), /Không hiểu/);
  await E.press('cn:add:lich'); E.sent.length = 0;
  assert.equal(await E.press('cn:on:lich'), 'Chưa bật được'); assert.match(E.all(), /Còn thiếu: GOOGLE_OAUTH_CREDENTIALS/);
  assert.equal(await E.press('cn:del:' + id), ''); assert.deepEqual(E.sent.pop().buttons.flat().map((b) => b.data), ['cn:delyes:' + id, 'cn:list']); assert.ok(E.C.get(id), 'chưa xác nhận thì chưa xóa');
  assert.equal(await E.press('cn:delyes:' + id), 'Đã xóa'); assert.equal(E.C.get(id), null); assert.equal(await E.press('cn:test:' + id), 'Không có kết nối này nữa.');
  assert.match(txt(await E.U.command('9', '1', 'them Kho')), /Cách dùng/);
  const add = await E.U.command('9', '1', 'them Kho npx -y goi-mcp'); assert.match(add.text, /Đã thêm "Kho" \(mã kho\)/); assert.deepEqual(E.C.get('kho').args, ['-y', 'goi-mcp']);
  assert.match(txt(await E.U.command('9', '1', 'them Xau rm -rf /')), /⚠️ Lệnh chạy máy chủ không hợp lệ: chỉ nhận npx/);
  const gm = await E.press('cn:add:gmail'); assert.equal(gm, 'Đã thêm'); assert.match(E.all(), /Gmail[\s\S]*MỘT LẦN trên máy/); assert.deepEqual(E.sent[E.sent.length - 1].buttons.flat().map((b) => b.data), ['cn:test:gmail']);
});

test('hàng rào: công cụ GHI/GỬI/XÓA của kết nối dịch vụ luôn hỏi chủ máy; công cụ chỉ đọc/tìm thì qua; không áp cho máy chủ khác', () => {
  const g = (tool) => decideGuard({ tool, input: {} }).action;
  for (const t of ['mcp__c_gmail__send_email', 'mcp__c_gmail__reply_to_thread', 'mcp__c_notion__API-post-page', 'mcp__c_notion__API-patch-block', 'mcp__c_notion__API-delete-a-block', 'mcp__c_lich__createEvent', 'mcp__c_lich__delete-event', 'mcp__c_lich__update_event', 'mcp__c_drive__uploadFile', 'mcp__c_x__set_value']) assert.equal(g(t), 'ask', t);
  for (const t of ['mcp__c_gmail__search_emails', 'mcp__c_gmail__read_email', 'mcp__c_notion__API-retrieve-a-page', 'mcp__c_lich__list_events', 'mcp__c_lich__getEvent', 'mcp__c_x__get_dataset', 'mcp__c_x__list_assets']) assert.equal(g(t), 'allow', t);
  assert.equal(g('mcp__browser__browser_click'), 'allow', 'không đụng trình duyệt'); assert.equal(g('mcp__other__send_email'), 'allow', 'chỉ áp cho kết nối dịch vụ (c_)');
  assert.match(decideGuard({ tool: 'mcp__c_gmail__send_email', input: {} }).warn, /Kết nối "gmail".*send_email/);
});
