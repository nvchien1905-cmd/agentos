'use strict';

// Đổi Markdown (kiểu AI/Claude Code trả về) sang HTML mà Telegram hiển thị đẹp: **đậm**, *nghiêng*, `mã`, ```khối mã```, tiêu đề, danh sách,
// > trích dẫn, liên kết, ~~gạch~~. Telegram KHÔNG có bảng nên bảng được vẽ lại bằng chữ đơn cách (hoặc danh sách nếu quá rộng).
// Kết quả là mảng tin (mỗi tin ≤ max ký tự, không cắt đôi thẻ): [{ html, text }] — `text` là bản chữ thường dùng khi Telegram từ chối HTML.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
const SAFE_URL = /^(https?:\/\/|tg:\/\/|mailto:)/i;

// Chữ trong dòng: đậm/nghiêng/gạch/liên kết. Mã inline đã được thay bằng \u0000N\u0000 trước đó.
function inline(s, codes) {
  let t = esc(s);
  t = t.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, (m, label, url) => {
    const u = url.replace(/&amp;/g, '&');
    return SAFE_URL.test(u) ? '<a href="' + escAttr(u) + '">' + label + '</a>' : m;
  });
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>').replace(/(^|[^\w])__([^_\n]+?)__(?=[^\w]|$)/g, '$1<b>$2</b>');
  t = t.replace(/(^|[\s(>])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?<]|$)/g, '$1<i>$2</i>').replace(/(^|[\s(>])_([^_\s][^_\n]*?)_(?=[\s).,;:!?<]|$)/g, '$1<i>$2</i>');
  t = t.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + esc(codes[Number(i)]) + '</code>');
}

const cutCell = (c, n) => { c = String(c).replace(/\s+/g, ' ').trim(); return c.length > n ? c.slice(0, n - 1) + '…' : c; };
const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

// Bảng -> khối chữ đơn cách (hoặc danh sách gạch đầu dòng nếu quá rộng/nhiều cột)
function renderTable(lines, plainOf, fmt) {
  const rows = lines.filter((l, i) => !(i === 1 && isSep(l))).map(cells);
  const head = rows[0], body = rows.slice(1);
  const n = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: n }, (_, c) => Math.min(22, Math.max(...rows.map((r) => cutCell(plainOf(r[c] || ''), 22).length), 1)));
  const total = widths.reduce((a, b) => a + b, 0) + 3 * (n - 1);
  if (n > 3 || total > 52) {
    const items = body.map((r) => '• <b>' + fmt(cutCell(r[0] || '', 60)) + '</b>' + r.slice(1).map((c, i) => (c ? ' · ' + (head[i + 1] ? esc(plainOf(head[i + 1])) + ': ' : '') + fmt(cutCell(c, 80)) : '')).join(''));
    return { html: (items.join('\n') || '(bảng trống)'), text: body.map((r) => '• ' + r.map((c) => plainOf(c)).join(' · ')).join('\n') };
  }
  const line = (r) => r.concat(Array(n - r.length).fill('')).map((c, i) => cutCell(plainOf(c), widths[i]).padEnd(widths[i])).join(' │ ').replace(/\s+$/, '');
  const sep = widths.map((w) => '─'.repeat(w)).join('─┼─');
  const txt = [line(head), sep].concat(body.map(line)).join('\n');
  return { html: '<pre>' + esc(txt) + '</pre>', text: txt, pre: true };
}

// Trả về mảng khối: { html, text, pre? }
function blocksOf(md) {
  const src = String(md == null ? '' : md).replace(/\r\n?/g, '\n');
  const out = [];
  const lines = src.split('\n');
  const plainOf = (s) => String(s).replace(/\*\*|__|~~|`/g, '');
  let para = [], paraText = [];
  const flush = () => { if (para.length) { out.push({ html: para.join('\n'), text: paraText.join('\n') }); para = []; paraText = []; } };
  const codes = [];
  const stash = (s) => String(s).replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\s*```+\s*([\w+-]*)\s*$/))) {                             // khối mã
      const buf = []; i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) buf.push(lines[i++]);
      flush();
      const code = buf.join('\n');
      out.push({ html: '<pre>' + (m[1] ? '<code class="language-' + esc(m[1]) + '">' + esc(code) + '</code>' : esc(code)) + '</pre>', text: code, pre: true, raw: code, lang: m[1] });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && isSep(lines[i + 1])) {   // bảng
      const tbl = [l, lines[i + 1]]; i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) tbl.push(lines[i++]);
      i--; flush(); out.push(renderTable(tbl, plainOf, (x) => inline(stash(x), codes))); continue;
    }
    if (!l.trim()) { flush(); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { para.push('──────────'); paraText.push('──────────'); continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*\S)\s*$/))) { para.push('<b>' + inline(stash(m[2]), codes) + '</b>'); paraText.push(plainOf(m[2])); continue; }
    if ((m = l.match(/^\s*>\s?(.*)$/))) {                                         // trích dẫn (gom các dòng liên tiếp)
      const q = [m[1]];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) q.push(lines[++i].replace(/^\s*>\s?/, ''));
      flush(); out.push({ html: '<blockquote>' + q.map((x) => inline(stash(x), codes)).join('\n') + '</blockquote>', text: q.map(plainOf).join('\n') });
      continue;
    }
    if ((m = l.match(/^(\s*)([-*+])\s+(.*)$/))) { const pad = ' '.repeat(Math.min(8, m[1].length)); para.push(pad + '• ' + inline(stash(m[3]), codes)); paraText.push(m[1] + '• ' + plainOf(m[3])); continue; }
    if ((m = l.match(/^(\s*)(\d+[.)])\s+(.*)$/))) { const pad = ' '.repeat(Math.min(8, m[1].length)); para.push(pad + m[2] + ' ' + inline(stash(m[3]), codes)); paraText.push(m[1] + m[2] + ' ' + plainOf(m[3])); continue; }
    para.push(inline(stash(l), codes)); paraText.push(plainOf(l));
  }
  flush();
  return out;
}

// Ghép khối thành các tin ≤ max ký tự; khối mã quá dài thì cắt theo dòng và mở lại thẻ <pre> ở tin sau.
function toTelegramChunks(md, max) {
  max = max || 3800;
  const chunks = [];
  let cur = { html: '', text: '' };
  const push = () => { if (cur.html) { chunks.push(cur); cur = { html: '', text: '' }; } };
  const add = (b) => {
    const sepH = cur.html ? '\n\n' : '';
    if (cur.html && cur.html.length + sepH.length + b.html.length > max) push();
    cur.html += (cur.html ? '\n\n' : '') + b.html; cur.text += (cur.text ? '\n\n' : '') + b.text;
  };
  for (const b of blocksOf(md)) {
    if (b.html.length <= max) { add(b); continue; }
    if (b.pre) {                                                                   // khối mã/bảng dài: chia theo dòng
      const open = b.lang ? '<pre><code class="language-' + esc(b.lang) + '">' : '<pre>', close = b.lang ? '</code></pre>' : '</pre>';
      const src = b.raw != null ? b.raw : b.text;
      let part = [], len = 0;
      const emit = () => { if (part.length) { add({ html: open + esc(part.join('\n')) + close, text: part.join('\n') }); push(); part = []; len = 0; } };
      for (const ln of src.split('\n')) {
        const piece = ln.length > max - 60 ? ln.slice(0, max - 60) + '…' : ln;
        if (len + piece.length + 1 > max - 60) emit();
        part.push(piece); len += piece.length + 1;
      }
      emit(); continue;
    }
    // đoạn văn dài: cắt theo dòng, rồi theo ký tự
    let buf = '', bufT = '';
    for (const ln of b.html.split('\n')) {
      if (buf.length + ln.length + 1 > max) { add({ html: buf, text: bufT }); push(); buf = ''; bufT = ''; }
      buf += (buf ? '\n' : '') + (ln.length > max ? ln.slice(0, max) : ln); bufT += (bufT ? '\n' : '') + ln.replace(/<[^>]+>/g, '');
    }
    if (buf) add({ html: buf, text: bufT });
  }
  push();
  return chunks.length ? chunks : [{ html: '', text: '' }];
}

module.exports = { toTelegramChunks, blocksOf, esc };
