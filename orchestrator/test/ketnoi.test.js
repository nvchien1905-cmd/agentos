'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { createFleet } = require('../src/fleet');
const { createKetNoi } = require('../src/ketnoi');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kn-'));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SzG5k2xF0Tnb8EVkhrHk4Z7TFhqRlpPE agentos-dau-nao';
const KEY = 'ab'.repeat(24);

async function setup(sshKeyDep) {
  const cdir = tmp(), child = createFleet({ file: path.join(cdir, 'c.json') }), port = await freePort();
  child.save(Object.assign(child.load(), { agent: { enabled: true, key: KEY, host: '127.0.0.1', port, name: 'May van phong' } }));
  const agent = child.createAgent({ version: () => 'v', submit: () => 1, getJob: () => null, stats: () => ({}), sshKey: sshKeyDep });
  await agent.listen();
  const head = createFleet({ file: path.join(tmp(), 'h.json') });
  head.addMachine({ name: 'May van phong', url: 'http://127.0.0.1:' + port, key: KEY });
  const keyDir = tmp(); fs.writeFileSync(path.join(keyDir, 'id_ed25519.pub'), PUB + '\n');
  return { head, agent, keyDir };
}
function kn(s, extra) {
  const sent = [], edits = [], asks = [], runs = [];
  const k = createKetNoi(Object.assign({
    fleet: s.head, keyDir: s.keyDir,
    ask: async (c, t, b) => { asks.push({ c, t, b }); return 77; }, edit: async (c, m, t) => { edits.push(t); }, send: async (c, t) => { sent.push(t); },
    run: async (bin, args) => { runs.push([bin].concat(args)); return { ok: true, out: 'agentos-ssh-ok\n', err: '' }; },
  }, extra || {}));
  return { k, sent, edits, asks, runs };
}
const wait = (f) => new Promise((res) => { const t = setInterval(() => { if (f()) { clearInterval(t); res(); } }, 10); });

test('ketnoi: hỏi duyệt trước, bấm Cho phép mới chép khóa công khai, rồi thử đăng nhập bằng khóa', async () => {
  const got = []; const s = await setup(async (k) => { got.push(k); return { ok: true, added: true, user: 'nguye', host: 'PC', warn: '' }; });
  const t = kn(s);
  assert.equal(await t.k.request('1', 'May van phong'), null);
  assert.equal(got.length, 0, 'chưa bấm thì chưa chép');
  assert.match(t.asks[0].t, /SSH/); const yes = t.asks[0].b[0][0].data;
  assert.match(await t.k.answer(yes, 1, () => true), /Đã cho phép/);
  await wait(() => t.sent.length);
  assert.deepEqual(got, [PUB]);                                                          // chỉ khóa CÔNG KHAI
  assert.match(t.sent[0], /thành công/);
  assert.ok(t.runs[0].includes('nguye@127.0.0.1'));
  assert.equal(t.k.pendingCount(), 0);
  assert.match(await t.k.answer(yes, 1, () => true), /hết hạn|trả lời/, 'bấm lần 2 không có tác dụng');
  assert.equal(got.length, 1);
  await s.agent.close();
});

test('ketnoi: bấm Hủy thì không chép; người không phải quản trị không duyệt được; hết giờ tự hủy', async () => {
  const got = []; const s = await setup(async (k) => { got.push(k); return { ok: true, added: true, user: 'u' }; });
  let t = kn(s);
  await t.k.request('1', 'May van phong');
  assert.match(await t.k.answer(t.asks[0].b[0][1].data, 1, () => true), /Đã hủy/);
  t = kn(s); await t.k.request('1', 'May van phong');
  assert.match(await t.k.answer(t.asks[0].b[0][0].data, 2, () => false), /quản trị/);
  assert.equal(got.length, 0);
  t = kn(s, { timeoutMs: 30 }); await t.k.request('1', 'May van phong');
  await wait(() => t.edits.length); assert.match(t.edits[0], /Hết thời gian/);
  assert.equal(t.k.pendingCount(), 0); assert.equal(got.length, 0);
  await s.agent.close();
});

test('ketnoi: máy không có trong Đội máy, máy chưa bật nhận khóa, ssh thử không vào được đều báo rõ', async () => {
  const s = await setup(async () => { throw new Error('Chủ máy Windows chưa bật "cho phép nhận khóa SSH"'); });
  let t = kn(s);
  assert.match(await t.k.request('1', 'Máy lạ'), /Không có máy/);
  assert.match(await t.k.request('1', ''), /Cách dùng/);
  await assert.rejects(t.k.connect('May van phong'), /chưa bật/);
  await s.agent.close();
  const s2 = await setup(async () => ({ ok: true, added: false, user: 'nguye', warn: 'cần mục C' }));
  t = kn(s2, { run: async () => ({ ok: false, out: '', err: 'Permission denied (publickey).' }) });
  const r = await t.k.connect('May van phong');
  assert.match(r, /xác nhận khóa có sẵn/); assert.match(r, /cần mục C/); assert.match(r, /chưa được: Permission denied/);
  await s2.agent.close();
});

test('ketnoi: chưa có khóa thì tự tạo bằng ssh-keygen; /ketnoi qua bot chỉ chủ máy dùng được', async () => {
  const s = await setup(async () => ({ ok: true }));
  const keyDir = tmp(); const calls = [];
  const t = kn(s, { keyDir, run: async (bin, args) => { calls.push([bin].concat(args)); fs.writeFileSync(path.join(keyDir, 'id_ed25519.pub'), PUB + '\n'); return { ok: true, out: '', err: '' }; } });
  assert.equal(await t.k.publicKey(), PUB);
  assert.equal(calls[0][0], 'ssh-keygen'); assert.ok(calls[0].includes('-N') && calls[0].includes(''));
  const { createBot } = require('../src/bot'), { openDb } = require('../src/db');
  const db = openDb(':memory:');
  const bot = createBot({ db, worker: { engineNames: () => [], wake() {} }, allowed: new Set(['1', '2']), profiles: [], isAdmin: (u) => u === '1', ketnoi: t.k, fleet: s.head });
  assert.match(await bot.handle({ from: { id: 2 }, chat: { id: 2, type: 'private' }, text: '/ketnoi May van phong' }), /Chỉ chủ máy/);
  assert.equal(await bot.handle({ from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/ketnoi May van phong' }), null);
  assert.equal(t.asks.length, 1);
  assert.match(await bot.handleCallback({ from: { id: 1 }, data: t.asks[0].b[0][1].data }), /Đã hủy/);
  await s.agent.close();
});
