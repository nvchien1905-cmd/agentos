'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { createFleet } = require('../src/fleet');
const { createKetNoi, createRemoteAccess } = require('../src/ketnoi');
const { createTsOwner } = require('../src/tsowner');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kn-'));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SzG5k2xF0Tnb8EVkhrHk4Z7TFhqRlpPE agentos-dau-nao';
const KEY = 'ab'.repeat(24);
const wait = (f) => new Promise((res, rej) => { const t0 = Date.now(), t = setInterval(() => { if (f()) { clearInterval(t); res(); } else if (Date.now() - t0 > 5000) { clearInterval(t); rej(new Error('hết giờ chờ')); } }, 10); });

// Một máy con thật (HTTP) ở 127.0.0.1. sameOwner quyết định máy gọi có cùng tài khoản Tailscale không.
async function child(o) {
  o = o || {};
  const cdir = tmp(), cf = createFleet({ file: path.join(cdir, 'c.json') }), port = await freePort();
  cf.save(Object.assign(cf.load(), { agent: Object.assign({ enabled: true, key: KEY, host: '127.0.0.1', port, name: 'May van phong' }, o.agent || {}) }));
  const keys = [];
  const agent = cf.createAgent({
    version: () => 'v', submit: () => 1, getJob: () => null, stats: () => ({}), platform: o.platform || 'linux',
    sameOwner: o.sameOwner === undefined ? async (ip) => ip === '127.0.0.1' : o.sameOwner,
    sshKey: o.sshKey || (async (k) => { keys.push(k); return { ok: true, added: true, user: 'agentos-remote', host: 'PC', warn: '' }; }),
  });
  await agent.listen();
  return { port, agent, keys, url: 'http://127.0.0.1:' + port };
}
function head() { return createFleet({ file: path.join(tmp(), 'h.json') }); }
function kn(fleet, extra) {
  const sent = [], edits = [], asks = [], runs = [];
  const keyDir = tmp(); fs.writeFileSync(path.join(keyDir, 'id_ed25519.pub'), PUB + '\n');
  const k = createKetNoi(Object.assign({
    fleet, keyDir,
    ask: async (c, t, b) => { asks.push({ c, t, b }); return 77; }, edit: async (c, m, t) => { edits.push(t); }, send: async (c, t) => { sent.push(t); },
    run: async (bin, args) => { runs.push([bin].concat(args)); return { ok: true, out: 'agentos-ssh-ok\n', err: '' }; },
  }, extra || {}));
  return { k, sent, edits, asks, runs };
}
const last = (t) => t.edits[t.edits.length - 1];
const one = (c) => ({ tsPeers: async () => ({ running: true, peers: [{ ip: '127.0.0.1', host: 'x', os: 'linux' }] }), agentPort: c.port });

test('ketnoi: /ketnoi tự dò máy cùng tài khoản Tailscale, MỘT thẻ ngắn; bấm Kết nối thì ghép đôi + chép khóa công khai + kiểm ứng dụng và ghi kết quả vào chính thẻ; chưa bấm thì chưa làm gì', async () => {
  const c = await child(), h = head();
  const t = kn(h, { agentPort: c.port, tsPeers: async () => ({ running: true, peers: [{ ip: '127.0.0.1', host: 'desktop-x', os: 'linux' }, { ip: '127.0.0.2', host: 'dien-thoai', os: 'android' }] }) });
  assert.equal(await t.k.request('1', ''), null);
  assert.equal(t.sent.length, 0, 'không có tin giới thiệu thừa');
  assert.equal(t.asks.length, 1, 'điện thoại không phải máy AgentOS nên chỉ 1 thẻ');
  assert.match(t.asks[0].t, /Ghép đôi/); assert.match(t.asks[0].t, /sudo/); assert.ok(t.asks[0].t.split('\n').length <= 2, 'thẻ ngắn');
  assert.equal(h.load().machines.length, 0, 'chưa bấm thì chưa ghép'); assert.equal(c.keys.length, 0);
  assert.match(await t.k.answer(t.asks[0].b[0][0].data, 1, () => true), /Đang kết nối/);
  await wait(() => t.edits.length > 1);
  assert.equal(h.load().machines.length, 1); assert.equal(h.load().machines[0].name, 'May van phong'); assert.equal(h.load().machines[0].key, KEY);
  assert.deepEqual(c.keys, [PUB]);                                                       // chỉ khóa CÔNG KHAI
  const r = last(t);                                                                     // kết quả ghi thẳng vào thẻ
  assert.match(r, /Đã ghép đôi/); assert.match(r, /SSH bằng khóa vào được: agentos-remote@127\.0\.0\.1 \(có sudo\)/); assert.match(r, /Ứng dụng: 5\/5 sẵn sàng/);
  assert.equal(t.sent.length, 0, 'không gửi thêm tin mới');
  assert.ok(t.runs.some((a) => a.includes('agentos-remote@127.0.0.1')));
  assert.equal(t.k.pendingCount(), 0);
  assert.match(await t.k.answer(t.asks[0].b[0][0].data, 1, () => true), /hết hạn|trả lời/, 'bấm lại không làm lần hai');
  assert.equal(c.keys.length, 1);
  await c.agent.close();
});

test('ketnoi: máy KHÔNG cùng tài khoản Tailscale không ghép đôi được; Tailscale chưa chạy / không có máy khác / chưa có máy con đều báo rõ', async () => {
  const c = await child({ sameOwner: async () => false }), h = head();
  const t = kn(h, { agentPort: c.port, tsPeers: async () => ({ running: true, peers: [{ ip: '127.0.0.1', host: 'laxx', os: 'linux' }] }) });
  assert.match(await t.k.request('1', ''), /chưa máy nào chạy máy con AgentOS/);
  await assert.rejects(h.pairWith(c.url), /cùng tài khoản Tailscale/);
  assert.equal(h.load().machines.length, 0);
  assert.match(await kn(h, { tsPeers: async () => ({ running: false, peers: [] }) }).k.request('1', ''), /chưa kết nối Tailscale/);
  assert.match(await kn(h, { tsPeers: async () => ({ running: true, peers: [] }) }).k.request('1', ''), /Chưa thấy máy nào/);
  await c.agent.close();
  const c2 = await child({ agent: { autoPair: false } });
  await assert.rejects(head().pairWith(c2.url), /tắt ghép đôi/); await c2.agent.close();
  const c3 = await child({ sameOwner: null }); await assert.rejects(head().hello(c3.url), /cùng tài khoản Tailscale/); await c3.agent.close();
});

test('ketnoi: /ketnoi <tên> cho máy đã trong Đội máy; Bỏ qua / người không phải quản trị / hết giờ thì không làm gì', async () => {
  const c = await child(), h = head(); h.addMachine({ name: 'May van phong', url: c.url, key: KEY });
  let t = kn(h);
  assert.match(await t.k.request('1', 'Máy lạ'), /Không có máy/);
  assert.equal(await t.k.request('1', 'May van phong'), null); assert.match(t.asks[0].t, /Kết nối SSH/);
  assert.match(await t.k.answer(t.asks[0].b[0][0].data, 2, () => false), /quản trị/);
  assert.match(await t.k.answer(t.asks[0].b[0][1].data, 1, () => true), /Đã bỏ qua/);
  assert.equal(c.keys.length, 0);
  t = kn(h, { timeoutMs: 30 }); await t.k.request('1', 'May van phong');
  await wait(() => t.edits.length); assert.match(t.edits[0], /Hết thời gian/);
  assert.equal(t.k.pendingCount(), 0); assert.equal(c.keys.length, 0);
  await c.agent.close();
});

test('ketnoi: máy chưa nhận khóa (Windows chưa cài) thì ghép đôi xong vẫn báo rõ lý do, không cài ứng dụng', async () => {
  const c = await child({ platform: 'windows', sshKey: async () => { throw new Error('Chủ máy Windows chưa bật "cho phép nhận khóa SSH"'); } }), h = head();
  const t = kn(h, one(c));
  await t.k.request('1', ''); assert.match(t.asks[0].t, /Windows/);
  await t.k.answer(t.asks[0].b[0][0].data, 1, () => true); await wait(() => t.edits.length > 1);
  assert.match(last(t), /Đã ghép đôi/); assert.match(last(t), /chưa bật/); assert.match(last(t), /thử lại/); assert.ok(!/Ứng dụng:/.test(last(t)));
  assert.equal(h.load().machines.length, 1);
  await c.agent.close();
});

test('ketnoi: máy Windows — RustDesk thiếu thì máy đầu não tự cài bằng kịch bản mã hóa (không winget), lưu ID + mật khẩu (0600); Tailscale/Node thiếu chỉ báo cách xử lý; chỉ liệt kê cái vừa cài hoặc lỗi', async () => {
  const c = await child({ platform: 'windows', sshKey: async () => ({ ok: true, added: true, user: 'nguye', host: 'PC' }) }), h = head();
  const cmds = [], inputs = []; let rdInstalled = false;
  const run = async (bin, args, opt) => {
    const x = args[args.length - 1]; cmds.push(x); if (opt && opt.input) inputs.push(opt.input);
    if (x === 'echo agentos-ssh-ok') return { ok: true, out: 'agentos-ssh-ok', err: '' };
    if (x === 'powershell -NoProfile -NonInteractive -Command -') return { ok: true, out: '', err: '' };                      // ghi tệp kịch bản
    if (/rd-install.ps1/.test(x)) { rdInstalled = true; return { ok: true, out: '', err: '' }; }
    if (/rustdesk\.exe/.test(x)) return { ok: rdInstalled, out: '', err: '' };
    if (/rustdesk\.json/.test(x)) return { ok: true, out: '﻿{"id":"123456789","password":"MatKhauNgauNhien1"}', err: '' };
    if (x === 'node --version') return { ok: false, out: '', err: '' };
    return { ok: false, out: '', err: '' };
  };
  const credsFile = path.join(tmp(), 'rd.json');
  const t = kn(h, Object.assign({ run, credsFile }, one(c)));
  await t.k.request('1', ''); await t.k.answer(t.asks[0].b[0][0].data, 1, () => true); await wait(() => t.edits.length > 1);
  const r = last(t);
  assert.match(r, /RustDesk[^\n]*vừa cài/); assert.match(r, /Tailscale[^\n]*chưa có \(chạy lại cai-dat-may-con\.ps1/); assert.match(r, /Node\.js[^\n]*chưa có/); assert.match(r, /Ứng dụng: 0\/3 sẵn sàng|Ứng dụng: 1\/3 sẵn sàng/);
  assert.match(r, /RustDesk ID: 123456789/); assert.ok(!/MatKhauNgauNhien1/.test(r), 'mật khẩu không hiện trong chat');
  assert.equal(inputs.length, 1, 'kịch bản truyền qua stdin MỘT dòng'); assert.equal(inputs[0].trim().split('\n').length, 1, 'một dòng duy nhất');
  assert.ok(cmds.every((x) => x.length < 1000), 'không dòng lệnh nào dài (Windows giới hạn 8191 ký tự)');
  const b64 = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(inputs[0])[1]; const script = Buffer.from(b64, 'base64').toString('utf8');
  assert.match(script, /--silent-install/); assert.match(script, /api\.github\.com\/repos\/rustdesk\/rustdesk/); assert.ok(!/winget/.test(script));
  assert.ok(!cmds.some((x) => /winget/.test(x)), 'không dùng winget qua SSH');
  const saved = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
  assert.equal(saved['May van phong'].id, '123456789'); assert.equal(saved['May van phong'].password, 'MatKhauNgauNhien1');
  if (process.platform !== 'win32') assert.equal(fs.statSync(credsFile).mode & 0o777, 0o600);
  await assert.rejects(kn(h).k.provision('May van phong'), /chạy \/ketnoi/, 'chưa SSH được thì không cài');
  await c.agent.close();
});

test('ketnoi: cài lỗi thì báo đúng lý do (stderr hoặc kết quả lệnh), không chỉ in cả dòng lệnh ssh', async () => {
  const c = await child({ platform: 'windows', sshKey: async () => ({ ok: true, added: true, user: 'nguye', host: 'PC' }) }), h = head();
  const run = async (bin, args) => {
    const x = args[args.length - 1];
    if (x === 'echo agentos-ssh-ok') return { ok: true, out: 'agentos-ssh-ok', err: '' };
    if (x === 'powershell -NoProfile -NonInteractive -Command -') return { ok: true, out: '', err: '' };
    if (/rd-install.ps1/.test(x)) return { ok: false, out: 'Invoke-WebRequest : Unable to connect to the remote server\n', err: '', msg: 'Command failed: ssh -i /var/lib/agentos/.ssh/id_ed25519 -o BatchMode=yes' };
    return { ok: false, out: '', err: '', msg: 'Command failed: ssh ...' };
  };
  const t = kn(h, Object.assign({ run }, one(c)));
  await t.k.request('1', ''); await t.k.answer(t.asks[0].b[0][0].data, 1, () => true); await wait(() => t.edits.length > 1);
  assert.match(last(t), /RustDesk[^\n]*không cài được — Invoke-WebRequest : Unable to connect/); assert.ok(!/Command failed/.test(last(t)));
  await c.agent.close();
});

test('ketnoi: máy Linux — cài rsync/curl/jq nếu thiếu, RustDesk thiếu thì chỉ báo; chưa có khóa thì tự tạo bằng ssh-keygen; /ketnoi qua bot chỉ chủ máy dùng được', async () => {
  const c = await child(), h = head();
  let installed = false; const cmds = [];
  const run = async (bin, args) => {
    const x = args[args.length - 1]; cmds.push(x);
    if (/apt-get install/.test(x)) { installed = true; return { ok: true, out: '', err: '' }; }
    if (/command -v rsync/.test(x)) return { ok: installed, out: '', err: '' };
    if (/command -v rustdesk/.test(x)) return { ok: false, out: '', err: '' };
    return { ok: true, out: 'agentos-ssh-ok', err: '' };
  };
  const t = kn(h, Object.assign({ run }, one(c)));
  await t.k.request('1', ''); await t.k.answer(t.asks[0].b[0][0].data, 1, () => true); await wait(() => t.edits.length > 1);
  assert.match(last(t), /rsync, curl, jq: vừa cài/); assert.match(last(t), /RustDesk[^\n]*chưa có/); assert.match(last(t), /Ứng dụng: 4\/5 sẵn sàng/); assert.ok(cmds.some((x) => /sudo -n sh -c/.test(x)));
  const keyDir = tmp(), calls = [];
  const t2 = kn(h, { keyDir, run: async (bin, args) => { calls.push([bin].concat(args)); fs.writeFileSync(path.join(keyDir, 'id_ed25519.pub'), PUB + '\n'); return { ok: true, out: '', err: '' }; } });
  fs.rmSync(path.join(keyDir, 'id_ed25519.pub'), { force: true });
  assert.equal(await t2.k.publicKey(), PUB); assert.equal(calls[0][0], 'ssh-keygen'); assert.ok(calls[0].includes('-N'));
  const { createBot } = require('../src/bot'), { openDb } = require('../src/db');
  const bot = createBot({ db: openDb(':memory:'), worker: { engineNames: () => [], wake() {} }, allowed: new Set(['1', '2']), profiles: [], isAdmin: (u) => u === '1', ketnoi: t.k, fleet: h });
  assert.match(await bot.handle({ from: { id: 2 }, chat: { id: 2, type: 'private' }, text: '/ketnoi' }), /Chỉ chủ máy/);
  assert.equal(h.load().machines.length, 1, 'đã được ghép đôi ở bước trước');
  const asksBefore = t.asks.length;
  assert.equal(await bot.handle({ from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/ketnoi May van phong' }), null);
  assert.equal(t.asks.length, asksBefore + 1);
  assert.match(await bot.handleCallback({ from: { id: 1 }, data: t.asks[asksBefore].b[0][1].data }), /Đã bỏ qua/);
  await c.agent.close();
});

test('ketnoi: tự báo khi thấy máy MỚI cùng tài khoản Tailscale — mỗi máy hỏi một lần (nhớ qua khởi động lại); máy đã trong Đội máy không hỏi', async () => {
  const c = await child(), h = head(), file = path.join(tmp(), 'offered.json');
  let t = kn(h, Object.assign({ offeredFile: file }, one(c)));
  assert.equal(await t.k.offerNew('1'), 1); assert.equal(t.asks.length, 1);
  assert.equal(await t.k.offerNew('1'), 0, 'lần sau không hỏi lại'); assert.equal(t.asks.length, 1);
  t = kn(h, Object.assign({ offeredFile: file }, one(c)));
  assert.equal(await t.k.offerNew('1'), 0, 'khởi động lại vẫn nhớ'); assert.equal(t.asks.length, 0);
  assert.equal(h.load().machines.length, 0, 'chưa bấm thì chưa ghép');
  h.addMachine({ name: 'May van phong', url: c.url, key: KEY });
  t = kn(h, Object.assign({ offeredFile: path.join(tmp(), 'o2.json') }, one(c)));
  assert.equal(await t.k.offerNew('1'), 0, 'đã trong Đội máy');
  assert.equal(await kn(h, { tsPeers: async () => ({ running: false, peers: [] }) }).k.offerNew('1'), 0);
  await c.agent.close();
});

test('tsowner: chỉ máy cùng tài khoản (UserID khớp, không gắn tag) được coi là của chủ; địa chỉ ngoài Tailscale bị loại; peers() chỉ lấy máy cùng tài khoản đang bật', async () => {
  const status = { BackendState: 'Running', TailscaleIPs: ['100.64.0.1'], Self: { UserID: 111, HostName: 'dau-nao', TailscaleIPs: ['100.64.0.1'] }, Peer: {
    a: { Online: true, UserID: 111, HostName: 'win', OS: 'windows', TailscaleIPs: ['100.64.0.2', 'fd7a::2'] },
    b: { Online: false, UserID: 111, HostName: 'tat', OS: 'linux', TailscaleIPs: ['100.64.0.3'] },
    c: { Online: true, UserID: 222, HostName: 'cua-nguoi-khac', OS: 'linux', TailscaleIPs: ['100.64.0.4'] },
    d: { Online: true, UserID: 111, HostName: 'may-gan-tag', OS: 'linux', Tags: ['tag:server'], TailscaleIPs: ['100.64.0.5'] } } };
  const who = { '100.64.0.2': { UserProfile: { ID: 111 }, Node: {} }, '100.64.0.4': { UserProfile: { ID: 222 }, Node: {} }, '100.64.0.5': { UserProfile: { ID: 111 }, Node: { Tags: ['tag:server'] } } };
  const run = async (args) => (args[0] === 'status' ? { ok: true, out: JSON.stringify(status) } : (who[args[2]] ? { ok: true, out: JSON.stringify(who[args[2]]) } : { ok: false, out: '' }));
  const ts = createTsOwner({ run });
  assert.equal(await ts.sameOwner('100.64.0.2'), true);
  assert.equal(await ts.sameOwner('100.64.0.4'), false, 'tài khoản khác');
  assert.equal(await ts.sameOwner('100.64.0.5'), false, 'máy gắn tag');
  assert.equal(await ts.sameOwner('100.64.0.9'), false, 'whois không biết');
  assert.equal(await ts.sameOwner('192.168.1.5'), false, 'không thuộc dải Tailscale');
  assert.equal(await ts.sameOwner('8.8.8.8'), false);
  const p = await ts.peers();
  assert.equal(p.running, true); assert.deepEqual(p.peers, [{ ip: '100.64.0.2', host: 'win', os: 'windows' }]);
  assert.equal((await createTsOwner({ run: async () => ({ ok: false, out: '' }) }).peers()).running, false);
});

test('máy con Linux: createRemoteAccess chỉ ghi tệp yêu cầu cho khóa công khai đúng dạng, chờ kết quả của tập lệnh root, báo lỗi/quá giờ', async () => {
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

test('ketnoi: RustDesk đã cài sẵn nhưng chưa có ID/mật khẩu thì chạy phần đặt mật khẩu; lỗi chỉ in lý do, bỏ XML tiến trình CLIXML của PowerShell', async () => {
  const c = await child({ platform: 'windows', sshKey: async () => ({ ok: true, added: true, user: 'nguye', host: 'PC' }) }), h = head();
  let hasCreds = false, scripts = 0;
  const run = async (bin, args) => {
    const x = args[args.length - 1];
    if (x === 'echo agentos-ssh-ok') return { ok: true, out: 'agentos-ssh-ok', err: '' };
    if (x === 'powershell -NoProfile -NonInteractive -Command -') return { ok: true, out: '', err: '' };
    if (/rd-install.ps1/.test(x)) { scripts++; hasCreds = true; return { ok: true, out: 'XONG\r\n', err: '' }; }
    if (/rustdesk\.json/.test(x)) return hasCreds ? { ok: true, out: '{"id":"264372510","password":"abc123def456ghi7"}', err: '' } : { ok: false, out: '', err: 'Cannot find path' };
    if (/rustdesk\.exe/.test(x)) return { ok: true, out: '', err: '' };                // exe đã có
    return { ok: false, out: '', err: '' };
  };
  const t = kn(h, Object.assign({ run, credsFile: path.join(tmp(), 'c.json') }, one(c)));
  await t.k.request('1', ''); await t.k.answer(t.asks[0].b[0][0].data, 1, () => true); await wait(() => t.edits.length > 1);
  assert.equal(scripts, 1); assert.match(last(t), /RustDesk ID: 264372510/); assert.ok(!/abc123def456ghi7/.test(last(t)));

  // lỗi: kịch bản in "LOI:"; hoặc chỉ có XML lỗi; không bao giờ hiện XML tiến trình
  const clixml = '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj></Objs>';
  const mk = (res) => { const c2 = { platform: 'windows' }; return res; };
  const cases = [
    [{ ok: false, out: 'user=PC\\nguye quan tri=True\r\nLOI: Khong thay ban cai RustDesk x86_64 tren GitHub.\r\n', err: clixml, msg: 'Command failed: ssh -i k' }, /không cài được — Khong thay ban cai RustDesk/],
    [{ ok: false, out: '', err: '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="x"><S S="Error">Invoke-WebRequest : Unable to connect_x000D__x000A_</S></Objs>', msg: '' }, /không cài được — Invoke-WebRequest : Unable to connect/],
    [{ ok: false, out: '', err: clixml, msg: 'Command failed: ssh -i k' }, /không cài được — không rõ lý do/],
  ];
  for (const [res, re] of cases) {
    const c3 = await child({ platform: 'windows', sshKey: async () => ({ ok: true, added: true, user: 'nguye', host: 'PC' }) }), h3 = head();
    const run3 = async (bin, args) => { const x = args[args.length - 1]; if (x === 'echo agentos-ssh-ok') return { ok: true, out: 'ok agentos-ssh-ok', err: '' }; if (x === 'powershell -NoProfile -NonInteractive -Command -') return { ok: true, out: '', err: '' }; if (/rd-install.ps1/.test(x)) return res; return { ok: false, out: '', err: '' }; };
    const t3 = kn(h3, Object.assign({ run: run3 }, one(c3)));
    await t3.k.request('1', ''); await t3.k.answer(t3.asks[0].b[0][0].data, 1, () => true); await wait(() => t3.edits.length > 1);
    assert.match(last(t3), re); assert.ok(!/Objs|CLIXML|Command failed/.test(last(t3)), 'không lộ XML hay dòng lệnh');
    await c3.agent.close();
  }
  await c.agent.close();
});
