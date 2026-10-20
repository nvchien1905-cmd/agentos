'use strict';
// Trình hướng dẫn lần đầu của AgentOS. Chạy bằng root (ghi /etc/agentos/orchestrator.env, nối Wi-Fi, bật dịch vụ) tới khi hoàn tất rồi tự tắt.
// Ba cách vào:
//   1. Màn hình máy (Chromium toàn màn hình, 127.0.0.1)          -> được tin
//   2. Wi-Fi tạm do máy tự phát (AgentOS-XXXX, mật khẩu riêng)   -> được tin (người dùng đã có mật khẩu in trên nhãn)
//   3. Điện thoại qua mạng LAN của cửa hàng                      -> phải nhập MÃ CÀI ĐẶT 6 số hiện trên màn hình/trang cài đặt
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const nm = require('./lib/nm');
const tg = require('./lib/telegram');
const envfile = require('./lib/envfile');
const engines = require('./lib/engines');
const apikeys = require('./lib/apikeys');
const hotspot = require('./lib/hotspot');
const store = require('./lib/store');
const fullaccess = require('./lib/fullaccess');
const qr = require('./lib/qr');
const netinfo = require('./lib/netinfo');
const { createAuth, parseCookies } = require('./lib/auth');
const { createLogin } = require('./lib/login');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8088,
  envFile: '/etc/agentos/orchestrator.env',
  stateFile: '/var/lib/agentos-wizard/state.json',
  hotspotFile: '/var/lib/agentos-wizard/hotspot.json',
  publicDir: path.join(__dirname, 'public'),
  telegramBase: process.env.TELEGRAM_API_BASE || '',      // chỉ để test
  trustLoopback: true,                                     // test đặt false để mô phỏng điện thoại qua LAN
  hotspotIp: hotspot.HOTSPOT_IP,
  hotspotDelayMs: 30000,                                   // chờ mạng có dây/Wi-Fi cũ tự lên trước khi phát Wi-Fi tạm
  captivePort: 80,                                         // 0 = không mở cổng chuyển hướng (test)
  pollPauseMs: 0,
};

// Chạy lệnh ngoài (không qua shell). opts: { timeoutMs, input, env }. Không bao giờ ném lỗi, trả { code, out, err }.
function realRun(cmd, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); } };
    let child;
    try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ? Object.assign({}, process.env, opts.env) : process.env }); } catch (e) { return resolve({ code: 127, out: '', err: e.message }); }
    const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* đã thoát */ } finish(124); }, opts.timeoutMs) : null;
    child.stdout.on('data', (d) => { if (out.length < 1e6) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 1e6) err += d; });
    child.on('error', (e) => { err += e.message; finish(127); });
    child.on('close', (c) => finish(c == null ? 1 : c));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input || '');
  });
}

// File xác thực X của người dùng đang đăng nhập màn hình (lightdm tự đăng nhập: /home/<người dùng>/.Xauthority).
function findXauthority(homeDir) {
  const base = homeDir || '/home';
  try {
    for (const u of fs.readdirSync(base)) {
      const f = path.join(base, u, '.Xauthority');
      if (fs.existsSync(f)) return f;
    }
  } catch (e) { /* không có */ }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripV4 = (a) => String(a || '').replace(/^::ffff:/, '');

const PAIR_PAGE = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentOS</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:18px system-ui,sans-serif;background:#f4f6f8;color:#18232d;padding:20px}
@media(prefers-color-scheme:dark){body{background:#0f161c;color:#e8eef3}main{background:#17212a!important;border-color:#2a3946!important}input{background:#0f161c!important;color:#e8eef3!important;border-color:#2a3946!important}}
main{background:#fff;border:1px solid #dbe2e8;border-radius:16px;padding:28px;max-width:420px;width:100%}input{font:inherit;font-size:28px;letter-spacing:6px;text-align:center;width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #dbe2e8;margin:12px 0}
button{font:inherit;width:100%;padding:14px;border-radius:10px;border:0;background:#0b5c8f;color:#fff;font-weight:600}p{margin:0 0 8px}.m{color:#b3261e;min-height:24px}</style></head>
<body><main><h2 style="margin-top:0">AgentOS</h2><p>Nhập <b>mã cài đặt 6 số</b> đang hiện trên màn hình máy (hoặc ghi trên nhãn).</p>
<input id="c" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="000000"><div class="m" id="m"></div><button id="b">Tiếp tục</button></main>
<script>function go(){var v=document.getElementById('c').value;fetch('/api/pair',{method:'POST',headers:{'content-type':'application/json','x-agentos-wizard':'1'},body:JSON.stringify({code:v})}).then(function(r){return r.json().then(function(j){if(r.ok)location.href='/';else document.getElementById('m').textContent=j.error||'Lỗi';})});}
document.getElementById('b').onclick=go;document.getElementById('c').onkeydown=function(e){if(e.key==='Enter')go();};</script></body></html>`;

function createWizard(options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const run = o.run || realRun;
  const auth = o.auth || createAuth({ code: o.code });
  const login = o.login || createLogin(o.loginOptions);
  const persisted = store.load(o.stateFile);
  const state = {
    token: persisted.token || null, bot: persisted.bot || null, owner: persisted.owner || null,
    claudeToken: persisted.claudeToken || null, lastError: persisted.lastError || null,
    apiKeys: persisted.apiKeys && typeof persisted.apiKeys === 'object' ? persisted.apiKeys : {},   // khóa API chủ máy nhập (lưu quyền 600, xóa khi hoàn tất)
    fullAccess: persisted.fullAccess === true,                   // chủ máy TỰ tích ô "toàn quyền" (mặc định tắt)
    engines: { claude: { installed: null, loggedIn: false }, codex: { installed: null, loggedIn: false }, gemini: { installed: null, loggedIn: false }, deepseekapi: { installed: null, loggedIn: false } },
    jobs: {}, finished: false,
    hotspot: { ssid: null, up: false, error: null },
    offline: { status: 'idle', step: null, error: null },
  };
  const persist = () => { try { store.save(o.stateFile, state); } catch (e) { /* ổ đĩa chỉ đọc: bỏ qua */ } };
  const tgOpts = () => ({ base: o.telegramBase || undefined, fetch: o.fetch });
  let closed = false, ownerLoopOn = false, captive = null;
  let boundPort = o.port;                                      // cổng thực tế sau khi nghe (test dùng cổng ngẫu nhiên)

  function startJob(name, fn) {
    if (state.jobs[name] && state.jobs[name].status === 'running') return;
    state.jobs[name] = { status: 'running', error: null };
    fn().then(() => { state.jobs[name].status = 'done'; }).catch((e) => { state.jobs[name] = { status: 'error', error: e.message }; });
  }

  // ---------- Telegram: chờ chủ máy nhắn đúng mã ----------
  function setupLink() {
    const ip = netinfo.lanAddresses(o.ifaces)[0];
    return ip ? 'http://' + ip.address + ':' + boundPort + '/?k=' + auth.code() : null;
  }
  async function ownerLoop() {
    if (ownerLoopOn) return;
    ownerLoopOn = true;
    let offset; const hinted = new Set();
    try {
      while (!closed && state.token && !state.owner && !state.finished) {
        try {
          const r = await tg.pollOwner(state.token, Object.assign({ code: auth.code(), offset, waitSec: o.pollWaitSec || 15 }, tgOpts()));
          offset = r.offset;
          for (const id of r.strangers) {
            if (hinted.has(id)) continue;
            hinted.add(id);
            tg.send(state.token, id, 'Để ghép đôi với máy này, hãy nhắn: /start <mã cài đặt 6 số> (mã hiện trên màn hình hoặc trang cài đặt của máy).', tgOpts()).catch(() => {});
          }
          if (r.owner) {
            state.owner = r.owner; persist();
            const link = setupLink();
            tg.send(state.token, r.owner.id, '✅ Đã ghép đôi với bạn (' + (r.owner.name || r.owner.id) + '). Tiếp theo: đăng nhập AI' +
              (link ? ' tại: ' + link + '\n(mở trên điện thoại đang dùng chung Wi-Fi với máy)' : ' trên màn hình máy.'), tgOpts()).catch(() => {});
          }
        } catch (e) { await sleep(o.errorPauseMs || 3000); }
        if (o.pollPauseMs) await sleep(o.pollPauseMs);
      }
    } finally { ownerLoopOn = false; }
  }

  // ---------- Wi-Fi tạm ----------
  async function startHotspot() {
    const cred = hotspot.credentials(o.hotspotFile);
    try {
      const ifname = await hotspot.up(run, cred);
      state.hotspot = { ssid: cred.ssid, up: true, error: null, ifname };
      if (o.captivePort && !captive) startCaptive();
      return true;
    } catch (e) {
      state.hotspot = { ssid: cred.ssid, up: false, error: e.message };
      return false;
    }
  }
  async function stopHotspot() {
    await hotspot.down(run).catch(() => {});
    state.hotspot.up = false;
    if (captive) { captive.close(); captive = null; }
  }
  function startCaptive() {
    // Mọi địa chỉ web trong mạng tạm được chuyển về trang cài đặt (điện thoại tự hiện cửa sổ "Đăng nhập Wi-Fi").
    captive = http.createServer((req, res) => { res.writeHead(302, { location: 'http://' + o.hotspotIp + ':' + boundPort + '/' }); res.end(); });
    captive.on('error', () => { captive = null; });
    captive.listen(o.captivePort, o.hotspotIp);
  }
  async function maybeHotspot() {
    if (o.hotspotDelayMs) await sleep(o.hotspotDelayMs);
    if (closed || state.finished) return;
    const net = await nm.status(run);
    if (net.online || net.hasEthernet || !net.hasWifi) return;
    await startHotspot();
  }

  // Phía điện thoại gửi một lần: Wi-Fi cửa hàng + token bot. Máy tắt Wi-Fi tạm, nối Wi-Fi cửa hàng, kiểm token, rồi chờ chủ nhắn mã.
  // Lỗi ở bước nào thì bật lại Wi-Fi tạm để điện thoại vào lại và thấy lý do.
  async function offlineJob(b) {
    const off = state.offline = { status: 'working', step: 'wifi', error: null };
    try {
      state.token = b.token; state.bot = null; state.owner = null; state.lastError = null; persist();
      await stopHotspot();
      await sleep(o.settleMs == null ? 2000 : o.settleMs);
      await nm.connect(run, b.ssid, b.password);
      off.step = 'internet';
      let online = false;
      for (let i = 0; i < (o.onlineTries || 30) && !online; i++) { online = (await nm.status(run)).online; if (!online) await sleep(o.onlinePollMs == null ? 1000 : o.onlinePollMs); }
      if (!online) throw new Error('Đã nối Wi-Fi nhưng không ra được Internet. Kiểm tra mạng của cửa hàng.');
      off.step = 'telegram';
      state.bot = await tg.getMe(b.token, tgOpts()); persist();
      off.status = 'done'; off.step = null;
      ownerLoop();
    } catch (e) {
      off.status = 'error'; off.error = e.message; state.lastError = e.message; persist();
      state.token = null; persist();
      await startHotspot();
    }
  }

  // ---------- các hành động ----------
  const actions = {
    async state(req) {
      const net = await nm.status(run);
      return {
        local: !!req && netinfo.isLoopback(stripV4(req.socket.remoteAddress)),          // đang ngồi trước máy (kiosk) hay dùng điện thoại
        net, bot: state.bot, owner: state.owner, engines: state.engines, jobs: state.jobs, finished: state.finished,
        code: auth.code(), lan: { ips: netinfo.lanAddresses(o.ifaces), host: netinfo.hostLabel(o.hostname), port: boundPort },
        hotspot: state.hotspot.up ? { ssid: state.hotspot.ssid, up: true, qr: hotspot.wifiQrText(state.hotspot.ssid, hotspot.credentials(o.hotspotFile).psk), psk: hotspot.credentials(o.hotspotFile).psk } : { up: false, error: state.hotspot.error },
        apiKeys: Object.keys(state.apiKeys).reduce((m, k) => { m[k] = apikeys.mask(state.apiKeys[k]); return m; }, {}), apiWhere: apikeys.WHERE,
        offline: state.offline, lastError: state.lastError, hasClaudeToken: !!state.claudeToken, fullAccess: state.fullAccess,
      };
    },
    // Ô tích "Cho bot toàn quyền": chỉ ghi nhớ lựa chọn của chủ máy; sudo + cấu hình chỉ được cài khi bấm Hoàn tất (finish).
    async setFullAccess(b) { state.fullAccess = b && b.on === true; persist(); return { fullAccess: state.fullAccess }; },
    async wifiScan() { return { networks: await nm.scan(run) }; },
    async wifiConnect(b) {
      await nm.connect(run, String(b.ssid || ''), b.password == null ? null : String(b.password));
      return { net: await nm.status(run) };
    },
    async setupOffline(b) {
      const token = String(b.token || '').trim();
      if (!tg.TOKEN_RE.test(token)) throw new Error('Token không đúng dạng (123456789:ABC...). Lấy token từ @BotFather.');
      if (!b.ssid) throw new Error('Chưa chọn Wi-Fi');
      if (state.offline.status === 'working') throw new Error('Đang xử lý, chờ một chút');
      offlineJob({ ssid: String(b.ssid), password: b.password == null ? null : String(b.password), token });
      return { started: true };
    },
    async telegramToken(b) {
      const bot = await tg.getMe(String(b.token || ''), tgOpts());
      state.token = String(b.token).trim(); state.bot = bot; state.owner = null; persist();
      ownerLoop();
      return { bot, code: auth.code() };
    },
    async telegramWait() {
      if (!state.token) throw new Error('Chưa nhập token bot');
      ownerLoop();
      const until = Date.now() + (o.waitMs || 20000);
      while (!state.owner && Date.now() < until && !closed) await sleep(300);
      return { owner: state.owner || null };
    },
    // Khóa API thay cho đăng nhập tài khoản: kiểm với máy chủ của hãng rồi lưu (chưa coi là sẵn sàng; phải "Kiểm tra" qua CLI sau khi cài).
    async apiKey(b) {
      const eng = String(b.engine), key = String(b.key || '').trim();
      if (!apikeys.ENGINES.includes(eng)) throw new Error('AI không biết');
      const r = await apikeys.check(eng, key, o.apiFetch);
      if (!r.ok) throw new Error(r.detail);
      state.apiKeys[eng] = key; state.engines[eng].loggedIn = false; persist();
      return { saved: true, detail: r.detail, limited: !!r.limited, masked: apikeys.mask(key) };
    },
    async apiKeyClear(b) {
      const eng = String(b.engine);
      delete state.apiKeys[eng]; state.engines[eng] && (state.engines[eng].loggedIn = false); persist();
      return { cleared: true };
    },
    async engineInstall(b) {
      const eng = String(b.engine);
      if (!engines.PACKAGES[eng]) throw new Error('AI không biết');
      startJob('install-' + eng, async () => {
        await engines.install(run, eng);
        state.engines[eng].installed = await engines.installed(run, eng);
      });
      return { started: true };
    },
    async engineCheck(b) {
      const eng = String(b.engine);
      if (!engines.PACKAGES[eng]) throw new Error('AI không biết');
      state.engines[eng].installed = await engines.installed(run, eng);
      if (!state.engines[eng].installed) return { installed: null, loggedIn: false, detail: 'chưa cài' };
      if (eng === 'gemini') engines.prepareGemini({ authType: state.apiKeys.gemini ? 'gemini-api-key' : undefined });
      const env = state.apiKeys[eng] ? apikeys.childEnv(eng, state.apiKeys)
        : eng === 'claude' && state.claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: state.claudeToken } : undefined;
      const v = await engines.verifyLogin(run, eng, env);
      state.engines[eng].loggedIn = v.ok;
      return { installed: state.engines[eng].installed, loggedIn: v.ok, limited: !!v.limited, detail: v.detail };
    },
    // Đăng nhập qua điện thoại: chạy lệnh đăng nhập của hãng trong pty, trả link/mã để người dùng làm trên điện thoại.
    async loginStart(b) {
      const eng = String(b.engine);
      if (!engines.PACKAGES[eng]) throw new Error('AI không biết');
      state.engines[eng].installed = await engines.installed(run, eng);
      if (!state.engines[eng].installed) throw new Error('Chưa cài ' + eng + '. Bấm "Cài đặt" trước.');
      return login.start(eng);
    },
    async loginState() {
      const v = login.get();
      if (v.status === 'done' && v.engine === 'claude' && !state.claudeToken) {
        const t = login.takeToken();
        if (t) { state.claudeToken = t; persist(); }
      }
      return v;
    },
    async loginInput(b) { return login.input(String(b.text || '')); },
    async loginCancel() { return login.cancel(); },
    // Mở cửa sổ đăng nhập trên MÀN HÌNH máy (dùng khi người dùng đang ngồi trước máy có màn hình).
    async engineLoginTerminal(b) {
      const eng = String(b.engine);
      if (!engines.BIN[eng]) throw new Error('AI không biết');
      if (eng === 'gemini') engines.prepareGemini();
      const cmd = eng === 'claude' ? engines.BIN.claude : eng === 'gemini' ? 'NO_BROWSER=true ' + engines.BIN.gemini + ' --skip-trust' : engines.BIN.codex + ' login';
      const display = process.env.DISPLAY || ':0';
      const xenv = { DISPLAY: display };
      const xauth = findXauthority(o.homeDir);
      if (xauth) xenv.XAUTHORITY = xauth;
      await run('xhost', ['+si:localuser:agentos'], { timeoutMs: 5000, env: xenv });
      const c = engines.asAgentos(['env', 'DISPLAY=' + display, 'xfce4-terminal', '--title', 'Đăng nhập ' + eng, '-x', 'bash', '-lc', cmd + '; echo; echo Xong - ban co the dong cua so nay.; sleep 600']);
      run(c.cmd, c.args, { timeoutMs: 3600000 });                 // chạy nền, không chờ
      return { opened: true };
    },
    async qr(text) { return qr.svg(run, text); },
    async finish() {
      if (!state.token || !state.owner) throw new Error('Chưa xong bước Telegram');
      const ready = Object.keys(state.engines).filter((e) => state.engines[e].loggedIn);
      // Toàn quyền: chỉ khi chủ máy đã tự tích ô. Cài sudo không mật khẩu cho `agentos` + gỡ giới hạn systemd TRƯỚC khi bật dịch vụ điều phối.
      if (state.fullAccess) await fullaccess.enable(run, o.fullAccessPaths);
      else if (fullaccess.isEnabled(o.fullAccessPaths)) await fullaccess.disable(run, o.fullAccessPaths);
      const content = envfile.build({ token: state.token, ownerIds: [state.owner.id], engines: ready, claudeToken: state.engines.claude.loggedIn && !state.apiKeys.claude ? state.claudeToken : null, apiKeys: state.apiKeys, fullAccess: state.fullAccess });
      envfile.writeSecure(o.envFile, content);
      store.clear(o.stateFile);                                    // token đã nằm trong orchestrator.env, không giữ bản sao
      await stopHotspot();
      await run('systemctl', ['enable', '--now', 'agentos-orchestrator.service'], { timeoutMs: 60000 });
      await tg.send(state.token, state.owner.id, 'AgentOS đã sẵn sàng. Nhắn việc cho em bằng chữ (ví dụ: "Hôm nay thứ mấy?"). Gõ /help để xem lệnh, /onedrive ketnoi để nối OneDrive (AI đọc dữ liệu và lưu kết quả ở đó). AI đang dùng: ' + ready.join(', ') + '.', tgOpts()).catch(() => {});
      state.finished = true;
      // Tự vô hiệu hóa sau khi trả lời xong: không để dịch vụ chạy bằng root nằm đó.
      setTimeout(() => {
        run('pkill', ['-f', 'chromium.*127\\.0\\.0\\.1:8088'], { timeoutMs: 5000 });          // đóng cửa sổ toàn màn hình của trình hướng dẫn
        run('systemctl', ['disable', '--now', 'agentos-wizard.service'], { timeoutMs: 30000 });
      }, o.finishDelayMs == null ? 5000 : o.finishDelayMs).unref();
      return { ok: true, engines: ready };
    },
  };

  const routes = {
    'GET /api/state': (b, req) => actions.state(req),
    'POST /api/wifi/scan': () => actions.wifiScan(),
    'POST /api/wifi/connect': actions.wifiConnect,
    'POST /api/setup/offline': actions.setupOffline,
    'POST /api/telegram/token': actions.telegramToken,
    'POST /api/telegram/wait': () => actions.telegramWait(),
    'POST /api/fullaccess': actions.setFullAccess,
    'POST /api/apikey': actions.apiKey,
    'POST /api/apikey/clear': actions.apiKeyClear,
    'POST /api/engine/install': actions.engineInstall,
    'POST /api/engine/check': actions.engineCheck,
    'POST /api/engine/login': actions.engineLoginTerminal,
    'POST /api/login/start': actions.loginStart,
    'GET /api/login/state': () => actions.loginState(),
    'POST /api/login/input': actions.loginInput,
    'POST /api/login/cancel': () => actions.loginCancel(),
    'POST /api/finish': () => actions.finish(),
  };

  // ---------- HTTP ----------
  const isTrusted = (req) => {
    const remote = stripV4(req.socket.remoteAddress), local = stripV4(req.socket.localAddress);
    return (o.trustLoopback && netinfo.isLoopback(remote)) || (!!o.hotspotIp && local === o.hotspotIp);
  };

  function handler(req, res) {
    const send = (code, body, type, headers) => {
      res.writeHead(code, Object.assign({ 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' }, headers || {}));
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const json = (code, obj, headers) => send(code, obj, null, headers);
    if (!netinfo.hostAllowed(req.headers.host)) return json(403, { error: 'Host không hợp lệ' });
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const ip = stripV4(req.socket.remoteAddress);
    const cookie = (token) => ({ 'set-cookie': 'aw=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' });

    const readBody = (cb) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > 64 * 1024) req.destroy(); else chunks.push(c); });
      req.on('end', () => {
        let body = {};
        if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return json(400, { error: 'JSON hỏng' }); } }
        cb(body);
      });
    };

    // Nhập mã cài đặt (điện thoại qua LAN)
    if (req.method === 'POST' && p === '/api/pair') {
      if (req.headers['x-agentos-wizard'] !== '1') return json(403, { error: 'Thiếu tiêu đề bảo vệ' });
      return readBody((b) => {
        const v = auth.verify(ip, b.code);
        if (!v.ok) return json(v.locked ? 429 : 403, { error: v.error });
        json(200, { ok: true }, cookie(v.token));
      });
    }

    let authed = isTrusted(req) || auth.valid(parseCookies(req.headers.cookie).aw);
    if (!authed && req.method === 'GET' && p === '/' && url.searchParams.get('k')) {         // link từ tin nhắn Telegram / mã QR: tự ghép đôi
      const v = auth.verify(ip, url.searchParams.get('k'));
      if (v.ok) return send(302, '', 'text/plain', Object.assign({ location: '/' }, cookie(v.token)));
    }
    if (!authed) {
      if (req.method === 'GET' && p === '/') return send(200, PAIR_PAGE, 'text/html; charset=utf-8');
      return json(401, { error: 'Cần mã cài đặt', needPair: true });
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      try {
        const html = fs.readFileSync(path.join(o.publicDir, 'index.html'));
        return send(200, html, 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
      } catch (e) { return json(500, { error: 'Thiếu giao diện' }); }
    }
    if (req.method === 'GET' && p === '/api/qr') {
      return actions.qr(url.searchParams.get('text')).then((svg) => (svg ? send(200, svg, 'image/svg+xml') : json(501, { error: 'Không tạo được mã QR' })))
        .catch((e) => json(400, { error: e.message }));
    }
    const route = routes[req.method + ' ' + p];
    if (!route) return json(404, { error: 'Không có' });
    // API ghi yêu cầu tiêu đề tự đặt (trình duyệt không gửi chéo trang nếu không có CORS)
    if (req.method === 'POST' && req.headers['x-agentos-wizard'] !== '1') return json(403, { error: 'Thiếu tiêu đề bảo vệ' });
    readBody(async (body) => {
      try { json(200, await route(body, req)); } catch (e) { json(400, { error: e.message }); }
    });
  }

  let server = null;
  return {
    state, actions, auth, login,
    listen() {
      return new Promise((resolve, reject) => {
        server = http.createServer(handler);
        server.once('error', reject);
        server.listen(o.port, o.host, () => {
          boundPort = server.address().port;
          resolve(boundPort);
          if (state.token && !state.owner && state.bot) ownerLoop();                  // nối tiếp sau khi máy khởi động lại giữa chừng
          maybeHotspot().catch(() => {});
        });
      });
    },
    close() { closed = true; if (captive) captive.close(); return new Promise((r) => (server ? server.close(() => r()) : r())); },
    _startHotspot: startHotspot,
  };
}

if (require.main === module) {
  const DEF = DEFAULTS;
  if (fs.existsSync(DEF.envFile)) { console.log('Đã cấu hình (' + DEF.envFile + '), trình hướng dẫn không chạy.'); process.exit(0); }
  const w = createWizard();
  w.listen().then((p) => {
    console.log('Trình hướng dẫn AgentOS: http://127.0.0.1:' + p + '/  (mã cài đặt: ' + w.auth.code() + ')');
    // Mã cài đặt cho kỹ thuật viên/chủ máy đọc khi cần (ví dụ qua SSH): /run/agentos-wizard.code, quyền 600
    try { fs.writeFileSync('/run/agentos-wizard.code', w.auth.code() + '\n', { mode: 0o600 }); } catch (e) { /* không ghi được */ }
  }).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { createWizard, realRun };
