'use strict';
const { noAccent } = require('./kiotviet');

// CHỌN AI THEO ĐỘ KHÓ để tiết kiệm token: câu hỏi nhẹ (hỏi đáp ngắn, không cần thao tác máy/tệp/ảnh) đi qua AI RẺ trước
// (mặc định DeepSeek API rồi Gemini); việc nặng (làm việc trên máy, có tệp/ảnh/video, dài, mã nguồn) dùng thứ tự ưu tiên bình thường (AI mạnh).
// Không đổi gì nếu chủ máy ÉP AI (/claude...), việc có bộ công cụ riêng (/web...), hoặc tắt định tuyến (ROUTE_BY_DIFFICULTY=false).
const ACTION = /\b(cai|go cai|xoa|sua|tao|chay|mo|dong|gui|luu|chup|in|tai|cap nhat|nang cap|ket noi|sao luu|khoi dong|tat|bat|viet|lap trinh|code|script|tep|file|thu muc|excel|word|pdf|anh|hinh|video|man hinh|ghi|doc|phan tich|dich|so sanh|tong hop|bao cao|lap ke hoach|nghien cuu|tim kiem|tra cuu|web|trang web|link|email|zalo|kiotviet|onedrive|dat hen|nhac|lenh|terminal|server|may chu|cron)\b/;

const hasAttachment = (prompt) => /\/inbox\//.test(String(prompt || '')) || /\[Tệp đính kèm/.test(String(prompt || ''));
const hasImage = (prompt) => /\/inbox\/\S+\.(jpe?g|png|webp|gif|bmp)/i.test(String(prompt || ''));

function classify(job) {
  const p = String(job.prompt || '');
  if (job.profile || hasAttachment(p) || p.length > 350 || /```|https?:\/\//.test(p)) return 'heavy';
  return ACTION.test(noAccent(p)) ? 'heavy' : 'light';
}

// Trả danh sách engine đã sắp xếp lại. cands: danh sách engine được phép (đã lọc theo bộ công cụ/ép).
function order(job, cands, opts) {
  opts = opts || {};
  let list = cands.slice();
  // AI không xem được ảnh (DeepSeek qua API chỉ có chữ) -> bỏ khỏi việc có ảnh nếu còn AI khác
  if (hasImage(job.prompt)) { const v = list.filter((e) => !/^deepseek/.test(e)); if (v.length) list = v; }
  if (!opts.enabled || job.engine_pref || list.length < 2) return list;
  if (classify(job) !== 'light') return list;
  const pref = (opts.lightEngines || []).filter((e) => list.includes(e));
  if (!pref.length) return list;
  return pref.concat(list.filter((e) => !pref.includes(e)));
}

module.exports = { order, classify, hasAttachment, hasImage };
