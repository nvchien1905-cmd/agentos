'use strict';
// Cài đặt → KiotViet: chủ máy TÍCH bot nào được dùng khóa API của từng gian hàng. Tích cho bot nào thì bot đó có khóa (cấu hình riêng, chỉ root đọc) và dùng được API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const kv = require('../lib/kiotviet');
const { createSettings } = require('../settings/server');
const config = require('../../orchestrator/src/config');
const agentctl = require('../../orchestrator/src/agentctl');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kvb-'));
const SHOP = (r, extra) => Object.assign({ name: r.toUpperCase(), retailer: r, clientId: 'id-' + r + '-0123456789', clientSecret: 'sec-' + r + '-0123456789' }, extra || {});
const ENV0 = 'TELEGRAM_TOKEN=123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw\nALLOWED_USER_IDS=5\nADMIN_USER_IDS=5\n';

test('thư viện: gian cũ (chưa tích) = chỉ bot quản lý; tích bot nào lưu đúng bot đó; khóa không lộ ra màn hình; lưu/sửa/xóa gian giữ nguyên quyền', () => {
  let text = ENV0;
  text = kv.upsert(text, SHOP('tulibaby')).text; text = kv.upsert(text, SHOP('huyenanh')).text;
  assert.deepEqual(kv.view(text).map((s) => [s.retailer, s.bots]), [['tulibaby', ['main']], ['huyenanh', ['main']]]);
  assert.ok(!/"bots"/.test(text), 'gian chưa tích không ghi trường bots (tương thích bản cũ)');
  const r = kv.setBots(text, 'HuyenAnh', ['main', 'a1', 'a2', 'khong-hop-le', 'a1']);
  assert.deepEqual(r.before, ['main']); assert.deepEqual(r.after, ['main', 'a1', 'a2']);
  text = r.text; assert.deepEqual(kv.view(text).find((s) => s.retailer === 'huyenanh').bots, ['main', 'a1', 'a2']); assert.deepEqual(kv.view(text).find((s) => s.retailer === 'tulibaby').bots, ['main']);
  assert.ok(!JSON.stringify(kv.view(text)).includes('sec-huyenanh-0123456789'), 'khóa bí mật chỉ hiện dạng che');
  // sửa gian không nói gì về bot: giữ quyền đã tích; gửi bots mới: đổi theo
  text = kv.upsert(text, { retailer: 'huyenanh', name: 'Tên mới', clientId: '', clientSecret: '' }).text;
  assert.deepEqual(kv.view(text).find((s) => s.retailer === 'huyenanh').bots, ['main', 'a1', 'a2']); assert.equal(kv.view(text).find((s) => s.retailer === 'huyenanh').name, 'Tên mới');
  text = kv.upsert(text, { retailer: 'huyenanh', bots: ['a2'] }).text; assert.deepEqual(kv.view(text).find((s) => s.retailer === 'huyenanh').bots, ['a2']);
  // bỏ tích hết: không bot nào dùng được (kể cả bot quản lý) — khác với "chưa tích"
  text = kv.setBots(text, 'huyenanh', []).text; assert.deepEqual(kv.view(text).find((s) => s.retailer === 'huyenanh').bots, []);
  assert.throws(() => kv.setBots(text, 'khong-co', ['main']), /Không có gian hàng/); assert.throws(() => kv.setBots(text, 'huyenanh', 'main'), /không hợp lệ/);
  assert.equal(kv.view(kv.remove(text, 'huyenanh')).length, 1);
});

test('bộ điều phối: mỗi bot chỉ nạp gian hàng được tích cho nó (bot quản lý mặc định có mọi gian chưa tích)', () => {
  const shops = JSON.stringify([SHOP('a'), SHOP('b', { bots: ['a1', 'main'] }), SHOP('c', { bots: ['a2'] }), SHOP('d', { bots: [] })]);
  const f = (extra) => config.load(Object.assign({ TELEGRAM_TOKEN: 't', ALLOWED_USER_IDS: '1', KIOTVIET_SHOPS: shops }, extra)).kiotviet.shops.map((s) => s.retailer).join(',');
  assert.equal(f({}), 'a,b'); assert.equal(f({ AGENT_ID: 'a1' }), 'b'); assert.equal(f({ AGENT_ID: 'a2' }), 'c'); assert.equal(f({ AGENT_ID: 'a3' }), '');
  const legacy = config.load({ TELEGRAM_TOKEN: 't', ALLOWED_USER_IDS: '1', KIOTVIET_CLIENT_ID: 'i', KIOTVIET_CLIENT_SECRET: 's', KIOTVIET_RETAILER: 'cu' });
  assert.deepEqual(legacy.kiotviet.shops.map((s) => s.retailer), ['cu']);
  assert.deepEqual(config.load({ TELEGRAM_TOKEN: 't', ALLOWED_USER_IDS: '1', AGENT_ID: 'a1', KIOTVIET_CLIENT_ID: 'i', KIOTVIET_CLIENT_SECRET: 's', KIOTVIET_RETAILER: 'cu' }).kiotviet.shops, [], 'bộ khóa cũ không tự chia cho bot phụ');
});

test('cấu hình riêng của bot phụ: chỉ có khóa các gian được tích cho nó, không lộ khóa gian khác', () => {
  const main = 'TELEGRAM_TOKEN=1\nKIOTVIET_SHOPS=' + JSON.stringify([SHOP('a'), SHOP('b', { bots: ['a1', 'main'] }), SHOP('c', { bots: ['a2'] })]) + '\n';
  const meta = { name: 'Bán hàng', owners: ['5'], settings: {} };
  const e1 = agentctl.envText('a1', meta, '999999999:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', main).text;
  const m1 = /^KIOTVIET_SHOPS=(.*)$/m.exec(e1); assert.ok(m1, 'a1 có gian được tích');
  assert.deepEqual(JSON.parse(m1[1]).map((s) => s.retailer), ['b']); assert.ok(!e1.includes('sec-a-') && !e1.includes('sec-c-'));
  assert.equal(config.load(agentctl.parseEnv(e1)).kiotviet.shops.length, 1);
  assert.ok(!/KIOTVIET/.test(agentctl.envText('a3', meta, '999999999:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', main).text), 'bot chưa được tích thì không có khóa nào');
  assert.ok(!/KIOTVIET/.test(agentctl.envText('a1', meta, '999999999:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 'TELEGRAM_TOKEN=1\nKIOTVIET_SHOPS={hỏng').text), 'cấu hình hỏng không làm hỏng việc tạo bot');
});

// ---- qua máy chủ Cài đặt ----
async function boot() {
  const dir = tmp(), calls = [], reqs = [], st = { fail: false };
  const envFile = path.join(dir, 'orchestrator.env'); fs.writeFileSync(envFile, ENV0); fs.writeFileSync(path.join(dir, 'VERSION'), '1\n');
  const apiFetch = async (url) => {
    if (/api\.telegram\.org/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 9, username: 'ban_hang_bot', first_name: 'Bán hàng' } }) };
    if (/id\.kiotviet\.vn/.test(url)) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
    if (/kiotapi\.com\/branches/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ branchName: 'Chi nhánh 1' }] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const run = async (cmd, args) => { calls.push([cmd].concat(args).join(' ')); return { code: 0, out: 'active\n', err: '' }; };
  const spawn = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; setImmediate(() => c.emit('close', 0)); return c; };
  const s = createSettings({ port: 0, host: '127.0.0.1', envFile, versionFile: path.join(dir, 'VERSION'), backupDir: path.join(dir, 'bk'), onedriveConf: path.join(dir, 'od'), onedriveDir: path.join(dir, 'odir'), memFallback: path.join(dir, 'so-tay'),
    run, spawn, fetch: apiFetch, peerUid: () => 1000, allowedUids: () => new Set([1000, 0]), pageFile: path.join(__dirname, '..', 'settings', 'index.html'), exit: () => {}, sleep: () => new Promise((r) => setTimeout(r, 1)),
    agentCtl: { handle: async (req) => { reqs.push(req); if (req.action === 'update' && st.fail) return { ok: false, error: 'dịch vụ lỗi' }; return { ok: true, msg: 'ok' }; } }, agentsFile: path.join(dir, 'agents.json'), agentShow: async () => ({ ActiveState: 'active' }) });
  const port = await s.listen();
  const call = async (method, p, body) => { const r = await fetch('http://127.0.0.1:' + port + '/api/' + p, { method, headers: { 'content-type': 'application/json', 'x-agentos-settings': '1' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* html */ } return { status: r.status, body: j, text }; };
  return { s, call, calls, reqs, st, env: () => fs.readFileSync(envFile, 'utf8') };
}

test('Cài đặt: danh sách bot để tích; lưu quyền → bot được thêm/bớt khởi động lại với cấu hình mới, bot quản lý chỉ khởi động lại khi chính nó đổi quyền; bot lạ bị từ chối', async () => {
  const S = await boot();
  try {
    let r = await S.call('POST', 'bots/agent/add', { token: '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', name: 'Bán hàng' }); assert.equal(r.status, 200, r.text);
    r = await S.call('POST', 'kiotviet/save', { name: 'Huyền Anh', retailer: 'huyenanh', clientId: 'cid-0123456789', clientSecret: 'csec-0123456789' }); assert.equal(r.status, 200, r.text); assert.deepEqual(r.body.warn, []);
    r = await S.call('GET', 'kiotviet'); assert.deepEqual(r.body.bots.map((b) => b.key), ['main', 'a1']); assert.equal(r.body.bots[1].name, 'Bán hàng'); assert.deepEqual(r.body.shops[0].bots, ['main']);
    assert.ok(!r.text.includes('csec-0123456789'), 'khóa bí mật không bao giờ trả ra trang');
    S.reqs.length = 0; S.calls.length = 0;
    r = await S.call('POST', 'kiotviet/bots', { retailer: 'huyenanh', bots: ['main', 'a1'] }); assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.bots, ['main', 'a1']); assert.deepEqual(r.body.changed, ['a1']); assert.deepEqual(r.body.warn, []);
    assert.deepEqual(S.reqs.map((q) => [q.action, q.id]), [['update', 'a1']], 'chỉ bot a1 được cập nhật');
    assert.ok(!S.calls.some((c) => /restart agentos-orchestrator/.test(c)), 'bot quản lý không đổi quyền thì không khởi động lại');
    assert.match(S.env(), /"bots":\["main","a1"\]/);
    // bỏ tích bot quản lý, giữ a1: bot quản lý khởi động lại
    S.reqs.length = 0; r = await S.call('POST', 'kiotviet/bots', { retailer: 'huyenanh', bots: ['a1'] }); assert.deepEqual(r.body.changed, ['main']); assert.equal(S.reqs.length, 0);
    assert.ok(S.calls.some((c) => /restart agentos-orchestrator/.test(c)));
    // tích lại giống cũ: không đổi gì
    r = await S.call('POST', 'kiotviet/bots', { retailer: 'huyenanh', bots: ['a1'] }); assert.deepEqual(r.body.changed, []);
    // từ chối: bot lạ, gian lạ, không phải mảng
    assert.equal((await S.call('POST', 'kiotviet/bots', { retailer: 'huyenanh', bots: ['a7'] })).status >= 400, true);
    assert.equal((await S.call('POST', 'kiotviet/bots', { retailer: 'khong-co', bots: ['main'] })).status >= 400, true);
    assert.equal((await S.call('POST', 'kiotviet/bots', { retailer: 'huyenanh', bots: 'main' })).body.bots.length, 0);        // không phải mảng → coi như bỏ tích hết (không văng lỗi lạ)
    // xóa gian: bot phụ đang dùng gian này được cập nhật (mất khóa)
    await S.call('POST', 'kiotviet/bots', { retailer: 'huyenanh', bots: ['main', 'a1'] }); S.reqs.length = 0;
    r = await S.call('POST', 'kiotviet/delete', { retailer: 'huyenanh' }); assert.equal(r.status, 200); assert.deepEqual(S.reqs.map((q) => [q.action, q.id]), [['update', 'a1']]);
  } finally { await S.s.close(); }
});

test('Cài đặt: bot phụ lỗi khi cập nhật không làm hỏng việc lưu quyền (quyền vẫn được lưu, báo cảnh báo); trang có khung tích bot, viết kiểu ES5', async () => {
  const S = await boot();
  try {
    await S.call('POST', 'bots/agent/add', { token: '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', name: 'Bán hàng' });
    await S.call('POST', 'kiotviet/save', { name: 'X', retailer: 'shopx', clientId: 'cid-0123456789', clientSecret: 'csec-0123456789' });
    S.st.fail = true;
    const r = await S.call('POST', 'kiotviet/bots', { retailer: 'shopx', bots: ['main', 'a1'] });
    assert.equal(r.status, 200, r.text); assert.equal(r.body.warn.length, 1); assert.match(r.body.warn[0], /^a1: /);
    assert.match(S.env(), /"bots":\["main","a1"\]/, 'quyền vẫn được lưu để lần cập nhật sau bot nhận khóa');
  } finally { await S.s.close(); }
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
  const code = html.match(/<script>([\s\S]*)<\/script>/)[1]; new Function(code);
  const seg = code.slice(code.indexOf('var botsBox'), code.indexOf("button[data-t]'"));
  assert.ok(seg.length > 1500); assert.match(seg, /data-bk/); assert.match(seg, /kiotviet\/bots/); assert.match(seg, /Bot được dùng gian hàng này/);
  assert.ok(!/=>/.test(seg) && !/\b(let|const)\b/.test(seg) && !/`/.test(seg) && !/\?\./.test(seg), 'ES5');
});
