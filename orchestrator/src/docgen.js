'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// TẠO TÀI LIỆU (Word, Excel, PDF, PowerPoint, trang web) từ MỘT mô tả có cấu trúc — để chỉnh bằng giao diện (trang Cài đặt → Xưởng sáng tạo) hoặc để AI soạn rồi xuất.
// Mô tả tài liệu (doc):
//   { type: 'docx'|'pdf'|'xlsx'|'pptx'|'html'|'md', title, subtitle?, author?, date?, theme?: 'bao-cao'|'thu'|'toi-gian',
//     blocks: [ {t:'h1'|'h2'|'h3'|'p'|'quote'|'code', text}, {t:'ul'|'ol', items:[...]}, {t:'table', rows:[[...]], header:true}, {t:'img', path, caption?}, {t:'pagebreak'} ],
//     sheets: [ {name, rows:[[...]], header:true} ]     (xlsx)
//     slides: [ {title, bullets:[...], notes?} ]         (pptx) }
// Chữ trong khối hỗ trợ **đậm**, *nghiêng*, `mã`, [chữ](https://địa-chỉ). Word/Excel/PowerPoint do `agentos-office create` dựng thật (python-docx/openpyxl/python-pptx), PDF = Word rồi LibreOffice đổi.
// Hàm ở đây thuần (kiểm tra, đổi qua lại, HTML, Markdown) nên test được không cần LibreOffice.
const TYPES = ['docx', 'pdf', 'xlsx', 'pptx', 'html', 'md'];
const THEMES = ['bao-cao', 'thu', 'toi-gian'];
const BLOCK_T = ['h1', 'h2', 'h3', 'p', 'quote', 'code', 'ul', 'ol', 'table', 'img', 'pagebreak'];
const LIMITS = { blocks: 600, text: 20000, items: 200, rows: 500, cols: 30, sheets: 20, slides: 60, title: 200 };

const str = (v, n) => String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, n);
const slug = (s) => String(s || 'tai-lieu').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tai-lieu';

// Làm sạch + kiểm tra: trả { doc, errors[] } (doc luôn dùng được; errors là điều đã bị bỏ/sửa)
function normalize(input) {
  const errors = [];
  const d = input && typeof input === 'object' ? input : {};
  const doc = { type: TYPES.includes(d.type) ? d.type : 'docx', title: str(d.title, LIMITS.title).trim() || 'Tài liệu', subtitle: str(d.subtitle, 300).trim(), author: str(d.author, 100).trim(), date: str(d.date, 40).trim(), theme: THEMES.includes(d.theme) ? d.theme : 'bao-cao', blocks: [], sheets: [], slides: [] };
  if (d.type && !TYPES.includes(d.type)) errors.push('Loại tài liệu "' + str(d.type, 20) + '" không có, dùng docx.');
  const blocks = Array.isArray(d.blocks) ? d.blocks : [];
  if (blocks.length > LIMITS.blocks) errors.push('Chỉ giữ ' + LIMITS.blocks + ' khối đầu.');
  for (const b of blocks.slice(0, LIMITS.blocks)) {
    if (!b || typeof b !== 'object' || !BLOCK_T.includes(b.t)) { errors.push('Bỏ một khối không hợp lệ.'); continue; }
    if (b.t === 'pagebreak') { doc.blocks.push({ t: 'pagebreak' }); continue; }
    if (b.t === 'ul' || b.t === 'ol') {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, LIMITS.items).map((x) => str(x, 2000)).filter((x) => x.trim());
      if (items.length) doc.blocks.push({ t: b.t, items }); else errors.push('Bỏ một danh sách rỗng.');
      continue;
    }
    if (b.t === 'table') {
      const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, LIMITS.rows).map((r) => (Array.isArray(r) ? r : []).slice(0, LIMITS.cols).map((c) => str(c, 1000)));
      const w = Math.max(0, ...rows.map((r) => r.length));
      if (!rows.length || !w) { errors.push('Bỏ một bảng rỗng.'); continue; }
      doc.blocks.push({ t: 'table', rows: rows.map((r) => r.concat(Array(w - r.length).fill(''))), header: b.header !== false });
      continue;
    }
    if (b.t === 'img') {
      const p = str(b.path, 500).trim();
      if (!p) { errors.push('Bỏ một ảnh không có đường dẫn.'); continue; }
      doc.blocks.push({ t: 'img', path: p, caption: str(b.caption, 300) });
      continue;
    }
    const text = str(b.text, LIMITS.text);
    if (!text.trim() && b.t !== 'code') { errors.push('Bỏ một khối chữ rỗng.'); continue; }
    doc.blocks.push({ t: b.t, text });
  }
  for (const s of (Array.isArray(d.sheets) ? d.sheets : []).slice(0, LIMITS.sheets)) {
    if (!s || typeof s !== 'object') continue;
    const rows = (Array.isArray(s.rows) ? s.rows : []).slice(0, LIMITS.rows * 10).map((r) => (Array.isArray(r) ? r : []).slice(0, LIMITS.cols * 3).map((c) => (typeof c === 'number' && Number.isFinite(c) ? c : str(c, 2000))));
    doc.sheets.push({ name: str(s.name, 31).replace(/[\\/?*[\]:]/g, ' ').trim() || 'Trang ' + (doc.sheets.length + 1), rows, header: s.header !== false });
  }
  for (const s of (Array.isArray(d.slides) ? d.slides : []).slice(0, LIMITS.slides)) {
    if (!s || typeof s !== 'object') continue;
    doc.slides.push({ title: str(s.title, 200), bullets: (Array.isArray(s.bullets) ? s.bullets : []).slice(0, 20).map((x) => str(x, 600)).filter(Boolean), notes: str(s.notes, 2000) });
  }
  if (doc.type === 'xlsx' && !doc.sheets.length) {
    // Tài liệu xlsx chỉ có khối bảng -> mỗi bảng thành một trang tính
    for (const b of doc.blocks) if (b.t === 'table') doc.sheets.push({ name: 'Trang ' + (doc.sheets.length + 1), rows: b.rows, header: b.header });
    if (!doc.sheets.length) errors.push('Bảng tính cần ít nhất một trang tính có dòng.');
  }
  if (doc.type === 'pptx' && !doc.slides.length) {
    // Tài liệu pptx chỉ có khối: mỗi tiêu đề h1/h2 mở một slide, các đoạn/danh sách sau nó là ý
    let cur = null;
    for (const b of doc.blocks) {
      if (b.t === 'h1' || b.t === 'h2') { cur = { title: b.text, bullets: [], notes: '' }; doc.slides.push(cur); }
      else if (cur && (b.t === 'p' || b.t === 'quote')) cur.bullets.push(b.text);
      else if (cur && (b.t === 'ul' || b.t === 'ol')) cur.bullets.push(...b.items);
    }
    if (!doc.slides.length) errors.push('Bài thuyết trình cần ít nhất một slide.');
  }
  if (!['xlsx', 'pptx'].includes(doc.type) && !doc.blocks.length) errors.push('Tài liệu chưa có nội dung.');
  return { doc, errors };
}

// ---- Chữ trong dòng -> HTML an toàn ----
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, a, u) => '<a href="' + u.replace(/&amp;/g, '&amp;') + '">' + a + '</a>');
  return t;
}
const THEME_CSS = {
  'bao-cao': 'body{font-family:"Noto Sans","Carlito",Arial,sans-serif;color:#1b2430;line-height:1.55;max-width:820px;margin:0 auto;padding:28px}h1{font-size:26px;border-bottom:3px solid #2563eb;padding-bottom:6px}h2{font-size:20px;color:#1d4ed8;margin-top:26px}h3{font-size:16px;color:#334155}th{background:#2563eb;color:#fff}',
  thu: 'body{font-family:"Caladea","Liberation Serif",Georgia,serif;color:#111;line-height:1.6;max-width:760px;margin:0 auto;padding:36px}h1,h2,h3{font-weight:700}th{background:#e5e7eb}',
  'toi-gian': 'body{font-family:system-ui,"Noto Sans",Arial,sans-serif;color:#222;line-height:1.5;max-width:760px;margin:0 auto;padding:24px}h1{font-size:24px}h2{font-size:19px}th{background:#f1f5f9}',
};
function toHtml(docIn, o) {
  o = o || {};
  const doc = docIn.blocks && docIn.theme ? docIn : normalize(docIn).doc;
  const imgSrc = o.imgSrc || ((p) => p);
  const body = [];
  if (doc.title) body.push('<h1>' + inline(doc.title) + '</h1>');
  const meta = [doc.subtitle, doc.author, doc.date].filter(Boolean);
  if (meta.length) body.push('<p class="meta">' + meta.map(esc).join(' · ') + '</p>');
  for (const b of doc.blocks) {
    if (b.t === 'h1' || b.t === 'h2' || b.t === 'h3') body.push('<' + b.t + '>' + inline(b.text) + '</' + b.t + '>');
    else if (b.t === 'p') body.push('<p>' + inline(b.text).replace(/\n/g, '<br>') + '</p>');
    else if (b.t === 'quote') body.push('<blockquote>' + inline(b.text).replace(/\n/g, '<br>') + '</blockquote>');
    else if (b.t === 'code') body.push('<pre>' + esc(b.text) + '</pre>');
    else if (b.t === 'ul' || b.t === 'ol') body.push('<' + b.t + '>' + b.items.map((x) => '<li>' + inline(x) + '</li>').join('') + '</' + b.t + '>');
    else if (b.t === 'table') body.push('<table>' + b.rows.map((r, i) => '<tr>' + r.map((c) => (i === 0 && b.header ? '<th>' : '<td>') + inline(c) + (i === 0 && b.header ? '</th>' : '</td>')).join('') + '</tr>').join('') + '</table>');
    else if (b.t === 'img') body.push('<figure><img src="' + esc(imgSrc(b.path)) + '" style="max-width:100%">' + (b.caption ? '<figcaption>' + inline(b.caption) + '</figcaption>' : '') + '</figure>');
    else if (b.t === 'pagebreak') body.push('<div style="page-break-after:always"></div>');
  }
  for (const s of doc.sheets) {
    body.push('<h2>' + esc(s.name) + '</h2><table>' + s.rows.map((r, i) => '<tr>' + r.map((c) => (i === 0 && s.header ? '<th>' : '<td>') + esc(c) + (i === 0 && s.header ? '</th>' : '</td>')).join('') + '</tr>').join('') + '</table>');
  }
  for (const s of doc.slides) body.push('<h2>' + inline(s.title) + '</h2>' + (s.bullets.length ? '<ul>' + s.bullets.map((x) => '<li>' + inline(x) + '</li>').join('') + '</ul>' : ''));
  const css = (THEME_CSS[doc.theme] || THEME_CSS['bao-cao']) + 'table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #cbd5e1;padding:6px 10px;text-align:left;vertical-align:top}blockquote{border-left:4px solid #94a3b8;margin:12px 0;padding:4px 14px;color:#475569}pre,code{background:#f1f5f9;font-family:"DejaVu Sans Mono",monospace}pre{padding:10px;white-space:pre-wrap}.meta{color:#64748b}figure{margin:14px 0}figcaption{color:#64748b;font-size:13px}@page{size:A4;margin:18mm}';
  return '<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>' + esc(doc.title) + '</title><style>' + css + '</style></head><body>' + body.join('\n') + '</body></html>';
}

function toMarkdown(docIn) {
  const doc = docIn.blocks && docIn.theme ? docIn : normalize(docIn).doc;
  const out = ['# ' + doc.title];
  const meta = [doc.subtitle, doc.author, doc.date].filter(Boolean);
  if (meta.length) out.push('*' + meta.join(' · ') + '*');
  for (const b of doc.blocks) {
    if (b.t === 'h1') out.push('# ' + b.text); else if (b.t === 'h2') out.push('## ' + b.text); else if (b.t === 'h3') out.push('### ' + b.text);
    else if (b.t === 'p') out.push(b.text);
    else if (b.t === 'quote') out.push(b.text.split('\n').map((l) => '> ' + l).join('\n'));
    else if (b.t === 'code') out.push('```\n' + b.text + '\n```');
    else if (b.t === 'ul') out.push(b.items.map((x) => '- ' + x).join('\n'));
    else if (b.t === 'ol') out.push(b.items.map((x, i) => (i + 1) + '. ' + x).join('\n'));
    else if (b.t === 'table') { const w = b.rows[0].length; const row = (r) => '| ' + r.map((c) => c.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |'; out.push([row(b.rows[0]), '|' + Array(w).fill(' --- ').join('|') + '|'].concat(b.rows.slice(1).map(row)).join('\n')); }
    else if (b.t === 'img') out.push('![' + (b.caption || '') + '](' + b.path + ')');
    else if (b.t === 'pagebreak') out.push('---');
  }
  return out.join('\n\n') + '\n';
}

// Markdown -> khối (để đưa báo cáo AI viết vào cùng khuôn tài liệu). Hỗ trợ: # ## ###, đoạn, - * danh sách, 1. danh sách số, > trích, ``` mã, bảng |, ---.
function fromMarkdown(md, o) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const blocks = []; let i = 0, title = '';
  const flushPara = (buf) => { const t = buf.join('\n').trim(); if (t) blocks.push({ t: 'p', text: t }); };
  while (i < lines.length) {
    const L = lines[i];
    let m;
    if (!L.trim()) { i++; continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(L))) { if (m[1].length === 1 && !title && !blocks.length) title = m[2].trim(); else blocks.push({ t: 'h' + m[1].length, text: m[2].trim() }); i++; continue; }
    if (/^```/.test(L)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; blocks.push({ t: 'code', text: buf.join('\n') }); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(L)) { blocks.push({ t: 'pagebreak' }); i++; continue; }
    if (/^\s*>\s?/.test(L)) { const buf = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); blocks.push({ t: 'quote', text: buf.join('\n') }); continue; }
    if (/^\s*[-*+]\s+/.test(L)) { const items = []; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, '')); blocks.push({ t: 'ul', items }); continue; }
    if (/^\s*\d+[.)]\s+/.test(L)) { const items = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, '')); blocks.push({ t: 'ol', items }); continue; }
    if (/^\s*\|.*\|\s*$/.test(L)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { const cells = lines[i].trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|')); if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells); i++; }
      if (rows.length) blocks.push({ t: 'table', rows, header: true });
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|.*\|\s*$|\s*(---|\*\*\*)\s*$)/.test(lines[i])) buf.push(lines[i++]);
    flushPara(buf);
    if (!buf.length) i++;
  }
  return Object.assign({ type: (o && o.type) || 'docx', title: (o && o.title) || title || 'Tài liệu', blocks }, o && o.meta ? o.meta : {});
}

function defaultExec(bin) {
  return (args, timeout) => new Promise((res) => execFile(bin, args, { timeout: timeout || 240000, maxBuffer: 8 << 20, env: process.env }, (e, so, se) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(so || ''), err: String(se || ''), missing: !!(e && e.code === 'ENOENT') })));
}

// Dựng tệp: html/md tự viết; docx/xlsx/pptx qua `agentos-office create`; pdf = docx rồi LibreOffice đổi (qua `agentos-office create pdf`).
// o: { bin, exec, outDir, tmpDir }. Trả { ok, file, errors } hoặc { ok:false, error }
function createDocgen(o) {
  o = o || {};
  const exec = o.exec || defaultExec(o.bin || 'agentos-office');
  const now = o.now || Date.now;
  async function build(input, opts) {
    opts = opts || {};
    const { doc, errors } = normalize(input);
    const outDir = opts.outDir || o.outDir;
    if (!outDir) return { ok: false, error: 'Chưa có thư mục lưu tài liệu.' };
    fs.mkdirSync(outDir, { recursive: true });
    if (!doc.blocks.length && !doc.sheets.length && !doc.slides.length) return { ok: false, error: 'Tài liệu chưa có nội dung.', errors };
    const base = (opts.name ? slug(opts.name) : slug(doc.title)) + '-' + String(now()).slice(-6);
    if (doc.type === 'html' || doc.type === 'md') {
      const file = path.join(outDir, base + '.' + doc.type);
      fs.writeFileSync(file, doc.type === 'html' ? toHtml(doc, { imgSrc: (p) => (path.isAbsolute(p) ? 'file://' + p : p) }) : toMarkdown(doc));
      return { ok: true, file, doc, errors };
    }
    const spec = path.join(o.tmpDir || outDir, '.' + base + '.spec.json');
    const file = path.join(outDir, base + '.' + doc.type);
    fs.writeFileSync(spec, JSON.stringify(doc));
    try {
      const r = await exec(['create', doc.type, spec, '--out', file], 300000);
      if (r.code !== 0 || !fs.existsSync(file)) return { ok: false, error: r.missing ? 'Máy chưa có công cụ agentos-office (cập nhật phần mềm để có).' : String(r.err || r.out || 'lỗi không rõ').replace(/^LỖI:\s*/, '').trim().slice(0, 400), errors };
      return { ok: true, file, doc, errors };
    } finally { try { fs.rmSync(spec, { force: true }); } catch (e) { /* bỏ qua */ } }
  }
  return { build, normalize, toHtml, toMarkdown, fromMarkdown };
}

module.exports = { normalize, toHtml, toMarkdown, fromMarkdown, createDocgen, inline, esc, slug, TYPES, THEMES, BLOCK_T, LIMITS };
