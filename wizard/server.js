'use strict';
// Trình hướng dẫn lần đầu của AgentOS: máy chủ web CỤC BỘ (127.0.0.1) hiện trong Chromium toàn màn hình ở lần đăng nhập đầu tiên.
// Chạy bằng root (ghi /etc/agentos/orchestrator.env, bật dịch vụ). Chỉ chạy tới khi hoàn tất rồi tự tắt và tự vô hiệu hóa.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const nm = require('./lib/nm');
const tg = require('./lib/telegram');
const envfile = require('./lib/envfile');
const engines = require('./lib/engines');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8088,
  envFile: '/etc/agentos/orchestrator.env',
  publicDir: path.join(__dirname, 'public'),
  telegramBase: process.env.TELEGRAM_API_BASE || '',      // chỉ để test
};

// Chạy lệnh ngoài (không qua shell). opts: { timeoutMs, input }. Không bao giờ ném lỗi, trả { code, out, err }.
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

function createWizard(options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const run = o.run || realRun;
  const state = {
    token: null, bot: null, owner: null,                     // bước Telegram
    engines: { claude: { installed: null, loggedIn: false }, codex: { installed: null, loggedIn: false } },
    jobs: {},                                                // tiến trình cài đặt chạy nền: { name: { status, error } }
    finished: false,
  };
  const tgOpts = () => ({ base: o.telegramBase || undefined, fetch: o.fetch });

  function startJob(name, fn) {
    if (state.jobs[name] && state.jobs[name].status === 'running') return;
    state.jobs[name] = { status: 'running', error: null };
    fn().then(() => { state.jobs[name].status = 'done'; }).catch((e) => { state.jobs[name] = { status: 'error', error: e.message }; });
  }

  // --- các hành động (mỗi hành động trả JSON, ném Error có thông báo tiếng Việt khi sai) ---
  const actions = {
    async state() {
      const net = await nm.status(run);
      return { net, bot: state.bot, owner: state.owner, engines: state.engines, jobs: state.jobs, finished: state.finished };
    },
    async wifiScan() { return { networks: await nm.scan(run) }; },
    async wifiConnect(b) {
      await nm.connect(run, String(b.ssid || ''), b.password == null ? null : String(b.password));
      return { net: await nm.status(run) };
    },
    async telegramToken(b) {
      const bot = await tg.getMe(String(b.token || ''), tgOpts());
      state.token = String(b.token).trim(); state.bot = bot; state.owner = null;
      return { bot };
    },
    async telegramWait() {
      if (!state.token) throw new Error('Chưa nhập token bot');
      const owner = await tg.waitForOwner(state.token, Object.assign({ waitSec: 20 }, tgOpts()));
      if (owner) state.owner = owner;
      return { owner: owner || null };
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
      const v = await engines.verifyLogin(run, eng);
      state.engines[eng].loggedIn = v.ok;
      return { installed: state.engines[eng].installed, loggedIn: v.ok, detail: v.detail };
    },
    // Mở cửa sổ terminal (dưới quyền agentos) để người dùng tự đăng nhập tài khoản CỦA HỌ. Không đọc/lưu token.
    async engineLoginTerminal(b) {
      const eng = String(b.engine);
      if (!engines.BIN[eng]) throw new Error('AI không biết');
      const cmd = eng === 'claude' ? engines.BIN.claude : engines.BIN.codex + ' login';
      const display = process.env.DISPLAY || ':0';
      // Cho phép người dùng agentos mở cửa sổ trên màn hình của người dùng desktop (cần file xác thực X của người đó).
      const xenv = { DISPLAY: display };
      const xauth = findXauthority(o.homeDir);
      if (xauth) xenv.XAUTHORITY = xauth;
      await run('xhost', ['+si:localuser:agentos'], { timeoutMs: 5000, env: xenv });
      const c = engines.asAgentos(['env', 'DISPLAY=' + display, 'xfce4-terminal', '--title', 'Đăng nhập ' + eng, '-x', 'bash', '-lc', cmd + '; echo; echo Xong - ban co the dong cua so nay.; sleep 600']);
      run(c.cmd, c.args, { timeoutMs: 3600000 });                 // chạy nền, không chờ
      return { opened: true };
    },
    async finish() {
      if (!state.token || !state.owner) throw new Error('Chưa xong bước Telegram');
      const ready = Object.keys(state.engines).filter((e) => state.engines[e].loggedIn);
      const content = envfile.build({ token: state.token, ownerIds: [state.owner.id], engines: ready });
      envfile.writeSecure(o.envFile, content);
      await run('systemctl', ['enable', '--now', 'agentos-orchestrator.service'], { timeoutMs: 60000 });
      await tg.send(state.token, state.owner.id, 'AgentOS đã sẵn sàng. Nhắn việc cho em bằng chữ (ví dụ: "Hôm nay thứ mấy?"). Gõ /help để xem lệnh. AI đang dùng: ' + ready.join(', ') + '.', tgOpts()).catch(() => {});
      state.finished = true;
      // Tự vô hiệu hóa sau khi trả lời xong: không để dịch vụ chạy bằng root nằm đó.
      setTimeout(() => {
        run('pkill', ['-f', 'chromium.*127\\.0\\.0\\.1:8088'], { timeoutMs: 5000 });          // đóng cửa sổ toàn màn hình của trình hướng dẫn
        run('systemctl', ['disable', '--now', 'agentos-wizard.service'], { timeoutMs: 30000 });
      }, 5000).unref();
      return { ok: true, engines: ready };
    },
  };

  const routes = {
    'GET /api/state': () => actions.state(),
    'POST /api/wifi/scan': () => actions.wifiScan(),
    'POST /api/wifi/connect': actions.wifiConnect,
    'POST /api/telegram/token': actions.telegramToken,
    'POST /api/telegram/wait': () => actions.telegramWait(),
    'POST /api/engine/install': actions.engineInstall,
    'POST /api/engine/check': actions.engineCheck,
    'POST /api/engine/login': actions.engineLoginTerminal,
    'POST /api/finish': () => actions.finish(),
  };

  function handler(req, res) {
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    // Chặn DNS rebinding / trang web lạ gọi vào: chỉ nhận Host là localhost/127.0.0.1.
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return json(403, { error: 'Host không hợp lệ' });

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      try {
        const html = fs.readFileSync(path.join(o.publicDir, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY' });
        return res.end(html);
      } catch (e) { return json(500, { error: 'Thiếu giao diện' }); }
    }
    const route = routes[req.method + ' ' + req.url.split('?')[0]];
    if (!route) return json(404, { error: 'Không có' });
    // API yêu cầu tiêu đề tự đặt (trình duyệt không gửi chéo trang nếu không có CORS) và nội dung JSON.
    if (req.method === 'POST' && req.headers['x-agentos-wizard'] !== '1') return json(403, { error: 'Thiếu tiêu đề bảo vệ' });
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) req.destroy(); else chunks.push(c); });
    req.on('end', async () => {
      let body = {};
      if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return json(400, { error: 'JSON hỏng' }); } }
      try { json(200, await route(body)); } catch (e) { json(400, { error: e.message }); }
    });
  }

  let server = null;
  return {
    state, actions,
    listen() { return new Promise((resolve, reject) => { server = http.createServer(handler); server.once('error', reject); server.listen(o.port, o.host, () => resolve(server.address().port)); }); },
    close() { return new Promise((r) => (server ? server.close(() => r()) : r())); },
  };
}

if (require.main === module) {
  if (fs.existsSync(DEFAULTS.envFile)) { console.log('Đã cấu hình (' + DEFAULTS.envFile + '), trình hướng dẫn không chạy.'); process.exit(0); }
  const w = createWizard();
  w.listen().then((p) => console.log('Trình hướng dẫn AgentOS: http://127.0.0.1:' + p + '/')).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { createWizard, realRun };
