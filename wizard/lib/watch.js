'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { createTrace } = require('../../orchestrator/src/trace');
const { createJournal } = require('../../orchestrator/src/journal');
const { diffLines, looksText } = require('../../orchestrator/src/textdiff');

// MÀN HÌNH "VIỆC AI" trong Cài đặt (xem như màn hình Claude Code): đọc dấu vết từng bước (trace.js), các tệp AI đã đổi + khác biệt từng dòng (từ nhật ký trước-khi-sửa, journal.js),
// và duyệt/xem tệp trong thư mục dự án (chỉ đọc; HTML xem trong khung cách ly, ảnh hiện trực tiếp). Chạy trong dịch vụ Cài đặt (chủ máy), không sửa gì.
const LIMITS = { diffBytes: 1024 * 1024, textPreview: 300 * 1024, imageBytes: 4 * 1024 * 1024, files: 40, rows: 400, dirEntries: 500 };
const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function createWatch(o) {
  const L = Object.assign({}, LIMITS, o.limits || {});
  const trace = createTrace({ dir: o.traceDir });
  const journal = createJournal({ dir: o.journalDir });

  const inside = (root, abs) => { const r = path.resolve(root); return abs === r || abs.startsWith(r + path.sep); };
  async function safeResolve(root, rel) {
    rel = String(rel || '').replace(/\\/g, '/');
    if (rel.startsWith('/') || rel.split('/').includes('..') || /^[a-zA-Z]:/.test(rel) || rel.includes('\0')) throw new Error('Đường dẫn không hợp lệ.');
    const abs = path.resolve(root, ...rel.split('/').filter(Boolean));
    if (!inside(root, abs)) throw new Error('Đường dẫn ra ngoài thư mục dự án.');
    const real = await fsp.realpath(abs).catch(() => null);                    // liên kết tắt trỏ ra ngoài thì từ chối
    const realRoot = await fsp.realpath(root).catch(() => path.resolve(root));
    if (real && !inside(realRoot, real)) throw new Error('Liên kết trỏ ra ngoài thư mục dự án.');
    return abs;
  }
  const rootOf = (id) => { const p = o.projects.get(String(id)); if (!p) throw new Error('Không có dự án này.'); return p.dir; };

  async function readIf(file, max) {
    let st; try { st = await fsp.stat(file); } catch (e) { return null; }
    if (!st.isFile()) return null;
    if (st.size > max) return { big: true, size: st.size };
    return { buf: await fsp.readFile(file), size: st.size, mtime: Math.round(st.mtimeMs) };
  }

  return {
    limits: L,
    trace: (id, from) => trace.read(String(id), Number(from) || 0),

    // Những tệp việc #id đã đổi: tạo mới / sửa / xóa, kèm khác biệt từng dòng (tệp chữ ≤ 1 MB)
    async changes(id) {
      const meta = await journal.get(String(id));
      if (!meta) return { exists: false, files: [], unsafe: [], partial: false, total: 0 };
      const es = await journal.entries(String(id));
      const out = [], seen = new Set(); let total = 0;
      for (const e of es) {
        if (seen.has(e.p) || (e.k !== 'file' && e.k !== 'none')) continue;
        seen.add(e.p);
        const cur = await readIf(e.p, L.diffBytes);
        const curSt = await fsp.lstat(e.p).catch(() => null);
        if (e.k === 'none') {
          if (!curSt) continue;                                               // tạo rồi xóa: không còn gì để xem
          total++; if (out.length >= L.files) continue;
          const f = { p: e.p, status: 'created', size: curSt.size };
          if (cur && cur.buf && looksText(cur.buf)) { const d = diffLines('', cur.buf.toString('utf8')); f.add = d.add; f.del = 0; f.rows = d.rows.slice(0, L.rows); f.cut = d.rows.length > L.rows; }
          else f.note = cur && cur.big ? 'tệp lớn, không so sánh' : 'tệp không phải chữ';
          out.push(f); continue;
        }
        if (e.meta) continue;
        if (e.skipped) { total++; if (out.length < L.files) out.push({ p: e.p, status: curSt ? 'modified' : 'deleted', size: e.size, note: 'không lưu được bản gốc (' + e.skipped + ')' }); continue; }
        const unchanged = curSt && curSt.isFile() && curSt.size === e.size && Math.round(curSt.mtimeMs) === e.mtime;
        if (unchanged) continue;
        total++; if (out.length >= L.files) continue;
        const f = { p: e.p, status: curSt ? 'modified' : 'deleted', size: e.size };
        const old = await readIf(path.join(o.journalDir, String(id), 'b', e.blob), L.diffBytes);
        if (old && old.buf && looksText(old.buf) && (!cur || (cur.buf && looksText(cur.buf)))) {
          const d = diffLines(old.buf.toString('utf8'), cur && cur.buf ? cur.buf.toString('utf8') : '');
          if (curSt && !d.add && !d.del) continue;                              // chỉ đổi giờ sửa, nội dung y hệt
          f.add = d.add; f.del = d.del; f.rows = d.rows.slice(0, L.rows); f.cut = d.rows.length > L.rows; f.truncated = d.truncated;
        } else f.note = (old && old.big) || (cur && cur.big) ? 'tệp lớn, không so sánh từng dòng' : 'tệp không phải chữ';
        out.push(f);
      }
      return { exists: true, files: out, total, unsafe: meta.unsafe || [], partial: !!meta.partial, bytes: meta.bytes };
    },

    // Thư mục trong dự án (chỉ đọc)
    async tree(projectId, rel) {
      const root = rootOf(projectId), abs = await safeResolve(root, rel);
      let ents; try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { throw new Error('Không mở được thư mục này.'); }
      const rows = [];
      for (const e of ents.slice(0, L.dirEntries * 2)) {
        let st; try { st = await fsp.lstat(path.join(abs, e.name)); } catch (er) { continue; }
        rows.push({ name: e.name, dir: st.isDirectory(), link: st.isSymbolicLink(), size: st.isFile() ? st.size : 0, mtime: Math.round(st.mtimeMs) });
      }
      rows.sort((a, b) => (a.dir === b.dir ? (a.name < b.name ? -1 : 1) : a.dir ? -1 : 1));
      return { path: String(rel || ''), entries: rows.slice(0, L.dirEntries), more: rows.length > L.dirEntries };
    },

    // Nội dung một tệp trong dự án để xem trước
    async file(projectId, rel) {
      const root = rootOf(projectId), abs = await safeResolve(root, rel);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || !st.isFile()) throw new Error('Không phải tệp.');
      const ext = path.extname(abs).toLowerCase();
      if (IMG[ext]) {
        if (st.size > L.imageBytes) return { kind: 'big', size: st.size };
        return { kind: 'image', size: st.size, dataUrl: 'data:' + IMG[ext] + ';base64,' + (await fsp.readFile(abs)).toString('base64') };
      }
      const fd = await fsp.open(abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, L.textPreview));
        await fd.read(buf, 0, buf.length, 0);
        if (!looksText(buf)) return { kind: 'binary', size: st.size };
        return { kind: ext === '.html' || ext === '.htm' ? 'html' : 'text', size: st.size, text: buf.toString('utf8'), cut: st.size > L.textPreview };
      } finally { await fd.close(); }
    },
  };
}

module.exports = { createWatch, LIMITS };
