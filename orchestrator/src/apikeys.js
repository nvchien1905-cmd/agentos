'use strict';

// KHÓA API của từng AI (khách mua khóa API thay vì thuê bao). Lưu trong /etc/agentos/orchestrator.env dưới tên riêng AGENTOS_KEY_* (KHÔNG phải tên chuẩn
// của hãng) để không tiến trình nào tự nhặt nhầm; khi chạy một AI, chỉ khóa CỦA AI ĐÓ được đổi sang đúng tên biến mà CLI của hãng đọc, các khóa khác bị xóa trắng.
//   claude       Claude Code dùng khóa Anthropic (ANTHROPIC_API_KEY)
//   codex        Codex dùng khóa OpenAI (CODEX_API_KEY / OPENAI_API_KEY)
//   gemini       Gemini CLI dùng khóa Google AI Studio (GEMINI_API_KEY)
//   deepseekapi  DeepSeek qua API CHÍNH THỨC: chạy Claude Code trỏ sang điểm cuối tương thích Anthropic của DeepSeek (cách DeepSeek hướng dẫn).
//                Khác với "DeepSeek web" (lệnh /deepseek): web cấm robot, API thì được phép.
const VAR = { claude: 'AGENTOS_KEY_CLAUDE', codex: 'AGENTOS_KEY_CODEX', gemini: 'AGENTOS_KEY_GEMINI', deepseekapi: 'AGENTOS_KEY_DEEPSEEK' };
const DEEPSEEK_URL = 'https://api.deepseek.com/anthropic';

// env: biến môi trường của bộ điều phối (process.env hoặc cấu hình). Trả { engine: khóa } cho các khóa có đặt.
function keysFrom(env) {
  const out = {};
  for (const e of Object.keys(VAR)) { const v = String((env || {})[VAR[e]] || '').trim(); if (v) out[e] = v; }
  return out;
}

// Biến môi trường cho tiến trình của `engine`: xóa trắng mọi AGENTOS_KEY_*, rồi nếu engine này có khóa thì đặt đúng biến CLI cần.
function childEnv(engine, keys, opts) {
  opts = opts || {};
  const env = {};
  for (const v of Object.values(VAR)) env[v] = '';
  const key = keys && keys[engine];
  if (!key) return env;
  if (engine === 'claude') Object.assign(env, { ANTHROPIC_API_KEY: key, CLAUDE_CODE_OAUTH_TOKEN: '' });
  else if (engine === 'codex') Object.assign(env, { CODEX_API_KEY: key, OPENAI_API_KEY: key });
  else if (engine === 'gemini') Object.assign(env, { GEMINI_API_KEY: key, GOOGLE_GENAI_USE_GEMINI: 'true' });
  else if (engine === 'deepseekapi') {
    const model = opts.deepseekModel || 'deepseek-flash';
    Object.assign(env, {
      ANTHROPIC_BASE_URL: opts.deepseekUrl || DEEPSEEK_URL, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
      API_TIMEOUT_MS: '600000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '',
    });
  }
  return env;
}

// Gemini CLI đọc kiểu đăng nhập từ ~/.gemini/settings.json TRƯỚC biến môi trường: có khóa API thì phải đặt 'gemini-api-key', không có thì 'oauth-personal'.
function setGeminiAuthType(home, type) {
  const fs = require('fs'), path = require('path');
  const dir = path.join(home, '.gemini'), file = path.join(dir, 'settings.json');
  let j = {}; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { j = {}; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) j = {};
  j.security = Object.assign({}, j.security); j.security.auth = Object.assign({}, j.security.auth);
  if (j.security.auth.selectedType === type) return false;
  j.security.auth.selectedType = type;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  return true;
}

module.exports = { setGeminiAuthType, VAR, DEEPSEEK_URL, keysFrom, childEnv };
