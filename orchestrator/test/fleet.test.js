'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { createFleet, sign } = require('../src/fleet');
const { createBot } = require('../src/bot');
const { openDb } = require('../src/db');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fl-'));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function child() {                                                                   // một máy con thật (HTTP) với việc giả
  const dir = tmp(), fleet = createFleet({ file: path.join(dir, 'c.json') }); const port = await freePort();
  fleet.save(Object.assign(fleet.load(), { agent: { enabled: true, key: 'ab'.repeat(24), host: '127.0.0.1', port, name: 'Kho Hồng Hà' } }));
  const jobs = new Map(); let next = 100;
  const agent = fleet.createAgent({ version: () => '2026.10.26.13', submit: (p, proj) => { const id = next++; jobs.set(id, { status: 'running', prompt: p, project: proj, lane: 'hook' }); return id; },
    getJob: (id) => { const j = jobs.get(id); return j ? { status: j.status, result: j.result || '', error: '' } : null; }, update: async () => 'đã là bản mới nhất', stats: () => ({ queued: 1, running: null, diskFreeMb: 50000, uptimeSec: 5 }) });
  await agent.listen();
  return { port, key: 'ab'.repeat(24), jobs, agent, close: () => agent.close() };
}
function head() { const dir = tmp(); return createFleet({ file: path.join(dir, 'h.json') }); }

test('đội máy: chữ ký HMAC — đúng thì nhận; sai khóa, lệch giờ, dùng lại, tắt cho phép, nội dung bị sửa đều bị từ chối', async () => {
  const dir = tmp(); let t = 1800000000000; const fleet = createFleet({ file: path.join(dir, 'c.json'), now: () => t });
  fleet.save(Object.assign(fleet.load(), { agent: { enabled: true, key: 'cd'.repeat(24), host: '', port: 8433, name: 'M' } }));
  const agent = fleet.createAgent({ version: () => 'v', submit: () => 1, getJob: () => null, stats: () => ({}) });
  const mk = (key, ts, body, m, p) => ({ 'x-fleet-ts': String(ts), 'x-fleet-sig': sign(key, m || 'GET', p || '/fleet/status', ts, body || '') });
  const K = 'cd'.repeat(24);
  assert.equal((await agent.handle('GET', '/fleet/status', mk(K, t), '')).status, 200);
  assert.equal((await agent.handle('GET', '/fleet/status', mk('ef'.repeat(24), t + 1), '')).status, 401, 'sai khóa');
  assert.equal((await agent.handle('GET', '/fleet/status', mk(K, t - 120000), '')).status, 401, 'lệch giờ 2 phút');
  const same = mk(K, t + 5); assert.equal((await agent.handle('GET', '/fleet/status', same, '')).status, 200); assert.equal((await agent.handle('GET', '/fleet/status', same, '')).status, 401, 'gửi lặp');
  const body = JSON.stringify({ prompt: 'làm việc A' }); assert.equal((await agent.handle('POST', '/fleet/task', mk(K, t + 6, body, 'POST', '/fleet/task'), body.replace('A', 'B'))).status, 401, 'nội dung bị sửa sau khi ký');
  assert.equal((await agent.handle('POST', '/fleet/task', mk(K, t + 7, body, 'POST', '/fleet/task'), body)).status, 200);
  const off = fleet.load(); off.agent.enabled = false; fleet.save(off); assert.equal((await agent.handle('GET', '/fleet/status', mk(K, t + 8), '')).status, 403);
});

test('đội máy: đầu não ↔ máy con qua HTTP thật — tình trạng, giao việc, lấy kết quả (chỉ việc từ đầu não), cập nhật, máy tắt báo offline, khóa sai báo lỗi', async () => {
  const c = await child(), H = head();
  try {
    assert.throws(() => H.addMachine({ name: 'x/y', url: 'http://127.0.0.1:' + c.port, key: c.key }), /Tên máy/); assert.throws(() => H.addMachine({ name: 'A', url: 'ftp://x', key: c.key }), /http/); assert.throws(() => H.addMachine({ name: 'A', url: 'http://x', key: 'ngan' }), /Khóa/);
    H.addMachine({ name: 'Kho Hồng Hà', url: 'http://127.0.0.1:' + c.port, key: c.key }); assert.throws(() => H.addMachine({ name: 'kho hồng hà', url: 'http://127.0.0.1:' + c.port, key: c.key }), /Đã có/);
    H.addMachine({ name: 'Máy tắt', url: 'http://127.0.0.1:' + (await freePort()), key: c.key }); H.addMachine({ name: 'Sai khóa', url: 'http://127.0.0.1:' + c.port, key: 'ee'.repeat(24) });
    const st = Object.fromEntries((await H.statusAll()).map((x) => [x.name, x]));
    assert.equal(st['Kho Hồng Hà'].online, true); assert.equal(st['Kho Hồng Hà'].version, '2026.10.26.13'); assert.equal(st['Kho Hồng Hà'].queued, 1); assert.equal(st['Kho Hồng Hà'].diskFreeMb, 50000);
    assert.equal(st['Máy tắt'].online, false); assert.equal(st['Sai khóa'].online, false); assert.match(st['Sai khóa'].error, /chữ ký sai/);
    const r = await H.sendTask('kho hồng hà', 'Kiểm tra tồn nồi chiên', { project: 'ke-toan' }); assert.ok(r.jobId >= 100);
    assert.equal(c.jobs.get(r.jobId).prompt, '[VIỆC TỪ MÁY ĐẦU NÃO] Kiểm tra tồn nồi chiên'); assert.equal(c.jobs.get(r.jobId).project, 'ke-toan');
    assert.equal((await H.jobResult('Kho Hồng Hà', r.jobId)).status, 'running'); c.jobs.get(r.jobId).status = 'done'; c.jobs.get(r.jobId).result = 'còn 5 cái';
    assert.deepEqual(await H.jobResult('Kho Hồng Hà', r.jobId), { status: 'done', result: 'còn 5 cái', error: '' });
    await assert.rejects(H.jobResult('Kho Hồng Hà', 99999), /không có việc này/); await assert.rejects(H.sendTask('Kho Hồng Hà', 'x'), /dài 2–8000/); await assert.rejects(H.sendTask('Không có', 'xin chào'), /Không có máy/);
    assert.equal((await H.updateMachine('Kho Hồng Hà')).text, 'đã là bản mới nhất');
    assert.equal(H.removeMachine('Máy tắt'), true); assert.equal(H.load().machines.length, 2);
  } finally { await c.close(); }
});

test('đội máy: bật cho phép sinh khóa ngẫu nhiên (tạo lại được), cổng hợp lệ, tệp cấu hình quyền 600', () => {
  const dir = tmp(), F = createFleet({ file: path.join(dir, 'f.json') });
  const a = F.enableAgent({ name: 'Kho Sơn Đồng', port: 9000 }); assert.match(a.key, /^[0-9a-f]{48}$/); assert.equal(a.port, 9000); assert.equal(a.enabled, true);
  assert.equal(F.enableAgent({}).key, a.key, 'bật lại không đổi khóa'); assert.notEqual(F.enableAgent({ regenerate: true }).key, a.key);
  assert.throws(() => F.enableAgent({ port: 80 }), /Cổng/); assert.throws(() => F.enableAgent({ name: '<script>' }), /Tên máy/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'f.json')).mode & 0o777, 0o600);
  F.disableAgent(); assert.equal(F.load().agent.enabled, false);
});

test('Telegram /may: chỉ chủ máy; xem danh sách, thêm/xóa, giao việc rồi gửi kết quả về chat khi máy con xong', async () => {
  const c = await child(), H = head(); H.addMachine({ name: 'Kho', url: 'http://127.0.0.1:' + c.port, key: c.key });
  const db = openDb(':memory:'), sent = [];
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const bot = createBot({ db, worker, allowed: new Set(['111', '222']), profiles: [], isAdmin: (u) => String(u) === '111', quietAck: true, fleet: H, send: async (chat, text) => { sent.push([chat, text]); } });
  const say = (u, t) => bot.handle({ from: { id: u }, chat: { id: u, type: 'private' }, text: t });
  try {
    assert.match(await say(222, '/may'), /Chỉ chủ máy/);
    assert.match(await say(111, '/may'), /🟢 Kho · bản 2026\.10\.26\.13 · 1 việc chờ.*ổ trống 49 GB/);
    assert.match(await say(111, '/may them X'), /Cách dùng/); assert.match(await say(111, '/may them Bếp http://127.0.0.1:1 ' + 'a'.repeat(48)), /Đã thêm máy "Bếp"/); assert.match(await say(111, '/may xoa Bếp'), /Đã xóa/);
    assert.match(await say(111, '/may Kho'), /Cách dùng: \/may Kho/);
    const ack = await say(111, '/may Kho Kiểm tra tồn nồi chiên'); assert.match(ack, /Đã giao cho "Kho" \(việc #100\)/);
    c.jobs.get(100).status = 'done'; c.jobs.get(100).result = 'còn 5 cái';
    for (let i = 0; i < 40 && !sent.length; i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal(sent.length, 1, 'kết quả gửi về chat'); assert.equal(sent[0][0], '111'); assert.match(sent[0][1], /Kho \(việc #100 · done\):\ncòn 5 cái/);
    assert.match(await say(111, '/may capnhat Kho'), /đã là bản mới nhất/); assert.match(await say(111, '/may Không-có làm gì đó'), /Không giao được.*Không có máy/);
  } finally { await c.close(); }
});
