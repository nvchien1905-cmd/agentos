'use strict';
const fs = require('fs');
const path = require('path');
const docgen = require('./docgen');

// SÁNG TẠO bằng AI qua Telegram (hai bộ công cụ có sẵn, xem builtins.js):
//   /ve <mô tả>      AI vẽ ảnh BẰNG MÃ (SVG/HTML: poster, infographic, sơ đồ, biểu đồ, logo đơn giản) → bộ điều phối chụp thành ảnh (render.js tự làm khi gặp tệp .html) — KHÔNG cần khóa API.
//   /taodoc <mô tả>  AI soạn nội dung tài liệu dạng có cấu trúc (JSON) → bộ điều phối dựng THẬT tệp Word/Excel/PDF/PowerPoint (docgen.js + agentos-office create).
// (Tạo ảnh bằng API Gemini/OpenAI: lệnh /anh, xem images.js.)
const VE_HINT = 'BẠN LÀ HỌA SĨ VẼ BẰNG MÃ. Người dùng nhờ vẽ một hình (poster, infographic, sơ đồ, biểu đồ, thiệp, logo đơn giản, banner...). Trả lời DUY NHẤT một khối ```html ... ``` chứa MỘT trang HTML hoàn chỉnh tự đủ (có thể nhúng <svg>): ' +
  'khung rộng 1200px (cao tự chọn, ví dụ 675 cho banner, 1200 cho poster dọc), CSS nội tuyến, KHÔNG dùng JavaScript, KHÔNG tải ảnh/phông/CSS từ mạng, chữ tiếng Việt CÓ DẤU với phông sans-serif (Noto Sans, Arial), nền đặc rõ ràng, bố cục cân đối, màu hài hòa, chữ đủ to và tương phản. ' +
  'Không giải thích, không thêm chữ ngoài khối mã. Có số liệu thì dùng đúng số người dùng đưa, không bịa.';
const DOC_HINT = 'BẠN LÀ NGƯỜI SOẠN TÀI LIỆU. Người dùng nhờ soạn văn bản/bảng/bài trình bày. Trả lời DUY NHẤT một khối ```json ... ``` là mô tả tài liệu theo lược đồ: ' +
  '{"type":"docx|xlsx|pdf|pptx","title":"...","subtitle":"","author":"","date":"","theme":"bao-cao|thu|toi-gian","blocks":[{"t":"h1|h2|h3|p|quote|code","text":"..."},{"t":"ul|ol","items":["..."]},{"t":"table","rows":[["Cột 1","Cột 2"],["a","b"]],"header":true},{"t":"pagebreak"}],"sheets":[{"name":"Trang 1","header":true,"rows":[["Tên","SL"],["A",3]]}],"slides":[{"title":"...","bullets":["..."],"notes":""}]}. ' +
  'Chọn type theo yêu cầu: Word=docx (dùng blocks), Excel=xlsx (dùng sheets, số ghi dạng số, công thức bắt đầu bằng =), PDF=pdf (dùng blocks), PowerPoint=pptx (dùng slides). Chữ trong khối hỗ trợ **đậm**, *nghiêng*, [chữ](https://...). ' +
  'Nội dung đầy đủ, đúng văn phong người dùng cần, tiếng Việt có dấu; số liệu/tên riêng KHÔNG bịa: thiếu thì để ô trống hoặc ghi "cần bổ sung". Không giải thích ngoài khối JSON.';

// Lấy khối mã đầu tiên theo ngôn ngữ (html/svg/json); không có hàng rào thì thử cả văn bản
function fenced(text, langs) {
  const re = /```([a-zA-Z]*)\s*\n([\s\S]*?)```/g; let m;
  while ((m = re.exec(String(text || '')))) if (!langs || langs.includes(m[1].toLowerCase()) || !m[1]) return m[2];
  return null;
}
function extractHtml(text) {
  let h = fenced(text, ['html', 'svg', 'xml']);
  if (!h) { const m = /(<!doctype html[\s\S]*<\/html>|<html[\s\S]*<\/html>|<svg[\s\S]*<\/svg>)/i.exec(String(text || '')); h = m && m[1]; }
  if (!h) return null;
  h = h.trim();
  if (/^<svg/i.test(h)) h = '<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}svg{display:block;width:1200px;height:auto}</style></head><body>' + h + '</body></html>';
  else if (!/<html/i.test(h)) h = '<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>body{margin:0;width:1200px;font-family:"Noto Sans",Arial,sans-serif}</style></head><body>' + h + '</body></html>';
  return h;
}
// Bỏ mã chạy được và tài nguyên ngoài: ảnh vẽ chỉ cần HTML/SVG/CSS tĩnh
function sanitizeHtml(h) {
  return String(h)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '').replace(/<(iframe|object|embed|link|base|meta http-equiv)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/javascript:/gi, '')
    .replace(/@import[^;]+;/gi, '').replace(/url\(\s*['"]?https?:[^)]*\)/gi, 'none');
}
function extractJson(text) {
  const f = fenced(text, ['json', 'js', '']);
  const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  let j = f ? tryParse(f.trim()) : null;
  if (!j) { const s = String(text || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) j = tryParse(s.slice(a, b + 1)); }
  return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
}

// Mô tả do AI soạn KHÔNG được nhúng tệp ảnh tuỳ ý của máy (vd. ảnh của người khác trong hộp thư đến): chỉ nhận ảnh có sẵn trong xưởng sáng tạo, theo TÊN tệp; còn lại bỏ.
function sanitizeImages(spec, studioDir) {
  if (!spec || !Array.isArray(spec.blocks)) return;
  spec.blocks = spec.blocks.filter((b) => {
    if (!b || b.t !== 'img') return true;
    const name = String(b.path || '');
    if (!studioDir || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(png|jpe?g|webp)$/i.test(name) || !fs.existsSync(path.join(studioDir, name))) return false;
    b.path = path.join(studioDir, name);
    return true;
  });
}

// o: { outDirFor(job), docgen (createDocgen), log }
function createCreative(o) {
  const log = o.log || (() => {});
  async function postProcess(job, res) {
    if (!job || !res || !res.text || (job.profile !== 've' && job.profile !== 'taodoc')) return null;
    let dir = null; try { dir = o.outDirFor ? o.outDirFor(job) : null; } catch (e) { dir = null; }
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    if (job.profile === 've') {
      const html = extractHtml(res.text);
      if (!html) return { text: '⚠️ AI không trả về hình vẽ dạng HTML/SVG. Thử mô tả rõ hơn (kiểu hình, màu, chữ cần có) rồi gõ lại /ve.' };
      const file = path.join(dir, 've-' + job.id + '.html');
      fs.writeFileSync(file, sanitizeHtml(html));
      return { text: '🎨 Đã vẽ xong (việc #' + job.id + '): em gửi ảnh và cả tệp HTML để anh sửa tiếp. Muốn chỉnh: gõ /ve kèm yêu cầu mới, hoặc nhắn "đổi màu…, thêm…".', files: [file] };
    }
    const spec = extractJson(res.text);
    if (!spec) return { text: '⚠️ AI không trả về mô tả tài liệu hợp lệ (JSON). Gõ lại /taodoc, nói rõ loại (Word/Excel/PDF/PowerPoint) và nội dung.' };
    if (!o.docgen) return { text: '⚠️ Máy này chưa có bộ dựng tài liệu.' };
    sanitizeImages(spec, o.studioDir);
    const r = await o.docgen.build(spec, { outDir: dir, name: String(spec.title || 'tai-lieu') });
    if (!r.ok) return { text: '⚠️ Không dựng được tệp: ' + r.error };
    if (o.studioDir) {                                  // lưu bản nháp để mở chỉnh tiếp bằng giao diện (Cài đặt → Xưởng sáng tạo)
      try { fs.mkdirSync(o.studioDir, { recursive: true }); fs.writeFileSync(path.join(o.studioDir, docgen.slug(r.doc.title) + '-' + job.id + '.json'), JSON.stringify(r.doc, null, 1)); } catch (e) { log('lưu bản nháp tài liệu lỗi: ' + e.message); }
    }
    const n = r.doc.blocks.length + r.doc.sheets.reduce((a, s) => a + s.rows.length, 0) + r.doc.slides.length;
    return { text: '📄 Đã tạo ' + r.doc.type.toUpperCase() + ': ' + path.basename(r.file) + ' (' + n + ' mục, "' + r.doc.title + '")' + (r.errors.length ? '\nĐã chỉnh: ' + r.errors.slice(0, 3).join(' ') : '') + '\nMuốn sửa bằng giao diện: Cài đặt → 🎨 Xưởng sáng tạo → Tài liệu.', files: [r.file] };
  }
  return { postProcess };
}

module.exports = { sanitizeImages, VE_HINT, DOC_HINT, createCreative, extractHtml, extractJson, sanitizeHtml, fenced };
