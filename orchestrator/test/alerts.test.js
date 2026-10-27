'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createAlerts, addDays } = require('../src/alerts');

// 2026-10-27 là Thứ Ba
const at = (date, hm) => Date.parse(date + 'T' + hm + ':00+07:00');
function inv(date, hm, total, status) { return { id: Math.random(), total, status: status === undefined ? 1 : status, purchaseDate: date + 'T' + hm + ':00.0000000' }; }
function mk(invoices, extra) {
  const db = openDb(':memory:'), sent = []; let t = at('2026-10-27', '15:05');
  const kv = Object.assign({ configured: () => true, invoiceTotals: async () => invoices, lowStock: async () => ({ total: 0, items: [] }) }, extra || {});
  const A = createAlerts({ kiotviet: kv, db, notify: async (c, text) => { sent.push([c, text]); }, admins: ['111'], now: () => t });
  return { A, db, sent, setNow: (x) => { t = x; } };
}
const weeksOf6M = () => [7, 14, 21, 28].flatMap((n) => { const d = addDays('2026-10-27', -n); return [inv(d, '10:00', 4000000), inv(d, '14:30', 2000000), inv(d, '16:00', 3000000)]; });

test('cảnh báo doanh số: hôm nay thấp hơn nhiều so với TB 4 tuần cùng thứ cùng giờ -> báo một lần mỗi mốc; hóa đơn sau giờ/đã hủy không tính', async () => {
  const today = [inv('2026-10-27', '10:00', 1000000), inv('2026-10-27', '14:00', 500000), inv('2026-10-27', '14:10', 9000000, 2), inv('2026-10-27', '15:30', 8000000)];   // đến 15:05: 1,5 triệu (hóa đơn hủy + sau giờ bỏ)
  const { A, sent, setNow } = mk(weeksOf6M().concat(today));
  const r = await A.checkSales(); assert.equal(r.alerted, true);
  assert.equal(sent.length, 1); assert.equal(sent[0][0], '111'); assert.match(sent[0][1], /đến 15:05 mới 1,5 triệu \(2 hóa đơn\), thấp hơn 75% so với trung bình 4 tuần cùng thứ \(6,0 triệu\)/);
  assert.equal(await A.checkSales(), null, 'cùng mốc 15h không báo lại'); assert.equal(sent.length, 1);
  setNow(at('2026-10-27', '19:10')); const r2 = await A.checkSales(); assert.ok(r2, 'mốc 19h được kiểm tra riêng');
});

test('cảnh báo doanh số: đủ doanh số thì im lặng; thiếu dữ liệu nền hoặc nền quá nhỏ thì không báo; ngoài giờ kiểm tra thì bỏ qua', async () => {
  const ok = [inv('2026-10-27', '10:00', 5000000)];
  const A1 = mk(weeksOf6M().concat(ok)); const r = await A1.A.checkSales(); assert.equal(r.alerted, false); assert.equal(A1.sent.length, 0);
  const A2 = mk([inv(addDays('2026-10-27', -7), '10:00', 6000000)]); assert.equal((await A2.A.checkSales()).alerted, false, 'chỉ 1 tuần nền: không đủ');
  const small = [7, 14, 21].map((n) => inv(addDays('2026-10-27', -n), '10:00', 300000)); const A3 = mk(small); assert.equal((await A3.A.checkSales()).alerted, false, 'nền dưới 1 triệu: không báo');
  const A4 = mk(weeksOf6M()); A4.setNow(at('2026-10-27', '12:00')); assert.equal(await A4.A.checkSales(), null, '12h chưa tới mốc nào');
  A4.setNow(at('2026-10-27', '18:30')); assert.equal(await A4.A.checkSales(), null, 'quá 3 giờ sau mốc 15h và chưa tới 19h: bỏ qua');
});

test('cảnh báo hàng mới sắp hết: báo mặt hàng MỚI, không báo lặp, nhắc lại sau 7 ngày; hết rồi đủ lại rồi hết lại thì báo mới', async () => {
  let items = [{ name: 'Nồi A', code: 'A1', onHand: 1, min: 5 }];
  const { A, sent, setNow } = mk([], { lowStock: async () => ({ total: items.length, items }) });
  let r = await A.checkLowStock(); assert.equal(r.alerted, true); assert.match(sent[0][1], /1 mặt hàng MỚI[\s\S]*Nồi A \(A1\): còn 1 \/ tối thiểu 5/);
  assert.equal(await A.checkLowStock(), null, 'chưa tới 2 giờ');
  setNow(at('2026-10-27', '17:30')); assert.equal((await A.checkLowStock()).alerted, false, 'đã báo rồi, không lặp');
  items = [{ name: 'Nồi A', code: 'A1', onHand: 1, min: 5 }, { name: 'Bếp B', code: 'B2', onHand: 0, min: 3 }]; setNow(at('2026-10-27', '20:00'));
  r = await A.checkLowStock(); assert.equal(r.alerted, true); assert.deepEqual(r.fresh.map((x) => x.code), ['B2']);
  items = []; setNow(at('2026-10-27', '23:00')); await A.checkLowStock();
  items = [{ name: 'Nồi A', code: 'A1', onHand: 0, min: 5 }]; setNow(at('2026-10-28', '02:00')); r = await A.checkLowStock(); assert.equal(r.alerted, true, 'đủ hàng rồi hết lại: báo mới');
  items = [{ name: 'Nồi A', code: 'A1', onHand: 0, min: 5 }]; setNow(at('2026-11-06', '02:00')); r = await A.checkLowStock(); assert.equal(r.alerted, true, 'còn thiếu quá 7 ngày: nhắc lại');
});

test('/canhbao: xem, bật/tắt từng loại (tắt thì không chạy), đổi ngưỡng, kiểm tra ngay không gửi cảnh báo', async () => {
  const today = [inv('2026-10-27', '10:00', 1000000)];
  const { A, sent } = mk(weeksOf6M().concat(today));
  assert.match(await A.command(''), /Doanh số tụt: BẬT.*15h, 19h, 21h.*50%/s);
  assert.match(await A.command('doanhso 30'), /dưới 30%/); assert.match(await A.command('doanhso 5'), /Ngưỡng từ 10 đến 90/);
  assert.match(await A.command('kiemtra'), /hôm nay 1,0 triệu \(1 hóa đơn\) · trung bình 4 tuần cùng thứ 6,0 triệu · 17% \(báo khi dưới 30%\)/); assert.equal(sent.length, 0, 'kiểm tra ngay không gửi cảnh báo');
  assert.match(await A.command('doanhso tat'), /tắt/); assert.equal(await A.checkSales(), null);
  assert.match(await A.command('tonkho tat'), /tắt/); assert.equal(await A.checkLowStock(), null);
  assert.match(await A.command('doanhso bat'), /BẬT/);
  const none = mk([], { configured: () => false }); assert.match(await none.A.command('kiemtra'), /Chưa nối KiotViet/);
});
