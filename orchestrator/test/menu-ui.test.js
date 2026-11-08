'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMenuUi, ITEMS, GOOGLE_ASKS } = require('../src/menuUi');
const { createGoogleAuth } = require('../src/googleAuth');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mn-'));
const cq = (data, uid) => ({ data, from: { id: uid || 1 }, message: { chat: { id: 77 } } });
function mk(over) {
  const sent = [], ran = [], subs = [];
  const ui = createMenuUi(Object.assign({
    isAdmin: (u) => String(u) === '1',
    run: async (m) => { ran.push(m.text); return 'kq:' + m.text; },
    send: async (c, t) => { sent.push([c, t]); },
    submit: (c, t) => { subs.push(t); return '⏳ đã xếp hàng'; },
    googleStatus: () => ({ clientSet: false, connected: false }),
  }, over || {}));
  return { ui, sent, ran, subs };
}

test('menu: có đủ nút, mọi nút có dữ liệu mn:c:<mã> duy nhất và ≤ 64 byte (giới hạn Telegram)', () => {
  const { ui } = mk();
  const c = ui.card();
  const flat = c.buttons.flat();
  assert.equal(flat.length, ITEMS.length);
  assert.equal(new Set(flat.map((b) => b.data)).size, flat.length);
  for (const b of flat) { assert.match(b.data, /^mn:c:\w+$/); assert.ok(Buffer.byteLength(b.data) <= 64); }
  assert.ok(c.buttons.every((r) => r.length <= 2));
});

test('bấm nút lệnh -> chạy đúng lệnh qua đường xử lý chung và gửi kết quả lại', async () => {
  const { ui, sent, ran } = mk();
  await ui.callback(cq('mn:c:pc'));
  assert.deepEqual(ran, ['/phancung']);
  assert.deepEqual(sent, [['77', 'kq:/phancung']]);
  await ui.callback(cq('mn:c:tt')); assert.equal(ran[1], '/trangthai');
});

test('cập nhật hệ điều hành: phải xác nhận 1 lần; "Thôi" thì không làm gì', async () => {
  const { ui, sent, ran } = mk();
  await ui.callback(cq('mn:c:cn'));
  assert.equal(ran.length, 0);
  const card = sent[0][1];
  assert.match(card.text, /Cập nhật hệ điều hành/);
  assert.deepEqual(card.buttons[0].map((b) => b.data), ['mn:ok:cn', 'mn:no']);
  assert.match(await ui.callback(cq('mn:no')), /Thôi/); assert.equal(ran.length, 0);
  await ui.callback(cq('mn:ok:cn')); assert.deepEqual(ran, ['/capnhat co']);
});

test('người không phải chủ máy bấm nút -> bị từ chối, không chạy gì', async () => {
  const { ui, ran, sent } = mk();
  assert.match(await ui.callback(cq('mn:c:pc', 2)), /Chỉ chủ máy/);
  assert.match(await ui.callback(cq('mn:ok:cn', 2)), /Chỉ chủ máy/);
  assert.equal(ran.length, 0); assert.equal(sent.length, 0);
});

test('mã nút lạ / dữ liệu không phải mn: -> bỏ qua an toàn', async () => {
  const { ui, ran } = mk();
  assert.equal(ui.isCallback('pl:list'), false); assert.equal(ui.isCallback('mn:x'), true);
  assert.equal(await ui.callback(cq('mn:c:khongco')), null);
  assert.equal(await ui.callback(cq('mn:ok:khongco')), null);
  assert.equal(await ui.callback(cq('mn:g:khongco')), null);
  assert.equal(ran.length, 0);
});

test('Google chưa có khóa: hướng dẫn làm tại Cài đặt, nêu "chỉ đọc"; đã có khóa nhưng chưa đăng nhập: chỉ còn bước đăng nhập', () => {
  const none = mk().ui.google();
  assert.match(none.text, /chưa kết nối/); assert.match(none.text, /5 bước/); assert.match(none.text, /chỉ ĐỌC/);
  const own = mk({ googleStatus: () => ({ clientSet: true, connected: false }) }).ui.google();
  assert.match(own.text, /đã có khóa/); assert.doesNotMatch(own.text, /5 bước/);
});

test('Google đã kết nối: có nút hỏi lịch/thư; bấm nút -> giao việc CHỈ ĐỌC cho AI; nói rõ quyền hiện tại', async () => {
  const { ui, sent, subs } = mk({ googleStatus: () => ({ clientSet: true, connected: true, write: false }) });
  const g = ui.google();
  assert.match(g.text, /đã kết nối/); assert.match(g.text, /chỉ ĐỌC/);
  const ds = g.buttons.flat().map((b) => b.data).filter((d) => /^mn:g:/.test(d));
  assert.deepEqual(ds.sort(), ['mn:g:lh', 'mn:g:lt', 'mn:g:th']);
  await ui.callback(cq('mn:g:th'));
  assert.equal(subs.length, 1); assert.match(subs[0], /Chỉ đọc/); assert.match(subs[0], /không trả lời\/xóa\/gửi/);
  assert.equal(sent[0][1], '⏳ đã xếp hàng');
  for (const v of Object.values(GOOGLE_ASKS)) assert.match(v, /Chỉ đọc/);
  const w = mk({ googleStatus: () => ({ clientSet: true, connected: true, write: true }) }).ui.google();
  assert.match(w.text, /ĐỌC \+ GHI/);
});

test('Google: trạng thái lỗi không làm sập thẻ', () => {
  const { ui } = mk({ googleStatus: () => { throw new Error('hỏng'); } });
  assert.match(ui.google().text, /chưa kết nối/);
});

test('googleAuth.saveClient: báo lỗi dễ hiểu cho tệp sai loại / rỗng / cắt dở', () => {
  const a = createGoogleAuth({ dir: tmp() });
  assert.match(a.saveClient('   ').error, /Chọn tệp JSON/);
  assert.match(a.saveClient('{"installed":{"client_id":').error, /bị cắt dở|không phải JSON/);
  assert.match(a.saveClient({ type: 'service_account', client_email: 'x@y' }).error, /tài khoản dịch vụ/);
  const web = a.saveClient({ web: { client_id: '1-a.apps.googleusercontent.com', client_secret: 'GOCSPX-abcdefgh' } });
  assert.equal(web.ok, false); assert.match(web.error, /Ứng dụng web/); assert.match(web.error, /máy tính để bàn/);
  assert.equal(a.clientSet(), false);
  const ok = a.saveClient({ installed: { client_id: '1-a.apps.googleusercontent.com', client_secret: 'GOCSPX-abcdefgh' } });
  assert.equal(ok.ok, true); assert.equal(a.clientSet(), true);
  assert.deepEqual([a.status().ownClient, a.status().sharedClient], [true, false]);
});

test('googleAuth: khóa DÙNG CHUNG của nhà phát hành — khách không phải tự tạo; khóa khách tự nhập được ưu tiên', () => {
  const d = tmp(), shared = path.join(d, 'shared.json');
  fs.writeFileSync(shared, JSON.stringify({ installed: { client_id: '9-shared.apps.googleusercontent.com', client_secret: 'GOCSPX-sharedsecret' } }));
  const a = createGoogleAuth({ dir: path.join(d, 'g'), sharedClientFile: shared });
  assert.equal(a.clientSet(), true);
  assert.deepEqual([a.status().ownClient, a.status().sharedClient], [false, true]);
  const s = a.start({ write: false, redirectUri: 'http://127.0.0.1:8089/google/callback' });
  assert.equal(s.ok, true); assert.match(s.url, /client_id=9-shared/);
  a.saveClient({ installed: { client_id: '1-own.apps.googleusercontent.com', client_secret: 'GOCSPX-ownsecret1' } });
  assert.match(a.start({ write: false, redirectUri: 'http://127.0.0.1:8089/google/callback' }).url, /client_id=1-own/);
  assert.deepEqual([a.status().ownClient, a.status().sharedClient], [true, false]);
  const none = createGoogleAuth({ dir: path.join(d, 'g2'), sharedClientFile: path.join(d, 'khong-co.json') });
  assert.equal(none.clientSet(), false);
});
