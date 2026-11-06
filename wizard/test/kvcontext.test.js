'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createMultiKiotViet } = require('../../orchestrator/src/kiotviet');
const { createKvContext, wants, build } = require('../../orchestrator/src/kvcontext');

const inv = (id, br, total, d) => ({ id, branchName: br, total, status: 1, purchaseDate: d || '2026-11-05T09:00:00' });
const DATA = { tulibaby: [inv(1, 'Thượng Mỗ', 100000), inv(2, 'Thọ An', 50000)], huyenanh: [inv(3, 'Phương Đình', 900000)] };
const f = async (url, opt) => {
  url = String(url);
  if (url.includes('token')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) };
  const d = DATA[opt.headers.Retailer] || [];
  if (url.includes('/products')) return { ok: true, status: 200, json: async () => ({ data: [{ name: 'Nồi chiên', code: 'SP1', basePrice: 1000000, inventories: [{ branchName: 'Phương Đình', onHand: 5 }] }], total: 1 }) };
  return { ok: true, status: 200, json: async () => ({ data: d, total: d.length }) };
};
const kv = createMultiKiotViet([{ name: 'Tulibaby', retailer: 'tulibaby', clientId: 'a', clientSecret: 'b' }, { name: 'Huyền Anh', retailer: 'huyenanh', clientId: 'c', clientSecret: 'd' }], { fetch: f });
const NOW = Date.UTC(2026, 10, 5, 5);

test('wants: nhận câu hỏi số liệu, bỏ qua câu chuyện khác', () => {
  for (const s of ['Tulibaby hôm qua bán được bao nhiêu', 'doanh thu hôm nay', 'tồn kho nồi chiên', 'xem hóa đơn mới', 'kiểm tra kiotviet']) assert.equal(wants(s), true, s);
  for (const s of ['viết thư cho khách', 'dọn thư mục tải về', 'hôm nay trời đẹp']) assert.equal(wants(s), false, s);
});

test('build: đính doanh số hôm nay + hôm qua theo chi nhánh, đúng gian khi nêu tên; có khối đánh dấu để AI biết', async () => {
  const r = await build(kv, 'cho anh biết doanh thu của từng chi nhánh Tulibaby hôm qua', NOW);
  assert.match(r, /^\[DỮ LIỆU KIOTVIET/); assert.match(r, /Thượng Mỗ: 1 hóa đơn · 100\.000đ/); assert.doesNotMatch(r, /Phương Đình/); assert.match(r, /\[HẾT DỮ LIỆU KIOTVIET\]/);
  const all = await build(kv, 'doanh thu hôm nay', NOW);
  assert.match(all, /🏬 Tulibaby/); assert.match(all, /🏬 Huyền Anh/);
  const st = await build(kv, 'tồn kho nồi chiên còn không', NOW);
  assert.match(st, /Nồi chiên/);
  assert.equal(await build(kv, 'viết thư cho khách', NOW), '');
  assert.equal(await build(createMultiKiotViet([]), 'doanh thu hôm nay', NOW), '');
});

test('build: KiotViet lỗi thì vẫn trả khối kèm cảnh báo thật, không ném lỗi', async () => {
  const bad = createMultiKiotViet([{ name: 'A', retailer: 'a', clientId: 'x', clientSecret: 'y' }], { fetch: async (u) => (String(u).includes('token') ? { ok: false, status: 401, json: async () => ({}) } : { ok: true, json: async () => ({}) }) });
  const r = await build(bad, 'doanh thu hôm nay', NOW);
  assert.match(r, /KiotViet từ chối đăng nhập|Không lấy được/);
});

test('prefix: nhớ theo việc (đổi AI không gọi lại KiotViet)', async () => {
  let n = 0; const counting = { configured: () => true, shops: () => [], revenue: async () => { n++; return 'x'; }, stock: async () => 'y' };
  const c = createKvContext({ kiotviet: counting, now: () => 1000 });
  const a = await c.prefix({ id: 7 }, 'doanh thu hôm nay'); const calls = n;
  assert.equal(await c.prefix({ id: 7 }, 'doanh thu hôm nay'), a); assert.equal(n, calls);
});

test('index.js: mọi AI đều đi qua lớp lấy sẵn dữ liệu KiotViet, chỉ cho chủ máy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'src', 'index.js'), 'utf8');
  assert.match(src, /kvctx\.prefix\(a\.job, a\.job\.prompt\)/); assert.match(src, /kvForAi\.allowed\(a\.job\)/);
  assert.match(src, /for \(const e of cfg\.engineOrder\) engines\[e\] = \{ start: \(a\) => \{\s*if \(fbRelease\.fn\) fbRelease\.fn\(\);\s*if \(!KV_ON/);
});

test('câu hỏi phức tạp (danh sách sản phẩm, N ngày) không lấy sẵn doanh thu hôm nay/qua — để AI tự tra', async () => {
  const { build } = require('../../orchestrator/src/kvcontext');
  let called = 0;
  const kv = { configured: () => true, pick: () => [], revenue: async () => { called++; return 'x'; }, stock: async () => { called++; return 'y'; } };
  assert.equal(await build(kv, 'Lọc cho anh danh sách sản phẩm có bán ra trong 15 ngày qua nhưng đang hết hàng tại 3 chi nhánh', Date.now()), '');
  assert.equal(called, 0);
  assert.match(await build(kv, 'doanh thu hôm qua các chi nhánh', Date.now()), /DỮ LIỆU KIOTVIET/);
});

test('build: hỏi theo khoảng ngày + từng ngày thì lấy đúng khoảng đó cho đúng gian (không lấy hôm nay/hôm qua)', async () => {
  const r = await build(kv, 'Cho anh biết doanh thu từng ngày của từng chi nhánh Tulibaby từ 1/11/2026 đến hiện tại', NOW);
  assert.match(r, /^\[DỮ LIỆU KIOTVIET/); assert.match(r, /Doanh số từng ngày từ 01\/11\/2026 đến 05\/11\/2026/);
  assert.match(r, /05\/11: .*Thượng Mỗ 100\.000đ/); assert.match(r, /01\/11: chưa có hóa đơn/); assert.doesNotMatch(r, /Phương Đình/); assert.doesNotMatch(r, /hôm qua/);
});
