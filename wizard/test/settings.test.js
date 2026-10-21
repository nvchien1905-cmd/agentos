'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createSettings, peerUid, sudoUids, CATALOG } = require('../settings/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-set-'));
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const KEY = { deepseekapi: 'sk-' + 'd'.repeat(32) };

async function boot(extra) {
  const dir = tmp();
  const envFile = path.join(dir, 'orchestrator.env');
  if (!(extra && extra.noEnv)) fs.writeFileSync(envFile, 'TELEGRAM_TOKEN=' + TOKEN + '\nALLOWED_USER_IDS=5\nADMIN_USER_IDS=5\nENGINE_ORDER=claude\nFULL_ACCESS=0\n');
  fs.writeFileSync(path.join(dir, 'VERSION'), '2026.10.21.2\n');
  const calls = [], spawned = [];
  const run = async (cmd, args) => {
    calls.push([cmd].concat(args));
    const a = args.join(' ');
    if (cmd === 'systemctl' && args[0] === 'is-active') return { code: 0, out: 'active\n', err: '' };
    if (cmd === 'dpkg-query') return { code: 0, out: 'vlc ii \ngimp un \n', err: '' };
    if (cmd === 'apt-get' && args[0] === 'update') return { code: 0, out: 'ok', err: '' };
    if (cmd === 'apt-get' && args[0] === '-s') return { code: 0, out: 'Inst libfoo [1] (2)\nInst bar [1] (2)\nConf libfoo\n', err: '' };
    if (cmd === 'runuser' && a.includes('--version')) return { code: 1, out: '', err: '' };
    if (cmd === 'nmcli' && a === '-t -f CONNECTIVITY general') return { code: 0, out: 'full', err: '' };
    if (cmd === 'nmcli') return { code: 0, out: 'eth0:ethernet:connected', err: '' };
    return { code: 0, out: '', err: '' };
  };
  const spawn = (cmd, args) => {
    spawned.push([cmd].concat(args));
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    setImmediate(() => { c.stdout.emit('data', 'dong 1\ndong 2\n'); if (cmd === 'false-cmd') { c.stderr.emit('data', 'hong\n'); c.emit('close', 3); } else c.emit('close', 0); });
    return c;
  };
  const apiFetch = async (url, init) => {
    if (/api\.telegram\.org/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 9, username: 'bot_moi', first_name: 'Bot' } }) };
    return { status: String((init.headers || {})['x-api-key'] || (init.headers || {}).Authorization || '').includes('bad') ? 401 : 200 };
  };
  let uid = 1000;
  const s = createSettings(Object.assign({
    port: 0, host: '127.0.0.1', envFile, versionFile: path.join(dir, 'VERSION'), backupDir: path.join(dir, 'bk'), onedriveConf: path.join(dir, 'od'), onedriveDir: path.join(dir, 'odir'),
    run, spawn, fetch: apiFetch, peerUid: () => uid, allowedUids: () => new Set([1000, 0]), pageFile: path.join(__dirname, '..', 'settings', 'index.html'),
    updater: { check: async () => ({ installed: '2026.10.21.2', latest: '2026.10.22.1', newer: true, notes: 'moi' }) }, tsRun: async () => ({ code: 0, out: JSON.stringify({ BackendState: 'NeedsLogin' }), err: '' }),
    memFallback: path.join(dir, 'ghi-nho.md'), exit: () => {}, fullAccessPaths: { sudoers: path.join(dir, 'sudoers.d', '90-x'), dropin: path.join(dir, 'dropin', '10-x.conf') }, sleep: (ms) => new Promise((r) => setTimeout(r, 2)), odPollMs: 1, odSettleMs: 0,
  }, extra || {}));
  const port = await s.listen();
  const call = async (method, p, body, headers) => {
    const r = await fetch('http://127.0.0.1:' + port + '/api/' + p, { method, headers: Object.assign({ 'content-type': 'application/json', 'x-agentos-settings': '1' }, headers || {}), body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* html */ }
    return { status: r.status, body: j, text };
  };
  return { s, port, call, calls, spawned, envFile, dir, setUid: (u) => { uid = u; }, env: () => fs.readFileSync(envFile, 'utf8') };
}
const waitJob = async (S, id) => { for (let i = 0; i < 100; i++) { const j = await S.call('GET', 'jobs/' + id); if (j.body.status !== 'running') return j.body; await new Promise((r) => setTimeout(r, 10)); } throw new Error('job không xong'); };

test('settings: chỉ nhận tài khoản quản trị (uid), Host cục bộ, tiêu đề bảo vệ cho POST; phục vụ trang', async () => {
  const S = await boot();
  try {
    const getPage = async () => { const r = await fetch('http://127.0.0.1:' + S.port + '/'); return { status: r.status, text: await r.text() }; };
    const page = await getPage();
    assert.equal(page.status, 200); assert.match(page.text, /Cài đặt AgentOS/);
    S.setUid(998);                                                              // ví dụ tài khoản agentos (AI)
    assert.equal((await S.call('GET', 'overview')).status, 403);
    assert.equal((await getPage()).status, 403);
    S.setUid(null); assert.equal((await S.call('GET', 'overview')).status, 403);
    S.setUid(1000);
    assert.equal((await S.call('POST', 'power', { action: 'reboot', confirm: true }, { 'x-agentos-settings': '0' })).status, 403);
    const evil = await new Promise((resolve) => require('http').request({ host: '127.0.0.1', port: S.port, path: '/api/overview', headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); }).end());
    assert.equal(evil, 403);                                                    // DNS rebinding
    assert.equal((await S.call('GET', 'khong-co')).status, 404);
    const ov = await S.call('GET', 'overview');
    assert.equal(ov.body.version, '2026.10.21.2'); assert.equal(ov.body.configured, true); assert.equal(ov.body.services.deskd, 'active');
  } finally { await S.s.close(); }
});

test('settings: đọc uid người gọi từ bảng socket; danh sách uid = nhóm sudo (không gồm agentos)', () => {
  const f = path.join(tmp(), 'tcp');
  fs.writeFileSync(f, '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:C350 0100007F:1F91 01 00000000:00000000 00:00000000 00000000  1000        0 12345 1\n   1: 0100007F:1F91 0100007F:C350 01 00000000:00000000 00:00000000 00000000     0        0 12346 1\n');
  assert.equal(peerUid({ remotePort: 0xC350 }, f), 1000);
  assert.equal(peerUid({ remotePort: 12345 }, f), null);
  const d = tmp(), g = path.join(d, 'group'), p = path.join(d, 'passwd');
  fs.writeFileSync(g, 'sudo:x:27:chien,agentos\nusers:x:100:\n');
  fs.writeFileSync(p, 'root:x:0:0::/root:/bin/sh\nchien:x:1000:1000::/home/chien:/bin/sh\nagentos:x:998:998::/var/lib/agentos:/bin/sh\nkhach:x:1001:1001::/home/khach:/bin/sh\n');
  assert.deepEqual([...sudoUids(g, p)].sort(), [0, 1000]);
});

test('settings: cập nhật AgentOS (kiểm + công việc nền có nhật ký) và hệ điều hành (apt update, đếm gói, nâng cấp không hỏi)', async () => {
  const S = await boot();
  try {
    const c = await S.call('POST', 'updates/agentos/check'); assert.equal(c.body.newer, true); assert.equal(c.body.latest, '2026.10.22.1');
    const a = await S.call('POST', 'updates/agentos/apply'); const j = await waitJob(S, a.body.job);
    assert.equal(j.status, 'done'); assert.ok(j.lines.some((l) => l.includes('agentos-update apply'))); assert.ok(j.lines.includes('dong 1'));
    const o = await S.call('POST', 'updates/os/check'); assert.deepEqual([o.body.upgradable, o.body.packages], [2, ['libfoo', 'bar']]);
    const u = await S.call('POST', 'updates/os/upgrade'); await waitJob(S, u.body.job);
    const cmds = S.spawned.map((x) => x.join(' '));
    assert.ok(cmds.some((x) => /^apt-get -y .*dist-upgrade$/.test(x) && x.includes('force-confold'))); assert.ok(cmds.some((x) => x === 'apt-get -y autoremove'));
    let exited = 0; // self-restart: chỉ khi rảnh
    assert.equal((await S.call('POST', 'self-restart')).body.ok, true);
    assert.equal((await S.call('POST', 'power', { action: 'reboot' })).status, 400);               // cần xác nhận
    assert.equal((await S.call('POST', 'power', { action: 'format', confirm: true })).status, 400);
  } finally { await S.s.close(); }
});

test('settings: công việc lỗi báo mã thoát; chỉ một công việc nền tại một thời điểm', async () => {
  const S = await boot({ spawn: (cmd, args) => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); setTimeout(() => { c.stderr.emit('data', 'hong\n'); c.emit('close', 3); }, 50); return c; } });
  try {
    const a = await S.call('POST', 'updates/agentos/apply');
    assert.match((await S.call('POST', 'updates/os/upgrade')).body.error, /công việc khác đang chạy|công việc khác chạy/);
    const j = await waitJob(S, a.body.job); assert.equal(j.status, 'error'); assert.equal(j.code, 3); assert.ok(j.lines.includes('hong'));
  } finally { await S.s.close(); }
});

test('settings: ứng dụng — danh mục, cài/gỡ qua apt, tên gói không hợp lệ bị chặn (không qua shell)', async () => {
  const S = await boot();
  try {
    const l = await S.call('GET', 'apps'); assert.equal(l.body.apps.length, CATALOG.length);
    assert.equal(l.body.apps.find((x) => x.id === 'vlc').installed, true); assert.equal(l.body.apps.find((x) => x.id === 'gimp').installed, false);
    const i = await S.call('POST', 'apps/install', { id: 'gimp' }); await waitJob(S, i.body.job);
    assert.ok(S.spawned.some((x) => x.join(' ') === 'apt-get install -y --no-install-recommends gimp'));
    const c = await S.call('POST', 'apps/install', { package: 'Htop' }); await waitJob(S, c.body.job);
    assert.ok(S.spawned.some((x) => x.join(' ') === 'apt-get install -y --no-install-recommends htop'));        // tên gói chuẩn hóa chữ thường
    for (const bad of ['a; rm -rf /', '$(id)', '../x', '-oAPT::x=1', 'a b', '']) assert.equal((await S.call('POST', 'apps/install', { package: bad })).status, 400, bad);
    assert.equal((await S.call('POST', 'apps/install', { id: 'khong-co' })).status, 400);
    const r = await S.call('POST', 'apps/remove', { id: 'vlc' }); await waitJob(S, r.body.job);
    assert.ok(S.spawned.some((x) => x.join(' ') === 'apt-get remove -y vlc'));
  } finally { await S.s.close(); }
});

test('settings: khóa API — kiểm với hãng, lưu vào orchestrator.env (không lộ), bật AI, xóa; khóa sai bị từ chối; thứ tự AI', async () => {
  const S = await boot();
  try {
    const bad = await S.call('POST', 'ai/key', { engine: 'deepseekapi', key: 'sk-' + 'bad'.repeat(10) });
    assert.equal(bad.status, 400); assert.match(bad.body.error, /không đúng hoặc đã bị thu hồi/);
    assert.doesNotMatch(S.env(), /AGENTOS_KEY_DEEPSEEK/);
    const ok = await S.call('POST', 'ai/key', { engine: 'deepseekapi', key: KEY.deepseekapi });
    assert.equal(ok.status, 200); assert.equal(ok.body.masked, 'sk-dddd…dddd'); assert.ok(ok.body.job);                // chưa cài CLI -> có công việc cài
    assert.match(S.env(), /^AGENTOS_KEY_DEEPSEEK=sk-d+$/m); assert.match(S.env(), /^ENGINE_ORDER=claude,deepseekapi$/m);
    const ai = await S.call('GET', 'ai'); const e = ai.body.engines.find((x) => x.id === 'deepseekapi');
    assert.equal(e.key, 'sk-dddd…dddd'); assert.equal(e.enabled, true); assert.doesNotMatch(JSON.stringify(ai.body), new RegExp(KEY.deepseekapi));
    assert.ok(S.calls.some((c) => c[0] === 'systemctl' && c[1] === 'restart' && c[2] === 'agentos-orchestrator.service'));
    assert.equal((await S.call('POST', 'ai/order', { order: ['deepseekapi', 'claude'] })).status, 200); assert.match(S.env(), /^ENGINE_ORDER=deepseekapi,claude$/m);
    assert.equal((await S.call('POST', 'ai/order', { order: ['claude', 'claude'] })).status, 400); assert.equal((await S.call('POST', 'ai/order', { order: [] })).status, 400);
    assert.equal((await S.call('POST', 'ai/key/clear', { engine: 'deepseekapi' })).status, 200); assert.doesNotMatch(S.env(), /AGENTOS_KEY_DEEPSEEK/);
    assert.equal((await S.call('POST', 'ai/key', { engine: 'gpt5', key: 'x' })).status, 400);
    assert.equal((await S.call('POST', 'ai/login', { engine: 'deepseekapi' })).status, 400);
  } finally { await S.s.close(); }
});

test('settings: bot Telegram — đổi token (kiểm getMe), ID chủ máy, chế độ bảo vệ/toàn quyền; chưa cấu hình thì báo rõ', async () => {
  const S = await boot();
  try {
    const b = await S.call('GET', 'bot'); assert.equal(b.body.configured, true); assert.equal(b.body.bot.username, 'bot_moi'); assert.deepEqual(b.body.owners, ['5']);
    assert.doesNotMatch(JSON.stringify(b.body), new RegExp(TOKEN));
    assert.equal((await S.call('POST', 'bot/token', { token: 'sai' })).status, 400);
    const t = '987654321:' + 'B'.repeat(35); assert.equal((await S.call('POST', 'bot/token', { token: t })).status, 200); assert.match(S.env(), new RegExp('^TELEGRAM_TOKEN=' + t, 'm'));
    assert.equal((await S.call('POST', 'bot/owner', { ids: '7, 8' })).status, 200); assert.match(S.env(), /^ALLOWED_USER_IDS=7,8$/m); assert.match(S.env(), /^ADMIN_USER_IDS=7,8$/m);
    assert.equal((await S.call('POST', 'bot/owner', { ids: 'abc' })).status, 400);
    assert.equal((await S.call('POST', 'bot/mode', { full: true })).status, 200); assert.match(S.env(), /^FULL_ACCESS=1$/m); assert.match(S.env(), /^JOB_TIMEOUT_SEC=3600$/m);
    assert.ok(fs.existsSync(path.join(S.dir, 'sudoers.d', '90-x')));
    assert.equal((await S.call('POST', 'bot/mode', { full: false })).status, 200); assert.match(S.env(), /^FULL_ACCESS=0$/m); assert.ok(!fs.existsSync(path.join(S.dir, 'sudoers.d', '90-x')));
  } finally { await S.s.close(); }
  const N = await boot({ noEnv: true });
  try { assert.equal((await N.call('GET', 'bot')).body.configured, false); assert.match((await N.call('POST', 'bot/owner', { ids: '5' })).body.error, /chưa cấu hình xong/); } finally { await N.s.close(); }
});

test('settings: OneDrive — lấy đường dẫn đăng nhập, từ chối địa chỉ lạ, hoàn tất khi có token; Tailscale/mạng/dịch vụ/nhật ký/sao lưu', async () => {
  const dir = tmp(); const conf = path.join(dir, 'od'); fs.mkdirSync(conf, { recursive: true });
  const S = await boot({ onedriveConf: conf, onedriveDir: path.join(dir, 'odir'), spawn: (cmd, args) => {
    const c = new EventEmitter(); c.kill = () => {}; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    if (!(cmd === 'runuser' && args.includes('onedrive'))) setImmediate(() => c.emit('close', 0));
    if (cmd === 'runuser' && args.includes('onedrive')) {
      fs.writeFileSync(path.join(conf, 'auth-url.txt'), 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x\n');
      const t = setInterval(() => { if (fs.existsSync(path.join(conf, 'auth-response.txt'))) { fs.writeFileSync(path.join(conf, 'refresh_token'), 'rt'); clearInterval(t); } }, 5);
    }
    return c;
  } });
  try {
    assert.equal((await S.call('GET', 'onedrive')).body.connected, false);
    const st = await S.call('POST', 'onedrive/start'); assert.match(st.body.url, /^https:\/\/login\.microsoftonline\.com\//);
    assert.equal((await S.call('POST', 'onedrive/finish', { response: 'https://evil.example/?code=1' })).status, 400);
    const fin = await S.call('POST', 'onedrive/finish', { response: 'https://login.microsoftonline.com/common/oauth2/nativeclient?code=M.C509.abc' });
    assert.equal(fin.body.connected, true); assert.equal((await S.call('GET', 'onedrive')).body.connected, true);
    assert.equal((await S.call('POST', 'onedrive/disconnect', {})).status, 400);                    // cần xác nhận
    assert.equal((await S.call('POST', 'onedrive/disconnect', { confirm: true })).body.connected, false);
    assert.equal((await S.call('GET', 'tailscale')).body.state, 'NeedsLogin');
    assert.equal((await S.call('GET', 'net')).body.status.online, true);
    const sv = await S.call('GET', 'services'); assert.ok(sv.body.restartable.includes('orchestrator'));
    assert.equal((await S.call('POST', 'services/restart', { name: 'ssh' })).status, 400);
    assert.equal((await S.call('POST', 'services/restart', { name: 'orchestrator' })).status, 200);
    assert.equal((await S.call('GET', 'logs?unit=khong-co')).status, 400);
    assert.equal((await S.call('GET', 'backup')).body.files.length, 0);
    const bk = await S.call('POST', 'backup/run'); assert.equal((await waitJob(S, bk.body.job)).status, 'done');
  } finally { await S.s.close(); }
});

test('settings: bộ nhớ chung — đọc/ghi ghi nhớ (chặn dòng giống bí mật, có bản .bak), cấu hình nén/định tuyến ghi vào env và khởi động lại bot', async () => {
  const S = await boot();
  try {
    const m0 = await S.call('GET', 'memory');
    assert.deepEqual([m0.body.config.enabled, m0.body.config.route, m0.body.config.provider, m0.body.config.rotateAfter, m0.body.summarizer.gemini], [true, true, 'auto', 25, false]);
    const ok = await S.call('POST', 'memory/facts', { text: '# Ghi nhớ\n- [2026-10-21] Cửa hàng nghỉ chủ nhật\n- [2026-10-21] Khách Lan thích màu xanh' });
    assert.equal(ok.body.lines, 2);
    assert.match((await S.call('GET', 'memory')).body.facts, /Cửa hàng nghỉ chủ nhật/);
    await S.call('POST', 'memory/facts', { text: '- [2026-10-22] Điều mới' });
    assert.ok(fs.existsSync(path.join(S.dir, 'ghi-nho.md.bak')));
    for (const bad of ['- mật khẩu: abc', '- api key = sk-abcdefghijklmnopqrstuv', '- Mật khẩu wifi là nhà-minh'])
      assert.equal((await S.call('POST', 'memory/facts', { text: bad })).status, 400, bad);
    assert.equal((await S.call('POST', 'memory/facts', { text: 'a'.repeat(20001) })).status, 400);
    const c = await S.call('POST', 'memory/config', { enabled: false, route: false, provider: 'gemini', rotateAfter: 40 });
    assert.equal(c.status, 200);
    assert.match(S.env(), /^MEMORY_ENABLED=false$/m); assert.match(S.env(), /^ROUTE_BY_DIFFICULTY=false$/m); assert.match(S.env(), /^SUMMARY_PROVIDER=gemini$/m); assert.match(S.env(), /^MEMORY_ROTATE_AFTER=40$/m);
    assert.ok(S.calls.some((x) => x[0] === 'systemctl' && x[1] === 'restart' && x[2] === 'agentos-orchestrator.service'));
    assert.match((await S.call('POST', 'memory/test')).body.error, /Chưa có khóa Gemini hoặc DeepSeek/);
    assert.equal((await S.call('POST', 'memory/config', { provider: 'khac' })).status, 400);
    assert.equal((await S.call('POST', 'memory/config', { rotateAfter: 2 })).status, 400);
    const g = await S.call('GET', 'memory'); assert.deepEqual([g.body.config.enabled, g.body.config.route, g.body.config.provider], [false, false, 'gemini']);
  } finally { await S.s.close(); }
});
