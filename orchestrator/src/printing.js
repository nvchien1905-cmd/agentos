'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// IN ẤN qua CUPS. Chỉ in tệp nằm trong thư mục OneDrive của AgentOS (không in được tệp hệ thống). Tệp Word/Excel/... được LibreOffice đổi sang PDF trước.
//   /in                       danh sách máy in           /in <tệp>      in bằng máy in mặc định          /in <tệp> may <tên máy in>
// Máy in được thêm một lần ở http://localhost:631 (trình duyệt trên máy) hoặc nhờ AI ở chế độ toàn quyền (lpadmin).
const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|txt)$/i;
const DIRECT = /\.(pdf|png|jpe?g|gif|bmp|tiff?|ps)$/i;
const MAX_BYTES = 50 * 1024 * 1024;

function createPrinting(o) {
  o = o || {};
  const dir = o.dir || '/srv/onedrive';
  const tmpRoot = o.tmpDir || os.tmpdir();
  const run = o.run || ((cmd, args, ms) => new Promise((resolve) => {
    cp.execFile(cmd, args, { timeout: ms || 30000, maxBuffer: 2 * 1024 * 1024 }, (err, out, errOut) =>
      resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, out: String(out || ''), err: String(errOut || ''), missing: !!(err && err.code === 'ENOENT') }));
  }));

  async function printers() {
    const r = await run('lpstat', ['-p', '-d']);
    if (r.missing) return '⚠️ Máy này chưa có hệ thống in (CUPS).';
    const t = (r.out + '\n' + r.err).trim();
    if (!t || /no destinations/i.test(t)) return '🖨️ Chưa có máy in nào. Cắm máy in vào máy, mở trình duyệt trên máy vào http://localhost:631 → Administration → Add Printer (làm một lần), hoặc nhờ AI ở chế độ /toanquyen.';
    return '🖨️ Máy in:\n' + t;
  }

  function resolveInside(p) {
    const full = path.resolve(dir, p);
    let real; try { real = fs.realpathSync(full); } catch (e) { return { error: 'Không thấy tệp "' + p + '" trong ' + dir + '.' }; }
    let base; try { base = fs.realpathSync(dir); } catch (e) { return { error: 'Thư mục ' + dir + ' chưa có.' }; }
    if (real !== base && !real.startsWith(base + path.sep)) return { error: 'Chỉ in được tệp nằm trong ' + dir + '.' };
    let st; try { st = fs.statSync(real); } catch (e) { return { error: 'Không đọc được tệp.' }; }
    if (!st.isFile()) return { error: '"' + p + '" không phải tệp.' };
    if (st.size > MAX_BYTES) return { error: 'Tệp quá lớn (trên 50MB).' };
    return { file: real };
  }

  async function print(arg) {
    arg = String(arg || '').trim();
    if (!arg) return printers();
    let printer = '';
    const m = arg.match(/^([\s\S]+?)\s+(?:may|máy)\s+(\S+)$/i);
    if (m) { arg = m[1].trim(); printer = m[2]; }
    if (printer && !/^[\w.-]+$/.test(printer)) return '⚠️ Tên máy in không hợp lệ.';
    const r = resolveInside(arg.replace(/^["']|["']$/g, ''));
    if (r.error) return '⚠️ ' + r.error;
    let file = r.file, tmp = null;
    try {
      if (!DIRECT.test(file)) {
        if (!OFFICE.test(file)) return '⚠️ Không in được loại tệp này. In được: PDF, ảnh, Word, Excel, PowerPoint, CSV, TXT.';
        tmp = fs.mkdtempSync(path.join(tmpRoot, 'in-'));
        const c = await run('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', tmp, file], 120000);
        if (c.missing) return '⚠️ Máy chưa có LibreOffice để đổi tệp sang PDF.';
        const pdf = fs.readdirSync(tmp).find((f) => /\.pdf$/i.test(f));
        if (!pdf) return '⚠️ Không đổi được tệp sang PDF để in' + (c.err ? ': ' + c.err.trim().slice(0, 150) : '') + '.';
        file = path.join(tmp, pdf);
      }
      const args = printer ? ['-d', printer, file] : [file];
      const p = await run('lp', args);
      if (p.missing) return '⚠️ Máy này chưa có hệ thống in (CUPS).';
      if (p.code !== 0) return '⚠️ Lệnh in lỗi: ' + (p.err || p.out).trim().slice(0, 200) + '\nGõ /in để xem máy in đã thêm chưa.';
      return '🖨️ Đã gửi lệnh in "' + path.basename(r.file) + '"' + (printer ? ' tới ' + printer : ' tới máy in mặc định') + '. ' + p.out.trim();
    } finally { if (tmp) fs.rm(tmp, { recursive: true, force: true }, () => {}); }
  }
  return { print, printers };
}

module.exports = { createPrinting };
