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
