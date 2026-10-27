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

test('ketnoi: sau khi nối được SSH thì xin duyệt cài ứng dụng; chỉ cài khi bấm Cài; cái đã có bỏ qua, cài lỗi báo rõ', async () => {
  const s = await setup(async () => ({ ok: true, added: true, user: 'agentos-remote', host: 'PC' }));
  const cmds = [];
  const run = async (bin, args) => {
    const cmd = args[args.length - 1]; cmds.push(cmd);
    if (cmd === 'echo agentos-ssh-ok') return { ok: true, out: 'agentos-ssh-ok\n', err: '' };
    if (/command -v rsync/.test(cmd) || /command -v rustdesk/.test(cmd)) return { ok: false, out: '', err: '' };      // chưa có
    if (/apt-get install/.test(cmd)) return { ok: true, out: '', err: '' };
    return { ok: true, out: '', err: '' };
  };
  let installed = false;
  const run2 = async (bin, args) => { const cmd = args[args.length - 1]; if (/apt-get install/.test(cmd)) installed = true; if (/command -v rsync/.test(cmd)) return { ok: installed, out: '', err: '' }; return run(bin, args); };
  const t = kn(s, { run: run2 });
  await t.k.request('1', 'May van phong'); await t.k.answer(t.asks[0].b[0][0].data, 1, () => true);
  await wait(() => t.asks.length > 1);
  assert.match(t.asks[1].t, /Cài các ứng dụng/); assert.match(t.asks[1].t, /sudo/);
  assert.ok(!cmds.some((c) => /apt-get install/.test(c)), 'chưa bấm Cài thì chưa cài gì');
  assert.match(await t.k.answer(t.asks[1].b[0][0].data, 1, () => true), /đang cài/);
  await wait(() => t.sent.length > 1);
  assert.match(t.sent[1], /rsync, curl, jq: đã cài/); assert.match(t.sent[1], /RustDesk[^\n]*chưa có/); assert.match(t.sent[1], /sudo không hỏi mật khẩu: đã có/);
  assert.ok(cmds.some((c) => /sudo -n sh -c/.test(c)));
  // bấm Bỏ qua: không cài
  const t2 = kn(s, { run: run2 }); installed = false;
  await t2.k.request('1', 'May van phong'); await t2.k.answer(t2.asks[0].b[0][0].data, 1, () => true); await wait(() => t2.asks.length > 1);
  assert.match(await t2.k.answer(t2.asks[1].b[0][1].data, 1, () => true), /Đã hủy/); assert.equal(installed, false);
  await s.agent.close();
});

test('ketnoi: máy Windows dùng winget (RustDesk, Tailscale, Node) với lệnh cố định; chưa nối SSH thì không cài', async () => {
  const s = await setup(async () => ({ ok: true, added: true, user: 'nguye', host: 'PC' }));
  await assert.rejects(kn(s).k.provision('May van phong'), /chạy \/ketnoi/);
  const orig = s.head.call; s.head.call = async (m, method, p, b, to) => (p === '/fleet/status' ? { platform: 'windows' } : orig(m, method, p, b, to));
  const cmds = [], have = new Set();
  const run = async (bin, args) => {
    const c = args[args.length - 1]; cmds.push(c);
    if (c === 'echo agentos-ssh-ok' || c === 'node --version') return { ok: true, out: 'agentos-ssh-ok', err: '' };
    const id = (/--id (\S+)/.exec(c) || [])[1];
    if (/winget install/.test(c)) { if (id === 'Tailscale.Tailscale') return { ok: false, out: '', err: 'Failed 0x8a150056' }; have.add(id); return { ok: true, out: '', err: '' }; }
    if (/winget list/.test(c)) return { ok: have.has(id), out: '', err: '' };
    return { ok: false, out: '', err: '' };
  };
  const t = kn(s, { run });
  await t.k.connect('May van phong');
  const r = await t.k.provision('May van phong');
  assert.match(r, /RustDesk[^\n]*đã cài/); assert.match(r, /Tailscale[^\n]*không cài được — Failed 0x8a150056/); assert.match(r, /Node\.js[^\n]*đã có/);
  assert.ok(cmds.some((c) => /^powershell -NoProfile -NonInteractive -Command "winget install --id RustDesk\.RustDesk -e --silent/.test(c)));
  await s.agent.close();
});

test('máy con Linux: createRemoteAccess chỉ ghi tệp yêu cầu cho khóa công khai đúng dạng, chờ kết quả của tập lệnh root, báo lỗi/quá giờ', async () => {
  const { createRemoteAccess } = require('../src/ketnoi');
  const dir = tmp(), req = path.join(dir, 'req'), res = path.join(dir, 'res.json');
  const ra = createRemoteAccess({ requestFile: req, resultFile: res, waitMs: 3000, pollMs: 20 });
  for (const bad of ['', 'rm -rf /', 'command="x" ' + PUB, '-----BEGIN OPENSSH PRIVATE KEY-----', PUB + '\nssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC' + 'x'.repeat(30)]) await assert.rejects(ra.request(bad), /không đúng dạng/);
  assert.ok(!fs.existsSync(req), 'khóa sai không được ghi ra tệp');
  const root = setInterval(() => { if (fs.existsSync(req)) { fs.rmSync(req); fs.writeFileSync(res, JSON.stringify({ ts: Math.floor(Date.now() / 1000), ok: true, added: true, user: 'agentos-remote', error: '' })); } }, 20);
  const r = await ra.request(PUB); clearInterval(root);
  assert.equal(r.user, 'agentos-remote'); assert.equal(r.added, true);
  const root2 = setInterval(() => { if (fs.existsSync(req)) { fs.rmSync(req); fs.writeFileSync(res, JSON.stringify({ ts: Math.floor(Date.now() / 1000), ok: false, error: 'cú pháp sudoers sai' })); } }, 20);
  await assert.rejects(ra.request(PUB), /sudoers/); clearInterval(root2);
  const slow = createRemoteAccess({ requestFile: req, resultFile: res, waitMs: 150, pollMs: 20 });
  await assert.rejects(slow.request(PUB), /chưa xử lý/);
  fs.rmSync(req, { force: true });
});
