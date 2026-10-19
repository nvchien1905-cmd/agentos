'use strict';

// Cài và kiểm tra Claude Code / Codex CLI cho người dùng hệ thống `agentos`. KHÔNG nhúng sẵn trong ISO (chờ GĐ 0 pháp lý):
// tải từ npm chính thức lúc cài đặt, người dùng tự đăng nhập tài khoản CỦA HỌ. Trình hướng dẫn không đọc/lưu token đăng nhập.
const PACKAGES = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };
const PREFIX = '/var/lib/agentos/.local';
const HOME = '/var/lib/agentos';
const BIN = { claude: PREFIX + '/bin/claude', codex: PREFIX + '/bin/codex' };

// Chạy lệnh DƯỚI QUYỀN người dùng agentos (trình hướng dẫn chạy bằng root).
function asAgentos(args) {
  return { cmd: 'runuser', args: ['-u', 'agentos', '--', 'env', 'HOME=' + HOME, 'PATH=' + PREFIX + '/bin:/usr/local/bin:/usr/bin:/bin', ...args] };
}

async function install(run, engine) {
  if (!PACKAGES[engine]) throw new Error('AI không biết: ' + engine);
  const c = asAgentos(['npm', 'install', '-g', '--prefix', PREFIX, '--no-audit', '--no-fund', PACKAGES[engine]]);
  const r = await run(c.cmd, c.args, { timeoutMs: 600000 });
  if (r.code !== 0) throw new Error('Cài ' + engine + ' thất bại: ' + String(r.err || r.out).trim().split('\n').slice(-3).join(' | '));
  return true;
}

async function installed(run, engine) {
  const c = asAgentos([BIN[engine], '--version']);
  const r = await run(c.cmd, c.args, { timeoutMs: 20000 });
  return r.code === 0 ? String(r.out).trim().split('\n')[0] : null;
}

// Kiểm tra đã đăng nhập: chạy một câu hỏi rất ngắn (tốn vài trăm token). Trả { ok, detail }.
// `extraEnv` (tùy chọn): biến môi trường cho lệnh kiểm tra, ví dụ CLAUDE_CODE_OAUTH_TOKEN (truyền qua môi trường, không qua tham số dòng lệnh để `ps` không thấy).
async function verifyLogin(run, engine, extraEnv) {
  const prompt = 'Trả lời đúng một từ: OK';
  if (!BIN[engine]) throw new Error('AI không biết: ' + engine);
  // Cả hai CLI đọc prompt từ stdin (giống bộ điều phối).
  const c = engine === 'claude'
    ? asAgentos([BIN.claude, '-p', '--output-format', 'json', '--max-turns', '1'])
    : asAgentos([BIN.codex, 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-']);
  const r = await run(c.cmd, c.args, { timeoutMs: 120000, input: prompt, env: extraEnv });
  const text = String(r.out) + String(r.err);
  if (r.code === 0 && !/not logged in|please run .*login|invalid api key|unauthorized/i.test(text)) return { ok: true, detail: 'đăng nhập tốt' };
  // Hết hạn mức (gói thuê bao dùng hết lượt): máy chủ của hãng đã nhận ra tài khoản => ĐÃ đăng nhập. Hệ thống tự đổi sang AI còn lại / chờ reset.
  if (/usage limit|hit your (usage )?limit|limit reached|rate.?limit|quota|out of credits|purchase more credits|resets? (at|in|on)/i.test(text) && !/not logged in|please run .*login|invalid api key|unauthorized|401/i.test(text)) {
    return { ok: true, limited: true, detail: 'đăng nhập tốt, nhưng tài khoản này đang hết hạn mức (tự dùng lại khi được cấp lại)' };
  }
  return { ok: false, detail: /login|logged in|unauthorized|auth/i.test(text) ? 'chưa đăng nhập' : String(text).trim().split('\n').slice(-2).join(' ').slice(0, 160) };
}

module.exports = { PACKAGES, BIN, PREFIX, HOME, asAgentos, install, installed, verifyLogin };
