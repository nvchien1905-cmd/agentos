'use strict';
const path = require('path');

// Chính sách quyền cho từng lần AI gọi công cụ. Hàm thuần, không đụng mạng/đĩa -> dễ test.
// Kết quả decide(): { action: 'allow'|'ask'|'deny', cls, summary, reason, warn, taint, canRemember }

// ToolSearch/TodoWrite là công cụ nội bộ của Claude Code (nạp định nghĩa công cụ, ghi danh sách việc), không đụng file hay mạng.
const READ = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'ToolSearch']);
const WRITE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const BROWSE_WEB = new Set(['WebFetch', 'WebSearch']);
// Thao tác chỉ xem của Playwright MCP; mọi thao tác khác của trình duyệt (bấm, gõ, chạy script, tải file lên...) là "interact".
const BROWSE_ACTIONS = /^browser_(navigate|navigate_back|snapshot|take_screenshot|tabs|wait_for|console_messages|network_requests|resize|close)$/;

const LABEL = { exec: 'Chạy lệnh', write: 'Ghi/sửa file', interact: 'Thao tác trên trang web', browse: 'Xem web', other: 'Dùng công cụ', read: 'Đọc file' };

// File chứa khóa/token/dữ liệu hệ thống: AI không bao giờ được đọc hay ghi, kể cả khi người dùng bấm cho phép.
const SECRET_RE = /(?<![\w-])(\.ssh|\.aws|\.gnupg|\.kube|\.claude|\.codex|\.config[\\/]onedrive|refresh_token|\.netrc|\.npmrc|\.git-credentials|\.env(\.[\w.-]+)?|id_rsa|id_ed25519|\.credentials\.json|orchestrator\.env|agentos\.db|shadow|passwd)(?![\w-])/i;

// Lệnh shell không bao giờ hợp lệ với tác nhân này (từ chối thẳng, không hỏi).
const EXEC_DENY = [
  [/\bsudo\b|\bsu\s+-?\w*\s*($|[;&|])|\bdoas\b/, 'nâng quyền (sudo/su)'],
  [/\|\s*(sudo\s+)?(ba|z|da|k|c)?sh\b|\|\s*(sudo\s+)?python3?\b|\|\s*(sudo\s+)?node\b|\|\s*perl\b/, 'đưa dữ liệu tải về vào shell/trình thông dịch'],
  [/\bmkfs(\.\w+)?\b|\bdd\b[^;&|]*\bof=\/dev\/|:\(\)\s*\{.*\}\s*;\s*:|\bfdisk\b|\bparted\b/, 'phá ổ đĩa'],
  [/\b(shutdown|reboot|halt|poweroff|init\s+0)\b|\bsystemctl\s+(poweroff|reboot|halt)\b/, 'tắt/khởi động lại máy'],
  [/\/dev\/(tcp|udp)\//, 'mở kết nối mạng thô'],
  [/\bchmod\s+(-R\s+)?[0-7]*777\b[^;&|]*\s\//, 'mở quyền toàn bộ hệ thống'],
  [/\bcrontab\b|\bsystemctl\s+(enable|edit|mask)\b|\/etc\/systemd\b|\.bashrc|\.profile\b|authorized_keys/, 'cài chạy ngầm / sửa cấu hình đăng nhập'],
];
const SHELL_META = /[;&|`$<>\n\\(){}]/;

function globRe(p) { return new RegExp('^' + String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); }
const matches = (list, tool) => (list || []).some((p) => globRe(p).test(tool));
const trunc = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function parseMcp(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  return m ? { server: m[1], name: m[2] } : null;
}

function classify(tool, input) {
  if (READ.has(tool)) return 'read';
  if (WRITE.has(tool)) return 'write';
  if (tool === 'Bash') return 'exec';
  if (BROWSE_WEB.has(tool)) return 'browse';
  const mcp = parseMcp(tool);
  if (mcp && /^browser/.test(mcp.server)) return BROWSE_ACTIONS.test(mcp.name) ? 'browse' : 'interact';
  return 'other';
}

function summarize(tool, input, cls) {
  input = input || {};
  if (cls === 'exec') return trunc(input.command, 400);
  if (cls === 'write') return trunc(input.file_path || input.notebook_path || '', 300);
  const url = input.url || input.query;
  const bits = [url, input.element, input.text, input.ref, input.function, input.key].filter(Boolean);
  const name = (parseMcp(tool) || {}).name || tool;
  if (bits.length) return trunc(name + ': ' + bits.join(' | '), 400);
  return trunc(name + ' ' + JSON.stringify(input), 400);
}

function privateIPv4(a, b) {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// Chặn truy cập mạng nội bộ / metadata đám mây (SSRF). Hostname phân giải ra IP nội bộ (DNS rebinding) thì chưa bắt được.
function checkUrl(u, allowPrivate) {
  let url;
  try { url = new URL(String(u)); } catch (e) { return 'địa chỉ không hợp lệ'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'chỉ cho phép http/https (không ' + url.protocol + ')';
  if (allowPrivate) return null;
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(h)) return 'địa chỉ mạng nội bộ';
  if (h.includes(':')) {
    if (h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^::ffff:/.test(h)) return 'địa chỉ mạng nội bộ';
    return null;
  }
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m && privateIPv4(Number(m[1]), Number(m[2]))) return 'địa chỉ mạng nội bộ';
  return null;
}

function originOf(u) { try { return new URL(String(u)).origin; } catch (e) { return null; } }

function pathsOf(input) {
  input = input || {};
  return [input.file_path, input.path, input.notebook_path, /^[\\/]|^[a-zA-Z]:/.test(String(input.pattern || '')) ? input.pattern : null].filter(Boolean).map(String);
}
function inside(workdir, p) {
  const root = path.resolve(workdir);
  const full = path.resolve(root, p);
  const rel = path.relative(root, full);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * ctx: { tool, input, policy, workdir, state: { tainted, allowed:Set } }
 * policy (trong profile): { allow:[mẫu tên công cụ], ask:[...], deny:[...], allowExec:[regex lệnh an toàn], allowPrivateNetwork }
 */
function decide(ctx) {
  const tool = ctx.tool, input = ctx.input || {}, pol = ctx.policy || {}, state = ctx.state || { tainted: false, allowed: new Set() };
  const cls = classify(tool, input);
  const out = { action: 'ask', cls, summary: summarize(tool, input, cls), reason: '', warn: '', taint: false, canRemember: false };
  const deny = (reason) => Object.assign(out, { action: 'deny', reason });

  // 1. Cấm cứng
  for (const p of pathsOf(input)) {
    if (SECRET_RE.test(p)) return deny('không được đụng vào file chứa khóa/token/dữ liệu hệ thống');
    // Thư mục làm việc + các thư mục dữ liệu được cho thêm (OneDrive của chủ máy). Đường dẫn tương đối tính từ thư mục làm việc.
    if ((cls === 'read' || cls === 'write') && ![ctx.workdir].concat(ctx.extraDirs || []).some((d) => inside(d, p))) return deny('chỉ được làm việc trong thư mục làm việc hoặc thư mục OneDrive');
  }
  if (cls === 'exec') {
    const cmd = String(input.command || '');
    if (SECRET_RE.test(cmd)) return deny('lệnh đụng vào file chứa khóa/token/dữ liệu hệ thống');
    for (const [re, why] of EXEC_DENY) if (re.test(cmd)) return deny('lệnh bị cấm: ' + why);
  }
  if (input.url !== undefined && (cls === 'browse' || cls === 'interact' || cls === 'other')) {
    const bad = checkUrl(input.url, pol.allowPrivateNetwork);
    if (bad) return deny('không truy cập được: ' + bad);
  }
  if (matches(pol.deny, tool)) return deny('bộ công cụ này cấm công cụ đó');

  const tainted = !!state.tainted;
  const risky = cls === 'exec' || cls === 'write' || cls === 'other';
  if (tainted && (cls === 'exec' || cls === 'write' || cls === 'other' || cls === 'interact')) {
    out.warn = 'Việc này đã đọc nội dung từ web. Nếu yêu cầu này bạn không ngờ tới, có thể do trang web cài vào: hãy từ chối.';
  }

  // 2. Tự cho phép
  if (cls === 'read') return Object.assign(out, { action: 'allow' });
  if (cls === 'browse') {
    // Chống rò dữ liệu qua địa chỉ URL: sau khi đã đọc web, chuyển sang trang web CHƯA ghé trong việc này thì hỏi lại (tùy chọn).
    const origin = pol.askNewOrigin && tainted && input.url ? originOf(input.url) : null;
    if (origin && !(state.origins && state.origins.has(origin))) {
      out.warn = 'Nội dung trang đang yêu cầu chuyển sang một trang web mới (' + origin + '). Nếu bạn không ngờ tới, có thể do trang cài vào: hãy từ chối.';
      out.taint = true;
      return out;
    }
    return Object.assign(out, { action: 'allow', taint: true });
  }
  if (matches(pol.ask, tool)) return finishAsk(out, cls, tainted);
  // "Cho phép cả việc này" chỉ có hiệu lực với thao tác trình duyệt; lệnh và ghi file luôn hỏi từng lần.
  if (cls === 'interact' && state.allowed && state.allowed.has(tool)) return Object.assign(out, { action: 'allow', taint: true });
  if (cls === 'exec') {
    const cmd = String(input.command || '').trim();
    const safe = !tainted && !SHELL_META.test(cmd) && (pol.allowExec || []).some((r) => { try { return new RegExp(r).test(cmd); } catch (e) { return false; } });
    if (safe) return Object.assign(out, { action: 'allow' });
  }
  if (matches(pol.allow, tool) && !(tainted && (cls === 'exec' || cls === 'write'))) {
    return Object.assign(out, { action: 'allow', taint: cls === 'interact' });
  }
  return finishAsk(out, cls, tainted, risky);
}

// ---- HÀNG RÀO cho chế độ TOÀN QUYỀN: AI vẫn tự làm mọi việc, riêng ba nhóm sau không tự làm được:
//  1. CẤM CỨNG: đọc khóa/token/biến môi trường (chứa API key) và cấu hình bí mật của AgentOS.
//  2. HỎI CHỦ MÁY (nút bấm trên Telegram): gửi thông tin/tin nhắn ra ngoài (email, Telegram/Zalo/Slack API, POST/upload, scp/rsync, git push...).
//  3. HỎI CHỦ MÁY: việc dính tiền (ngân hàng, thanh toán, ví điện tử, tiền mã hóa, "chuyển khoản").
// Đây là "hàng rào chặn thói quen xấu và chặn bị lừa qua nội dung web/email", KHÔNG phải bức tường tuyệt đối: AI đã có sudo nên người cố tình vẫn vòng được.
const GUARD_DENY_CMD = [
  [/\b(printenv|export\s+-p|declare\s+-x|compgen\s+-e)\b|(^|[;&|(]\s*)env\s*($|[|;&>)])|\/proc\/[^\s]*\/environ/, 'đọc biến môi trường (chứa khóa API)'],
  [/\/etc\/agentos(\/|\b)|orchestrator\.env|\.agentos-update|signing-private|update-pubkey/, 'đọc cấu hình bí mật của AgentOS'],
];
const GUARD_SEND_CMD = [
  [/\b(sendmail|mailx?|mutt|msmtp|swaks|ssmtp)\b/, 'gửi email'],
  [/api\.telegram\.org|openapi\.zalo\.me|oauth\.zaloapp\.com|graph\.facebook\.com|hooks\.slack\.com|discord(app)?\.com\/api|api\.line\.me|api\.twilio\.com|api\.sendgrid\.com|smtp\./i, 'gửi tin nhắn/thư qua dịch vụ bên ngoài'],
  [/\b(curl|wget|http|https|xh)\b[^|;&\n]*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s--data\S*|\s-d\s|\s-F\s|\s--form\b|\s-T\s|--upload-file|--json\b)/i, 'gửi dữ liệu lên mạng (POST/upload)'],
  [/\b(scp|rsync|sftp|rclone|nc|ncat|netcat|socat)\b/, 'chuyển dữ liệu qua mạng'],
  [/\bgit\s+push\b|\bnpm\s+publish\b|\bgh\s+(pr|release|repo|gist)\b|\btwine\s+upload\b|\bdocker\s+push\b/, 'đẩy mã/đăng tải ra ngoài'],
];
const MONEY_RE = /(vietcombank|vcbdigibank|techcombank|bidv|vietinbank|mbbank|tpbank|vpbank|sacombank|agribank|hdbank|ocb\.com|momo\.vn|zalopay|vnpay|paypal|stripe\.com|payoneer|binance|coinbase|e-?banking|internet banking|chuyển khoản|chuyen khoan|chuyển tiền|chuyen tien|thanh toán|thanh toan|wire transfer)/i;

function decideGuard(ctx) {
  const tool = ctx.tool, input = ctx.input || {};
  const cls = classify(tool, input);
  const out = { action: 'allow', cls, summary: summarize(tool, input, cls), reason: '', warn: '', taint: false, canRemember: false };
  const deny = (reason) => Object.assign(out, { action: 'deny', reason });
  const ask = (warn) => Object.assign(out, { action: 'ask', warn });
  for (const p of pathsOf(input)) if (SECRET_RE.test(p)) return deny('không được đụng vào file chứa khóa/token/dữ liệu hệ thống');
  if (cls === 'exec') {
    const cmd = String(input.command || '');
    if (SECRET_RE.test(cmd)) return deny('lệnh đụng vào file chứa khóa/token/dữ liệu hệ thống');
    for (const [re, why] of GUARD_DENY_CMD) if (re.test(cmd)) return deny('không được ' + why);
    for (const [re, why] of GUARD_SEND_CMD) if (re.test(cmd)) return ask('Việc nhạy cảm: ' + why + '. Chỉ cho phép nếu chính anh vừa yêu cầu; nếu không ngờ tới (có thể do nội dung web/email/tệp cài vào) hãy từ chối.');
    if (MONEY_RE.test(cmd)) return ask('Việc dính tới tiền (ngân hàng/thanh toán/chuyển khoản). Chỉ cho phép nếu chính anh yêu cầu.');
  }
  if (input.url !== undefined && (cls === 'browse' || cls === 'interact' || cls === 'other') && MONEY_RE.test(String(input.url))) return ask('Trang ngân hàng/thanh toán: thao tác ở đây có thể liên quan tới tiền. Chỉ cho phép nếu chính anh yêu cầu.');
  return out;
}

function finishAsk(out, cls, tainted) {
  // Cho "cho phép trong việc này" chỉ với thao tác trình duyệt; lệnh và ghi file luôn hỏi từng lần.
  out.canRemember = cls === 'interact';
  out.taint = cls === 'interact';
  return out;
}

module.exports = { decideGuard, GUARD_DENY_CMD, GUARD_SEND_CMD, MONEY_RE, decide, classify, summarize, checkUrl, originOf, inside, globRe, SECRET_RE, EXEC_DENY, LABEL, trunc };
