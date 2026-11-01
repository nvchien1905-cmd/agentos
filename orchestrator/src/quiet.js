'use strict';
// Việc chạy ngầm cho bộ điều phối (không làm phiền chủ máy):
//  - "sys": chat_id bắt đầu bằng "sys:" (ví dụ soạn trả lời khách fanpage): không nhắn Telegram, không tin trạng thái; kết quả đọc thẳng từ cơ sở dữ liệu.
//  - "yên lặng": câu lệnh bắt đầu bằng [YÊN LẶNG] (ví dụ kiểm tin Facebook định kỳ): không hiện "Đang làm…"; AI trả "KHÔNG CÓ TIN MỚI" thì không nhắn gì.
const QUIET_RE = /^\[YÊN LẶNG\]/;
const isSysJob = (job) => String((job && job.chat_id) || '').startsWith('sys:');
const isQuietJob = (job) => isSysJob(job) || QUIET_RE.test(String((job && job.prompt) || ''));
// Có nên BỎ QUA việc gửi câu trả lời của AI cho chủ máy không?
const skipAnswer = (job, text) => isSysJob(job) || (QUIET_RE.test(String((job && job.prompt) || '')) && /^\s*KHÔNG CÓ TIN MỚI/i.test(String(text || '')));
const isFacebookCheck = (job) => /^\[YÊN LẶNG\]\[FACEBOOK-KIỂM-TIN\]/.test(String((job && job.prompt) || ''));

module.exports = { isSysJob, isQuietJob, skipAnswer, isFacebookCheck, QUIET_RE };
