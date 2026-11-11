'use strict';

// NÉN NGỮ CẢNH bằng mô hình RẺ qua khóa API (Gemini hoặc DeepSeek), không dùng AI mạnh/đắt cho việc tóm tắt.
// Gọi thẳng API của hãng (không qua CLI): một cuộc gọi, không công cụ, đầu vào bị cắt ngắn. Lỗi/không có khóa -> trả null (bộ nhớ tự dùng cách tóm tắt cắt gọn).
//   provider: 'auto' (Gemini nếu có khóa, rồi DeepSeek, rồi Codex nếu có) | 'gemini' | 'deepseek' | 'codex' | 'claude' | 'none'
//   Codex: dùng tài khoản Codex đã đăng nhập sẵn (không cần khóa API) qua hàm o.codex(system, user) do nơi gọi đưa vào.
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const DEEPSEEK = 'https://api.deepseek.com/chat/completions';
const MAX_IN = 14000;                         // ký tự gửi đi tối đa mỗi lần

function createSummarizer(o) {
  o = o || {};
  const keys = o.keys || {};
  const f = o.fetch || fetch;
  const log = o.log || (() => {});
  const provider = String(o.provider || 'auto').toLowerCase();
  const geminiModelCfg = o.geminiModel || '';
  const deepseekModel = o.deepseekModel || 'deepseek-flash';
  let geminiModel = geminiModelCfg || null, discoveredAt = 0;

  // Danh sách cách nén theo thứ tự thử: khóa Gemini/DeepSeek (rẻ nhất), rồi CHÍNH các AI mà bot này có (theo thứ tự ưu tiên của bot: engineOrder). Bot chỉ có Claude thì không bao giờ thử Codex.
  const engineOrder = Array.isArray(o.engineOrder) && o.engineOrder.length ? o.engineOrder : ['codex', 'claude'];
  const candidates = () => {
    if (provider === 'none') return [];
    const c = [];
    if ((provider === 'auto' || provider === 'gemini') && keys.gemini) c.push('gemini');
    if ((provider === 'auto' || provider === 'deepseek') && keys.deepseekapi) c.push('deepseek');
    for (const e of engineOrder) {
      if (e === 'claude' && (provider === 'auto' || provider === 'claude') && typeof o.claude === 'function') c.push('claude');
      if (e === 'codex' && (provider === 'auto' || provider === 'codex') && typeof o.codex === 'function') c.push('codex');
    }
    if (provider === 'claude' && typeof o.claude === 'function' && !c.includes('claude')) c.push('claude');
    if (provider === 'codex' && typeof o.codex === 'function' && !c.includes('codex')) c.push('codex');
    return c;
  };
  const pick = () => candidates()[0] || null;

  // Chọn mô hình Gemini "flash" còn dùng được (tên mô hình đổi theo thời gian): hỏi danh sách rồi nhớ 24 giờ.
  async function discoverGemini() {
    if (geminiModelCfg) return geminiModelCfg;
    if (geminiModel && Date.now() - discoveredAt < 24 * 3600 * 1000) return geminiModel;
    try {
      const r = await f(GEMINI + '/models?pageSize=200', { headers: { 'x-goog-api-key': keys.gemini }, signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const j = await r.json();
        const names = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, ''));
        const best = names.find((n) => n === 'gemini-flash-latest') || names.find((n) => /^gemini-[\d.]+-flash$/.test(n)) || names.find((n) => /flash/.test(n) && !/(image|tts|live|thinking|lite)/.test(n)) || names[0];
        if (best) { geminiModel = best; discoveredAt = Date.now(); return best; }
      }
    } catch (e) { /* dùng mặc định */ }
    geminiModel = geminiModel || 'gemini-flash-latest'; discoveredAt = Date.now();
    return geminiModel;
  }

  async function viaGemini(system, user) {
    const model = await discoverGemini();
    const r = await f(GEMINI + '/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': keys.gemini }, signal: AbortSignal.timeout(45000),
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 1200 } }),
    });
    if (!r.ok) throw new Error('Gemini HTTP ' + r.status);
    const j = await r.json();
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const text = parts.map((p) => p.text || '').join('').trim();
    if (!text) throw new Error('Gemini trả rỗng');
    return text;
  }
  async function viaDeepseek(system, user) {
    const r = await f(DEEPSEEK, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + keys.deepseekapi }, signal: AbortSignal.timeout(45000),
      body: JSON.stringify({ model: deepseekModel, temperature: 0.2, max_tokens: 1200, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error('DeepSeek HTTP ' + r.status);
    const j = await r.json();
    const text = String((((j.choices || [])[0] || {}).message || {}).content || '').trim();
    if (!text) throw new Error('DeepSeek trả rỗng');
    return text;
  }

  async function viaCodex(system, user) {
    const text = String(await o.codex(system, user) || '').trim();
    if (!text) throw new Error('Codex trả rỗng');
    return text;
  }

  async function viaClaude(system, user) {
    const text = String(await o.claude(system, user) || '').trim();
    if (!text) throw new Error('Claude trả rỗng');
    return text;
  }

  // Trả { text, via } hoặc null khi không có khóa/lỗi.
  async function run(system, user) {
    const cands = candidates();
    if (!cands.length) return null;
    const input = String(user).length > MAX_IN ? String(user).slice(-MAX_IN) : String(user);
    for (const via of cands) {                                    // lỗi ở cách này (hết hạn mức, mất đăng nhập...) thì thử cách kế tiếp thay vì bỏ nén
      try { return { text: await (via === 'gemini' ? viaGemini : via === 'codex' ? viaCodex : via === 'claude' ? viaClaude : viaDeepseek)(system, input), via }; }
      catch (e) { log('tóm tắt bằng ' + via + ' lỗi: ' + e.message); }
    }
    return null;
  }
  return { run, available: () => !!pick(), provider: () => pick() };
}

module.exports = { createSummarizer };
