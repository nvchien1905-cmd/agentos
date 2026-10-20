'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { createQuick, appKey } = require('../src/quick');
const { createKiotViet, parseRange, noAccent } = require('../src/kiotviet');
const { openDb } = require('../src/db');
const { createWorker } = require('../src/worker');
const { createBot } = require('../src/bot');

const fakeDesk = (handler) => { const calls = []; return { calls, call: async (req) => { calls.push(req); return handler(req); } }; };
const ok = (extra) => Object.assign({ ok: true }, extra || {});

// ---------- lệnh nhanh ----------

test('quick: /manhinh trả ảnh (xóa sau khi gửi), lỗi từ trợ lý màn hình hiện rõ', async () => {
  const d = fakeDesk((r) => (r.cmd === 'screenshot' ? ok({ file: '/run/agentos/manhinh-1.png' }) : ok()));
  const q = createQuick({ desk: d });
  const r = await q.run('manhinh', '');
  assert.match(r.text, /Màn hình máy lúc \d\d:\d\d/);
  assert.deepEqual(r.files, [{ path: '/run/agentos/manhinh-1.png', name: 'manhinh.png', kind: 'photo', temp: true }]);
  const bad = createQuick({ desk: fakeDesk(() => ({ ok: false, error: 'Không có ai đang đăng nhập màn hình chính' })) });
  assert.equal(await bad.run('manhinh', ''), '⚠️ Không có ai đang đăng nhập màn hình chính');
});

test('quick: /mo, /dong hiểu tên gọi tiếng Việt, không đoán bừa; thiếu tên thì hướng dẫn', async () => {
  assert.deepEqual(['Kiot', 'Trình duyệt', 'Zalo', 'KiotViet', 'điều khiển từ xa', 'Deep Seek'].map(appKey), ['kiotviet', 'chrome', 'zalo', 'kiotviet', 'rustdesk', 'deepseek']);
  const d = fakeDesk((r) => (r.cmd === 'open' ? ok({ app: 'KiotViet' }) : ok({ app: 'Zalo', closed: 0 })));
  const q = createQuick({ desk: d });
  assert.match(await q.run('mo', 'Kiot'), /Đã mở KiotViet/);
  assert.deepEqual(d.calls[0], { cmd: 'open', app: 'kiotviet' });
  assert.match(await q.run('dong', 'zalo'), /Zalo đang không mở/);
  assert.match(await q.run('mo', ''), /Cách dùng: \/mo/);
  assert.equal(d.calls.length, 2);                                  // thiếu tên: không gọi trợ lý màn hình
});

test('quick: /khoimay và /tatmay phải có chữ "co" xác nhận mới thực hiện; /khoamay khóa màn hình', async () => {
  const d = fakeDesk((r) => ok({ after: 6 }));
  const q = createQuick({ desk: d });
  assert.match(await q.run('tatmay', ''), /Gõ \/tatmay co để xác nhận/);
  assert.match(await q.run('khoimay', 'có hay không'), /Gõ \/khoimay co/);
  assert.equal(d.calls.length, 0);
  assert.match(await q.run('khoimay', 'co'), /khởi động lại sau 6 giây/); assert.equal(d.calls[0].cmd, 'reboot');
  assert.match(await q.run('tatmay', 'Có'), /tắt sau 6 giây/); assert.equal(d.calls[1].cmd, 'poweroff');
  assert.match(await q.run('khoamay', ''), /Đã khóa màn hình/); assert.equal(d.calls[2].cmd, 'lock');
});

test('quick: /deepseek chép câu lệnh rồi mở DeepSeek web; KHÔNG tự gõ/gửi; lỗi chép thì không mở', async () => {
  const d = fakeDesk(() => ok({ app: 'DeepSeek' }));
  const q = createQuick({ desk: d });
  const r = await q.run('deepseek', 'Viết mô tả cho nồi chiên không dầu 6L');
  assert.match(r, /Ctrl\+V/); assert.match(r, /bước Gửi do anh làm/);
  assert.deepEqual(d.calls, [{ cmd: 'clip', text: 'Viết mô tả cho nồi chiên không dầu 6L' }, { cmd: 'open', app: 'deepseek' }]);
  assert.ok(!d.calls.some((c) => c.cmd === 'type' || c.cmd === 'key' || c.cmd === 'click'), 'không tự thao tác vào trang DeepSeek');
  assert.match(await q.run('deepseek', ''), /Cách dùng/);
  const d2 = fakeDesk((r2) => (r2.cmd === 'clip' ? { ok: false, error: 'xclip lỗi' } : ok()));
  assert.match(await createQuick({ desk: d2 }).run('deepseek', 'hỏi gì đó'), /xclip lỗi/);
  assert.deepEqual(d2.calls.map((c) => c.cmd), ['clip']);
});

test('quick: KiotViet chưa cấu hình thì hướng dẫn thêm khóa; lỗi bất ngờ không làm sập', async () => {
  const q = createQuick({ desk: fakeDesk(() => ok()), kiotviet: createKiotViet({}) });
  assert.match(await q.run('doanhso', ''), /Chưa cấu hình KiotViet/);
  const boom = createQuick({ desk: { call: async () => { throw new Error('hỏng'); } } });
  assert.match(await boom.run('manhinh', ''), /Lỗi: hỏng/);
});

// ---------- KiotViet ----------

test('kiotviet: hiểu khoảng thời gian tiếng Việt có dấu và không dấu, theo giờ Việt Nam', () => {
  const t = Date.UTC(2026, 9, 20, 20, 30);                  // 20/10 20:30 UTC = 21/10 03:30 giờ VN (Thứ Tư)
  assert.deepEqual([parseRange('', t).from, parseRange('', t).to], ['2026-10-21', '2026-10-22']);
  assert.equal(parseRange('hôm qua', t).from, '2026-10-20');
  assert.equal(parseRange('Hom Qua', t).from, '2026-10-20');
  assert.equal(parseRange('tuần', t).from, '2026-10-19');   // Thứ Hai đầu tuần
  assert.equal(parseRange('tháng', t).from, '2026-10-01');
  assert.equal(parseRange('năm ngoái', t), null);
  assert.equal(noAccent('Nồi CHIÊN Đa năng'), 'noi chien da nang');
});

function fakeKv(routes) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push([String(url), opts]);
    for (const [re, fn] of routes) if (re.test(String(url))) return fn(String(url), opts);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.calls = calls;
  return f;
}
const tokenRoute = [/connect\/token/, () => ({ ok: true, status: 200, json: async () => ({ access_token: 'T', expires_in: 3600 }) })];

test('kiotviet: /doanhso cộng hóa đơn hoàn thành theo chi nhánh, bỏ hóa đơn hủy và ngoài khoảng ngày, chỉ đọc', async () => {
  const t = Date.UTC(2026, 9, 20, 5, 0);                    // 20/10 12:00 giờ VN
  const f = fakeKv([tokenRoute, [/\/invoices\?/, () => ({ ok: true, status: 200, json: async () => ({ total: 5, data: [
    { purchaseDate: '2026-10-20T09:00:00', status: 1, total: 1500000, branchName: 'Phương Đình' },
    { purchaseDate: '2026-10-20T10:00:00', status: 1, total: 500000, branchName: 'Phương Đình' },
    { purchaseDate: '2026-10-20T11:00:00', status: 1, total: 2000000, branchName: 'Hồng Hà' },
    { purchaseDate: '2026-10-20T11:30:00', status: 2, total: 999999, branchName: 'Hồng Hà' },
    { purchaseDate: '2026-10-21T00:10:00', status: 1, total: 777777, branchName: 'Hồng Hà' },
  ] }) })]]);
  const kv = createKiotViet({ clientId: 'i', clientSecret: 's', retailer: 'shop', fetch: f });
  const r = await kv.revenue('hôm nay', t);
  assert.match(r, /Doanh số hôm nay \(20\/10\/2026\)/);
  assert.match(r, /• Phương Đình: 2 hóa đơn · 2\.000\.000đ/); assert.match(r, /• Hồng Hà: 1 hóa đơn · 2\.000\.000đ/);
  assert.match(r, /Tổng: 3 hóa đơn · 4\.000\.000đ/); assert.match(r, /không tính 1 hóa đơn hủy/);
  const inv = f.calls.find((c) => /\/invoices\?/.test(c[0]));
  assert.match(inv[0], /fromPurchaseDate=2026-10-20/); assert.match(inv[0], /toPurchaseDate=2026-10-21/);
  assert.equal(inv[1].headers.Retailer, 'shop'); assert.equal(inv[1].headers.Authorization, 'Bearer T');
  assert.ok(f.calls.every((c) => !c[1] || !c[1].method || c[1].method === 'POST' && /connect\/token/.test(c[0])), 'chỉ đọc (GET), trừ lấy token');
  assert.match(await kv.revenue('năm ngoái', t), /không hiểu được/);
});

test('kiotviet: /doanhso phân trang, không có hóa đơn thì báo; token hết hạn (401) tự lấy lại; sai khóa báo rõ', async () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ purchaseDate: '2026-10-20T08:00:00', status: 1, total: 1000, branchName: 'A', i }));
  let page = 0;
  const f = fakeKv([tokenRoute, [/\/invoices\?/, () => { page++; return { ok: true, status: 200, json: async () => ({ total: 130, data: page === 1 ? mk(100) : mk(30) }) }; }]]);
  const kv = createKiotViet({ clientId: 'i', clientSecret: 's', retailer: 'shop', fetch: f });
  assert.match(await kv.revenue('', Date.UTC(2026, 9, 20, 5)), /Tổng: 130 hóa đơn · 130\.000đ/);
  const none = createKiotViet({ clientId: 'i', clientSecret: 's', retailer: 'shop', fetch: fakeKv([tokenRoute, [/\/invoices\?/, () => ({ ok: true, status: 200, json: async () => ({ total: 0, data: [] }) })]]) });
  assert.match(await none.revenue('', Date.UTC(2026, 9, 20, 5)), /chưa có hóa đơn hoàn thành nào/);
  let first = true;
  const f401 = fakeKv([tokenRoute, [/\/invoices\?/, () => { if (first) { first = false; return { ok: false, status: 401, json: async () => ({}) }; } return { ok: true, status: 200, json: async () => ({ total: 0, data: [] }) }; }]]);
  await createKiotViet({ clientId: 'i', clientSecret: 's', retailer: 'shop', fetch: f401 }).revenue('', Date.UTC(2026, 9, 20, 5));
  assert.equal(f401.calls.filter((c) => /connect\/token/.test(c[0])).length, 2);      // lấy token lại sau 401
  const badKey = createKiotViet({ clientId: 'x', clientSecret: 'y', retailer: 'shop', fetch: fakeKv([[/connect\/token/, () => ({ ok: false, status: 400, json: async () => ({}) })]]) });
  await assert.rejects(() => badKey.revenue('', Date.UTC(2026, 9, 20, 5)), /từ chối đăng nhập API/);
});

test('kiotviet: /ton tìm theo tên hoặc mã, hiện tồn từng chi nhánh', async () => {
  const f = fakeKv([tokenRoute, [/\/products\?/, (u) => ({ ok: true, status: 200, json: async () => (/name=n%E1%BB%93i/i.test(u) || /n%E1%BB%93i/.test(u) ? { total: 1, data: [
    { name: 'Nồi chiên không dầu 6L', code: 'SP001', basePrice: 1290000, inventories: [{ branchName: 'Phương Đình', onHand: 3 }, { branchName: 'Hồng Hà', onHand: 0 }, { branchName: 'Kho Tổng', onHand: 12 }] }] } : { total: 0, data: [] }) })]]);
  const kv = createKiotViet({ clientId: 'i', clientSecret: 's', retailer: 'shop', fetch: f });
  const r = await kv.stock('nồi');
  assert.match(r, /Nồi chiên không dầu 6L \(SP001\) · giá 1\.290\.000đ/); assert.match(r, /Phương Đình: 3 · Kho Tổng: 12 → tổng 15/);
  assert.doesNotMatch(r, /Hồng Hà/);                                             // chi nhánh hết hàng không liệt kê
  assert.match(await kv.stock('x'), /Cách dùng/);
  assert.match(await kv.stock('không-có-hàng-này-xyz'), /Không thấy sản phẩm nào khớp/);
});

// ---------- bot ----------

function botWith(quick, admins) {
  const db = openDb(':memory:');
  const worker = createWorker({ db, engines: { claude: { start: () => { throw new Error('không chạy'); } } }, order: ['claude'], notify: async () => {} });
  const adm = new Set(admins || ['1']);
  const bot = createBot({ db, worker, allowed: new Set(['1', '2']), isAdmin: (u) => adm.has(String(u)), quick });
  const m = (text, uid) => ({ from: { id: uid || 1 }, chat: { id: uid || 1, type: 'private' }, text });
  return { bot, m };
}

test('bot: lệnh nhanh chỉ quản trị viên, trả Promise; không phải admin bị từ chối và KHÔNG chạy gì; /help có liệt kê lệnh nhanh', async () => {
  const d = fakeDesk(() => ok({ file: '/run/agentos/x.png' }));
  const { bot, m } = botWith(createQuick({ desk: d }));
  const r = bot.handle(m('/manhinh'));
  assert.equal(typeof r.then, 'function');
  assert.ok((await r).files);
  assert.match(bot.handle(m('/manhinh', 2)), /chỉ dành cho quản trị viên/);
  assert.match(bot.handle(m('/tatmay co', 2)), /chỉ dành cho quản trị viên/);
  assert.equal(d.calls.length, 1);                                             // người thứ hai không gây ra lệnh nào
  const help = bot.handle(m('/help'));
  for (const w of ['/manhinh', '/mo', '/deepseek', '/doanhso', '/ton']) assert.ok(help.includes(w), w);
  assert.equal(bot.handle({ from: { id: 99 }, chat: { id: 99, type: 'private' }, text: '/manhinh' }), null);   // người lạ: im lặng
});
