'use strict';

// MENU NÚT BẤM trên Telegram cho người KHÔNG rành lệnh: /menu (hoặc /start) hiện các nút việc hay dùng; bấm nút = chạy đúng lệnh tương ứng
// (qua cùng đường xử lý như gõ tay nên quyền hạn, nhật ký, hàng đợi y nguyên). Việc gây thay đổi lớn (cập nhật hệ điều hành) hỏi lại 1 lần.
// /google: thẻ trạng thái Google + hướng dẫn từng bước + nút hỏi nhanh lịch/thư (chỉ đọc).
const ITEMS = [
  { k: 'tt', label: '📊 Tình trạng', cmd: '/trangthai' },
  { k: 'tc', label: '🩺 Tự kiểm tra máy', cmd: '/tuchan nhanh' },
  { k: 'pc', label: '🖥 Phần cứng', cmd: '/phancung' },
  { k: 'ht', label: '↩️ Hoàn tác', cmd: '/hoantac' },
  { k: 'ks', label: '🧩 Kỹ năng & plugin', cmd: '/cho' },
  { k: 'kn', label: '🔌 Kết nối dịch vụ', cmd: '/dichvu' },
  { k: 'gg', label: '📅 Google (Lịch, Gmail)', google: true },
  { k: 'da', label: '📁 Dự án', cmd: '/duan' },
  { k: 'ag', label: '🤖 Agent (bot phụ)', cmd: '/daily' },
  { k: 'mh', label: '📸 Xem màn hình máy', cmd: '/manhinh' },
  { k: 'cd', label: '🛡 Chế độ & quyền AI', cmd: '/cheodo' },
  { k: 'cn', label: '🔄 Cập nhật hệ điều hành', cmd: '/capnhat co', confirm: 'Cập nhật hệ điều hành lên bản mới nhất? Máy có thể khởi động lại một vài dịch vụ (khoảng 1 phút).' },
  { k: 'hp', label: '❓ Tất cả lệnh', cmd: '/help' },
];
const GOOGLE_ASKS = {
  lh: 'Xem lịch Google hôm nay của tôi và tóm tắt theo giờ, nhắc việc cần chuẩn bị. Chỉ đọc, không sửa gì.',
  lt: 'Xem lịch Google 7 ngày tới, nói ngày nào bận, ngày nào rảnh. Chỉ đọc, không sửa gì.',
  th: 'Tìm thư chưa đọc trong 2 ngày qua trên Gmail, tóm tắt thư quan trọng và nói thư nào cần trả lời trước. Chỉ đọc, không trả lời/xóa/gửi gì.',
};

function createMenuUi(o) {
  const find = (k) => ITEMS.find((i) => i.k === k);
  const rows = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

  function card() {
    return { text: '📋 Menu AgentOS — bấm nút để làm, khỏi nhớ lệnh.\nMuốn nhờ AI làm việc gì thì cứ nhắn bình thường như đang nói chuyện.', buttons: rows(ITEMS.map((i) => ({ text: i.label, data: 'mn:c:' + i.k })), 2) };
  }

  function google() {
    let st = null; try { st = o.googleStatus ? o.googleStatus() : null; } catch (e) { st = null; }
    const back = [{ text: '⬅️ Menu', data: 'mn:m' }];
    if (st && st.connected) {
      return { text: '📅 Google (Lịch + Gmail): ✅ đã kết nối — quyền ' + (st.write ? 'ĐỌC + GHI (ghi luôn hỏi anh trước)' : 'chỉ ĐỌC') + '.\nBấm nút để hỏi nhanh, hoặc nhắn tự do, ví dụ "mai anh có lịch gì?".' + (st.write ? '' : '\nMuốn AI tạo lịch/soạn nháp thư: vào Cài đặt trên máy → Kết nối và kỹ năng → Google → tích "Cho phép GHI" → Đăng nhập lại.'),
        buttons: [[{ text: '📅 Lịch hôm nay', data: 'mn:g:lh' }, { text: '📆 Lịch 7 ngày', data: 'mn:g:lt' }], [{ text: '✉️ Thư chưa đọc', data: 'mn:g:th' }], back] };
    }
    const own = st && st.clientSet;
    return { text: '📅 Google (Lịch + Gmail): ⚪ chưa kết nối.\n\n' + (own
      ? 'Máy đã có khóa Google. Chỉ còn đăng nhập:\n1) Trên máy AgentOS mở Cài đặt → "Kết nối và kỹ năng" → thẻ Google.\n2) Bấm "Đăng nhập Google", chọn Gmail của anh. Google hiện cảnh báo "chưa xác minh" thì bấm Nâng cao → Tiếp tục.'
      : 'Làm một lần (khoảng 5 phút), trên máy AgentOS:\n1) Mở Cài đặt → "Kết nối và kỹ năng" → thẻ Google.\n2) Làm theo 5 bước trong thẻ (mỗi bước có nút mở thẳng trang Google cần bấm; bước cuối chỉ chọn tệp JSON vừa tải).\n3) Bấm "Đăng nhập Google".') +
      '\n\nMặc định chỉ ĐỌC lịch và thư — không thể sửa hay gửi gì khi anh chưa cho phép.', buttons: [back] };
  }

  const isCallback = (d) => /^mn:/.test(String(d || ''));

  async function callback(cq) {
    const uid = String(cq.from.id), chatId = String(cq.message && cq.message.chat ? cq.message.chat.id : cq.from.id), d = String(cq.data);
    if (!o.isAdmin(uid)) return 'Chỉ chủ máy dùng được menu này.';
    const reply = (t) => (t && o.send ? o.send(chatId, t) : null);
    const runCmd = async (text) => { const r = await o.run({ from: cq.from, chat: cq.message ? cq.message.chat : { id: chatId }, text }); await reply(r); };
    let m;
    if (d === 'mn:m') { await reply(card()); return ''; }
    if ((m = d.match(/^mn:g:(\w+)$/))) {
      const prompt = GOOGLE_ASKS[m[1]]; if (!prompt) return null;
      const ack = o.submit ? o.submit(chatId, prompt, null) : null; await reply(ack); return 'Đang hỏi Google…';
    }
    if ((m = d.match(/^mn:ok:(\w+)$/))) { const it = find(m[1]); if (!it || !it.cmd) return null; await runCmd(it.cmd); return 'Đã làm'; }
    if (d === 'mn:no') return 'Thôi, không làm.';
    if ((m = d.match(/^mn:c:(\w+)$/))) {
      const it = find(m[1]); if (!it) return null;
      if (it.google) { await reply(google()); return ''; }
      if (it.confirm) { await reply({ text: '⚠️ ' + it.confirm, buttons: [[{ text: '✅ Làm luôn', data: 'mn:ok:' + it.k }, { text: 'Thôi', data: 'mn:no' }]] }); return ''; }
      await runCmd(it.cmd); return '';
    }
    return null;
  }

  return { card, google, isCallback, callback, ITEMS };
}

module.exports = { createMenuUi, ITEMS, GOOGLE_ASKS };
