'use strict';
const fs = require('fs');

// Đọc trạng thái SAO LƯU RA Ổ NGOÀI do tập lệnh root `agentos-backup` ghi (xem iso/.../usr/local/sbin/agentos-backup).
// Bộ điều phối chạy bằng người dùng thường nên không tự sao lưu: chỉ ĐỌC trạng thái và gửi YÊU CẦU (tạo tệp backup-now, dịch vụ systemd
// agentos-backup.path thấy tệp thì chạy sao lưu bằng root).
const STALE_HOURS = 40;                // sao lưu chạy mỗi đêm: quá 40 giờ chưa thành công là có vấn đề

function createBackup(o) {
  o = o || {};
  const statusFile = o.statusFile || '/var/lib/agentos/backup-status.json';
  const confFile = o.confFile || '/etc/agentos/backup.json';
  const triggerFile = o.triggerFile || '/var/lib/agentos/backup-now';
  const now = o.now || Date.now;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

  const configured = () => !!readJson(confFile);
  function status() {
    const conf = readJson(confFile), st = readJson(statusFile);
    if (!conf) return { configured: false, ok: null, message: 'chưa bật sao lưu ra ổ ngoài' };
    if (!st) return { configured: true, ok: null, message: 'đã chọn ổ nhưng chưa sao lưu lần nào', keepDays: conf.keepDays };
    const ageH = st.ts ? (now() / 1000 - st.ts) / 3600 : null;
    const stale = ageH != null && ageH > STALE_HOURS;
    return { configured: true, ok: !!st.ok && !stale, lastOk: !!st.ok, stale, at: st.at, ageHours: ageH, message: st.message, bytes: st.bytes, files: st.files, secs: st.secs, keepDays: conf.keepDays, target: conf.target };
  }
  const human = (n) => { n = Number(n) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; };
  function text() {
    const s = status();
    if (!s.configured) return '💾 Chưa bật sao lưu ra ổ ngoài. Cắm ổ USB/HDD vào máy rồi vào Cài đặt → Sao lưu ngoài để chọn ổ (hoặc nhờ em: sudo agentos-backup set <UUID>).';
    if (s.ok === null) return '💾 ' + s.message + '. Gõ /saoluudia chay để sao lưu ngay.';
    return (s.ok ? '✅' : '⚠️') + ' Sao lưu ra ổ ngoài: ' + (s.lastOk ? 'lần gần nhất thành công' : 'lần gần nhất LỖI') + ' lúc ' + s.at +
      (s.lastOk ? ' (' + human(s.bytes) + ', ' + s.files + ' tệp mới/đổi, ' + s.secs + ' giây)' : ': ' + s.message) + (s.stale ? '\n⚠️ Đã quá ' + STALE_HOURS + ' giờ chưa có bản sao lưu mới: kiểm tra ổ đã cắm chưa.' : '') +
      '\nGiữ bản cũ/đã xóa ' + s.keepDays + ' ngày. Gõ /saoluudia chay để sao lưu ngay.';
  }
  // Gửi yêu cầu chạy ngay. Trả true nếu đã gửi.
  function request() {
    if (!configured()) return false;
    try { fs.writeFileSync(triggerFile, String(now())); return true; } catch (e) { return false; }
  }
  return { status, text, request, configured, human, STALE_HOURS };
}

module.exports = { createBackup };
