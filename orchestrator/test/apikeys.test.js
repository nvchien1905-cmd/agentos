'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const apikeys = require('../src/apikeys');
const config = require('../src/config');
const tools = require('../src/tools');
const { startClaude } = require('../src/engines/claude');
const { startGemini } = require('../src/engines/gemini');
const { classifyFailure } = require('../src/limits');

test('apikeys: đọc AGENTOS_KEY_* từ cấu hình, bỏ giá trị trống', () => {
  const k = apikeys.keysFrom({ AGENTOS_KEY_CLAUDE: ' sk-ant-xxx ', AGENTOS_KEY_CODEX: '', AGENTOS_KEY_DEEPSEEK: 'sk-ds', OTHER: '1' });
  assert.deepEqual(k, { claude: 'sk-ant-xxx', deepseekapi: 'sk-ds' });
  const cfg = config.load({ TELEGRAM_TOKEN: '1:x', ALLOWED_USER_IDS: '5', ENGINE_ORDER: 'claude,deepseekapi', AGENTOS_KEY_DEEPSEEK: 'sk-ds' });
  assert.deepEqual(cfg.apiKeys, { deepseekapi: 'sk-ds' }); assert.equal(cfg.deepseekModel, 'deepseek-flash');
  assert.deepEqual(config.validate(cfg), []);
});

test('deepseekapi là engine hợp lệ, không trùng tên lệnh nhanh /deepseek (mở web) và có trong bộ công cụ mặc định', () => {
  assert.ok(config.KNOWN_ENGINES.includes('deepseekapi'));
  assert.ok(tools.RESERVED.has('deepseekapi'));
  const t = tools.loadTools({ file: '', fallbackAllow: 'Read', vars: {} });
  assert.ok(t.enginesFor(null).includes('deepseekapi'));
});

// CLI giả in ra các biến môi trường nó nhìn thấy
function fakeCli() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-')), 'cli.js');
  fs.writeFileSync(f, "const k=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','GEMINI_API_KEY','GOOGLE_GENAI_USE_GEMINI','AGENTOS_KEY_CLAUDE','AGENTOS_KEY_DEEPSEEK','CLAUDE_CODE_OAUTH_TOKEN'];" +
    "const o={};for(const x of k)o[x]=process.env[x]||'';const s=JSON.stringify(o);console.log(JSON.stringify({type:'result',result:s,response:s,session_id:'s1'}));");
  return f;
}

test('khóa API: Claude Code nhận khóa Anthropic; DeepSeek chạy Claude Code với điểm cuối DeepSeek; khóa khác không lọt sang; Gemini nhận khóa Google', async () => {
  const cli = fakeCli();
  process.env.AGENTOS_KEY_DEEPSEEK = 'sk-lo-ra-ngoai'; process.env.AGENTOS_KEY_CLAUDE = 'sk-ant-lo-ra-ngoai'; process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-cu';
  try {
    const keys = { claude: 'sk-ant-claude-key', deepseekapi: 'sk-deepseek-key', gemini: 'AIzaGeminiKey' };
    const run = async (name) => JSON.parse((await startClaude({ bin: process.execPath, binArgs: [cli], cwd: os.tmpdir(), prompt: 'hi', timeoutMs: 20000, env: apikeys.childEnv(name, keys) }).done).text);
    const c = await run('claude');
    assert.equal(c.ANTHROPIC_API_KEY, 'sk-ant-claude-key'); assert.equal(c.ANTHROPIC_BASE_URL, ''); assert.equal(c.AGENTOS_KEY_DEEPSEEK, ''); assert.equal(c.AGENTOS_KEY_CLAUDE, ''); assert.equal(c.CLAUDE_CODE_OAUTH_TOKEN, '');
    const d = await run('deepseekapi');
    assert.equal(d.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic'); assert.equal(d.ANTHROPIC_AUTH_TOKEN, 'sk-deepseek-key'); assert.equal(d.ANTHROPIC_API_KEY, ''); assert.equal(d.AGENTOS_KEY_CLAUDE, ''); assert.equal(d.AGENTOS_KEY_DEEPSEEK, '');
    const none = await run('codex');
    assert.equal(none.ANTHROPIC_API_KEY, ''); assert.equal(none.AGENTOS_KEY_DEEPSEEK, '');
    const g = JSON.parse((await startGemini({ bin: process.execPath, binArgs: [cli], cwd: os.tmpdir(), prompt: 'hi', timeoutMs: 20000, env: apikeys.childEnv('gemini', keys) }).done).text);
    assert.equal(g.GEMINI_API_KEY, 'AIzaGeminiKey'); assert.equal(g.GOOGLE_GENAI_USE_GEMINI, 'true'); assert.equal(g.AGENTOS_KEY_DEEPSEEK, '');
    // không có khóa: đăng nhập tài khoản như cũ (không biến nào bị đặt) nhưng khóa trong môi trường bộ điều phối vẫn bị xóa trắng
    const plain = JSON.parse((await startClaude({ bin: process.execPath, binArgs: [cli], cwd: os.tmpdir(), prompt: 'hi', timeoutMs: 20000, env: apikeys.childEnv('claude', {}) }).done).text);
    assert.equal(plain.ANTHROPIC_API_KEY, ''); assert.equal(plain.AGENTOS_KEY_CLAUDE, ''); assert.equal(plain.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-cu');
  } finally { delete process.env.AGENTOS_KEY_DEEPSEEK; delete process.env.AGENTOS_KEY_CLAUDE; delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
});

test('hết số dư / hết hạn mức của khóa API được coi là hết hạn mức (tự chuyển AI khác)', () => {
  for (const m of ['Your credit balance is too low to access the Anthropic API', 'Insufficient Balance', 'You exceeded your current quota, please check your plan and billing details', 'API Error: 429 rate limit'])
    assert.equal(classifyFailure(m).limit, true, m);
  assert.equal(classifyFailure('invalid x-api-key').limit, false);
});

test('setGeminiAuthType: đặt đúng kiểu đăng nhập, giữ cài đặt khác, không ghi lại khi không đổi', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
  const file = path.join(home, '.gemini', 'settings.json');
  assert.equal(apikeys.setGeminiAuthType(home, 'gemini-api-key'), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).security.auth.selectedType, 'gemini-api-key');
  fs.writeFileSync(file, JSON.stringify({ theme: 'x', security: { auth: { selectedType: 'gemini-api-key' }, other: 1 } }));
  assert.equal(apikeys.setGeminiAuthType(home, 'gemini-api-key'), false);
  assert.equal(apikeys.setGeminiAuthType(home, 'oauth-personal'), true);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([j.theme, j.security.other, j.security.auth.selectedType], ['x', 1, 'oauth-personal']);
});
