'use strict';
const fs = require('fs');
const path = require('path');

// TẠO ẢNH (như app Claude/ChatGPT): gọi API tạo ảnh bằng KHÓA API của chủ máy (đặt ở Cài đặt → AI):
//   gemini  Google (mô hình ảnh Gemini, mặc định gemini-2.5-flash-image): tạo ảnh MỚI và SỬA ảnh đã có theo lời nhắn
//   openai  OpenAI (gpt-image-1) bằng khóa của Codex: tạo ảnh mới (sửa = tạo lại theo mô tả đã ghép)
// Không có khóa nào thì dùng `/ve` (AI vẽ bằng mã SVG/HTML rồi chụp thành ảnh, không cần khóa) — xem creative.js.
// fetch được tiêm vào để test không cần mạng. Khóa không bao giờ ghi vào nhật ký.
const SIZES = { vuong: { label: 'Vuông 1:1', openai: '1024x1024', ratio: '1:1' }, ngang: { label: 'Ngang 16:9', openai: '1536x1024', ratio: '16:9' }, doc: { label: 'Dọc 9:16', openai: '1024x1536', ratio: '9:16' } };
const MAX_PROMPT = 2000, MAX_EDIT_IMAGE = 8 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function createImages(o) {
  o = o || {};
  const keys = o.keys || {};
  const doFetch = o.fetch || ((...a) => fetch(...a));
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const models = Object.assign({ gemini: 'gemini-2.5-flash-image', openai: 'gpt-image-1' }, o.models || {});
  const timeoutMs = o.timeoutMs || 120000;

  const providers = () => [
    { id: 'gemini', label: 'Google Gemini (' + models.gemini + ')', ready: !!keys.gemini, edit: true },
    { id: 'openai', label: 'OpenAI (' + models.openai + ')', ready: !!keys.codex, edit: false },
  ];
  const ready = () => providers().filter((p) => p.ready);

  async function post(url, headers, body) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await doFetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body), signal: ac.signal });
      let j = null; try { j = await r.json(); } catch (e) { j = null; }
      return { ok: r.ok, status: r.status, json: j };
    } catch (e) { return { ok: false, status: 0, json: null, error: e.name === 'AbortError' ? 'quá ' + Math.round(timeoutMs / 1000) + ' giây' : e.message }; }
    finally { clearTimeout(t); }
  }
  const apiError = (r) => {
    const m = r.json && r.json.error && (r.json.error.message || r.json.error.status) || r.error || ('HTTP ' + r.status);
    if (r.status === 401 || r.status === 403) return 'khóa API bị từ chối (kiểm khóa ở Cài đặt → AI)';
    if (r.status === 429) return 'hết hạn mức gọi API tạo ảnh, thử lại sau';
    return String(m).slice(0, 200);
  };

  async function gemini(prompt, size, base) {
    const parts = [{ text: prompt + (base ? '' : '\n\nTỉ lệ khung hình ' + SIZES[size].ratio + '.') }];
    if (base) parts.push({ inline_data: { mime_type: base.mime, data: base.b64 } });
    const r = await post('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(models.gemini) + ':generateContent', { 'x-goog-api-key': keys.gemini },
      { contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } });
    if (!r.ok) return { ok: false, error: apiError(r) };
    const cand = r.json && r.json.candidates && r.json.candidates[0];
    const ps = (cand && cand.content && cand.content.parts) || [];
    const img = ps.map((p) => p.inlineData || p.inline_data).find((x) => x && x.data);
    if (!img) {
      const said = ps.map((p) => p.text).filter(Boolean).join(' ').slice(0, 200);
      return { ok: false, error: said ? 'Gemini không tạo ảnh: ' + said : 'Gemini không trả ảnh (có thể bị chặn vì nội dung). Thử mô tả khác.' };
    }
    return { ok: true, b64: img.data, mime: img.mimeType || img.mime_type || 'image/png' };
  }
  async function openai(prompt, size) {
    const r = await post('https://api.openai.com/v1/images/generations', { authorization: 'Bearer ' + keys.codex }, { model: models.openai, prompt, size: SIZES[size].openai, n: 1 });
    if (!r.ok) return { ok: false, error: apiError(r) };
    const d = r.json && r.json.data && r.json.data[0];
    if (!d || !d.b64_json) return { ok: false, error: 'OpenAI không trả ảnh.' };
    return { ok: true, b64: d.b64_json, mime: 'image/png' };
  }

  // opts: { prompt, provider ('auto'|'gemini'|'openai'), size ('vuong'|'ngang'|'doc'), editOf (đường dẫn ảnh cần sửa), dir }
  async function generate(opts) {
    opts = opts || {};
    const prompt = String(opts.prompt || '').trim();
    if (!prompt) return { ok: false, error: 'Chưa có mô tả ảnh.' };
    if (prompt.length > MAX_PROMPT) return { ok: false, error: 'Mô tả dài quá ' + MAX_PROMPT + ' ký tự.' };
    const size = SIZES[opts.size] ? opts.size : 'vuong';
    const rdy = ready();
    if (!rdy.length) return { ok: false, noKey: true, error: 'Chưa có khóa API tạo ảnh (Google Gemini hoặc OpenAI). Thêm ở Cài đặt → AI, hoặc dùng /ve để AI vẽ bằng mã (không cần khóa).' };
    let pid = opts.provider && opts.provider !== 'auto' ? opts.provider : null;
    if (pid && !rdy.some((p) => p.id === pid)) return { ok: false, error: 'Nhà cung cấp "' + pid + '" chưa có khóa API.' };
    let base = null;
    if (opts.editOf) {
      try {
        const st = fs.statSync(opts.editOf);
        if (st.size > MAX_EDIT_IMAGE) return { ok: false, error: 'Ảnh cần sửa lớn quá (> 8 MB).' };
        const ext = path.extname(opts.editOf).slice(1).toLowerCase();
        if (!MIME[ext]) return { ok: false, error: 'Chỉ sửa được ảnh png/jpg/webp.' };
        base = { mime: MIME[ext], b64: fs.readFileSync(opts.editOf).toString('base64') };
      } catch (e) { return { ok: false, error: 'Không đọc được ảnh cần sửa.' }; }
      if (!pid) pid = rdy.find((p) => p.edit) ? 'gemini' : null;
      if (pid !== 'gemini') return { ok: false, error: 'Sửa ảnh theo lời nhắn cần khóa Google Gemini. Hãy mô tả ảnh mới đầy đủ để tạo lại.' };
    }
    pid = pid || rdy[0].id;
    const res = pid === 'gemini' ? await gemini(prompt, size, base) : await openai(prompt, size);
    if (!res.ok) { log('tạo ảnh (' + pid + ') lỗi: ' + res.error); return { ok: false, error: res.error, provider: pid }; }
    const buf = Buffer.from(res.b64, 'base64');
    if (buf.length < 200) return { ok: false, error: 'Ảnh nhận về rỗng.', provider: pid };
    const dir = opts.dir || o.dir;
    if (!dir) return { ok: false, error: 'Chưa có thư mục lưu ảnh.' };
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'anh-' + now() + '-' + pid + '.' + (EXT[res.mime] || 'png'));
    fs.writeFileSync(file, buf);
    return { ok: true, file, provider: pid, bytes: buf.length, prompt, size, edited: !!base };
  }

  return { generate, providers, ready, SIZES };
}

module.exports = { createImages, SIZES };
