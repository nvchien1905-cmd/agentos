'use strict';
const fs = require('fs');
const path = require('path');

// AI ĐỘC LẬP ĐÁNH GIÁ TỪNG LỆNH (bảng điều khiển bot → "Nhờ AI đánh giá"). Trang Cài đặt (root) đọc được dữ liệu mọi bot nên chép lệnh + các bước + kết quả vào
// `in/<bot>-<mã>.json`; bộ điều phối của bot quản lý (có đăng nhập AI) đọc, nhờ một AI KHÁC với AI đã làm việc đó (nếu máy có nhiều AI), không công cụ, lần chạy mới
// không dính phiên cũ, rồi ghi `out/<bot>-<mã>.json`. Đánh giá chỉ là ý kiến tham khảo: không tự sửa gì; muốn bot làm theo thì chủ máy bấm "Dạy bot".
const SYSTEM = 'Bạn là người đánh giá độc lập công việc của một trợ lý AI chạy trên máy của một cửa hàng. Bạn KHÔNG làm lại việc, chỉ nhận xét thẳng thắn, cụ thể, bằng tiếng Việt thường (người đọc không rành kỹ thuật). ' +
  'Trả lời DUY NHẤT một đối tượng JSON, không chữ nào khác, đúng dạng: ' +
  '{"diem": số nguyên 1-10, "ketLuan": "một câu: làm vậy có thông minh/hiệu quả không", "daLam": ["điểm làm tốt"], "vanDe": ["điểm chưa tốt hoặc lãng phí, nói rõ vì sao"], "cachTotHon": ["cách làm gọn/nhanh/rẻ/chắc hơn, cụ thể"], "baiHoc": "MỘT hoặc hai câu dặn trợ lý, viết ở ngôi \'bạn\', áp dụng được cho các lệnh tương tự về sau (để trống nếu việc đã tối ưu)"}. ' +
  'Chấm theo: đúng yêu cầu, ít bước thừa, không rủi ro/thao tác nguy hiểm không cần thiết, kết quả dễ dùng, báo cáo rõ ràng. Không bịa điều không có trong dữ liệu.';

function extractJson(text) {
  const s = String(text || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}
const arr = (x, n) => (Array.isArray(x) ? x : []).map((y) => String(y || '').trim().slice(0, 400)).filter(Boolean).slice(0, n);

function clean(j) {
  if (!j || typeof j !== 'object') return null;
  const d = Math.round(Number(j.diem));
  return { diem: Number.isFinite(d) ? Math.max(1, Math.min(10, d)) : null, ketLuan: String(j.ketLuan || '').trim().slice(0, 400), daLam: arr(j.daLam, 6), vanDe: arr(j.vanDe, 6), cachTotHon: arr(j.cachTotHon, 6), baiHoc: String(j.baiHoc || '').trim().slice(0, 500) };
}

function createJobReview(o) {
  const dir = o.dir, ask = o.ask, log = o.log || (() => {}), now = o.now || Date.now;
  const inFile = (bot, id) => path.join(dir, 'in', bot + '-' + id + '.json');
  const outFile = (bot, id) => path.join(dir, 'out', bot + '-' + id + '.json');
  const busy = new Set();
  const write = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, f); try { fs.chmodSync(f, 0o644); } catch (e) { /* bỏ qua */ } };

  async function run(bot, id) {
    const key = bot + '-' + id;
    if (busy.has(key)) return false;
    busy.add(key);
    try {
      let inp; try { inp = JSON.parse(fs.readFileSync(inFile(bot, id), 'utf8')); } catch (e) { write(outFile(bot, id), { at: now(), error: 'Không đọc được dữ liệu lệnh để đánh giá.' }); return false; }
      const user = '[LỆNH CHỦ MÁY GIAO]\n' + String(inp.prompt || '').slice(0, 3000) + '\n\n[CÁC BƯỚC TRỢ LÝ ĐÃ LÀM]\n' + String(inp.steps || '(không ghi lại)').slice(0, 5000) +
        '\n\n[KẾT QUẢ TRỢ LÝ TRẢ LỜI]\n' + String(inp.result || inp.error || '(chưa có)').slice(0, 4000) +
        '\n\n[THÔNG TIN]\nTrạng thái: ' + String(inp.status || '') + ' · AI đã làm: ' + String(inp.engine || '?') + ' · thời gian: ' + (inp.secs != null ? inp.secs + ' giây' : '?') + ' · số bước: ' + (inp.stepCount != null ? inp.stepCount : '?') +
        (inp.lessons ? '\nChủ máy đã dạy trợ lý trước đó: ' + String(inp.lessons).slice(0, 1200) : '');
      let res = null, err = '';
      try { res = await ask(SYSTEM, user, inp.engine || ''); } catch (e) { err = e.message || String(e); }
      const rv = res && res.text ? clean(extractJson(res.text)) : null;
      if (!rv) { write(outFile(bot, id), { at: now(), error: err ? 'Không nhờ được AI đánh giá: ' + err.slice(0, 200) : 'AI trả lời không đúng dạng, thử lại.' }); return false; }
      write(outFile(bot, id), Object.assign({ at: now(), by: res.via || '' }, rv));
      log('đánh giá lệnh ' + bot + '#' + id + ': ' + rv.diem + '/10 (' + (res.via || '?') + ')');
      return true;
    } finally { busy.delete(key); }
  }
  return { run, inFile, outFile };
}

module.exports = { createJobReview, extractJson, clean, SYSTEM };
