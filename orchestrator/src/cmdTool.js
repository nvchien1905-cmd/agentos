'use strict';

// CHỦ MÁY NHẮN BẰNG LỜI, AI TỰ CHẠY LỆNH CỦA BOT (công cụ `bot_command`): mọi lệnh /... của bot (doanh số, tồn kho, mở ứng dụng, hẹn giờ, quản lý bot phụ, nhớ/quên, cập nhật...) đều làm được
// bằng câu bình thường — AI hiểu ý rồi gọi công cụ này thay vì bắt chủ máy gõ lệnh. Lệnh đi qua ĐÚNG đường như khi chủ máy tự gõ (cùng quyền, cùng nhật ký).
// Hàng rào (cổng duyệt, gate.js):
//   - chỉ việc của chủ máy (quản trị viên);
//   - lệnh "xem/hỏi" (safe): chạy luôn;
//   - lệnh "làm" (normal): chạy luôn khi việc CHƯA đọc nội dung từ web (câu do chính chủ máy nhắn); đã đọc web (nghi bị chèn lệnh) thì hỏi chủ máy bằng nút bấm;
//   - lệnh NHẠY CẢM (danger: bật/tắt toàn quyền, tắt/khởi động lại máy, chạy lệnh dòng lệnh, cập nhật phần mềm, xóa bot, phân quyền, hoàn tác tệp...) LUÔN hỏi chủ máy bằng nút bấm, kể cả khi việc đến từ chính chủ máy.
const SAFE = new Set(['help', 'id', 'start', 'menu', 'trangthai', 'viec', 'tim', 'nhatky', 'phien', 'cuaso', 'manhinh', 'doanhso', 'ton', 'hanghoa', 'maytinh', 'trinho', 'log', 'chiphi', 'phancung', 'gia', 'canhbao', 'sukien', 'camera', 'dichvu']);
const NORMAL = new Set(['mo', 'dong', 'go', 'phim', 'bam', 'timchu', 'bamchu', 'chuyen', 'dan', 'nho', 'quen', 'hen', 'baocao', 'moi', 'huy', 'dung', 'nen', 'tieptuc', 'ai', 'cheodo', 'quyen', 'kynang', 'skill', 'cho', 'plugin', 'duan', 'project',
  'ghepdoi', 'onedrive', 'tailscale', 'dongbo', 'fanpage', 'facebook', 'fb', 'google', 'may', 'ketnoi', 'dien', 'bat', 'in', 'doc', 'doi', 'thay', 'lay', 'guilen', 'saoluu', 'saoluudia', 'hoidong', 'bacsi', 'anh', 'giao', 'daily', 'agent', 'deepseek', 'vao', 'nhaman', 'claude', 'codex', 'gemini', 'deepseekapi']);
// luôn nhạy cảm (kèm vì sao, hiện cho chủ máy trong nút duyệt)
const DANGER = {
  toanquyen: 'Bật chế độ TOÀN QUYỀN (AI tự làm không hỏi, có sudo)', baove: 'Đổi chế độ bảo vệ của AI', tatmay: 'TẮT máy', khoimay: 'Khởi động lại máy', khoamay: 'Khóa màn hình máy', mokhoa: 'Mở khóa máy',
  lenh: 'Chạy lệnh dòng lệnh trên máy', tuxa: 'Mở điều khiển từ xa', hangrao: 'Đổi hàng rào an toàn của chế độ toàn quyền', tuchan: 'Đổi hàng rào an toàn của chế độ toàn quyền', vaitro: 'Đổi vai/quyền của người dùng',
  quyenmay: 'Đổi quyền dùng máy của người dùng', hoantac: 'Hoàn tác (khôi phục) tệp về bản cũ', khoiphuc: 'Hoàn tác (khôi phục) tệp về bản cũ',
};
// lệnh bình thường nhưng một số cách dùng là nhạy cảm
const DANGER_ARG = { capnhat: [/^(co|xacnhan|ok|tudong\b.*)/i, 'Cập nhật phần mềm AgentOS / đổi cập nhật tự động'], daily: [/^(xoa|chu|sudo|quyen)\b/i, 'Xóa bot phụ / đổi chủ / cấp quyền bot phụ'], agent: [/^(xoa|chu|sudo|quyen)\b/i, 'Xóa bot phụ / đổi chủ / cấp quyền bot phụ'],
  chiphi: [/^tran\b/i, 'Đổi trần chi phí AI'], nhaman: [/./, 'Đổi quyền màn hình'] };

// text: "/doanhso hôm nay". Trả { ok:true, name, arg, level, why, text } hoặc { ok:false, error }
function classify(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || t.length > 2000) return { ok: false, error: 'Lệnh rỗng hoặc dài quá.' };
  const m = /^\/([a-z0-9_]{1,24})(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(t);
  if (!m) return { ok: false, error: 'Lệnh phải bắt đầu bằng "/" và tên lệnh, ví dụ "/doanhso hôm nay". Dùng bot_help để xem danh sách.' };
  const name = m[1].toLowerCase(), arg = String(m[2] || '').trim();
  if (DANGER[name]) return { ok: true, name, arg, level: 'danger', why: DANGER[name], text: '/' + name + (arg ? ' ' + arg : '') };
  if (DANGER_ARG[name] && DANGER_ARG[name][0].test(arg)) return { ok: true, name, arg, level: 'danger', why: DANGER_ARG[name][1], text: '/' + name + (arg ? ' ' + arg : '') };
  if (name === 'capnhat') return { ok: true, name, arg, level: 'safe', why: '', text: '/capnhat' + (arg ? ' ' + arg : '') };                // chỉ xem có bản mới không
  if (SAFE.has(name)) return { ok: true, name, arg, level: 'safe', why: '', text: '/' + name + (arg ? ' ' + arg : '') };
  if (NORMAL.has(name)) return { ok: true, name, arg, level: 'normal', why: '', text: '/' + name + (arg ? ' ' + arg : '') };
  return { ok: false, error: 'Không có lệnh "/' + name + '". Dùng bot_help để xem danh sách; bộ công cụ có sẵn (/nghiencuu, /ve, /taodoc, /web...) thì giao việc bình thường, không qua công cụ này.' };
}

const TOOLS_HELP = 'Chạy MỘT lệnh của bot thay chủ máy (như họ tự gõ), khi họ nhờ bằng lời. Truyền đúng cú pháp lệnh, ví dụ: "/doanhso hôm nay", "/ton nồi chiên", "/mo webbot", "/hen 08:00 báo cáo doanh số", "/daily", "/nho cửa hàng nghỉ chủ nhật", "/capnhat". ' +
  'Lệnh nhạy cảm (toàn quyền, tắt/khởi động lại máy, chạy lệnh, cập nhật, xóa bot, phân quyền) tự hỏi chủ máy bằng nút bấm. Không biết cú pháp: gọi bot_help trước. KHÔNG bảo chủ máy tự gõ lệnh.';

module.exports = { classify, SAFE, NORMAL, DANGER, DANGER_ARG, TOOLS_HELP };
