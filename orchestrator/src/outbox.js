'use strict';
const fs = require('fs');
const path = require('path');

// Thư mục "hộp thư ra": AI lưu ảnh chụp màn hình / file kết quả vào đây, bộ điều phối gửi về Telegram.
// Chỉ gửi loại file trong danh sách cho phép, không đi theo liên kết tượng trưng, không gửi file ẩn.
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const DOC = new Set(['.pdf', '.csv', '.txt', '.md', '.xlsx', '.docx', '.html']);
const LIMITS = { maxFiles: 5, maxPhotoBytes: 10 * 1024 * 1024, maxDocBytes: 20 * 1024 * 1024, maxDepth: 3 };

function scan(dir, since, opts) {
  const lim = Object.assign({}, LIMITS, opts || {});
  const found = [];
  (function walk(d, depth) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name[0] === '.') continue;
      const p = path.join(d, e.name);
      let st;
      try { st = fs.lstatSync(p); } catch (err) { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (depth < lim.maxDepth) walk(p, depth + 1); continue; }
      if (!st.isFile() || st.mtimeMs < since) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (IMAGE.has(ext) && st.size > 0) {
        found.push({ path: p, name: e.name, kind: st.size <= lim.maxPhotoBytes ? 'photo' : 'document', size: st.size, mtime: st.mtimeMs });
      } else if (DOC.has(ext) && st.size > 0) {
        found.push({ path: p, name: e.name, kind: 'document', size: st.size, mtime: st.mtimeMs });
      }
    }
  })(dir, 0);
  return found
    .filter((f) => f.size <= lim.maxDocBytes)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, lim.maxFiles)
    .reverse(); // gửi theo thứ tự thời gian
}

function createOutbox(dir, opts) {
  return (since) => scan(dir, since, opts);
}

module.exports = { scan, createOutbox, LIMITS };
