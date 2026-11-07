'use strict';

// BẢNG NĂNG LỰC TỪNG AI (hiện ở /ai): các AI không bằng nhau về những gì bot cho phép làm — chủ máy cần biết để chọn và để hiểu vì sao việc ra kết quả khác nhau.
// Mỗi dòng phản ánh ĐÚNG cách bot nối từng AI (index.js): Claude và DeepSeek chạy qua Claude Code (có cổng duyệt/hàng rào, trình duyệt, kết nối dịch vụ); Codex và Gemini KHÔNG qua cổng duyệt nên
// ở chế độ bảo vệ chỉ được ĐỌC, ở chế độ toàn quyền thì tự làm không có hàng rào hỏi trước (gửi ra ngoài/dính tiền), và không được cấp kết nối dịch vụ.
const CLAUDE_LIKE = ['Sửa tệp/chạy lệnh ✅ (bảo vệ: hỏi anh từng lần)', 'Hàng rào hỏi trước khi gửi ra ngoài/dính tiền ✅', 'Trình duyệt ✅', 'Trợ lý phụ ✅', 'Kết nối dịch vụ ✅', 'Xem tiến độ từng bước ✅'];
const CAPS = {
  claude: CLAUDE_LIKE,
  deepseekapi: CLAUDE_LIKE.concat(['(chạy bằng Claude Code với mô hình DeepSeek: chất lượng làm việc theo mô hình)']),
  codex: ['Sửa tệp/chạy lệnh: toàn quyền ✅, bảo vệ = chỉ đọc', 'Hàng rào hỏi trước khi gửi ra ngoài/dính tiền ❌', 'Trình duyệt ⚠️ chưa kiểm với Codex thật', 'Trợ lý phụ ✅ (toàn quyền)', 'Kết nối dịch vụ ❌', 'Xem tiến độ từng bước ✅'],
  gemini: ['Sửa tệp/chạy lệnh: toàn quyền ✅ (tự chấp nhận mọi việc), bảo vệ = chỉ đọc', 'Hàng rào hỏi trước khi gửi ra ngoài/dính tiền ❌', 'Trình duyệt ❌', 'Trợ lý phụ ✅ (toàn quyền)', 'Kết nối dịch vụ ❌', 'Xem tiến độ từng bước ❌'],
};
const COMMON = 'Mọi AI đều có: sổ tay/chỉ dẫn/kỹ năng của dự án, mốc khôi phục (/hoantac), tệp gửi về Telegram.';

// enabled: danh sách tên AI đang bật; label(e): tên hiển thị
function capsText(enabled, label) {
  const rows = (enabled || []).filter((e) => CAPS[e]).map((e) => '• ' + ((label && label(e)) || e) + ': ' + CAPS[e].join(' · '));
  if (!rows.length) return '';
  return 'Năng lực từng AI:\n' + rows.join('\n') + '\n' + COMMON + '\nViệc cần hàng rào/kết nối dịch vụ/trình duyệt thì để Claude làm (/claude <việc>).';
}

module.exports = { capsText, CAPS };
