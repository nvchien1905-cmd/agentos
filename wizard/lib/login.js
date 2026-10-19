'use strict';
const { spawn: realSpawn } = require('child_process');
const engines = require('./engines');

// Đăng nhập AI QUA ĐIỆN THOẠI: chạy lệnh đăng nhập chính thức của hãng trong một pty (qua `script`), chuyển tiếp link/mã cho trang cài đặt.
//  - Claude Code: `claude setup-token` -> in link, người dùng đăng nhập trên điện thoại, trình duyệt hiện MÃ, dán mã lại -> CLI in token 1 năm
//    (dùng cho gói thuê bao Pro/Max/Team; token được truyền cho bộ điều phối qua CLAUDE_CODE_OAUTH_TOKEN).
//  - Codex: `codex login --device-auth` -> in link + mã dùng một lần; người dùng nhập trên điện thoại; CLI tự lưu đăng nhập.
// Không ghi mật khẩu, chỉ chuyển tiếp mã người dùng dán vào CLI. Token (nếu có) chỉ giữ trong bộ nhớ/tệp trạng thái quyền 600.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[()][0-9A-B]|\r/g;
const URL_RE = /https?:\/\/[^\s"'<>\u001b]+/;
const CLAUDE_TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{20,}/;
const MAX_BUF = 20000;

const PLANS = {
  claude: { argv: () => [engines.BIN.claude, 'setup-token'], needsInput: true, wantsToken: true },
  codex: { argv: () => [engines.BIN.codex, 'login', '--device-auth'], needsInput: false, wantsToken: false },
};

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// Lệnh thực tế: dưới quyền agentos, trong pty rộng (link dài không bị ngắt dòng).
function defaultWrap(argv) {
  const inner = 'stty cols 4000 2>/dev/null; exec ' + argv.map(shq).join(' ');
  const c = engines.asAgentos(['env', 'COLUMNS=4000', 'TERM=dumb', 'script', '-qefc', inner, '/dev/null']);
  return { cmd: c.cmd, args: c.args };
}

function clean(s) { return String(s).replace(ANSI, ''); }

// Token Claude: CLI in ra từng đoạn/in lại nhiều lần, nên KHÔNG lấy lần khớp đầu tiên (có thể mới in nửa chừng -> token thiếu chữ -> bị từ chối).
// Lấy bản DÀI NHẤT trong mọi lần xuất hiện.
function bestToken(buf) {
  const all = clean(buf).match(new RegExp(CLAUDE_TOKEN_RE.source, 'g'));
  return all ? all.reduce((a, b) => (b.length > a.length ? b : a)) : null;
}

function createLogin(opts) {
  opts = opts || {};
  const spawn = opts.spawn || realSpawn;
  const wrap = opts.wrap || defaultWrap;
  const timeoutMs = opts.timeoutMs || 15 * 60 * 1000;
  let cur = null;

  function view(s) {
    if (!s) return { status: 'idle' };
    const text = clean(s.buf);
    const redacted = text.replace(new RegExp(CLAUDE_TOKEN_RE.source, 'g'), '[đã nhận token]');
    const m = text.match(URL_RE);
    // Codex: mã thiết bị dùng một lần (VD 5X5H-X6VNW) để nhập trên trang OpenAI. Hiện riêng, to, thay vì chôn trong nội dung.
    const dc = s.engine === 'codex' ? text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/) : null;
    return {
      id: s.id, engine: s.engine, status: s.status, url: m ? m[0].replace(/[).,]+$/, '') : null, code: dc ? dc[1] : null,
      needsInput: PLANS[s.engine].needsInput, hasToken: !!s.token,
      tail: redacted.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-12).join('\n').slice(-1500),
      error: s.error || null,
    };
  }

  function stop(s, why) {
    if (!s || s.done) return;
    s.error = s.error || why || null;
    try { s.child.kill('SIGTERM'); } catch (e) { /* đã thoát */ }
    setTimeout(() => { try { s.child.kill('SIGKILL'); } catch (e) { /* đã thoát */ } }, 3000).unref();
  }

  return {
    start(engine) {
      const plan = PLANS[engine];
      if (!plan) throw new Error('AI không biết: ' + engine);
      if (cur && !cur.done) stop(cur, 'Bị thay bằng lần đăng nhập mới');
      const w = wrap(plan.argv());
      const s = { id: Date.now().toString(36), engine, buf: '', status: 'running', token: null, done: false, error: null, child: null };
      cur = s;
      let child;
      try { child = spawn(w.cmd, w.args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { s.status = 'error'; s.error = e.message; s.done = true; return view(s); }
      s.child = child;
      const onData = (d) => {
        s.buf += d;
        if (s.buf.length > MAX_BUF) s.buf = s.buf.slice(-MAX_BUF);
        if (plan.wantsToken) s.token = bestToken(s.buf) || s.token;
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.stdin.on('error', () => {});
      child.on('error', (e) => { s.status = 'error'; s.error = 'Không chạy được lệnh đăng nhập: ' + e.message; s.done = true; });
      child.on('close', (code) => {
        s.done = true; clearTimeout(s.timer);
        if (plan.wantsToken) s.token = bestToken(s.buf) || s.token;   // lấy lại lần cuối từ toàn bộ nội dung đã nhận
        if (s.status === 'error') return;
        const ok = code === 0 && (!plan.wantsToken || s.token);
        s.status = ok ? 'done' : 'error';
        if (!ok && !s.error) s.error = plan.wantsToken && code === 0 ? 'Không nhận được token' : 'Lệnh đăng nhập kết thúc với mã ' + code;
      });
      s.timer = setTimeout(() => stop(s, 'Quá thời gian đăng nhập (15 phút)'), timeoutMs);
      if (s.timer.unref) s.timer.unref();
      return view(s);
    },
    get() { return view(cur); },
    // Dán mã (Claude) vào CLI. Chỉ nhận khi đang chạy; mã ngắn, không có ký tự điều khiển.
    input(text) {
      if (!cur || cur.done) throw new Error('Không có lần đăng nhập đang chạy');
      if (!PLANS[cur.engine].needsInput) throw new Error('Lần đăng nhập này không cần nhập mã');
      const t = String(text || '').trim();
      if (!t || t.length > 400 || /[\u0000-\u001f\u007f]/.test(t)) throw new Error('Mã không hợp lệ');
      // Claude Code đọc phím bằng TUI: mã dán + Enter gửi cùng lúc thì Enter bị coi là một phần của đoạn dán và không được nhận
      // (đã gặp trên máy thật: ô nhập hiện ****** rồi treo mãi). Gửi mã trước, ngắt một nhịp, rồi mới gửi Enter (\r như phím thật).
      const s = cur;
      s.child.stdin.write(t);
      setTimeout(() => { if (!s.done) { try { s.child.stdin.write('\r'); } catch (e) { /* đã thoát */ } } }, opts.enterDelayMs == null ? 500 : opts.enterDelayMs).unref();
      return view(cur);
    },
    // Token Claude đã nhận (chỉ dùng nội bộ để ghi cấu hình); không bao giờ trả ra API.
    takeToken() { return cur && cur.token ? cur.token : null; },
    cancel() { if (cur) stop(cur, 'Đã hủy'); return view(cur); },
    _current: () => cur,
  };
}

module.exports = { createLogin, defaultWrap, clean, URL_RE, CLAUDE_TOKEN_RE };
