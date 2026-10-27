'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const mask = require('../lib/mask');
const odauth = require('../lib/odauth');
const apikeys = require('../lib/apikeys');
const { createSettings } = require('../settings/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-acc-'));
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

test('che thông tin: cho biết "đã có" nhưng không lộ đủ để dùng; khóa ngắn che hết', () => {
  assert.equal(mask.secret(''), ''); assert.equal(mask.secret('abc'), mask.DOTS); assert.equal(mask.secret('sk-ant-api03-ABCDEFGHIJKLMNOP'), 'sk-a••••NOP');
  assert.equal(mask.telegramToken(TOKEN), '1234••••:••••saw');
  assert.equal(mask.email('chien.nguyen@gmail.com'), 'c•••@g•••.com'); assert.equal(mask.email('khong-phai-email'), 'k•••');
  assert.equal(mask.name('Nguyễn Văn An'), 'N••• V••• A•••'); assert.equal(mask.digits('0336190599'), '••••599');
  for (const s of [TOKEN, 'sk-ant-api03-ABCDEFGHIJKLMNOP', 'chien.nguyen@gmail.com']) assert.ok(!mask.secret(s).includes(s.slice(8, 20)), 'không lộ phần giữa');
});

test('odauth: đổi địa chỉ nhận mã sang máy này + state, đổi mã lấy khóa làm mới, hỏi chủ ổ đĩa; lỗi Microsoft báo rõ', async () => {
  const u = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=cid-1&scope=Files.ReadWrite%20offline_access&response_type=code&prompt=login&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient';
  assert.deepEqual(odauth.parseAuthUrl(u), { clientId: 'cid-1', scope: 'Files.ReadWrite offline_access' }); assert.equal(odauth.parseAuthUrl('https://evil.example/x'), null);
  const a = new URL(odauth.autoUrl(u, 'http://127.0.0.1:53100/', 'ST'));
  assert.equal(a.searchParams.get('redirect_uri'), 'http://127.0.0.1:53100/'); assert.equal(a.searchParams.get('state'), 'ST'); assert.equal(a.searchParams.get('client_id'), 'cid-1');
  const seen = [];
  const f = async (url, init) => { seen.push([String(url), init && init.body]); return { ok: true, status: 200, json: async () => ({ refresh_token: ' RT-abc \n', access_token: 'AT' }) }; };
  const ex = await odauth.exchange({ fetch: f, clientId: 'cid-1', scope: 's', code: 'CODE', redirect: 'http://127.0.0.1:53100/' });
  assert.deepEqual(ex, { refreshToken: 'RT-abc', accessToken: 'AT' });
  const body = new URLSearchParams(seen[0][1]); assert.equal(body.get('grant_type'), 'authorization_code'); assert.equal(body.get('code'), 'CODE'); assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:53100/');
  const bad = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'AADSTS70000: mã hết hạn\nTrace ID: x' }) });
  await assert.rejects(odauth.exchange({ fetch: bad, clientId: 'c', scope: 's', code: 'x', redirect: 'r' }), /AADSTS70000: mã hết hạn/);
  assert.deepEqual(await odauth.whoami(async () => ({ ok: true, json: async () => ({ driveType: 'personal', owner: { user: { displayName: 'Lan' } } }) }), 'AT'), { name: 'Lan', email: '', driveType: 'personal' });
  assert.equal(await odauth.whoami(async () => { throw new Error('mạng'); }, 'AT'), null);
});

function boot(extra) {
  const dir = tmp(); const home = path.join(dir, 'home'); fs.mkdirSync(path.join(home, '.codex'), { recursive: true }); fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  const conf = path.join(dir, 'od'); fs.mkdirSync(conf, { recursive: true });
  const envFile = path.join(dir, 'orchestrator.env');
  const KEYS = { claude: 'sk-ant-' + 'a1B2c3D4'.repeat(4), deepseekapi: 'sk-' + 'Zz9'.repeat(12) };
  fs.writeFileSync(envFile, ['TELEGRAM_TOKEN=' + TOKEN, 'ALLOWED_USER_IDS=111222333,5', 'ADMIN_USER_IDS=111222333', 'ENGINE_ORDER=claude,codex',
    apikeys.VAR.claude + '=' + KEYS.claude, apikeys.VAR.deepseekapi + '=' + KEYS.deepseekapi,
    'KIOTVIET_CLIENT_ID=kv-client-id-0123456789abcdef', 'KIOTVIET_CLIENT_SECRET=kv-secret-ABCDEFGHIJKLMNOPQRSTUV', 'KIOTVIET_RETAILER=cuahanghuyenanh', ''].join('\n'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'chien.nguyen@gmail.com' } }));
  const jwt = 'x.' + Buffer.from(JSON.stringify({ email: 'chu.cuahang@outlook.com' })).toString('base64url') + '.y';
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: jwt, access_token: 'SECRET-ACCESS-TOKEN-VALUE', refresh_token: 'SECRET-REFRESH-VALUE' } }));
  fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ refresh_token: 'SECRET-GEMINI-REFRESH' }));
  fs.writeFileSync(path.join(home, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'gia.dung@gmail.com' }));
  const tokenCalls = [];
  const apiFetch = async (url, init) => {
    url = String(url);
    if (/api\.telegram\.org/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 9, username: 'bot_moi', first_name: 'Bot' } }) };
    if (/oauth2\/v2\.0\/token/.test(url)) { tokenCalls.push(String(init.body)); return { ok: true, status: 200, json: async () => ({ refresh_token: 'RT-DAY-LA-KHOA-LAM-MOI', access_token: 'AT-1' }) }; }
    if (/graph\.microsoft\.com/.test(url)) return { ok: true, status: 200, json: async () => ({ driveType: 'personal', owner: { user: { displayName: 'Nguyen Van An' } } }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const run = async (cmd, args) => (cmd === 'systemctl' ? { code: 0, out: 'active\n', err: '' } : cmd === 'runuser' && args.includes('--version') ? { code: 0, out: '2.1.0\n', err: '' } : { code: 0, out: '', err: '' });
  const spawn = (cmd, args) => {
    const c = new EventEmitter(); c.kill = () => {}; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    if (cmd === 'runuser' && args.includes('onedrive')) fs.writeFileSync(path.join(conf, 'auth-url.txt'), 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=cid-9&scope=Files.ReadWrite%20offline_access&response_type=code&prompt=login&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient\n');
    else setImmediate(() => c.emit('close', 0));
    return c;
  };
  const s = createSettings(Object.assign({ port: 0, host: '127.0.0.1', envFile, versionFile: path.join(dir, 'VERSION'), backupDir: path.join(dir, 'bk'), onedriveConf: conf, onedriveDir: path.join(dir, 'odir'), homeDir: home, odPort: 0,
    run, spawn, fetch: apiFetch, peerUid: () => 1000, allowedUids: () => new Set([1000]), pageFile: path.join(__dirname, '..', 'settings', 'index.html'), updater: {}, tsRun: async () => ({ code: 0, out: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'may-a.ts.net.', TailscaleIPs: ['100.64.1.2'] } }), err: '' }),
    memFallback: path.join(dir, 'so-tay'), exit: () => {}, sleep: () => new Promise((r) => setTimeout(r, 2)), odPollMs: 2, odSettleMs: 0, updatePubkey: path.join(dir, 'pub.pem') }, extra || {}));
  fs.writeFileSync(path.join(dir, 'pub.pem'), 'PUBKEY');
  return s.listen().then((port) => ({ s, port, dir, conf, KEYS, tokenCalls, call: async (m, p, b) => { const r = await fetch('http://127.0.0.1:' + port + '/api/' + p, { method: m, headers: { 'content-type': 'application/json', 'x-agentos-settings': '1' }, body: m === 'POST' ? JSON.stringify(b || {}) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* html */ } return { status: r.status, body: j, text: t }; } }));
}

test('trang Tài khoản đã lưu: cho biết cái gì đã có, che bớt bí mật — không lộ khóa, token, email đầy đủ ở BẤT KỲ chỗ nào trong phản hồi', async () => {
  const S = await boot();
  try {
    const r = await S.call('GET', 'accounts'); assert.equal(r.status, 200);
    const g = Object.fromEntries(r.body.groups.map((x) => [x.id, x]));
    assert.equal(g.telegram.status, 'ok'); assert.deepEqual(g.telegram.rows[0], ['Token bot', '1234••••:••••saw']); assert.equal(g.telegram.rows[1][1], '@bot_moi');
    assert.equal(g['ai-claude'].status, 'ok');
    assert.match(JSON.stringify(g['ai-claude'].rows), /sk-a••••/); assert.match(JSON.stringify(g['ai-claude'].rows), /c•••@g•••\.com/);
    assert.match(JSON.stringify(g['ai-codex'].rows), /c•••@o•••\.com/); assert.match(JSON.stringify(g['ai-gemini'].rows), /g•••@g•••\.com/);
    assert.equal(g['ai-deepseekapi'].status, 'ok'); assert.equal(g.onedrive.status, 'none'); assert.equal(g.tailscale.status, 'ok'); assert.match(JSON.stringify(g.tailscale.rows), /100\.64\.1\.2/);
    assert.equal(g.kiotviet.status, 'ok'); assert.equal(g.kiotviet.rows[0][1], 'cuahanghuyenanh'); assert.match(JSON.stringify(g.kiotviet.rows), /kv-c••••def/);
    assert.match(JSON.stringify(g.system.rows), /dấu vân [0-9a-f]{16}/);
    // KHÔNG lộ bí mật nào, ở bất kỳ đâu
    const all = r.text;
    for (const secret of [TOKEN, TOKEN.slice(10, 30), S.KEYS.claude, S.KEYS.claude.slice(8, 24), S.KEYS.deepseekapi.slice(6, 20), 'chien.nguyen@gmail.com', 'chu.cuahang@outlook.com', 'gia.dung@gmail.com', 'SECRET-ACCESS-TOKEN-VALUE', 'SECRET-REFRESH-VALUE', 'SECRET-GEMINI-REFRESH', 'kv-secret-ABCDEFGHIJKLMNOPQRSTUV', 'kv-client-id-0123456789abcdef'])
      assert.ok(!all.includes(secret), 'lộ: ' + secret);
    const page = await fetch('http://127.0.0.1:' + S.port + '/'); assert.match(await page.text(), /Tài khoản đã lưu/);
  } finally { await S.s.close(); }
  const N = await boot({ envFile: path.join(tmp(), 'khong-co.env') });                    // chưa cấu hình: báo "chưa có", không lỗi
  try { const r = await N.call('GET', 'accounts'); assert.equal(r.status, 200); assert.equal(r.body.groups.find((x) => x.id === 'telegram').status, 'none'); } finally { await N.s.close(); }
});

test('OneDrive tự nhận mã (không cần copy): sai state bị từ chối, đúng thì đổi mã, ghi khóa làm mới thô quyền 600, lưu tên tài khoản (che), đóng cổng', async () => {
  const S = await boot();
  try {
    const st = (await S.call('POST', 'onedrive/start')).body;
    assert.equal(st.auto, true); assert.match(st.url, /nativeclient/);
    const a = new URL(st.autoUrl); const redirect = a.searchParams.get('redirect_uri'); const state = a.searchParams.get('state');
    assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/$/); assert.equal(a.searchParams.get('client_id'), 'cid-9');
    assert.equal((await S.call('GET', 'onedrive/auth-status')).body.status, 'waiting');
    const wrong = await fetch(redirect + '?code=KHONG&state=sai'); assert.match(await wrong.text(), /không hợp lệ/);
    assert.equal((await S.call('GET', 'onedrive/auth-status')).body.status, 'waiting', 'sai state không làm đổi gì');
    assert.equal(fs.existsSync(path.join(S.conf, 'refresh_token')), false);
    const okp = await fetch(redirect + '?code=M.C509.xyz&state=' + state); assert.match(await okp.text(), /Đã nhận mã đăng nhập/);
    for (let i = 0; i < 100 && (await S.call('GET', 'onedrive/auth-status')).body.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await S.call('GET', 'onedrive/auth-status')).body.status, 'done');
    assert.equal(fs.readFileSync(path.join(S.conf, 'refresh_token'), 'utf8'), 'RT-DAY-LA-KHOA-LAM-MOI');                      // chuỗi thô, không xuống dòng
    assert.equal(fs.statSync(path.join(S.conf, 'refresh_token')).mode & 0o777, 0o600);
    const body = new URLSearchParams(S.tokenCalls[0]); assert.equal(body.get('code'), 'M.C509.xyz'); assert.equal(body.get('redirect_uri'), redirect); assert.equal(body.get('client_id'), 'cid-9');
    const od = (await S.call('GET', 'onedrive')).body; assert.equal(od.connected, true); assert.equal(od.account.name, 'N••• V••• A•••'); assert.ok(!JSON.stringify(od).includes('Nguyen Van An'));
    await assert.rejects(fetch(redirect + '?code=lan2&state=' + state, { signal: AbortSignal.timeout(1500) }), 'cổng đã đóng sau khi nhận mã');
    const acc = (await S.call('GET', 'accounts')).body.groups.find((x) => x.id === 'onedrive'); assert.equal(acc.status, 'ok'); assert.match(JSON.stringify(acc.rows), /N••• V••• A•••/);
    assert.equal((await S.call('POST', 'onedrive/disconnect', { confirm: true })).body.connected, false); assert.equal(fs.existsSync(path.join(S.conf, 'account.json')), false);
  } finally { await S.s.close(); }
});

test('OneDrive tự nhận mã: Microsoft báo lỗi / đổi mã thất bại thì báo rõ để dùng cách dán tay; cổng bận thì chỉ còn cách dán tay', async () => {
  const S = await boot();
  try {
    const st = (await S.call('POST', 'onedrive/start')).body; const a = new URL(st.autoUrl);
    const r1 = await fetch(a.searchParams.get('redirect_uri') + '?error=access_denied&error_description=AADSTS65004%3A+bạn+đã+từ+chối&state=' + a.searchParams.get('state'));
    assert.match(await r1.text(), /Microsoft báo lỗi/);
    const s1 = (await S.call('GET', 'onedrive/auth-status')).body; assert.equal(s1.status, 'error'); assert.match(s1.error, /AADSTS65004/);
  } finally { await S.s.close(); }
  const busy = require('http').createServer(() => {}); await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const S2 = await boot({ odPort: busy.address().port });
  try { const st = (await S2.call('POST', 'onedrive/start')).body; assert.equal(st.auto, false); assert.match(st.url, /nativeclient/); } finally { await S2.s.close(); busy.close(); }
});

test('trang AI và khóa API: hiện AI nào đang đăng nhập bằng tài khoản nào (email đã che) và bot đang dùng khóa hay tài khoản', async () => {
  const S = await boot();
  try {
    const r = await S.call('GET', 'ai'); assert.equal(r.status, 200);
    const e = Object.fromEntries(r.body.engines.map((x) => [x.id, x]));
    assert.deepEqual(e.claude.login, { loggedIn: true, how: 'tài khoản Claude', who: 'c•••@g•••.com' }); assert.equal(e.claude.using, 'key', 'có khóa thì khóa được ưu tiên');
    assert.deepEqual(e.codex.login, { loggedIn: true, how: 'tài khoản ChatGPT/OpenAI', who: 'c•••@o•••.com' }); assert.equal(e.codex.using, 'account');
    assert.deepEqual(e.gemini.login, { loggedIn: true, how: 'tài khoản Google', who: 'g•••@g•••.com' });
    assert.equal(e.deepseekapi.login.loggedIn, false); assert.equal(e.deepseekapi.using, 'key');
    for (const secret of ['chien.nguyen@gmail.com', 'chu.cuahang@outlook.com', 'gia.dung@gmail.com', 'SECRET-ACCESS-TOKEN-VALUE', 'SECRET-REFRESH-VALUE', 'SECRET-GEMINI-REFRESH', S.KEYS.claude]) assert.ok(!r.text.includes(secret), 'lộ: ' + secret);
    const page = await (await fetch('http://127.0.0.1:' + S.port + '/')).text(); assert.match(page, /Tài khoản đăng nhập: /); assert.match(page, /Bot đang dùng: /);
    fs.rmSync(path.join(S.dir, 'home', '.codex', 'auth.json'));                       // đăng xuất Codex -> chưa đăng nhập
    const r2 = await S.call('GET', 'ai'); const c2 = r2.body.engines.find((x) => x.id === 'codex'); assert.equal(c2.login.loggedIn, false); assert.equal(c2.using, 'none');
  } finally { await S.s.close(); }
});

test('OneDrive đồng bộ chọn lọc: kết nối mới mặc định chỉ /AgentOS; đổi danh sách thì ghi sync_list và đồng bộ lại (--resync); đầu vào xấu bị từ chối; "tất cả" cần xác nhận', async () => {
  const synclist = require('../lib/synclist');
  assert.deepEqual(synclist.clean(['Kế toán', '/Kho/', '//Dữ liệu//báo cáo', '/kho']), ['/AgentOS', '/Kế toán', '/Kho', '/Dữ liệu/báo cáo', '/kho'].filter((x, i, a) => a.indexOf(x) === i));
  assert.deepEqual(synclist.clean('/agentos\n/Kho'), ['/agentos', '/Kho']);                // đã có AgentOS (không phân biệt hoa thường) thì không thêm
  for (const bad of [['/../etc'], ['/a/../b'], ['/'], ['*'], ['/a?b'], ['/a\b'], ['/x{y}']]) assert.throws(() => synclist.clean(bad), /không hợp lệ|TOÀN BỘ/, JSON.stringify(bad));
  const spawned = [];
  const S = await boot({ spawn: (cmd, args) => {
    spawned.push([cmd].concat(args));
    const c = new EventEmitter(); c.kill = () => {}; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    if (cmd === 'runuser' && args.includes('onedrive') && !args.includes('--resync')) fs.writeFileSync(path.join(S2conf(), 'auth-url.txt'), 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=cid-9&scope=Files.ReadWrite%20offline_access&response_type=code&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient\n');
    else setImmediate(() => c.emit('close', 0));
    return c;
  } });
  function S2conf() { return S.conf; }
  try {
    assert.deepEqual((await S.call('GET', 'onedrive')).body.folders, []); assert.equal((await S.call('GET', 'onedrive')).body.syncAll, true);   // chưa có danh sách = toàn bộ (máy cũ)
    await S.call('POST', 'onedrive/start');                                                  // kết nối MỚI
    assert.equal(fs.readFileSync(path.join(S.conf, 'sync_list'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).join(','), '/AgentOS');
    assert.equal((await S.call('POST', 'onedrive/folders', { folders: ['/Kho'] })).status, 400, 'chưa kết nối (chưa có khóa) thì từ chối');
    fs.writeFileSync(path.join(S.conf, 'refresh_token'), 'rt');                              // coi như đã kết nối
    const od = (await S.call('GET', 'onedrive')).body; assert.equal(od.syncAll, false); assert.deepEqual(od.folders, ['/AgentOS']);
    assert.equal((await S.call('POST', 'onedrive/folders', { folders: ['/../x'] })).status, 400);
    assert.equal((await S.call('POST', 'onedrive/folders', { all: true })).status, 400, 'toàn bộ cần xác nhận');
    spawned.length = 0;
    const r = await S.call('POST', 'onedrive/folders', { folders: ['Kế toán', '/Hóa đơn'] }); assert.equal(r.status, 200); assert.deepEqual(r.body.folders, ['/AgentOS', '/Kế toán', '/Hóa đơn']);
    for (let i = 0; i < 100 && spawned.length < 3; i++) await new Promise((x) => setTimeout(x, 20));
    assert.deepEqual(spawned.map((s) => s[0] + ' ' + (s.includes('--resync') ? 'resync' : s[1])).slice(0, 3), ['systemctl stop', 'runuser resync', 'systemctl start']);
    const resync = spawned.find((s) => s.includes('--resync')); assert.ok(resync.includes('--sync') && resync.includes('--resync-auth') && resync.includes('agentos'), 'chạy dưới người dùng agentos, không hỏi xác nhận');
    for (const verb of ['stop', 'start']) assert.ok(spawned.some((s) => s[0] === 'systemctl' && s[1] === verb && s.includes('onedrive-agentos.path') && s.includes('onedrive-agentos.service')), 'phải ' + verb + ' cả .path và .service (.path tự bật lại dịch vụ)');
    assert.equal(fs.readFileSync(path.join(S.conf, 'sync_list'), 'utf8').includes('/Kế toán'), true);
    const all = await S.call('POST', 'onedrive/folders', { all: true, confirmAll: true }); assert.equal(all.status, 200); assert.equal(all.body.all, true);
    for (let i = 0; i < 100 && (await S.call('GET', 'onedrive')).body.syncAll !== true; i++) await new Promise((x) => setTimeout(x, 20));
    assert.equal(fs.existsSync(path.join(S.conf, 'sync_list')), false, 'chọn tất cả thì bỏ sync_list');
  } finally { await S.s.close(); }
});

test('Kho tệp riêng: trạng thái, cài (công việc nền), xem/đổi mật khẩu cần đúng thao tác, gỡ cần xác nhận; chưa cài thì không lộ mật khẩu', async () => {
  const dir = tmp(); const bin = path.join(dir, 'agentos-cloud'); const log = path.join(dir, 'calls.txt');
  fs.writeFileSync(bin, '#!/bin/sh\necho "$1" >> ' + log + '\ncase "$1" in status) cat ' + path.join(dir, 'status.txt') + ' ;; password) grep -q installed=yes ' + path.join(dir, 'status.txt') + ' && printf "user=chu\\npassword=MAT-KHAU-THU\\n" || exit 1 ;; reset-password) printf "user=chu\\npassword=MOI-123\\n" ;; *) echo ok ;; esac\n', { mode: 0o755 });
  const S = await boot({ cloudBin: bin, run: async (cmd, args) => { if (cmd === bin) return new Promise((res) => require('child_process').execFile(cmd, args, (e, out, err) => res({ code: e ? (e.code || 1) : 0, out, err }))); return { code: 0, out: 'active\n', err: '' }; } });
  try {
    fs.writeFileSync(path.join(dir, 'status.txt'), 'installed=no\n');
    assert.deepEqual((await S.call('GET', 'cloud')).body.installed, false);
    assert.equal((await S.call('POST', 'cloud/password')).status, 400, 'chưa cài thì không có mật khẩu');
    fs.writeFileSync(path.join(dir, 'status.txt'), 'installed=yes\nrunning=yes\nuser=chu\nversion=34.0.5\nurl=http://192.168.1.5:8280\nurl=http://100.64.0.2:8280\nshare=/srv/onedrive\n');
    const st = (await S.call('GET', 'cloud')).body;
    assert.equal(st.installed, true); assert.equal(st.running, true); assert.equal(st.user, 'chu'); assert.deepEqual(st.urls, ['http://192.168.1.5:8280', 'http://100.64.0.2:8280']);
    assert.ok(!JSON.stringify(st).includes('MAT-KHAU'), 'trạng thái không chứa mật khẩu');
    assert.equal((await S.call('POST', 'cloud/password')).body.password, 'MAT-KHAU-THU');
    assert.equal((await S.call('POST', 'cloud/reset-password', {})).status, 400); assert.equal((await S.call('POST', 'cloud/reset-password', { confirm: true })).body.password, 'MOI-123');
    assert.equal((await S.call('POST', 'cloud/remove', {})).status, 400);
    const j = (await S.call('POST', 'cloud/install')).body.job; assert.ok(j);
    const end = Date.now() + 5000; let job; while (Date.now() < end) { job = (await S.call('GET', 'jobs/' + j + '?from=0')).body; if (job.status !== 'running') break; await new Promise((r) => setTimeout(r, 30)); }
    assert.equal(job.status, 'done'); assert.ok(job.lines.some((l) => l === '$ ' + bin + ' install'), 'chạy đúng lệnh cài');
  } finally { await S.s.close(); }
});

test('Dự án (Cài đặt): tạo, đổi AI ưu tiên/người dùng, lưu chỉ dẫn, xem tệp, cất, xóa cần xác nhận; dữ liệu cùng tệp .du-an.json với bộ điều phối', async () => {
  const dir = tmp(); const S = await boot({ onedriveDir: dir });
  try {
    assert.deepEqual((await S.call('GET', 'projects')).body.list, []);
    assert.equal((await S.call('POST', 'projects/create', { name: 'x' })).status, 400);
    const c = (await S.call('POST', 'projects/create', { name: 'Kế toán 2026' })).body.project; assert.equal(c.id, 'ke-toan-2026');
    assert.equal((await S.call('POST', 'projects/create', { name: 'kế toán 2026' })).status, 400, 'trùng tên');
    assert.equal((await S.call('POST', 'projects/update', { id: c.id, engine: 'codex', users: '111222333, 555666777' })).status, 200);
    assert.equal((await S.call('POST', 'projects/instructions', { id: c.id, text: 'Luôn trả lời bằng bảng.' })).status, 200);
    fs.writeFileSync(path.join(c.dir, 'TAI-LIEU', 'a.txt'), 'x');
    const g = (await S.call('GET', 'projects')).body; const p = g.list[0];
    assert.equal(p.engine, 'codex'); assert.deepEqual(p.users, ['111222333', '555666777']); assert.match(p.instructions, /Luôn trả lời bằng bảng/); assert.equal(p.usage.docs, 1); assert.ok(g.engines.includes('claude'));
    assert.deepEqual((await S.call('POST', 'projects/files', { id: c.id })).body.docs.map((x) => x.name), ['a.txt']);
    // cùng định dạng với bộ điều phối đọc
    const { createProjects } = require('../../orchestrator/src/projects'); const P = createProjects({ baseDir: dir });
    assert.equal(P.get('ke-toan-2026').engine, 'codex'); assert.equal(P.instructions('ke-toan-2026'), 'Luôn trả lời bằng bảng.');
    await S.call('POST', 'projects/update', { id: c.id, archived: true }); assert.equal(P.list().length, 0); assert.equal(P.list({ all: true }).length, 1);
    assert.equal((await S.call('POST', 'projects/delete', { id: c.id })).status, 400);
    assert.equal((await S.call('POST', 'projects/delete', { id: c.id, confirm: true })).status, 200); assert.equal((await S.call('GET', 'projects')).body.list.length, 0);
  } finally { await S.s.close(); }
});

test('Cài đặt: sao lưu ra ổ ngoài — liệt kê ổ, chọn ổ (kiểm đầu vào), chạy/kiểm tra bằng công việc nền, tắt cần xác nhận', async () => {
  const dir = tmp(); const bin = path.join(dir, 'agentos-backup'); const calls = path.join(dir, 'calls.txt');
  fs.writeFileSync(bin, '#!/bin/sh\necho "$@" >> ' + calls + '\ncase "$1" in devices) echo \'{"path":"/dev/sdb1","uuid":"AAAA-1111","label":"USB","fstype":"ext4","size":8000000000,"mount":"","external":true,"model":"x"}\' ;; *) echo ok ;; esac\n', { mode: 0o755 });
  const files = { statusFile: path.join(dir, 'st.json'), confFile: path.join(dir, 'conf.json'), triggerFile: path.join(dir, 'now') };
  const S = await boot({ backupBin: bin, backupFiles: files, run: async (cmd, args) => { if (cmd === bin) return new Promise((res) => require('child_process').execFile(cmd, args, (e, out, err) => res({ code: e ? 1 : 0, out, err }))); return { code: 0, out: 'inactive\n', err: '' }; } });
  try {
    let g = (await S.call('GET', 'diskbackup')).body; assert.equal(g.status.configured, false); assert.equal(g.devices[0].uuid, 'AAAA-1111'); assert.equal(g.devices[0].external, true);
    for (const bad of [{ target: '' }, { target: 'a b; rm -rf /' }, { target: 'AAAA-1111', keepDays: 0 }, { target: 'AAAA-1111', keepDays: 9999 }]) assert.equal((await S.call('POST', 'diskbackup/set', bad)).status, 400, JSON.stringify(bad));
    const j = (await S.call('POST', 'diskbackup/set', { target: 'AAAA-1111', keepDays: 14 })).body.job; assert.ok(j);
    const end = Date.now() + 5000; let job; while (Date.now() < end) { job = (await S.call('GET', 'jobs/' + j + '?from=0')).body; if (job.status !== 'running') break; await new Promise((r) => setTimeout(r, 30)); }
    assert.ok(job.lines.some((l) => l === '$ ' + bin + ' set AAAA-1111 14'));
    fs.writeFileSync(files.confFile, '{"target":"AAAA-1111","keepDays":14}'); fs.writeFileSync(files.statusFile, JSON.stringify({ ok: true, at: 'x', ts: Date.now() / 1000, message: 'ok', bytes: 1, files: 1, secs: 1 }));
    g = (await S.call('GET', 'diskbackup')).body; assert.equal(g.status.ok, true); assert.equal(g.status.keepDays, 14);
    assert.equal((await S.call('POST', 'diskbackup/off', {})).status, 400); assert.equal((await S.call('POST', 'diskbackup/off', { confirm: true })).status, 200);
  } finally { await S.s.close(); }
});

test('Cài đặt: Chi phí AI đọc cơ sở dữ liệu bộ điều phối ở chế độ chỉ đọc (theo AI, dự án, ngày)', { skip: (() => { try { require('../../orchestrator/node_modules/better-sqlite3'); return false; } catch (e) { try { require('better-sqlite3'); return false; } catch (e2) { return true; } } })() }, async () => {
  const { openDb } = require('../../orchestrator/src/db'); const dir = tmp(); const file = path.join(dir, 'a.db'); const db = openDb(file);
  const id = db.addJob('1', 'x'); db.claimNext(); db.raw.prepare("UPDATE jobs SET engine='claude', status='done', started_at=?, finished_at=?, cost_usd=0.4 WHERE id=?").run(Date.now() - 5000, Date.now(), id); db.close();
  const S = await boot({ dbFile: file, onedriveDir: dir });
  try {
    const r = (await S.call('GET', 'usage?days=7')).body; assert.equal(r.days, 7); assert.equal(r.perEngine[0].engine, 'claude'); assert.equal(r.perEngine[0].jobs, 1); assert.equal(r.perEngine[0].cost, 0.4); assert.equal(r.daily.length, 7);
    const S2 = await boot({ dbFile: path.join(dir, 'khong-co.db') }); try { assert.equal((await S2.call('GET', 'usage')).status, 400); } finally { await S2.s.close(); }
  } finally { await S.s.close(); }
});

test('Cài đặt: Nhật ký (chỉ đọc) — danh sách, chi tiết, CSV', { skip: (() => { try { require('../../orchestrator/node_modules/better-sqlite3'); return false; } catch (e) { try { require('better-sqlite3'); return false; } catch (e2) { return true; } } })() }, async () => {
  const { openDb } = require('../../orchestrator/src/db'); const dir = tmp(); const file = path.join(dir, 'b.db'); const db = openDb(file);
  const id = db.addJob('111', 'Việc thử, có "ngoặc"'); db.claimNext(); db.finishJob(id, 'done', { result: 'xong' }); db.addAudit({ jobId: id, tool: 'Write', cls: 'write', decision: 'allow', source: 'auto', summary: '/srv/x' }); db.close();
  const S = await boot({ dbFile: file, onedriveDir: dir });
  try {
    const r = (await S.call('GET', 'audit?days=7')).body; assert.equal(r.list.length, 1); assert.equal(r.list[0].tools, 1); assert.equal(r.week.total, 1);
    const d = (await S.call('GET', 'audit/job?id=' + id)).body; assert.equal(d.result, 'xong'); assert.equal(d.tools[0].tool, 'Write');
    assert.equal((await S.call('GET', 'audit/job?id=999')).status, 400);
    assert.match((await S.call('GET', 'audit/csv?days=7')).body.csv, /^﻿Việc,/);
  } finally { await S.s.close(); }
});

test('Cài đặt: Đội máy — bật cho phép điều khiển (sinh khóa), xem địa chỉ/khóa, thêm máy con, xem tình trạng thật, xóa cần xác nhận', async () => {
  const { createFleet } = require('../../orchestrator/src/fleet'); const net = require('net');
  const dir = tmp(); const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const cf = createFleet({ file: path.join(dir, 'child.json') }); cf.save(Object.assign(cf.load(), { agent: { enabled: true, key: 'ab'.repeat(24), host: '127.0.0.1', port, name: 'Con' } }));
  const agent = cf.createAgent({ version: () => '9.9', submit: () => 1, getJob: () => null, stats: () => ({ queued: 0, diskFreeMb: 1024 }) }); await agent.listen();
  const S = await boot({ fleetFile: path.join(dir, 'head.json'), tsRun: async () => ({ code: 0, out: '', err: '' }) });
  try {
    let g = (await S.call('GET', 'fleet')).body; assert.equal(g.agent.enabled, false); assert.deepEqual(g.machines, []);
    assert.equal((await S.call('POST', 'fleet/agent', { enabled: true, name: 'Đầu não', port: 9100 })).status, 200);
    g = (await S.call('GET', 'fleet')).body; assert.equal(g.agent.enabled, true); assert.equal(g.agent.name, 'Đầu não'); assert.equal(g.agent.port, 9100); assert.equal(g.agent.hasKey, true); assert.ok(!JSON.stringify(g).includes('key"'), 'danh sách không lộ khóa');
    const k = (await S.call('POST', 'fleet/key')).body; assert.match(k.key, /^[0-9a-f]{48}$/); assert.match(k.url, /:9100$/);
    assert.equal((await S.call('POST', 'fleet/add', { name: 'Con', url: 'http://127.0.0.1:' + port, key: 'ab'.repeat(24) })).status, 200);
    assert.equal((await S.call('POST', 'fleet/add', { name: 'Con', url: 'http://127.0.0.1:' + port, key: 'ab'.repeat(24) })).status, 400, 'trùng tên');
    g = (await S.call('GET', 'fleet')).body; assert.equal(g.machines[0].online, true); assert.equal(g.machines[0].version, '9.9'); assert.ok(!JSON.stringify(g.machines).includes('abab'), 'không trả khóa máy con');
    assert.equal((await S.call('POST', 'fleet/remove', { name: 'Con' })).status, 400); assert.equal((await S.call('POST', 'fleet/remove', { name: 'Con', confirm: true })).status, 200);
    assert.equal((await S.call('POST', 'fleet/agent', { enabled: false })).status, 200); assert.equal((await S.call('GET', 'fleet')).body.agent.enabled, false);
  } finally { await S.s.close(); await agent.close(); }
});

test('Cài đặt: Thiết bị — thêm camera/ổ cắm (chỉ địa chỉ nội bộ), chụp thử trả ảnh, bật/tắt thử, xóa cần xác nhận; không lộ mật khẩu', async () => {
  const http = require('http'); const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('x')]); let on = false;
  const srv = http.createServer((req, res) => { if (req.url === '/snap') { res.writeHead(200); res.end(JPG); } else { on = /turn=on/.test(req.url) ? true : /turn=off/.test(req.url) ? false : on; res.end(JSON.stringify({ ison: on })); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port; const dir = tmp();
  const S = await boot({ devicesFile: path.join(dir, 'dev.json'), devicesOut: dir });
  try {
    assert.deepEqual((await S.call('GET', 'devices')).body, { cameras: [], plugs: [] });
    assert.equal((await S.call('POST', 'devices/camera', { name: 'Ngoài', url: 'rtsp://8.8.8.8/x' })).status, 400);
    assert.equal((await S.call('POST', 'devices/camera', { name: 'Quầy', url: base.replace('http://', 'http://tk:matkhau@') + '/snap' })).status, 200);
    assert.equal((await S.call('POST', 'devices/plug', { name: 'Đèn', type: 'shelly', url: base })).status, 200);
    const g = (await S.call('GET', 'devices')).body; assert.equal(g.cameras[0].name, 'Quầy'); assert.ok(!JSON.stringify(g).includes('matkhau'));
    const snap = (await S.call('POST', 'devices/snapshot', { name: 'Quầy' })).body; assert.match(snap.image, /^data:image\/jpeg;base64,/);
    assert.deepEqual((await S.call('POST', 'devices/plug-test', { name: 'Đèn', action: 'on' })).body, { on: true }); assert.deepEqual((await S.call('POST', 'devices/plug-test', { name: 'Đèn', action: 'off' })).body, { on: false });
    assert.equal((await S.call('POST', 'devices/remove', { kind: 'camera', name: 'Quầy' })).status, 400); assert.equal((await S.call('POST', 'devices/remove', { kind: 'camera', name: 'Quầy', confirm: true })).status, 200); assert.equal((await S.call('GET', 'devices')).body.cameras.length, 0);
  } finally { await S.s.close(); await new Promise((r) => srv.close(r)); }
});

test('Cài đặt: đăng nhập AI QUA ĐIỆN THOẠI — không mở cửa sổ dòng lệnh: bắt đầu, hiện link + mã + QR, gửi link sang Telegram, dán mã, hủy', async () => {
  const calls = []; let view = { status: 'idle' };
  const login = { start: (e) => { calls.push(['start', e]); view = { id: 'x', engine: e, status: 'running', url: 'https://auth.openai.com/codex/device', code: e === 'codex' ? 'ABCD-12345' : null, needsInput: e !== 'codex', tail: '' }; return view; },
    get: () => view, input: (t) => { calls.push(['input', t]); return view; }, cancel: () => { calls.push(['cancel']); view = { status: 'idle' }; return view; } };
  const sent = [];
  const S = await boot({ login, qrSvg: async (u) => '<svg data-u="' + u + '"></svg>', tgSend: async (token, chat, text) => { sent.push({ token, chat, text }); } });
  try {
    assert.equal((await S.call('POST', 'ai/login/start', { engine: 'deepseekapi' })).status, 400, 'AI dùng khóa API: không đăng nhập tài khoản');
    const v = (await S.call('POST', 'ai/login/start', { engine: 'codex' })).body; assert.equal(v.status, 'running'); assert.equal(v.code, 'ABCD-12345'); assert.match(v.qr, /<svg/); assert.deepEqual(calls[0], ['start', 'codex']);
    assert.equal((await S.call('GET', 'ai/login/state')).body.url, 'https://auth.openai.com/codex/device');
    assert.equal((await S.call('POST', 'ai/login/phone')).status, 200); assert.equal(sent.length, 1); assert.equal(sent[0].chat, '111222333'); assert.match(sent[0].text, /https:\/\/auth\.openai\.com\/codex\/device/); assert.match(sent[0].text, /Nhập mã: ABCD-12345/);
    await S.call('POST', 'ai/login/start', { engine: 'claude' }); assert.equal((await S.call('POST', 'ai/login/input', { text: 'MA-DAN-VAO' })).status, 200); assert.deepEqual(calls[calls.length - 1], ['input', 'MA-DAN-VAO']);
    await S.call('POST', 'ai/login/phone'); assert.match(sent[1].text, /dán vào trang Cài đặt/);
    assert.equal((await S.call('POST', 'ai/login/cancel')).status, 200); assert.equal((await S.call('POST', 'ai/login/phone')).status, 400, 'hủy rồi thì không còn gì để gửi');
  } finally { await S.s.close(); }
});
