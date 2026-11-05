'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { THINK_HINT, kiotvietHint } = require('../src/thinking');
const { checkReadPath, createKiotViet } = require('../src/kiotviet');
const { createGate } = require('../src/gate');
const kvcli = require('../src/kvcli');

test('thinking: nguyên tắc nghĩ trước khi làm nêu đủ ý chính', () => {
  for (const k of ['HIỂU ĐÚNG VIỆC', 'API', 'dry-run', 'sao lưu', 'ĐÚNG PHẠM VI', 'KHÔNG BỊA', 'THẤT BẠI', 'chưa kiểm']) assert.ok(THINK_HINT.includes(k), 'thiếu: ' + k);
});

test('thinking: KiotViet — có khóa thì chỉ lệnh API, không có khóa hoặc AI khác thì cấm bấm web', () => {
  const on = kiotvietHint(true, true);
  assert.match(on, /kvcli\.js/); assert.match(on, /KHÔNG mở trang web KiotViet/); assert.match(on, /KHÔNG ghi được/);
  assert.doesNotMatch(kiotvietHint(false, true), /kvcli\.js/);
  assert.match(kiotvietHint(false, true), /Cài đặt AgentOS → KiotViet/);
  const other = kiotvietHint(true, false);
  assert.doesNotMatch(other, /kvcli\.js/); assert.match(other, /KHÔNG đăng nhập/);
});

test('kiotviet.checkReadPath: chỉ nhóm dữ liệu cho phép, không lách đường dẫn', () => {
  assert.equal(checkReadPath('/invoices?pageSize=20').ok, true);
  assert.equal(checkReadPath('/products/code/SP001').ok, true);
  assert.equal(checkReadPath('/customers?name=an').ok, true);
  for (const bad of ['', 'invoices', '//evil.com/x', '/invoices/../users', '/webhooks', '/retailer', '/invoices x', 'https://x.com/invoices', '/x\\y']) assert.equal(checkReadPath(bad).ok, false, bad);
});

test('kiotviet.rawGet: chỉ gọi GET tới đúng máy chủ KiotViet', async () => {
  const calls = [];
  const f = async (url, opt) => { calls.push({ url: String(url), method: (opt && opt.method) || 'GET' }); return url.includes('token') ? { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) } : { ok: true, status: 200, json: async () => ({ data: [1] }) }; };
  const kv = createKiotViet({ clientId: 'a', clientSecret: 'b', retailer: 'r', fetch: f });
  assert.deepEqual(await kv.rawGet('/invoices?pageSize=1'), { data: [1] });
  assert.ok(calls.some((c) => c.url === 'https://public.kiotapi.com/invoices?pageSize=1' && c.method === 'GET'));
  await assert.rejects(() => kv.rawGet('/webhooks'), /không nằm trong danh sách/);
});

async function withGate(kvOpt, fn) {
  const gate = createGate({ db: { addAudit() {} }, approvals: null, workdir: '/tmp', log() {}, kiotviet: kvOpt });
  const port = await gate.listen(0);
  const url = 'http://127.0.0.1:' + port;
  try { await fn(gate, url); } finally { await gate.close(); }
}
const post = (url, token, body) => fetch(url + '/kiotviet', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': token }, body: JSON.stringify(body) });

test('gate /kiotviet: sai khóa 401; việc không được phép bị từ chối; việc của chủ máy đọc được', async () => {
  const api = { configured: () => true, rawGet: async (p) => ({ echo: p }) };
  await withGate({ api, allowed: (job) => job.chat_id === 'admin' }, async (gate, url) => {
    gate.begin({ id: 1, chat_id: 'admin', lane: 'main' }, {}); gate.begin({ id: 2, chat_id: 'khach', lane: 'main' }, {});
    assert.equal((await post(url, 'sai', { jobId: 1, path: '/invoices' })).status, 401);
    assert.deepEqual(await (await post(url, gate.token, { jobId: 1, path: '/invoices?x=1' })).json(), { ok: true, data: { echo: '/invoices?x=1' } });
    const no = await (await post(url, gate.token, { jobId: 2, path: '/invoices' })).json();
    assert.equal(no.ok, false); assert.match(no.error, /không được phép/);
    const gone = await (await post(url, gate.token, { jobId: 99, path: '/invoices' })).json();
    assert.equal(gone.ok, false);
  });
});

test('gate /kiotviet: chưa cấu hình KiotViet thì báo rõ, lỗi API trả thông báo (không sập)', async () => {
  await withGate({ api: { configured: () => false }, allowed: () => true }, async (gate, url) => {
    gate.begin({ id: 1, chat_id: 'a' }, {});
    assert.match((await (await post(url, gate.token, { jobId: 1, path: '/invoices' })).json()).error, /Chưa cấu hình/);
  });
  await withGate({ api: { configured: () => true, rawGet: async () => { throw new Error('KiotViet lỗi 500'); } }, allowed: () => true }, async (gate, url) => {
    gate.begin({ id: 1, chat_id: 'a' }, {});
    assert.match((await (await post(url, gate.token, { jobId: 1, path: '/invoices' })).json()).error, /500/);
  });
});

test('kvcli: gọi qua cổng nội bộ bằng biến môi trường của việc, in kết quả JSON', async () => {
  const api = { configured: () => true, rawGet: async (p) => ({ p }) };
  await withGate({ api, allowed: () => true }, async (gate, url) => {
    gate.begin({ id: 7, chat_id: 'a' }, {});
    const keep = Object.assign({}, process.env);
    Object.assign(process.env, { AGENTOS_GATE_URL: url, AGENTOS_GATE_TOKEN: gate.token, AGENTOS_JOB_ID: '7' });
    const lines = []; const log = console.log; console.log = (s) => lines.push(String(s));
    try { assert.equal(await kvcli.main(['ton', 'nồi', 'chiên']), 0); assert.equal(await kvcli.main(['get', '/branches']), 0); assert.equal(await kvcli.main([]), 2); }
    finally { console.log = log; for (const k of ['AGENTOS_GATE_URL', 'AGENTOS_GATE_TOKEN', 'AGENTOS_JOB_ID']) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
    assert.match(lines[0], /products\?name=n%E1%BB%93i\+chi%C3%AAn&includeInventory=true/);
    assert.equal(lines[1], '{"p":"/branches"}');
  });
});

test('index.js: mọi AI đều nhận chỉ dẫn tư duy; gate được truyền KiotViet', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.ok((src.match(/THINK_HINT/g) || []).length >= 4);
  assert.match(src, /kiotviet: kvForAi/); assert.match(src, /kvForAi\.api = kiotviet/);
  assert.doesNotMatch(src, /\bFULL_HINT\b/);
});

// ---------- hỏi doanh số bằng câu thường (không qua AI) ----------
const { createQuick } = require('../src/quick');
const { splitRevenueQuery } = require('../src/kiotviet');

test('splitRevenueQuery: tách khoảng thời gian và tên chi nhánh trong câu thường', () => {
  assert.deepEqual(splitRevenueQuery('em kiểm tra và báo cáo cho anh doanh thu của từng chi nhánh Tulibaby ngày hôm nay'), { range: 'hom nay', filter: 'tulibaby' });
  assert.deepEqual(splitRevenueQuery('hôm qua'), { range: 'hom qua', filter: '' });
  assert.deepEqual(splitRevenueQuery(''), { range: '', filter: '' });
  assert.equal(splitRevenueQuery('năm ngoái').range, 'nam ngoai');
});

test('quick.match: câu hỏi doanh thu/tồn kho đi thẳng API, việc khác vẫn về AI', () => {
  const q = createQuick({});
  const a = q.match('Em kiểm tra và báo cáo cho anh doanh thu của từng chi nhánh Tulibaby ngày hôm nay');
  assert.equal(a.name, 'doanhso'); assert.equal(a.soft, true);
  assert.deepEqual([q.match('tồn kho nồi chiên').name, q.match('tồn kho nồi chiên').arg], ['ton', 'nồi chiên']);
  assert.equal(q.match('kiểm tra tồn kho'), null);
  assert.equal(q.match('xóa file doanh thu cũ'), null);
  assert.equal(q.match('/doanhso hôm nay'), null);          // đã là lệnh
  assert.equal(q.match('hôm nay trời đẹp'), null);
  assert.ok(q.has('doanhso') && q.has('ton') && q.has('hanghoa'));
});

test('/doanhso lọc theo tên chi nhánh; chưa cấu hình thì chỉ cách khai khóa', async () => {
  const inv = (id, br, total) => ({ id, branchName: br, total, status: 1, purchaseDate: '2026-11-05T09:00:00' });
  const data = [inv(1, 'Tulibaby Phương Đình', 100000), inv(2, 'Tulibaby Hồng Hà', 50000), inv(3, 'Huyền Anh Sơn Đồng', 900000)];
  const f = async (u) => (String(u).includes('token') ? { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) } : { ok: true, status: 200, json: async () => ({ data, total: data.length }) });
  const kv = createKiotViet({ clientId: 'a', clientSecret: 'b', retailer: 'r', fetch: f });
  const now = Date.UTC(2026, 10, 5, 5);
  const r = await kv.revenue('doanh thu từng chi nhánh Tulibaby hôm nay', now);
  assert.match(r, /Tulibaby Phương Đình: 1 hóa đơn · 100\.000đ/); assert.match(r, /Tổng: 2 hóa đơn · 150\.000đ/); assert.doesNotMatch(r, /Huyền Anh/);
  assert.match(await kv.revenue('hôm nay mamakids', now), /không có hóa đơn nào ở chi nhánh khớp "mamakids".*Huyền Anh Sơn Đồng/);
  const q = createQuick({ kiotviet: createKiotViet({}) });
  assert.match(await q.run('doanhso', 'hôm nay'), /Chưa cấu hình KiotViet/);
});
