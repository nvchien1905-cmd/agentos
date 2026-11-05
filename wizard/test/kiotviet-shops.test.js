'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMultiKiotViet, parseShops } = require('../../orchestrator/src/kiotviet');
const kvLib = require('../lib/kiotviet');

// KiotViet giả: mỗi retailer có hóa đơn riêng; khóa sai = 401
function fakeFetch(data) {
  return async (url, opt) => {
    url = String(url);
    if (url.includes('token')) {
      const id = new URLSearchParams(String(opt.body)).get('client_id');
      return id.startsWith('bad') ? { ok: false, status: 401, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ access_token: 'tk-' + id, expires_in: 3600 }) };
    }
    const shop = opt.headers.Retailer;
    if (url.includes('/branches')) return shop === 'khongco' ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ data: (data[shop] || []).map((x) => ({ branchName: x.branchName })) }) };
    return { ok: true, status: 200, json: async () => ({ data: data[shop] || [], total: (data[shop] || []).length }) };
  };
}
const inv = (id, br, total) => ({ id, branchName: br, total, status: 1, purchaseDate: '2026-11-05T09:00:00' });
const DATA = { tulibaby: [inv(1, 'Cầu Giấy', 100000), inv(2, 'Hà Đông', 50000)], tongkhohuyenanh01: [inv(3, 'Phương Đình', 900000)] };
const SHOPS = [{ name: 'Tulibaby', retailer: 'tulibaby', clientId: 'a1', clientSecret: 's1' }, { name: 'Huyền Anh', retailer: 'tongkhohuyenanh01', clientId: 'a2', clientSecret: 's2' }];
const NOW = Date.UTC(2026, 10, 5, 5);

test('nhiều gian: hỏi có tên gian thì chỉ gian đó; không nêu tên thì hỏi cả hai và ghi rõ từng gian', async () => {
  const kv = createMultiKiotViet(SHOPS, { fetch: fakeFetch(DATA) });
  assert.equal(kv.configured(), true);
  const one = await kv.revenue('doanh thu từng chi nhánh Tulibaby hôm nay', NOW);
  assert.match(one, /🏬 Tulibaby/); assert.match(one, /Cầu Giấy: 1 hóa đơn · 100\.000đ/); assert.doesNotMatch(one, /Huyền Anh|Phương Đình/);
  const all = await kv.revenue('hôm nay', NOW);
  assert.match(all, /🏬 Tulibaby/); assert.match(all, /🏬 Huyền Anh/); assert.match(all, /Phương Đình: 1 hóa đơn · 900\.000đ/);
});

test('nhiều gian: lỗi một gian không làm mất gian kia; rawGet phải nêu gian khi có nhiều', async () => {
  const shops = [{ name: 'Hỏng', retailer: 'hong', clientId: 'bad1', clientSecret: 'x' }, SHOPS[1]];
  const kv = createMultiKiotViet(shops, { fetch: fakeFetch(DATA) });
  const r = await kv.revenue('hôm nay', NOW);
  assert.match(r, /🏬 Hỏng\n⚠️ KiotViet từ chối đăng nhập API/); assert.match(r, /Phương Đình/);
  const kv2 = createMultiKiotViet(SHOPS, { fetch: fakeFetch(DATA) });
  await assert.rejects(() => kv2.rawGet('/invoices'), /phải nói rõ gian nào/);
  assert.deepEqual((await kv2.rawGet('/invoices', 'tulibaby')).total, 2);
  await assert.rejects(() => kv2.rawGet('/invoices', 'xyz'), /Không có gian hàng/);
  assert.deepEqual(kv2.shops().map((s) => s.retailer), ['tulibaby', 'tongkhohuyenanh01']);
});

test('một gian: chạy y như bản cũ (không tiêu đề gian); không có gian: chưa cấu hình', async () => {
  const kv = createMultiKiotViet([SHOPS[1]], { fetch: fakeFetch(DATA) });
  const r = await kv.revenue('hôm nay', NOW);
  assert.doesNotMatch(r, /🏬/); assert.match(r, /Tổng: 1 hóa đơn · 900\.000đ/);
  assert.equal(createMultiKiotViet([], {}).configured(), false);
  assert.match(await createMultiKiotViet([], {}).revenue('hôm nay'), /Chưa cấu hình/);
});

test('parseShops: KIOTVIET_SHOPS + bộ khóa cũ, không trùng, bỏ mục thiếu khóa', () => {
  const env = { KIOTVIET_SHOPS: JSON.stringify([{ name: 'A', retailer: 'a', clientId: '1', clientSecret: '2' }, { retailer: 'thieu' }]), KIOTVIET_CLIENT_ID: 'x', KIOTVIET_CLIENT_SECRET: 'y', KIOTVIET_RETAILER: 'cu' };
  assert.deepEqual(parseShops(env).map((s) => s.retailer), ['cu', 'a']);
  assert.deepEqual(parseShops({ KIOTVIET_SHOPS: 'hỏng', KIOTVIET_CLIENT_ID: 'x', KIOTVIET_CLIENT_SECRET: 'y', KIOTVIET_RETAILER: 'cu' }).map((s) => s.retailer), ['cu']);
  assert.deepEqual(parseShops({}), []);
});

test('Cài đặt KiotViet: thêm gian, gộp bộ khóa cũ, sửa giữ khóa cũ, xóa; khóa được che khi hiển thị', () => {
  let t = 'TELEGRAM_TOKEN=1:abc\nKIOTVIET_CLIENT_ID=oldid_1234567\nKIOTVIET_CLIENT_SECRET=oldsecret_9876\nKIOTVIET_RETAILER=tongkhohuyenanh01\n';
  const a = kvLib.upsert(t, { name: 'Tulibaby', retailer: 'tulibaby', clientId: 'tid-12345678', clientSecret: 'tsecret-98765' });
  t = a.text;
  assert.match(t, /^TELEGRAM_TOKEN=1:abc$/m); assert.doesNotMatch(t, /^KIOTVIET_CLIENT_ID=/m); assert.match(t, /^KIOTVIET_SHOPS=\[/m);
  assert.deepEqual(kvLib.shopsFromEnv(t).map((s) => s.retailer), ['tongkhohuyenanh01', 'tulibaby']);   // bộ cũ được gộp, không mất
  const view = JSON.stringify(kvLib.view(t)); assert.doesNotMatch(view, /tsecret-98765|oldsecret_9876/);
  t = kvLib.upsert(t, { name: 'Tulibaby 2', retailer: 'TULIBABY' }).text;                              // đổi tên, để trống khóa = giữ khóa
  const s = kvLib.shopsFromEnv(t).find((x) => x.retailer === 'TULIBABY' || x.retailer === 'tulibaby');
  assert.equal(s.name, 'Tulibaby 2'); assert.equal(s.clientSecret, 'tsecret-98765');
  assert.equal(kvLib.shopsFromEnv(t).length, 2);
  t = kvLib.remove(t, 'tulibaby'); assert.deepEqual(kvLib.shopsFromEnv(t).map((x) => x.retailer), ['tongkhohuyenanh01']);
  assert.throws(() => kvLib.upsert(t, { retailer: 'x y', clientId: 'a', clientSecret: 'b' }), /Retailer/);
  assert.throws(() => kvLib.upsert(t, { retailer: 'moi', clientId: 'a\nPWNED=1', clientSecret: 'b' }), /không hợp lệ/);
  assert.throws(() => kvLib.upsert(t, { retailer: 'moi', clientId: 'a' }), /Client Secret/);
});

test('kvLib.check: khóa sai, sai Retailer, đúng (liệt kê chi nhánh), lỗi mạng', async () => {
  const f = fakeFetch(DATA);
  assert.match((await kvLib.check({ retailer: 'tulibaby', clientId: 'bad', clientSecret: 'x' }, f)).detail, /không đúng/);
  assert.match((await kvLib.check({ retailer: 'khongco', clientId: 'a', clientSecret: 'x' }, f)).detail, /không khớp/);
  const ok = await kvLib.check({ retailer: 'tulibaby', clientId: 'a1', clientSecret: 's1' }, f);
  assert.equal(ok.ok, true); assert.deepEqual(ok.branches, ['Cầu Giấy', 'Hà Đông']);
  const net = await kvLib.check({ retailer: 'tulibaby', clientId: 'a', clientSecret: 'b' }, async () => { throw new Error('ENOTFOUND'); });
  assert.deepEqual([net.ok, net.network], [false, true]);
  assert.equal((await kvLib.check({ retailer: '', clientId: 'a', clientSecret: 'b' }, f)).ok, false);
});

test('tự chẩn đoán KiotViet: gọi thật từng gian; khóa hỏng của một gian → báo lỗi nêu đúng tên gian', async () => {
  const { createSelfTest } = require('../../orchestrator/src/selftest');
  const good = createMultiKiotViet(SHOPS, { fetch: fakeFetch(DATA) });
  const h = await good.health(NOW);
  assert.deepEqual(h.map((x) => [x.name, x.ok]), [['Tulibaby', true], ['Huyền Anh', true]]);
  assert.match(h[0].detail, /2 chi nhánh, hôm nay 2 hóa đơn/);
  const st = createSelfTest({ kiotviet: good });
  const ok = await st.checks.kiotviet(); assert.equal(ok.status, 'ok');
  const bad = createSelfTest({ kiotviet: createMultiKiotViet([{ name: 'Hỏng', retailer: 'hong', clientId: 'bad1', clientSecret: 'x' }, SHOPS[1]], { fetch: fakeFetch(DATA) }) });
  const r = await bad.checks.kiotviet(); assert.equal(r.status, 'fail'); assert.match(r.detail, /Hỏng LỖI — KiotViet từ chối/); assert.match(r.detail, /Huyền Anh: 1 chi nhánh/);
  assert.equal((await createSelfTest({ kiotviet: createMultiKiotViet([]) }).checks.kiotviet()).status, 'ok');
  assert.ok((await createSelfTest({ kiotviet: good, db: null }).light).toString().length > 0);
});
