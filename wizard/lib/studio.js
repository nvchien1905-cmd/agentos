'use strict';
const fs = require('fs');
const path = require('path');
const docgen = require('../../orchestrator/src/docgen');
const { createImages } = require('../../orchestrator/src/images');

// XƯỞNG SÁNG TẠO (Cài đặt → 🎨 Xưởng sáng tạo): tạo ẢNH bằng AI và soạn TÀI LIỆU (Word, Excel, PDF, PowerPoint) chỉnh bằng giao diện.
// Mọi thứ nằm trong MỘT thư mục (mặc định /var/lib/agentos/data/studio, cùng thư mục dữ liệu của bot quản lý nên /taodoc trên Telegram lưu bản nháp vào đây để mở chỉnh tiếp):
//   anh-*.png        ảnh đã tạo           <tên>.json   bản nháp tài liệu (mô tả có cấu trúc của docgen.js)           <tên>-<số>.docx|xlsx|pdf|pptx|html|md   tệp đã xuất
// Tên tệp qua trang chỉ gồm chữ/số/._- và luôn nằm trong thư mục này (không thoát ra ngoài).
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const IMG_EXT = /\.(png|jpe?g|webp)$/i, OUT_EXT = /\.(docx|xlsx|pdf|pptx|html|md)$/i;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_DL = 25 * 1024 * 1024, MAX_PREVIEW_IMG = 6 * 1024 * 1024;

const TEMPLATES = [
  { id: 'thu', label: 'Thư / công văn', doc: { type: 'docx', theme: 'thu', title: 'CÔNG VĂN', subtitle: 'Số: …/CV', date: '', blocks: [{ t: 'p', text: '**Kính gửi:** [Tên đơn vị / người nhận]' }, { t: 'p', text: 'Nhân việc [nội dung], chúng tôi xin trình bày như sau:' }, { t: 'ol', items: ['Ý thứ nhất.', 'Ý thứ hai.'] }, { t: 'p', text: 'Rất mong nhận được sự quan tâm của quý đơn vị.' }, { t: 'p', text: 'Trân trọng.' }] } },
  { id: 'baogia', label: 'Bảng báo giá (Word)', doc: { type: 'docx', theme: 'bao-cao', title: 'BẢNG BÁO GIÁ', subtitle: 'Gia dụng Huyền Anh', blocks: [{ t: 'p', text: 'Kính gửi quý khách. Chúng tôi xin gửi bảng báo giá như sau:' }, { t: 'table', header: true, rows: [['STT', 'Sản phẩm', 'Số lượng', 'Đơn giá', 'Thành tiền'], ['1', '', '', '', ''], ['2', '', '', '', '']] }, { t: 'p', text: '*Giá đã gồm VAT. Báo giá có hiệu lực 7 ngày.*' }] } },
  { id: 'hop', label: 'Biên bản họp', doc: { type: 'docx', theme: 'bao-cao', title: 'BIÊN BẢN HỌP', subtitle: '', blocks: [{ t: 'h2', text: 'Thông tin' }, { t: 'ul', items: ['Thời gian: ', 'Địa điểm: ', 'Thành phần: '] }, { t: 'h2', text: 'Nội dung' }, { t: 'ol', items: ['Nội dung thứ nhất', 'Nội dung thứ hai'] }, { t: 'h2', text: 'Việc cần làm' }, { t: 'table', header: true, rows: [['Việc', 'Người phụ trách', 'Hạn'], ['', '', '']] }] } },
  { id: 'chamcong', label: 'Bảng chấm công (Excel)', doc: { type: 'xlsx', title: 'Bảng chấm công', sheets: [{ name: 'Tháng', header: true, rows: [['Nhân viên', 'Ngày công', 'Nghỉ phép', 'Đi muộn', 'Ghi chú'], ['', 0, 0, 0, ''], ['', 0, 0, 0, ''], ['Tổng', '=SUM(B2:B3)', '=SUM(C2:C3)', '=SUM(D2:D3)', '']] }] } },
  { id: 'trinhbay', label: 'Bài thuyết trình 3 slide (PowerPoint)', doc: { type: 'pptx', title: 'Tiêu đề bài trình bày', subtitle: '', slides: [{ title: 'Giới thiệu', bullets: ['Ý chính 1', 'Ý chính 2'], notes: '' }, { title: 'Nội dung', bullets: ['Điểm 1', 'Điểm 2', 'Điểm 3'], notes: '' }, { title: 'Kết luận', bullets: ['Tóm lại', 'Bước tiếp theo'], notes: '' }] } },
];

function createStudio(o) {
  o = o || {};
  const dir = o.dir;
  if (!dir) throw new Error('Thiếu thư mục xưởng sáng tạo');
  const now = o.now || Date.now;
  const keys = typeof o.keys === 'function' ? o.keys : () => o.keys || {};
  const chown = o.chown || (() => {});
  fs.mkdirSync(dir, { recursive: true });
  chown(dir);                                         // trang Cài đặt chạy bằng root: thư mục (và tệp) phải thuộc người dùng agentos để bộ điều phối ghi ảnh /anh và bản nháp /taodoc vào được

  const abs = (name) => {
    name = String(name || '');
    if (!NAME_RE.test(name)) throw new Error('Tên tệp không hợp lệ.');
    const p = path.join(dir, name);
    if (path.dirname(p) !== path.resolve(dir) && path.dirname(p) !== dir) throw new Error('Tên tệp không hợp lệ.');
    return p;
  };
  const imgs = () => createImages({ keys: keys(), dir, fetch: o.fetch, now, log: o.log });
  const dg = () => docgen.createDocgen({ outDir: dir, tmpDir: dir, exec: o.exec, bin: o.officeBin, now });
  const info = (name) => { try { const st = fs.statSync(path.join(dir, name)); return st.isFile() ? { name, size: st.size, at: Math.round(st.mtimeMs) } : null; } catch (e) { return null; } };
  const draftMeta = (name) => {
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); return { title: String(j.title || name).slice(0, 120), type: docgen.TYPES.includes(j.type) ? j.type : 'docx' }; } catch (e) { return { title: name, type: 'docx' }; }
  };

  function list() {
    let names = []; try { names = fs.readdirSync(dir).filter((n) => NAME_RE.test(n)); } catch (e) { names = []; }
    const all = names.map(info).filter(Boolean).sort((a, b) => b.at - a.at);
    return {
      providers: imgs().providers().map((p) => ({ id: p.id, label: p.label, ready: p.ready, edit: p.edit })),
      sizes: Object.keys(imgs().SIZES).map((k) => ({ id: k, label: imgs().SIZES[k].label })),
      images: all.filter((f) => IMG_EXT.test(f.name)).slice(0, 60),
      drafts: all.filter((f) => /\.json$/i.test(f.name)).map((f) => Object.assign({}, f, draftMeta(f.name))).slice(0, 100),
      files: all.filter((f) => OUT_EXT.test(f.name)).slice(0, 100),
      templates: TEMPLATES.map((t) => ({ id: t.id, label: t.label })),
      types: [['docx', 'Word (.docx)'], ['pdf', 'PDF'], ['xlsx', 'Excel (.xlsx)'], ['pptx', 'PowerPoint (.pptx)'], ['html', 'Trang web (.html)'], ['md', 'Markdown (.md)']],
    };
  }
  const template = (id) => { const t = TEMPLATES.find((x) => x.id === id); if (!t) throw new Error('Không có mẫu này.'); return JSON.parse(JSON.stringify(t.doc)); };

  async function image(b) {
    b = b || {};
    const r = await imgs().generate({ prompt: b.prompt, provider: b.provider, size: b.size, editOf: b.editOf ? abs(b.editOf) : null });
    if (!r.ok) throw new Error(r.error);
    chown(r.file);
    return { name: path.basename(r.file), provider: r.provider, edited: r.edited };
  }

  // Khối ảnh trỏ tới tên tệp ảnh trong xưởng -> đường dẫn đầy đủ (chỉ ảnh trong thư mục này)
  function resolveImages(doc) {
    const d = JSON.parse(JSON.stringify(doc || {}));
    for (const b of Array.isArray(d.blocks) ? d.blocks : []) {
      if (b && b.t === 'img' && NAME_RE.test(String(b.path || '')) && IMG_EXT.test(b.path) && fs.existsSync(path.join(dir, b.path))) b.path = path.join(dir, b.path);
      else if (b && b.t === 'img') b.path = '';
    }
    return d;
  }
  function preview(doc) {
    const { doc: n } = docgen.normalize(resolveImages(doc));
    return docgen.toHtml(n, { imgSrc: (p) => { try { const st = fs.statSync(p); if (st.size > MAX_PREVIEW_IMG) return ''; return 'data:' + (MIME[path.extname(p).toLowerCase()] || 'image/png') + ';base64,' + fs.readFileSync(p).toString('base64'); } catch (e) { return ''; } } });
  }
  function saveDraft(name, doc) {
    const { doc: n } = docgen.normalize(doc);
    const keep = n;                                   // khối ảnh giữ theo TÊN tệp trong xưởng; đường dẫn đầy đủ chỉ được ghép lúc xem trước / xuất tệp
    const file = name && NAME_RE.test(name) && /\.json$/i.test(name) ? name : docgen.slug(n.title) + '-' + String(now()).slice(-6) + '.json';
    const p = abs(file);
    fs.writeFileSync(p, JSON.stringify(keep, null, 1)); chown(p);
    return { name: file, title: n.title, type: n.type };
  }
  function getDraft(name) {
    const p = abs(name); if (!/\.json$/i.test(name)) throw new Error('Không phải bản nháp.');
    let j; try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { throw new Error('Không đọc được bản nháp.'); }
    return docgen.normalize(j).doc;
  }
  async function build(doc, draftName) {
    const r = await dg().build(resolveImages(doc), { outDir: dir, name: draftName ? draftName.replace(/\.json$/i, '').replace(/-\d{6}$/, '') : undefined });
    if (!r.ok) throw new Error(r.error);
    chown(r.file);
    return { name: path.basename(r.file), type: r.doc.type, notes: r.errors };
  }
  function fromMarkdown(md, type) {
    if (String(md || '').length > 200000) throw new Error('Văn bản dài quá.');
    return docgen.normalize(docgen.fromMarkdown(md, { type: docgen.TYPES.includes(type) ? type : 'docx' })).doc;
  }
  function fileData(name, download) {
    const p = abs(name), st = fs.statSync(p);
    if (!st.isFile()) throw new Error('Không phải tệp.');
    const ext = path.extname(name).toLowerCase();
    if (download) { if (st.size > MAX_DL) throw new Error('Tệp lớn quá để tải qua trang này.'); return { name, size: st.size, base64: fs.readFileSync(p).toString('base64') }; }
    if (MIME[ext]) return { name, size: st.size, kind: 'image', dataUrl: 'data:' + MIME[ext] + ';base64,' + fs.readFileSync(p).toString('base64') };
    throw new Error('Chỉ xem trước được ảnh; dùng nút tải về.');
  }
  function remove(name) { const p = abs(name); if (!fs.existsSync(p)) return { removed: false }; fs.rmSync(p, { force: true }); return { removed: true }; }

  return { list, image, preview, saveDraft, getDraft, build, fromMarkdown, fileData, remove, template, resolveImages, abs, TEMPLATES };
}

module.exports = { createStudio, NAME_RE, TEMPLATES };
