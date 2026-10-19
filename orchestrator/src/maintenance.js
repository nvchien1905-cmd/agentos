'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DAY = 24 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');
const dateStamp = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

// Kiểm tra nhanh một file SQLite. File chưa tồn tại = ổn (sẽ tạo mới).
function checkIntegrity(file) {
  if (!fs.existsSync(file)) return { ok: true, detail: 'chưa có' };
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.pragma('quick_check');
    const first = rows && rows[0] && (rows[0].quick_check || Object.values(rows[0])[0]);
    return first === 'ok' ? { ok: true, detail: 'ok' } : { ok: false, detail: String(first) };
  } catch (e) {
    return { ok: false, detail: e.message };
  } finally { if (db) { try { db.close(); } catch (e) { /* bỏ qua */ } } }
}

// Cơ sở dữ liệu hỏng: đổi tên giữ lại để điều tra (không xóa), trả đường dẫn mới.
function quarantine(file, at) {
  const dest = file + '.corrupt-' + (at || Date.now());
  fs.renameSync(file, dest);
  for (const ext of ['-wal', '-shm']) { try { fs.renameSync(file + ext, dest + ext); } catch (e) { /* không có */ } }
  return dest;
}

function listBackups(dir) {
  try { return fs.readdirSync(dir).filter((f) => /^agentos-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse(); } catch (e) { return []; }
}

// Khôi phục từ bản sao lưu mới nhất còn nguyên vẹn. Trả tên bản đã dùng hoặc null.
function restoreLatestBackup(file, dir) {
  for (const name of listBackups(dir)) {
    const p = path.join(dir, name);
    if (checkIntegrity(p).ok) {
      fs.copyFileSync(p, file);
      for (const ext of ['-wal', '-shm']) { try { fs.rmSync(file + ext, { force: true }); } catch (e) { /* bỏ qua */ } }
      return name;
    }
  }
  return null;
}

// Mỗi ngày một bản (VACUUM INTO: nhất quán dù đang ghi), giữ `keep` bản mới nhất. Trả tên file mới hoặc null nếu hôm nay đã có.
function backup(db, dir, { now, keep } = {}) {
  now = now == null ? Date.now() : now;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = 'agentos-' + dateStamp(now) + '.db';
  const dest = path.join(dir, name);
  let made = null;
  if (!fs.existsSync(dest)) {
    const tmp = dest + '.tmp';
    fs.rmSync(tmp, { force: true });
    db.backupTo(tmp);
    fs.renameSync(tmp, dest);
    try { fs.chmodSync(dest, 0o600); } catch (e) { /* Windows */ }
    made = name;
  }
  for (const old of listBackups(dir).slice(keep || 7)) fs.rmSync(path.join(dir, old), { force: true });
  return made;
}

// Xóa file cũ hơn maxAgeMs (không đi theo liên kết tượng trưng). Trả số file đã xóa.
function pruneFiles(dir, maxAgeMs, now) {
  now = now == null ? Date.now() : now;
  let n = 0;
  (function walk(d) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      let st; try { st = fs.lstatSync(p); } catch (err) { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && now - st.mtimeMs > maxAgeMs) { try { fs.rmSync(p, { force: true }); n++; } catch (err) { /* đang dùng */ } }
    }
  })(dir);
  return n;
}

// Dung lượng trống (MB) của ổ chứa `dir`; không đo được -> Infinity (không chặn nhầm).
function diskFreeMb(dir) {
  try { const s = fs.statfsSync(dir); return Math.floor((s.bavail * s.bsize) / 1048576); } catch (e) { return Infinity; }
}

module.exports = { checkIntegrity, quarantine, restoreLatestBackup, backup, pruneFiles, diskFreeMb, listBackups, dateStamp, DAY };
