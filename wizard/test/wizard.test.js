'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nm = require('../lib/nm');
const tg = require('../lib/telegram');
const envfile = require('../lib/envfile');
const engines = require('../lib/engines');
const { createWizard } = require('../server');

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-w-'));

// ---------- nmcli ----------

test('nm: tách trường có dấu : được thoát, danh sách Wi-Fi bỏ trùng/rỗng và sắp theo sóng', () => {
  assert.deepEqual(nm.splitTerse('Cafe\\: Hà Nội:72:WPA2'), ['Cafe: Hà Nội', '72', 'WPA2']);
  const list = nm.parseWifiList(['Shop:40:WPA2', ':90:WPA2', 'Shop:80:WPA2', 'Khach:55:', 'Cu:30:--', ''].join('\n'));
  assert.deepEqual(list, [
    { ssid: 'Shop', signal: 80, secured: true },
    { ssid: 'Khach', signal: 55, secured: false },
    { ssid: 'Cu', signal: 30, secured: false },
  ]);
  assert.deepEqual(nm.parseDevices('wlan0:wifi:disconnected\neth0:ethernet:connected\nlo:loopback:unmanaged'),
    [{ device: 'wlan0', type: 'wifi', state: 'disconnected' }, { device: 'eth0', type: 'ethernet', state: 'connected' }, { device: 'lo', type: 'loopback', state: 'unmanaged' }]);
});

test('nm: trạng thái mạng, quét, kết nối (tham số không qua shell), báo lỗi dễ hiểu', async () => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    const a = args.join(' ');
    if (a === '-t -f CONNECTIVITY general') return { code: 0, out: 'full\n', err: '' };
    if (a === '-t -f DEVICE,TYPE,STATE dev') return { code: 0, out: 'wlan0:wifi:disconnected\neth0:ethernet:connected\n', err: '' };
    if (a === 'dev wifi rescan') return { code: 1, out: '', err: 'quá thường xuyên' };
    if (a === '-t -f SSID,SIGNAL,SECURITY dev wifi list') return { code: 0, out: 'Shop:70:WPA2\n', err: '' };
    if (args.includes('connect') && args.includes('sai')) return { code: 4, out: '', err: 'Error: Connection activation failed: Secrets were required, but not provided.' };
    if (args.includes('connect')) return { code: 0, out: 'ok', err: '' };
    return { code: 1, out: '', err: '' };
  };
  assert.deepEqual(await nm.status(run), { connectivity: 'full', online: true, hasWifi: true, hasEthernet: true });
  assert.deepEqual(await nm.scan(run), [{ ssid: 'Shop', signal: 70, secured: true }]);
  assert.equal(await nm.connect(run, 'Shop $(rm -rf /)', 'p;w d'), true);
  const c = calls.find((x) => x[1].includes('connect'));
  assert.equal(c[0], 'nmcli'); assert.deepEqual(c[1].slice(-3), ['Shop $(rm -rf /)', 'password', 'p;w d']);   // nguyên văn, không bị shell diễn giải
  assert.equal(c[2].secret, true);
  await assert.rejects(() => nm.connect(run, 'Shop', 'sai'), /Sai mật khẩu hoặc không kết nối được/);
  await assert.rejects(() => nm.connect(run, 'a\nb', 'x'), /không hợp lệ/);
  await assert.rejects(() => nm.connect(run, '', 'x'), /không hợp lệ/);
  assert.equal((await nm.status(async () => ({ code: 1, out: '', err: '' }))).online, false);
});

// ---------- Telegram ----------

function fakeTelegram(script) {
  const calls = [];
  const f = async (url, init) => {
    const method = url.split('/').pop(); const body = JSON.parse(init.body);
    calls.push({ method, body });
    const r = script(method, body);
    return { json: async () => r };
  };
  return { f, calls };
}

test('telegram: kiểm tra token đúng dạng, getMe, token sai bị từ chối trước khi gọi mạng', async () => {
  const T = fakeTelegram((m) => (m === 'getMe' ? { ok: true, result: { id: 9, username: 'cua_hang_bot', first_name: 'Cửa hàng' } } : { ok: false }));
  assert.deepEqual(await tg.getMe(TOKEN, { fetch: T.f }), { id: 9, username: 'cua_hang_bot', name: 'Cửa hàng' });
  await assert.rejects(() => tg.getMe('khong-phai-token', { fetch: T.f }), /không đúng dạng/);
  assert.equal(T.calls.length, 1);
  const bad = fakeTelegram(() => ({ ok: false, error_code: 401, description: 'Unauthorized' }));
  await assert.rejects(() => tg.getMe(TOKEN, { fetch: bad.f }), /Token sai hoặc đã bị thu hồi/);
});

test('telegram: nhận diện mã ghép đôi', () => {
  for (const t of ['/start 123456', '/start@cua_hang_bot 123456', '  123456 ', '/START 123456']) assert.equal(tg.isPairing(t, '123456'), true, t);
  for (const t of ['xin chào', '/start', '/start 654321', '1234567', '', null]) assert.equal(tg.isPairing(t, '123456'), false, String(t));
});

test('telegram: chỉ người nhắn ĐÚNG MÃ thành chủ máy; người lạ/bot/nhóm bị bỏ qua; đánh dấu đã đọc', async () => {
  const updates = [
    { update_id: 10, message: { chat: { type: 'group' }, text: '/start 123456', from: { id: 1, first_name: 'Nhóm' } } },
    { update_id: 11, message: { chat: { type: 'private' }, text: '/start 123456', from: { id: 2, is_bot: true, first_name: 'Bot' } } },
    { update_id: 12, message: { chat: { type: 'private' }, text: 'chào bot', from: { id: 55, first_name: 'Người lạ' } } },
    { update_id: 13, message: { chat: { type: 'private' }, text: '/start 123456', from: { id: 777, first_name: 'Huyền', last_name: 'Anh', username: 'huyenanh' } } },
  ];
  const T = fakeTelegram((m, b) => (m === 'getUpdates' && b.timeout !== 0 ? { ok: true, result: updates } : { ok: true, result: [] }));
  const r = await tg.pollOwner(TOKEN, { fetch: T.f, code: '123456', waitSec: 5 });
  assert.deepEqual(r.owner, { id: '777', name: 'Huyền Anh', username: 'huyenanh' });
  assert.deepEqual(r.strangers, ['55']);
  assert.equal(T.calls.at(-1).body.offset, 14);                                   // đã đánh dấu đọc tới update 13
  const wrong = await tg.pollOwner(TOKEN, { fetch: T.f, code: '000000', waitSec: 5 });
  assert.equal(wrong.owner, null); assert.deepEqual(wrong.strangers.sort(), ['55', '777']);
  const none = fakeTelegram(() => ({ ok: true, result: [] }));
  const e = await tg.pollOwner(TOKEN, { fetch: none.f, code: '123456', waitSec: 1, offset: 9 });
  assert.deepEqual(e, { owner: null, offset: 9, strangers: [] });
});

// ---------- file cấu hình ----------

test('envfile: dựng cấu hình đúng, từ chối thiếu/sai, ghi quyền 600 qua file tạm', () => {
  const s = envfile.build({ token: TOKEN, ownerIds: ['777'], engines: ['claude', 'codex', 'gemini'] });
  assert.match(s, /^TELEGRAM_TOKEN=123456789:AAH/m);
  assert.match(s, /^ALLOWED_USER_IDS=777$/m); assert.match(s, /^ADMIN_USER_IDS=777$/m);
  assert.match(s, /^ENGINE_ORDER=claude,codex$/m);                              // engine lạ bị bỏ
  assert.match(s, /^SANDBOX=auto$/m); assert.match(s, /^CLAUDE_BIN=\/var\/lib\/agentos\/\.local\/bin\/claude$/m);
  assert.throws(() => envfile.build({ token: 'x', ownerIds: ['1'], engines: ['claude'] }), /token/);
  assert.throws(() => envfile.build({ token: TOKEN, ownerIds: [], engines: ['claude'] }), /ID Telegram/);
  assert.throws(() => envfile.build({ token: TOKEN, ownerIds: ['1;2'], engines: ['claude'] }), /ID Telegram/);
  assert.throws(() => envfile.build({ token: TOKEN, ownerIds: ['1'], engines: [] }), /AI nào/);
  assert.throws(() => envfile.build({ token: TOKEN, ownerIds: ['1'], engines: ['claude'], paths: { workdir: '/a\nTELEGRAM_TOKEN=x' } }), /ký tự không hợp lệ/);
  const f = path.join(tmp(), 'etc', 'agentos', 'orchestrator.env');
  envfile.writeSecure(f, s);
  assert.equal(fs.readFileSync(f, 'utf8'), s);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(f + '.tmp'), false);
});

// ---------- cài/kiểm AI ----------

test('engines: lệnh chạy dưới quyền agentos, cài đặt vào /var/lib/agentos/.local, kiểm đăng nhập qua stdin', async () => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args.includes('install')) return { code: 0, out: 'ok', err: '' };
    if (args.includes('--version')) return { code: 0, out: '2.1.302 (Claude Code)\n', err: '' };
    if (args.includes('-p')) return { code: 0, out: '{"result":"OK"}', err: '' };
    return { code: 1, out: '', err: 'Please run codex login' };
  };
  await engines.install(run, 'claude');
  assert.equal(calls[0].cmd, 'runuser'); assert.deepEqual(calls[0].args.slice(0, 3), ['-u', 'agentos', '--']);
  assert.ok(calls[0].args.includes('@anthropic-ai/claude-code') && calls[0].args.includes('/var/lib/agentos/.local'));
  assert.equal(await engines.installed(run, 'claude'), '2.1.302 (Claude Code)');
  assert.deepEqual(await engines.verifyLogin(run, 'claude'), { ok: true, detail: 'đăng nhập tốt' });
  assert.equal(calls.at(-1).opts.input, 'Trả lời đúng một từ: OK');
  const cx = await engines.verifyLogin(run, 'codex');
  assert.equal(cx.ok, false); assert.ok(cx.detail.startsWith('chưa đăng nhập'), cx.detail);
  // Hết hạn mức (tin thật từ máy người dùng 20/10/2026) => ĐÃ đăng nhập, không phải chưa đăng nhập
  const lim = await engines.verifyLogin(async () => ({ code: 1, out: '', err: "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again later." }), 'codex');
  assert.equal(lim.ok, true); assert.equal(lim.limited, true);
  // Hạn mức + lỗi đăng nhập thật thì vẫn là chưa đăng nhập
  assert.equal((await engines.verifyLogin(async () => ({ code: 1, out: '', err: 'unauthorized: please run codex login' }), 'codex')).ok, false);
  await assert.rejects(() => engines.install(run, 'gemini'), /không biết/);
  await assert.rejects(() => engines.install(async () => ({ code: 1, out: '', err: 'EACCES\nboom' }), 'codex'), /Cài codex thất bại: EACCES \| boom/);
});

// ---------- máy chủ ----------

async function boot(extra) {
  const dir = tmp();
  const envFile = path.join(dir, 'orchestrator.env');
  const calls = [];
  const sent = [];
  let paired = false;
  const T = fakeTelegram((m, b) => {
    if (m === 'getMe') return { ok: true, result: { id: 9, username: 'cua_hang_bot', first_name: 'CH' } };
    if (m === 'getUpdates') {
      if (b.timeout === 0 || paired) return { ok: true, result: [] };
      paired = true;
      return { ok: true, result: [{ update_id: 5, message: { chat: { type: 'private' }, text: '/start 123456', from: { id: 777, first_name: 'Chủ' } } }] };
    }
    if (m === 'sendMessage') { sent.push(b); return { ok: true, result: {} }; }
    return { ok: true, result: {} };
  });
  const run = async (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    const a = args.join(' ');
    if (cmd === 'nmcli' && a === '-t -f CONNECTIVITY general') return { code: 0, out: 'full', err: '' };
    if (cmd === 'nmcli' && a.includes('DEVICE,TYPE,STATE')) return { code: 0, out: 'wlan0:wifi:connected', err: '' };
    if (args.includes('install')) return { code: 0, out: '', err: '' };
    if (args.includes('--version')) return { code: 0, out: '1.0.0', err: '' };
    if (args.includes('-p')) return { code: 0, out: '{"result":"OK"}', err: '' };
    return { code: 0, out: '', err: '' };
  };
  const w = createWizard(Object.assign({
    port: 0, host: '127.0.0.1', envFile, run, fetch: T.f, code: '123456', stateFile: path.join(dir, 'state.json'), hotspotFile: path.join(dir, 'hotspot.json'),
    hotspotDelayMs: 0, captivePort: 0, pollPauseMs: 5, waitMs: 3000, finishDelayMs: 60000,
    // Không bao giờ đụng /etc thật khi test
    fullAccessPaths: { sudoers: path.join(dir, 'sudoers.d', '90-agentos-toan-quyen'), dropin: path.join(dir, 'dropin', '10-toan-quyen.conf') },
  }, extra || {}));
  const port = await w.listen();
  const call = async (method, p, body, headers) => {
    const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: Object.assign({ 'content-type': 'application/json', 'x-agentos-wizard': '1' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* html */ }
    return { status: r.status, body: j, text };
  };
  return { w, port, call, envFile, calls, sent };
}

test('server: chỉ nhận Host cục bộ và yêu cầu tiêu đề bảo vệ; phục vụ giao diện; đường lạ 404', async () => {
  const S = await boot();
  try {
    const page = await S.call('GET', '/');
    assert.equal(page.status, 200); assert.match(page.text, /Chào mừng đến với AgentOS/);
    assert.equal((await S.call('POST', '/api/finish', {}, { 'x-agentos-wizard': '0' })).status, 403);     // thiếu tiêu đề đúng
    const evil = await new Promise((resolve) => {
      require('http').request({ host: '127.0.0.1', port: S.port, path: '/api/state', headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); }).end();
    });
    assert.equal(evil, 403);                                                                              // DNS rebinding
    assert.equal((await S.call('GET', '/khong-co')).status, 404);
    assert.equal((await S.call('POST', '/api/finish', {})).status, 400);                                  // chưa xong Telegram
  } finally { await S.w.close(); }
});

test('server: luồng đầy đủ Wi-Fi -> Telegram -> AI -> hoàn tất ghi cấu hình, bật dịch vụ, nhắn chủ máy', async () => {
  const S = await boot();
  try {
    const st = await S.call('GET', '/api/state');
    assert.equal(st.body.net.online, true); assert.equal(st.body.finished, false);

    const wc = await S.call('POST', '/api/wifi/connect', { ssid: 'Shop', password: 'matkhau123' });
    assert.equal(wc.status, 200);
    assert.ok(S.calls.some((c) => c[0] === 'nmcli' && c[1].includes('matkhau123') && c[2] && c[2].secret));

    assert.equal((await S.call('POST', '/api/telegram/token', { token: 'sai' })).status, 400);
    assert.equal((await S.call('POST', '/api/telegram/wait', {})).body.error, 'Chưa nhập token bot');
    const tk = await S.call('POST', '/api/telegram/token', { token: TOKEN });
    assert.equal(tk.body.bot.username, 'cua_hang_bot'); assert.equal(tk.body.code, '123456');
    const ow = await S.call('POST', '/api/telegram/wait', {});
    assert.equal(ow.body.owner.id, '777');

    assert.equal((await S.call('POST', '/api/finish', {})).body.error, 'Chưa có AI nào đăng nhập được');
    assert.equal((await S.call('POST', '/api/engine/install', { engine: 'gemini' })).status, 400);
    await S.call('POST', '/api/engine/install', { engine: 'claude' });
    for (let i = 0; i < 40; i++) { const s = await S.call('GET', '/api/state'); if (s.body.jobs['install-claude'].status !== 'running') break; await new Promise((r) => setTimeout(r, 25)); }
    assert.equal((await S.call('GET', '/api/state')).body.jobs['install-claude'].status, 'done');
    const ck = await S.call('POST', '/api/engine/check', { engine: 'claude' });
    assert.deepEqual([ck.body.installed, ck.body.loggedIn], ['1.0.0', true]);
    assert.equal((await S.call('POST', '/api/engine/login', { engine: 'claude' })).body.opened, true);
    assert.ok(S.calls.some((c) => c[0] === 'xhost') && S.calls.some((c) => c[0] === 'runuser' && c[1].includes('xfce4-terminal')));

    const fin = await S.call('POST', '/api/finish', {});
    assert.deepEqual(fin.body, { ok: true, engines: ['claude'] });
    const env = fs.readFileSync(S.envFile, 'utf8');
    assert.match(env, /^TELEGRAM_TOKEN=123456789:/m); assert.match(env, /^ALLOWED_USER_IDS=777$/m); assert.match(env, /^ENGINE_ORDER=claude$/m);
    assert.ok(S.calls.some((c) => c[0] === 'systemctl' && c[1].join(' ') === 'enable --now agentos-orchestrator.service'));
    const welcome = S.sent.filter((s) => /AgentOS đã sẵn sàng/.test(s.text));
    assert.equal(welcome.length, 1); assert.equal(welcome[0].chat_id, '777');
    assert.ok(S.sent.some((s) => /Đã ghép đôi với bạn \(Chủ\)/.test(s.text)));          // tin báo ghép đôi thành công
    assert.equal((await S.call('GET', '/api/state')).body.finished, true);
  } finally { await S.w.close(); }
});

// ---------- chế độ TOÀN QUYỀN (chủ máy tự tích) ----------

const fullaccess = require('../lib/fullaccess');
const fapaths = (S) => ({ sudoers: path.join(path.dirname(S.envFile), 'sudoers.d', '90-agentos-toan-quyen'), dropin: path.join(path.dirname(S.envFile), 'dropin', '10-toan-quyen.conf') });
async function toFinish(S) {
  await S.call('POST', '/api/telegram/token', { token: TOKEN });
  await S.call('POST', '/api/telegram/wait', {});
  await S.call('POST', '/api/engine/install', { engine: 'claude' });
  for (let i = 0; i < 40; i++) { const s = await S.call('GET', '/api/state'); if (s.body.jobs['install-claude'].status !== 'running') break; await new Promise((r) => setTimeout(r, 25)); }
  await S.call('POST', '/api/engine/check', { engine: 'claude' });
}

test('toàn quyền: mặc định TẮT - hoàn tất không cài sudo, FULL_ACCESS=0', async () => {
  const S = await boot();
  try {
    assert.equal((await S.call('GET', '/api/state')).body.fullAccess, false);
    await toFinish(S);
    assert.equal((await S.call('POST', '/api/finish', {})).body.ok, true);
    const env = fs.readFileSync(S.envFile, 'utf8');
    assert.match(env, /^FULL_ACCESS=0$/m); assert.match(env, /^JOB_TIMEOUT_SEC=900$/m);
    assert.ok(!S.calls.some((c) => c[0] === 'visudo'), 'không đụng tới sudo khi chủ máy không tích');
  } finally { await S.w.close(); }
});

test('toàn quyền: chủ máy tích -> hoàn tất cài sudo không mật khẩu (qua visudo -cf), gỡ giới hạn systemd, FULL_ACCESS=1', async () => {
  const S = await boot();
  const paths = fapaths(S);
  try {
    assert.equal((await S.call('POST', '/api/fullaccess', { on: 'true' })).body.fullAccess, false);   // chỉ nhận đúng true (không nhận chuỗi)
    assert.equal((await S.call('POST', '/api/fullaccess', { on: true })).body.fullAccess, true);
    assert.equal((await S.call('GET', '/api/state')).body.fullAccess, true);
    await toFinish(S);
    assert.ok(!fs.existsSync(paths.sudoers), 'chưa bấm Hoàn tất thì chưa cài gì');
    assert.equal((await S.call('POST', '/api/finish', {})).body.ok, true);
    assert.match(fs.readFileSync(paths.sudoers, 'utf8'), /^agentos ALL=\(ALL:ALL\) NOPASSWD: ALL$/m);
    assert.match(fs.readFileSync(paths.dropin, 'utf8'), /NoNewPrivileges=no[\s\S]*ProtectSystem=no/);
    const vi = S.calls.find((c) => c[0] === 'visudo'); assert.ok(vi && vi[1][0] === '-cf');
    assert.ok(S.calls.findIndex((c) => c[0] === 'visudo') < S.calls.findIndex((c) => c[0] === 'systemctl' && c[1][0] === 'enable'), 'sudo cài TRƯỚC khi bật dịch vụ');
    assert.ok(S.calls.some((c) => c[0] === 'systemctl' && c[1].join(' ') === 'daemon-reload'));
    const env = fs.readFileSync(S.envFile, 'utf8');
    assert.match(env, /^FULL_ACCESS=1$/m); assert.match(env, /^JOB_TIMEOUT_SEC=3600$/m);
  } finally { await S.w.close(); }
});

test('toàn quyền: tệp sudo không hợp lệ thì KHÔNG cài (visudo từ chối), gỡ bằng disable', async () => {
  const dir = tmp(); const o = { sudoers: path.join(dir, 'sudoers.d', '90-x'), dropin: path.join(dir, 'd', '10-x.conf') };
  await assert.rejects(() => fullaccess.enable(async () => ({ code: 1, out: '', err: 'syntax error near line 3' }), o), /không hợp lệ/);
  assert.ok(!fs.existsSync(o.sudoers) && !fs.existsSync(o.sudoers + '.tmp') && !fs.existsSync(o.dropin));
  const ok = async () => ({ code: 0, out: '', err: '' });
  await fullaccess.enable(ok, o); assert.ok(fullaccess.isEnabled(o));
  await fullaccess.disable(ok, o); assert.ok(!fullaccess.isEnabled(o) && !fs.existsSync(o.dropin));
});
