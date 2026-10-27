'use strict';

// HỎI ĐÁP CHO NHÂN VIÊN BÁN HÀNG (vai "banhang"): nhân viên nhắn câu hỏi tự nhiên ("nồi chiên 6 lít giá bao nhiêu, còn hàng không?"),
// bot TRA KIOTVIET trước (giá, tồn theo chi nhánh) rồi đưa AI chỉ trả lời DỰA TRÊN dữ liệu đó + sổ tay/chính sách của dự án hỏi đáp.
// Chỉ đọc: việc của người không phải chủ máy luôn chạy chế độ bảo vệ; ở đây còn dặn AI không báo giá vốn/doanh thu và không bịa khi thiếu dữ liệu.
const STOP = new Set(('la cua bao nhieu gia con hang khong cai em anh chi co va voi cho mua ban loai nao the nao khac gi nay kia do duoc khong ha a oi ne nhe vay thi ' +
  'toi minh can muon hoi xem tim giup nhan vien khach hang san pham sp may chiec con bo').split(' '));
const noAccent = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Trích các cụm tìm kiếm từ câu hỏi: mã hàng, cụm từ khóa (bỏ từ chung chung), cặp từ liền nhau
function queries(text) {
  const words = noAccent(text).split(' ').filter(Boolean);
  const out = [];
  for (const w of words) if (/^[a-z]*\d[a-z0-9]*$/.test(w) && w.length >= 4) out.push(w);                      // mã hàng
  const key = words.filter((w) => !STOP.has(w) && w.length > 1);
  if (key.length) out.push(key.slice(0, 4).join(' '));
  for (let i = 0; i + 1 < key.length && out.length < 6; i++) out.push(key[i] + ' ' + key[i + 1]);
  return [...new Set(out)].slice(0, 3);
}

function fmtMoney(n) { return Number(n || 0).toLocaleString('vi-VN') + 'đ'; }

function createHoiDap(o) {
  const { kiotviet, projects, db, log } = o;
  const cache = new Map(), now = o.now || Date.now;

  async function search(q) {
    const c = cache.get(q); if (c && now() - c.at < 60000) return c.items;
    const items = await kiotviet.products(q, 4); cache.set(q, { at: now(), items }); if (cache.size > 200) cache.clear();
    return items;
  }

  // Dữ liệu KiotViet liên quan tới câu hỏi (mảng sản phẩm, bỏ trùng)
  async function facts(text) {
    if (!kiotviet || !kiotviet.configured || !kiotviet.configured()) return { items: [], note: 'Chưa nối KiotViet nên không có dữ liệu giá/tồn.' };
    const seen = new Map(); let failed = false;
    for (const q of queries(text)) {
      try { for (const p of await search(q)) if (!seen.has(p.code)) seen.set(p.code, p); } catch (e) { failed = true; log && log('hỏi đáp: KiotViet lỗi (' + q + '): ' + e.message); }
      if (seen.size >= 8) break;
    }
    return { items: [...seen.values()].slice(0, 8), note: failed && !seen.size ? 'KiotViet đang lỗi, chưa tra được giá/tồn.' : '' };
  }

  function buildPrompt(text, f, project) {
    const data = f.items.length
      ? f.items.map((p) => '- ' + p.name + ' (mã ' + p.code + ') · giá bán ' + fmtMoney(p.price) + ' · tồn: ' + (p.branches.length ? p.branches.map((b) => b.name + ' ' + b.onHand).join(', ') + ' (tổng ' + p.total + ')' : 'hết hàng ở mọi chi nhánh')).join('\n')
      : '(không tìm thấy sản phẩm nào khớp trong KiotViet)' + (f.note ? ' ' + f.note : '');
    return '[HỎI ĐÁP BÁN HÀNG — CHỈ ĐỌC] Bạn đang hỗ trợ NHÂN VIÊN BÁN HÀNG của cửa hàng trả lời khách. Quy tắc: (1) CHỈ dùng DỮ LIỆU KIOTVIET bên dưới' + (project ? ' và sổ tay/chính sách của dự án "' + project.name + '" (đã gửi kèm)' : '') +
      '; thiếu thì nói rõ "chưa có thông tin, hỏi quản lý", TUYỆT ĐỐI không bịa giá, tồn, khuyến mại, bảo hành. (2) Không nói giá vốn, doanh thu, lãi. (3) Không ghi/sửa tệp, không chạy lệnh. ' +
      '(4) Trả lời NGẮN, đúng việc nhân viên cần nói với khách: giá, còn hàng ở chi nhánh nào, điểm khác nhau giữa các mẫu nếu được hỏi.\n\nDỮ LIỆU KIOTVIET:\n' + data + '\n\nCÂU HỎI CỦA NHÂN VIÊN:\n' + text;
  }

  // Tra dữ liệu rồi giao AI trả lời. Trả { jobId } hoặc { error }
  async function ask(chatId, text) {
    const f = await facts(text);
    const project = projects ? projects.hoidapProject() : null;
    const id = db.addJob(chatId, buildPrompt(text, f, project), null, null, 'main', project ? project.id : null);
    return { jobId: id, found: f.items.length };
  }
  return { ask, facts, buildPrompt, queries };
}

module.exports = { createHoiDap, queries, noAccent };
