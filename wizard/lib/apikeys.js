'use strict';
// Nhập và kiểm tra KHÓA API cho từng AI (dùng chung cho trình hướng dẫn và lệnh `agentos-key`). Cách bộ điều phối dùng khóa: orchestrator/src/apikeys.js.
const base = require('../../orchestrator/src/apikeys');

const ENGINES = ['claude', 'codex', 'gemini', 'deepseekapi'];
const NAMES = { claude: 'Claude (Anthropic)', codex: 'Codex (OpenAI)', gemini: 'Gemini (Google)', deepseekapi: 'DeepSeek (API)' };
// Nơi lấy khóa (hiển thị cho chủ máy)
const WHERE = {
  claude: 'console.anthropic.com → API Keys (dạng sk-ant-api03-…)',
  codex: 'platform.openai.com → API keys (dạng sk-…)',
  gemini: 'aistudio.google.com → Get API key (dạng AIza…)',
  deepseekapi: 'platform.deepseek.com → API keys (dạng sk-…)',
};
// Dạng khóa (kiểm sơ bộ để bắt lỗi dán nhầm; kiểm thật bằng cách hỏi máy chủ của hãng)
const FORMAT = {
  claude: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  codex: /^sk-[A-Za-z0-9_-]{20,}$/,
  gemini: /^AIza[A-Za-z0-9_-]{30,}$/,
  deepseekapi: /^sk-[A-Za-z0-9]{20,}$/,
};

function validFormat(engine, key) {
  if (!FORMAT[engine]) return false;
  return FORMAT[engine].test(String(key || '').trim());
}

// Hỏi máy chủ của hãng danh sách mô hình bằng khóa này (không tốn token). Trả { ok, detail }.
// 401/403 = khóa sai/bị thu hồi; 429 = khóa đúng nhưng đang bị giới hạn; lỗi mạng = chưa kiểm được (ok:false, network:true).
async function check(engine, key, fetchImpl) {
  const f = fetchImpl || fetch;
  key = String(key || '').trim();
  const req = {
    claude: ['https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }],
    codex: ['https://api.openai.com/v1/models', { Authorization: 'Bearer ' + key }],
    gemini: ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': key }],
    deepseekapi: ['https://api.deepseek.com/models', { Authorization: 'Bearer ' + key }],
  }[engine];
  if (!req) return { ok: false, detail: 'AI không biết: ' + engine };
  if (!validFormat(engine, key)) return { ok: false, detail: 'Khóa không đúng dạng của ' + NAMES[engine] + '. Lấy ở ' + WHERE[engine] + '.' };
  let r;
  try { r = await f(req[0], { headers: req[1], signal: AbortSignal.timeout(20000) }); }
  catch (e) { return { ok: false, network: true, detail: 'Không kết nối được tới máy chủ ' + NAMES[engine] + ' (kiểm tra mạng): ' + (e.message || e) }; }
  if (r.status === 200) return { ok: true, detail: 'Khóa hợp lệ' };
  if (r.status === 429) return { ok: true, limited: true, detail: 'Khóa hợp lệ nhưng đang bị giới hạn lượt (rate limit)' };
  if (r.status === 401 || r.status === 403 || r.status === 400) return { ok: false, detail: 'Hãng báo khóa không đúng hoặc đã bị thu hồi (HTTP ' + r.status + ').' };
  if (r.status === 402) return { ok: true, limited: true, detail: 'Khóa hợp lệ nhưng tài khoản hết số dư — nạp thêm tiền để dùng' };
  return { ok: false, network: true, detail: 'Máy chủ ' + NAMES[engine] + ' trả HTTP ' + r.status + ', thử lại sau.' };
}

// Sửa nội dung orchestrator.env: đặt (key) hoặc xóa (key = null) khóa của `engine`; đặt khóa thì bật AI đó trong ENGINE_ORDER.
function applyToEnv(text, engine, key) {
  if (!base.VAR[engine]) throw new Error('AI không biết: ' + engine);
  if (key != null && /[\r\n\0]/.test(key)) throw new Error('Khóa chứa ký tự không hợp lệ');
  const lines = String(text || '').split('\n');
  const set = (name, value) => {
    const i = lines.findIndex((l) => l.startsWith(name + '='));
    if (value == null) { if (i >= 0) lines.splice(i, 1); return; }
    if (i >= 0) lines[i] = name + '=' + value; else { if (lines.length && lines[lines.length - 1] === '') lines.pop(); lines.push(name + '=' + value, ''); }
  };
  set(base.VAR[engine], key == null ? null : String(key).trim());
  if (key != null) {
    const i = lines.findIndex((l) => l.startsWith('ENGINE_ORDER='));
    const cur = i >= 0 ? lines[i].slice(13).split(',').map((x) => x.trim()).filter(Boolean) : [];
    if (!cur.includes(engine)) set('ENGINE_ORDER', cur.concat(engine).join(','));
  }
  return lines.join('\n');
}

// Che khóa khi hiển thị: sk-ant-…ab12
const mask = (key) => (!key ? '' : String(key).length <= 12 ? '****' : String(key).slice(0, 7) + '…' + String(key).slice(-4));

module.exports = { ENGINES, NAMES, WHERE, FORMAT, validFormat, check, applyToEnv, mask, VAR: base.VAR, childEnv: base.childEnv, keysFrom: base.keysFrom };
