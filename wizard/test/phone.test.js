'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createAuth, parseCookies } = require('../lib/auth');
const netinfo = require('../lib/netinfo');
const hotspot = require('../lib/hotspot');
const store = require('../lib/store');
const qr = require('../lib/qr');
const envfile = require('../lib/envfile');
const { createLogin } = require('../lib/login');
const { createWizard } = require('../server');

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-p-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE = path.join(__dirname, 'fake-login.js');
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 4000)) { const v = await fn(); if (v) return v; await sleep(25); } return null; }

// ---------- mã cài đặt + phiên ----------

test('auth: mã đúng cho phiên, mã sai bị đếm và khóa tạm, khóa theo IP, phiên hết hạn', () => {
  let t = 1000000;
  const a = createAuth({ code: '482913', now: () => t, maxFails: 3, lockMs: 60000, sessionMs: 5000 });
  assert.equal(a.verify('1.1.1.1', '000000').ok, false);
  assert.equal(a.verify('1.1.1.1', '111111').error, 'Mã không đúng.');
  const third = a.verify('1.1.1.1', '222222');
  assert.equal(third.ok, false); assert.match(third.error, /quá nhiều lần/);
  const locked = a.verify('1.1.1.1', '482913');                                  // đúng mã nhưng đang bị khóa
  assert.equal(locked.ok, false); assert.equal(locked.locked, true); assert.ok(locked.retryAfterSec > 0);
  assert.equal(a.verify('2.2.2.2', ' 482 913 ').ok, true);                       // IP khác không bị ảnh hưởng, bỏ khoảng trắng
  t += 61000;
  const ok = a.verify('1.1.1.1', '482913');
  assert.equal(ok.ok, true); assert.equal(a.valid(ok.token), true);
  t += 6000;
  assert.equal(a.valid(ok.token), false);                                        // hết hạn
  assert.equal(a.valid('khong-co'), false);
  const old = a.code(); const nw = a.rotate();
  assert.match(nw, /^\d{6}$/); assert.equal(a.code(), nw); assert.ok(old === '482913');
  assert.deepEqual(parseCookies('a=1; aw=abc; b=x=y'), { a: '1', aw: 'abc', b: 'x=y' });
});

test('netinfo: địa chỉ LAN, tên .local, Host hợp lệ', () => {
  const ifaces = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    eth0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.50', internal: false }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
  };
  assert.deepEqual(netinfo.lanAddresses(ifaces), [{ name: 'eth0', address: '192.168.1.50' }]);
  assert.equal(netinfo.hostLabel('AgentOS_Test'), 'agentostest.local');
  for (const h of ['localhost:8088', '127.0.0.1', '192.168.1.5:8088', 'agentos-test.local', '[::1]:8088']) assert.equal(netinfo.hostAllowed(h), true, h);
  for (const h of ['evil.example.com', 'a.b.c', '', undefined, 'localhost.evil.com']) assert.equal(netinfo.hostAllowed(h), false, String(h));
  assert.equal(netinfo.isLoopback('::ffff:127.0.0.1'), true); assert.equal(netinfo.isLoopback('10.0.0.1'), false);
});

// ---------- Wi-Fi tạm ----------

test('hotspot: thông tin Wi-Fi sinh một lần rồi giữ nguyên; chuỗi QR Wi-Fi thoát ký tự đặc biệt', () => {
  const f = path.join(tmp(), 'sub', 'hotspot.json');
  const c1 = hotspot.credentials(f);
  assert.match(c1.ssid, /^AgentOS-[0-9A-F]{4}$/); assert.match(c1.psk, /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/);
  assert.deepEqual(hotspot.credentials(f), c1);                                  // lần sau đọc lại, không đổi
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(hotspot.wifiQrText('AgentOS-1A2B', 'abc23'), 'WIFI:T:WPA;S:AgentOS-1A2B;P:abc23;;');
  assert.equal(hotspot.wifiQrText('Cafe;A:b', 'p"w\\d,'), 'WIFI:T:WPA;S:Cafe\\;A\\:b;P:p\\"w\\\\d\\,;;');
});

test('hotspot: dựng lệnh nmcli đúng, báo lỗi rõ khi không có card hoặc card không phát được', async () => {
  const calls = [];
  const run = (script) => async (cmd, args, opts) => { calls.push([cmd, args, opts]); return script(args.join(' ')) || { code: 0, out: '', err: '' }; };
  const cred = { ssid: 'AgentOS-AB12', psk: 'abcdefghjk' };
  const ok = run((a) => (a === '-t -f DEVICE,TYPE,STATE dev' ? { code: 0, out: 'eth0:ethernet:connected\nwlan0:wifi:disconnected\nlo:loopback:unmanaged\n', err: '' } : null));
  assert.equal(await hotspot.up(ok, cred), 'wlan0');
  const add = calls.find((c) => c[1].includes('add'));
  assert.equal(add[2].secret, true);
  const s = add[1].join(' ');
  for (const part of ['type wifi', 'ifname wlan0', 'con-name AgentOS-Setup', 'autoconnect no', 'ssid AgentOS-AB12', 'mode ap', 'ipv4.method shared', 'ipv4.addresses 10.42.0.1/24', 'wifi-sec.key-mgmt wpa-psk', 'wifi-sec.psk abcdefghjk']) assert.ok(s.includes(part), part);
  assert.ok(calls.some((c) => c[1].join(' ') === '--wait 30 con up AgentOS-Setup ifname wlan0'));

  calls.length = 0;
  await assert.rejects(() => hotspot.up(run((a) => (a.includes('DEVICE,TYPE') ? { code: 0, out: 'eth0:ethernet:connected\nwlan0:wifi:unavailable\n', err: '' } : null)), cred), /không có card Wi-Fi/);
  const noAp = run((a) => (a.includes('DEVICE,TYPE') ? { code: 0, out: 'wlan0:wifi:disconnected\n', err: '' } : a.includes('con up') ? { code: 4, out: '', err: 'Error: AP mode not supported' } : null));
  calls.length = 0;
  await assert.rejects(() => hotspot.up(noAp, cred), /không hỗ trợ chế độ AP/);
  assert.ok(calls.some((c) => c[1].join(' ') === 'con delete AgentOS-Setup'));      // dọn cấu hình dở dang

  calls.length = 0;
  await hotspot.down(ok);
  assert.deepEqual(calls.map((c) => c[1].join(' ')), ['con down AgentOS-Setup', 'con delete AgentOS-Setup']);
  assert.equal(await hotspot.isUp(run(() => ({ code: 0, out: 'Wired:activated\nAgentOS-Setup:activated\n', err: '' }))), true);
  assert.equal(await hotspot.isUp(run(() => ({ code: 0, out: 'Wired:activated\n', err: '' }))), false);
});

// ---------- lưu trạng thái, QR ----------

test('store: ghi/đọc/xóa, bỏ khóa lạ; envfile thêm token Claude đúng dạng', async () => {
  const f = path.join(tmp(), 'x', 'state.json');
  assert.deepEqual(store.load(f), {});
  store.save(f, { token: 't', owner: { id: '1' }, claudeToken: null, evil: 'x', lastError: undefined });
  assert.deepEqual(store.load(f), { token: 't', owner: { id: '1' } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  store.clear(f); assert.deepEqual(store.load(f), {});
  const cfg = { token: TOKEN, ownerIds: ['7'], engines: ['claude'], claudeToken: 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx' };
  assert.match(envfile.build(cfg), /^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx$/m);
  assert.doesNotMatch(envfile.build(Object.assign({}, cfg, { claudeToken: null })), /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.throws(() => envfile.build(Object.assign({}, cfg, { claudeToken: 'abc\nX=1' })), /Token Claude/);
  assert.equal(await qr.svg(async () => ({ code: 0, out: '<svg xmlns="x"></svg>', err: '' }), 'WIFI:T:WPA;S:a;P:b;;'), '<svg xmlns="x"></svg>');
  assert.equal(await qr.svg(async () => ({ code: 127, out: '', err: 'no qrencode' }), 'x'), null);
  await assert.rejects(() => qr.svg(async () => ({}), 'x'.repeat(401)), /không hợp lệ/);
});

// ---------- đăng nhập AI qua điện thoại (pty giả lập) ----------

const wrapFake = (argv) => ({ cmd: process.execPath, args: [FAKE, argv[1] === 'setup-token' ? (process.env.FAKE_SPLIT ? 'claude-split' : 'claude-token') : argv[1] === 'login' ? 'codex-device' : 'fail'] });

test('login Claude: lấy link, nhận mã dán vào, bắt token, che token trong nội dung hiển thị', async () => {
  const L = createLogin({ wrap: wrapFake });
  const v0 = L.start('claude');
  assert.equal(v0.status, 'running');
  const v1 = await until(() => { const v = L.get(); return v.url ? v : null; });
  assert.equal(v1.url, 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz');
  assert.equal(v1.needsInput, true); assert.match(v1.tail, /Visit this URL to sign in:/); assert.doesNotMatch(v1.tail, /\u001b/);
  assert.throws(() => L.input('ma\u0000xau'), /Mã không hợp lệ/);
  assert.throws(() => L.input(''), /Mã không hợp lệ/);
  L.input('MA-DUNG');
  const done = await until(() => { const v = L.get(); return v.status === 'done' ? v : null; });
  assert.equal(done.hasToken, true);
  assert.doesNotMatch(done.tail, /sk-ant-oat01-AbCdEf/); assert.match(done.tail, /\[đã nhận token\]/);
  assert.equal(L.takeToken(), 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx_yz-0123456789');
  assert.throws(() => L.input('x'), /Không có lần đăng nhập đang chạy/);
});

test('login Claude: mã sai thì báo lỗi; Codex: link + mã thiết bị, không nhận nhập; lệnh lỗi; hủy; hết giờ', async () => {
  const L = createLogin({ wrap: wrapFake });
  L.start('claude'); await until(() => L.get().url);
  L.input('SAI');
  const bad = await until(() => { const v = L.get(); return v.status === 'error' ? v : null; });
  assert.match(bad.error, /mã 1|Lệnh đăng nhập/);

  L.start('codex');
  const c = await until(() => { const v = L.get(); return v.url && /ABCD-1234/.test(v.tail) ? v : null; });
  assert.equal(c.url, 'https://auth.openai.com/codex/device'); assert.equal(c.needsInput, false);
  assert.equal(c.code, 'ABCD-1234');   // mã thiết bị tách riêng để trang hiện to
  assert.throws(() => L.input('x'), /không cần nhập mã/);
  assert.equal((await until(() => { const v = L.get(); return v.status === 'done' ? v : null; })).status, 'done');

  const F = createLogin({ wrap: () => ({ cmd: process.execPath, args: [FAKE, 'fail'] }) });
  F.start('codex');
  assert.match((await until(() => { const v = F.get(); return v.status === 'error' ? v : null; })).error, /mã 3/);
  assert.throws(() => F.start('gemini'), /không biết/);

  const C = createLogin({ wrap: () => ({ cmd: process.execPath, args: [FAKE, 'long'] }) });
  C.start('codex'); await until(() => C.get().url);
  C.cancel();
  assert.equal((await until(() => { const v = C.get(); return v.status === 'error' ? v : null; })).error, 'Đã hủy');
  const T = createLogin({ wrap: () => ({ cmd: process.execPath, args: [FAKE, 'long'] }), timeoutMs: 150 });
  T.start('codex');
  assert.match((await until(() => { const v = T.get(); return v.status === 'error' ? v : null; })).error, /Quá thời gian/);
});

// ---------- máy chủ: điện thoại qua LAN ----------

async function boot(extra) {
  const dir = tmp();
  const calls = [];
  const sent = [];
  const mk = Object.assign({ online: true, connectOk: true, getMeOk: true }, (extra && extra.sim) || {});
  const run = async (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    const a = args.join(' ');
    if (cmd === 'nmcli') {
      if (a === '-t -f CONNECTIVITY general') return { code: 0, out: mk.online ? 'full' : 'none', err: '' };
      if (a.includes('DEVICE,TYPE,STATE')) return { code: 0, out: (mk.ethernet ? 'eth0:ethernet:connected\n' : '') + 'wlan0:wifi:disconnected\n', err: '' };
      if (a.includes('SSID,SIGNAL')) return { code: 0, out: 'Shop:70:WPA2\n', err: '' };
      if (args.includes('connect')) { if (mk.connectOk) { mk.online = true; return { code: 0, out: '', err: '' }; } return { code: 4, out: '', err: 'Secrets were required' }; }
      if (a.includes('con up AgentOS-Setup')) return { code: 0, out: '', err: '' };
      if (a.includes('con add')) return { code: 0, out: '', err: '' };
      return { code: 0, out: '', err: '' };
    }
    if (cmd === 'qrencode') return { code: 0, out: '<svg>' + args[args.length - 1] + '</svg>', err: '' };
    if (args && args.includes('install')) return { code: 0, out: '', err: '' };
    if (args && args.includes('--version')) return { code: 0, out: '9.9.9', err: '' };
    if (args && args.includes('-p')) return { code: 0, out: '{"result":"OK"}', err: '' };
    return { code: 0, out: '', err: '' };
  };
  let paired = false;
  const f = async (url, init) => {
    const method = url.split('/').pop(); const body = JSON.parse(init.body);
    let r = { ok: true, result: {} };
    if (method === 'getMe') r = mk.getMeOk ? { ok: true, result: { id: 9, username: 'cua_hang_bot', first_name: 'CH' } } : { ok: false, error_code: 401, description: 'Unauthorized' };
    if (method === 'getUpdates') r = { ok: true, result: (body.timeout === 0 || paired || !mk.pairing) ? [] : (paired = true, [{ update_id: 5, message: { chat: { type: 'private' }, text: '/start 654321', from: { id: 777, first_name: 'Chủ' } } }]) };
    if (method === 'sendMessage') sent.push(body);
    return { json: async () => r };
  };
  const w = createWizard(Object.assign({
    port: 0, host: '127.0.0.1', run, fetch: f, code: '654321', trustLoopback: false, hotspotIp: null,
    envFile: path.join(dir, 'orchestrator.env'), stateFile: path.join(dir, 'state.json'), hotspotFile: path.join(dir, 'hotspot.json'),
    hotspotDelayMs: 0, captivePort: 0, pollPauseMs: 5, errorPauseMs: 10, settleMs: 0, onlinePollMs: 5, onlineTries: 5, waitMs: 2000, finishDelayMs: 60000,
    ifaces: { eth0: [{ family: 'IPv4', address: '192.168.1.77', internal: false }] }, hostname: 'agentos-shop',
  }, extra && extra.opts));
  delete (extra || {}).sim;
  const port = await w.listen();
  const call = async (method, p, body, headers) => {
    const r = await fetch('http://127.0.0.1:' + port + p, { method, redirect: 'manual', headers: Object.assign({ 'content-type': 'application/json', 'x-agentos-wizard': '1' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* html */ }
    return { status: r.status, body: j, text, headers: r.headers };
  };
  return { w, port, call, calls, sent, dir, sim: mk };
}

test('LAN: chưa có mã thì chỉ thấy trang nhập mã; sai mã bị khóa; đúng mã (hoặc link ?k=) vào được kèm cookie', async () => {
  const S = await boot();
  try {
    const page = await S.call('GET', '/');
    assert.equal(page.status, 200); assert.match(page.text, /mã cài đặt 6 số/); assert.doesNotMatch(page.text, /Chào mừng đến với AgentOS/);
    const noAuth = await S.call('GET', '/api/state');
    assert.equal(noAuth.status, 401); assert.equal(noAuth.body.needPair, true);
    assert.equal((await S.call('POST', '/api/finish', {})).status, 401);
    assert.equal((await S.call('POST', '/api/pair', { code: '000000' }, { 'x-agentos-wizard': '0' })).status, 403);

    const wrong = await S.call('POST', '/api/pair', { code: '111111' });
    assert.equal(wrong.status, 403); assert.equal(wrong.body.error, 'Mã không đúng.');
    const good = await S.call('POST', '/api/pair', { code: '654321' });
    assert.equal(good.status, 200);
    const cookie = good.headers.get('set-cookie');
    assert.match(cookie, /^aw=[0-9a-f]{48}; HttpOnly; SameSite=Strict; Path=\//);
    const c = cookie.split(';')[0];
    const home = await S.call('GET', '/', null, { cookie: c });
    assert.match(home.text, /Chào mừng đến với AgentOS/);
    const st = await S.call('GET', '/api/state', null, { cookie: c });
    assert.equal(st.status, 200); assert.equal(st.body.code, '654321'); assert.deepEqual(st.body.lan.ips, [{ name: 'eth0', address: '192.168.1.77' }]); assert.equal(st.body.lan.host, 'agentos-shop.local');
    assert.equal((await S.call('GET', '/api/state', null, { cookie: 'aw=gia' })).status, 401);

    const link = await S.call('GET', '/?k=654321');                                 // link trong tin Telegram / mã QR
    assert.equal(link.status, 302); assert.equal(link.headers.get('location'), '/'); assert.match(link.headers.get('set-cookie'), /^aw=/);
    assert.match((await S.call('GET', '/?k=999999')).text, /mã cài đặt 6 số/);       // link sai: quay lại trang nhập mã
    const q = await S.call('GET', '/api/qr?text=' + encodeURIComponent('http://192.168.1.77:8088/?k=654321'), null, { cookie: c });
    assert.equal(q.status, 200); assert.match(q.text, /^<svg>http:\/\/192\.168\.1\.77/); assert.equal(q.headers.get('content-type'), 'image/svg+xml');
  } finally { await S.w.close(); }
});

test('LAN: nhập sai mã nhiều lần thì khóa, kể cả khi sau đó nhập đúng', async () => {
  const S = await boot();
  try {
    let last;
    for (let i = 0; i < 5; i++) last = await S.call('POST', '/api/pair', { code: '00000' + i });
    assert.equal(last.status, 403); assert.match(last.body.error, /quá nhiều lần/);
    const locked = await S.call('POST', '/api/pair', { code: '654321' });
    assert.equal(locked.status, 429);
  } finally { await S.w.close(); }
});

test('Wi-Fi tạm: máy tự phát khi không có mạng; đang trong Wi-Fi tạm thì được tin không cần mã; có mạng dây thì không phát', async () => {
  const S = await boot({ sim: { online: false }, opts: { hotspotIp: '127.0.0.1', trustLoopback: false } });
  try {
    await until(() => S.w.state.hotspot.up);
    assert.equal(S.w.state.hotspot.up, true);
    const add = S.calls.find((c) => c[0] === 'nmcli' && c[1].includes('add'));
    assert.ok(add && add[1].includes('mode') && add[1].includes('ap'));
    const st = await S.call('GET', '/api/state');                                  // không cookie nhưng đến qua địa chỉ của Wi-Fi tạm => được tin
    assert.equal(st.status, 200);
    assert.equal(st.body.hotspot.up, true); assert.match(st.body.hotspot.ssid, /^AgentOS-[0-9A-F]{4}$/);
    assert.match(st.body.hotspot.qr, /^WIFI:T:WPA;S:AgentOS-[0-9A-F]{4};P:[a-z0-9]{10};;$/);
  } finally { await S.w.close(); }
  const E = await boot({ sim: { online: false, ethernet: true } });
  try { await sleep(100); assert.equal(E.w.state.hotspot.up, false); assert.ok(!E.calls.some((c) => c[1].includes('add'))); } finally { await E.w.close(); }
});

test('Wi-Fi tạm: cổng chuyển hướng (captive portal) đưa mọi địa chỉ về trang cài đặt', async () => {
  const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r)); const free = probe.address().port; await new Promise((r) => probe.close(r));
  const S = await boot({ sim: { online: false }, opts: { hotspotIp: '127.0.0.1', captivePort: free } });
  try {
    await until(() => S.w.state.hotspot.up); await sleep(80);
    const r = await fetch('http://127.0.0.1:' + free + '/generate_204', { redirect: 'manual', headers: { host: 'connectivitycheck.gstatic.com' } });
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), 'http://127.0.0.1:' + S.port + '/');
  } finally { await S.w.close(); }
});

test('cài đặt bằng điện thoại: Wi-Fi + token một lần -> tắt Wi-Fi tạm, nối Wi-Fi cửa hàng, kiểm token, chờ chủ nhắn mã', async () => {
  const S = await boot({ sim: { online: false, pairing: true }, opts: { hotspotIp: '127.0.0.1' } });
  try {
    await until(() => S.w.state.hotspot.up);
    assert.equal((await S.call('POST', '/api/setup/offline', { ssid: 'Shop', password: 'matkhau', token: 'sai' })).status, 400);
    assert.equal((await S.call('POST', '/api/setup/offline', { ssid: '', password: 'x', token: TOKEN })).body.error, 'Chưa chọn Wi-Fi');
    const r = await S.call('POST', '/api/setup/offline', { ssid: 'Shop', password: 'matkhau', token: TOKEN });
    assert.deepEqual(r.body, { started: true });
    const done = await until(() => (S.w.state.owner ? true : null));
    assert.ok(done, 'phải ghép đôi được chủ máy');
    assert.equal(S.w.state.owner.id, '777'); assert.equal(S.w.state.bot.username, 'cua_hang_bot');
    // thứ tự: tắt Wi-Fi tạm TRƯỚC khi nối Wi-Fi cửa hàng
    const seq = S.calls.filter((c) => c[0] === 'nmcli').map((c) => c[1].join(' '));
    const iDown = seq.findIndex((s) => s === 'con down AgentOS-Setup'); const iConn = seq.findIndex((s) => s.includes('dev wifi connect Shop'));
    assert.ok(iDown >= 0 && iConn > iDown, seq.join(' | '));
    assert.ok(S.calls.some((c) => c[1].includes('password') && c[1].includes('matkhau') && c[2] && c[2].secret));
    assert.equal(S.w.state.offline.status, 'done');
    const msg = S.sent.find((s) => /Đã ghép đôi với bạn/.test(s.text));
    assert.ok(msg && msg.chat_id === '777' && new RegExp('http://192\\.168\\.1\\.77:' + S.port + '/\\?k=654321').test(msg.text), 'tin Telegram phải có link cài đặt AI');
    assert.equal(store.load(path.join(S.dir, 'state.json')).owner.id, '777');       // đã lưu để nối tiếp nếu mất điện
  } finally { await S.w.close(); }
});

test('cài đặt bằng điện thoại: sai mật khẩu Wi-Fi hoặc sai token thì bật lại Wi-Fi tạm và ghi lý do', async () => {
  const A = await boot({ sim: { online: false, connectOk: false }, opts: { hotspotIp: '127.0.0.1' } });
  try {
    await until(() => A.w.state.hotspot.up);
    A.calls.length = 0;
    await A.call('POST', '/api/setup/offline', { ssid: 'Shop', password: 'sai', token: TOKEN });
    await until(() => (A.w.state.offline.status === 'error' ? true : null));
    assert.match(A.w.state.offline.error, /Sai mật khẩu hoặc không kết nối được/);
    await until(() => (A.w.state.hotspot.up ? true : null));
    assert.equal(A.w.state.hotspot.up, true);                                       // phát lại Wi-Fi tạm
    assert.ok(A.calls.some((c) => c[1].includes('add')));
    const st = await A.call('GET', '/api/state');
    assert.equal(st.body.offline.status, 'error'); assert.match(st.body.lastError, /Sai mật khẩu/);
    assert.equal(A.w.state.token, null);
  } finally { await A.w.close(); }

  const B = await boot({ sim: { online: false, getMeOk: false }, opts: { hotspotIp: '127.0.0.1' } });
  try {
    await until(() => B.w.state.hotspot.up);
    await B.call('POST', '/api/setup/offline', { ssid: 'Shop', password: 'dung', token: TOKEN });
    await until(() => (B.w.state.offline.status === 'error' ? true : null));
    assert.match(B.w.state.offline.error, /Token sai hoặc đã bị thu hồi/);
    await until(() => (B.w.state.hotspot.up ? true : null));
  } finally { await B.w.close(); }
});

test('đăng nhập AI qua API: Claude -> token được giữ, truyền cho bước kiểm tra qua môi trường và ghi vào cấu hình; Codex tự lưu', async () => {
  const L = createLogin({ wrap: wrapFake });
  const S = await boot({ sim: { pairing: true }, opts: { trustLoopback: true, login: L } });
  try {
    assert.equal((await S.call('POST', '/api/login/start', { engine: 'claude' })).status, 200);   // máy ảo giả: đã cài (--version trả 9.9.9)
    const v = await until(async () => { const s = (await S.call('GET', '/api/login/state')).body; return s.url ? s : null; });
    assert.match(v.url, /^https:\/\/claude\.ai\/oauth/);
    assert.equal((await S.call('POST', '/api/login/input', { text: 'MA-DUNG' })).status, 200);
    const done = await until(async () => { const s = (await S.call('GET', '/api/login/state')).body; return s.status === 'done' ? s : null; });
    assert.equal(done.hasToken, true); assert.doesNotMatch(JSON.stringify(done), /sk-ant-oat01-AbCdEf/);   // API không bao giờ trả token
    assert.equal((await S.call('GET', '/api/state')).body.hasClaudeToken, true);
    assert.equal(store.load(path.join(S.dir, 'state.json')).claudeToken, 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx_yz-0123456789');

    S.calls.length = 0;
    const ck = await S.call('POST', '/api/engine/check', { engine: 'claude' });
    assert.equal(ck.body.loggedIn, true);
    const verify = S.calls.find((c) => c[1] && c[1].includes('-p'));
    assert.equal(verify[2].env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx_yz-0123456789');
    assert.ok(!verify[1].join(' ').includes('sk-ant-'), 'token không được nằm trên dòng lệnh');

    await S.call('POST', '/api/telegram/token', { token: TOKEN });
    await S.call('POST', '/api/telegram/wait', {});
    await S.call('POST', '/api/finish', {});
    const env = fs.readFileSync(path.join(S.dir, 'orchestrator.env'), 'utf8');
    assert.match(env, /^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-AbCdEf/m); assert.match(env, /^ENGINE_ORDER=claude$/m);
    assert.deepEqual(store.load(path.join(S.dir, 'state.json')), {});                // đã xóa bản sao trạng thái sau khi hoàn tất
  } finally { await S.w.close(); }
});

test('khởi động lại giữa chừng: đọc lại token đã lưu và tiếp tục chờ chủ nhắn mã', async () => {
  const dir = tmp();
  store.save(path.join(dir, 'state.json'), { token: TOKEN, bot: { id: 9, username: 'cua_hang_bot' } });
  const S = await boot({ sim: { pairing: true }, opts: { stateFile: path.join(dir, 'state.json'), trustLoopback: true } });
  try {
    assert.equal(S.w.state.token, TOKEN);
    await until(() => (S.w.state.owner ? true : null));
    assert.equal(S.w.state.owner.id, '777');
  } finally { await S.w.close(); }
});

test('login Claude: token in ra từng đoạn thì vẫn lấy ĐỦ token (không lấy lần khớp đầu)', async () => {
  process.env.FAKE_SPLIT = '1';
  try {
    const L = createLogin({ wrap: wrapFake, enterDelayMs: 10 });
    L.start('claude'); await until(() => L.get().tail.includes('Paste code'));
    L.input('MA-DUNG');
    const done = await until(() => { const v = L.get(); return v.status === 'done' ? v : null; });
    assert.equal(done.hasToken, true);
    assert.equal(L.takeToken(), 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx_yz-0123456789-FULLTOKEN');
  } finally { delete process.env.FAKE_SPLIT; }
});
