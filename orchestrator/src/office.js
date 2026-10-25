'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Cầu nối tới `agentos-office` (đọc / thay chữ / đổi định dạng tệp Word, Excel, PowerPoint, PDF bằng LibreOffice + thư viện Python) cho lệnh nhanh /doc /doi /thay.
// Tệp khách gửi qua Telegram nằm ở thư mục inbox; lệnh không ghi đường dẫn thì lấy TỆP VĂN PHÒNG GỬI GẦN NHẤT.
const OFFICE_EXT = /\.(docx?|xlsx?|xlsm|pptx?|pps|odt|ods|odp|rtf|pdf|csv|txt|md)$/i;
const FORMATS = ['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'csv', 'txt', 'html'];

function createOffice(o) {
  o = o || {};
  const bin = o.bin || 'agentos-office';
  const dirs = [o.inboxDir, o.oneDriveDir, o.cwd].filter(Boolean);
  const exec = o.exec || ((args, timeout) => new Promise((res) => execFile(bin, args, { timeout: timeout || 200000, maxBuffer: 8 << 20, env: process.env }, (e, so, se) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(so || ''), err: String(se || '').trim(), missing: !!(e && e.code === 'ENOENT') }))));

  function latest() {
    let best = null;
    for (const d of [o.inboxDir].filter(Boolean)) {
      try { for (const n of fs.readdirSync(d)) { if (!OFFICE_EXT.test(n)) continue; const p = path.join(d, n); const st = fs.statSync(p); if (st.isFile() && (!best || st.mtimeMs > best.at)) best = { path: p, at: st.mtimeMs }; } } catch (e) { /* chưa có thư mục */ }
    }
    return best && best.path;
  }
  function resolve(arg) {
    arg = String(arg || '').trim().replace(/^["']|["']$/g, '');
    if (!arg) return latest();
    if (path.isAbsolute(arg)) return arg;
    for (const d of dirs) { const p = path.join(d, arg); if (fs.existsSync(p)) return p; }
    return path.join(dirs[0] || '.', arg);
  }
  const fail = (r) => (r.missing ? '⚠️ Máy chưa có công cụ agentos-office (cập nhật phần mềm để có).' : '⚠️ ' + (r.err || r.out || 'lỗi không rõ').replace(/^LỖI:\s*/, '').slice(0, 400));

  return {
    resolve, latest, FORMATS,
    async read(arg) {
      const p = resolve(arg);
      if (!p) return '⚠️ Chưa có tệp nào. Gửi tệp Word/Excel/PowerPoint/PDF vào đây rồi gõ /doc, hoặc /doc <đường dẫn tệp>.';
      if (!fs.existsSync(p)) return '⚠️ Không thấy tệp: ' + p;
      const r = await exec(['read', p, '--max', '3200']);
      return r.code === 0 ? '📄 ' + path.basename(p) + '\n' + (r.out.trim() || '(tệp không có chữ)') : fail(r);
    },
    async convert(fmt, arg) {
      fmt = String(fmt || '').toLowerCase();
      if (!FORMATS.includes(fmt)) return 'Cách dùng: /doi <' + FORMATS.join('|') + '> [tệp], ví dụ /doi pdf (đổi tệp gửi gần nhất) hoặc /doi pdf bao-cao.docx.';
      const p = resolve(arg);
      if (!p || !fs.existsSync(p)) return '⚠️ ' + (p ? 'Không thấy tệp: ' + p : 'Chưa có tệp nào. Gửi tệp vào đây trước.');
      const outdir = o.outDir || path.dirname(p);
      const r = await exec(['convert', p, fmt, '--outdir', outdir], 240000);
      if (r.code !== 0) return fail(r);
      const out = r.out.trim().split('\n').pop();
      return { text: '✅ Đã đổi sang ' + fmt.toUpperCase() + ': ' + path.basename(out), files: [{ path: out, name: path.basename(out), kind: 'document' }] };
    },
    async replace(spec) {
      const parts = String(spec || '').split('|').map((x) => x.trim());
      let file, a, b;
      if (parts.length >= 3) [file, a, b] = parts; else if (parts.length === 2) { file = ''; [a, b] = parts; }
      if (!a) return 'Cách dùng: /thay <tệp> | <chữ cũ> | <chữ mới>, hoặc /thay <chữ cũ> | <chữ mới> (tệp gửi gần nhất). Chỉ sửa được .docx .pptx .xlsx; tệp gốc giữ nguyên, bot gửi lại bản mới.';
      const p = resolve(file);
      if (!p || !fs.existsSync(p)) return '⚠️ ' + (p ? 'Không thấy tệp: ' + p : 'Chưa có tệp nào. Gửi tệp vào đây trước.');
      const r = await exec(['replace', p, a, b]);
      if (r.code !== 0) return fail(r);
      const out = (r.out.match(/Tệp mới: (.+)$/m) || [])[1];
      return out ? { text: '✏️ ' + r.out.trim().split('\n')[0] + ' (bản mới, tệp gốc giữ nguyên)', files: [{ path: out.trim(), name: path.basename(out.trim()), kind: 'document' }] } : r.out.trim();
    },
  };
}

module.exports = { createOffice, FORMATS, OFFICE_EXT };
