'use strict';

// Cài và kiểm tra Claude Code / Codex CLI cho người dùng hệ thống `agentos`. KHÔNG nhúng sẵn trong ISO (chờ GĐ 0 pháp lý):
// tải từ npm chính thức lúc cài đặt, người dùng tự đăng nhập tài khoản CỦA HỌ. Trình hướng dẫn không đọc/lưu token đăng nhập.
const PACKAGES = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex', gemini: '@google/gemini-cli' };
const PREFIX = '/var/lib/agentos/.local';
const HOME = '/var/lib/agentos';
const BIN = { claude: PREFIX + '/bin/claude', codex: PREFIX + '/bin/codex', gemini: PREFIX + '/bin/gemini' };
const GEMINI_CREDS = HOME + '/.gemini/oauth_creds.json';           // Gemini CLI lưu đăng nhập Google ở đây sau khi dán mã

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
  // Gemini: chạy từ thư mục home của agentos (env -C): nếu thư mục hiện tại agentos không đọc được, Gemini CLI báo EACCES khi tìm GEMINI.md. Chế độ plan = chỉ đọc.
  const c = engine === 'claude'
    ? asAgentos([BIN.claude, '-p', '--output-format', 'json', '--max-turns', '1'])
    : engine === 'gemini'
      ? asAgentos(['env', '-C', HOME, BIN.gemini, '-p', '', '--output-format', 'json', '--skip-trust', '--approval-mode', 'plan'])
      : asAgentos([BIN.codex, 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-']);
  const r = await run(c.cmd, c.args, { timeoutMs: 120000, input: prompt, env: extraEnv });
  const text = String(r.out) + String(r.err);
  if (r.code === 0 && !/not logged in|please run .*login|invalid api key|unauthorized/i.test(text)) return { ok: true, detail: 'đăng nhập tốt' };
  // Hết hạn mức (gói thuê bao dùng hết lượt): máy chủ của hãng đã nhận ra tài khoản => ĐÃ đăng nhập. Hệ thống tự đổi sang AI còn lại / chờ reset.
  if (/usage limit|hit your (usage )?limit|limit reached|rate.?limit|quota|out of credits|purchase more credits|resets? (at|in|on)|exhausted your capacity|RESOURCE_EXHAUSTED/i.test(text) && !/not logged in|please run .*login|invalid api key|unauthorized|401/i.test(text)) {
    return { ok: true, limited: true, detail: 'đăng nhập tốt, nhưng tài khoản này đang hết hạn mức (tự dùng lại khi được cấp lại)' };
  }
  // Kèm nguyên văn lý do hãng báo (không chứa token) để biết lỗi thật thay vì chỉ "chưa đăng nhập"
  const raw = String(text).replace(/sk-ant-[A-Za-z0-9_-]+/g, '[token]').replace(/\s+/g, ' ').trim().slice(-200);
  return { ok: false, detail: (/login|logged in|unauthorized|auth/i.test(text) ? 'chưa đăng nhập' : 'lỗi') + (raw ? ' — ' + raw : '') };
}

// Chuẩn bị đăng nhập Gemini: đặt sẵn kiểu đăng nhập "Google" trong ~/.gemini/settings.json (không thì Gemini hiện menu chọn kiểu đăng nhập
// bằng phím mũi tên, khó điều khiển từ xa). Chạy bằng root nên phải trả quyền sở hữu cho agentos.
function prepareGemini(deps) {
  deps = deps || {};
  const fs = deps.fs || require('fs'), execFileSync = deps.execFileSync || require('child_process').execFileSync;
  const dir = HOME + '/.gemini', file = dir + '/settings.json';
  fs.mkdirSync(dir, { recursive: true });
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { cfg = {}; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  cfg.security = Object.assign({}, cfg.security, { auth: Object.assign({}, cfg.security && cfg.security.auth, { selectedType: 'oauth-personal' }) });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    const uid = Number(execFileSync('id', ['-u', 'agentos']).toString()), gid = Number(execFileSync('id', ['-g', 'agentos']).toString());
    fs.chownSync(dir, uid, gid); fs.chownSync(file, uid, gid);
  } catch (e) { /* máy thử không có người dùng agentos */ }
  return file;
}

module.exports = { PACKAGES, BIN, PREFIX, HOME, GEMINI_CREDS, asAgentos, install, installed, verifyLogin, prepareGemini };
