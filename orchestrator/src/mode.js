'use strict';

// Chế độ TOÀN QUYỀN có hai nơi lưu: FULL_ACCESS trong orchestrator.env (Cài đặt AgentOS và trình hướng dẫn ghi vào đây) và kv 'fullAccess' trong cơ sở dữ liệu
// (lệnh /toanquyen và /baove trên Telegram ghi vào đây, và nó được ưu tiên lúc chạy). Lỗi tìm ra khi thử thật: chủ máy bấm "Chuyển sang Bảo vệ" trong Cài đặt
// (đổi env + khởi động lại) nhưng kv cũ từ lệnh Telegram vẫn thắng nên máy vẫn ở toàn quyền.
// Quy tắc: lúc khởi động, nếu FULL_ACCESS trong env KHÁC giá trị env đã thấy lần trước thì env thắng (ghi đè kv); nếu không đổi thì kv (lệnh Telegram) giữ nguyên.
function reconcile(db, envFull) {
  const cur = envFull ? '1' : '0';
  const seen = db.kvGet('fullAccessEnv');
  if (seen === cur) return { changed: false, value: db.kvGet('fullAccess') };
  db.kvSet('fullAccessEnv', cur);
  if (seen === null) return { changed: false, value: db.kvGet('fullAccess') };         // lần chạy đầu: chỉ ghi nhớ giá trị env, không đè lệnh Telegram đã có
  db.kvSet('fullAccess', cur);
  return { changed: true, value: cur };
}

module.exports = { reconcile };
