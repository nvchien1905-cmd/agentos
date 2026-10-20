'use strict';
const { noAccent } = require('./kiotviet');

// LỆNH NHANH: chạy ngay, KHÔNG qua AI (nhanh, không tốn hạn mức, không bị lừa bằng nội dung web). Chỉ dành cho quản trị viên.
//   /manhinh /cuaso /mo <ứng dụng> /dong <ứng dụng> /khoamay /khoimay co /tatmay co   -> qua trợ lý màn hình (deskd)
//   /deepseek <việc>  -> mở DeepSeek web trên màn hình máy + chép sẵn câu lệnh; NGƯỜI bấm Ctrl+V và Gửi (điều khoản DeepSeek cấm robot tự gửi)
//   /doanhso [hôm nay|hôm qua|tuần|tháng]  /ton <sản phẩm>   -> KiotViet API chính thức, chỉ đọc
const NAMES = ['manhinh', 'cuaso', 'mo', 'dong', 'khoamay', 'khoimay', 'tatmay', 'deepseek', 'doanhso', 'ton'];

const ALIAS = { kiot: 'kiotviet', 'kiot viet': 'kiotviet', 'trinh duyet': 'chrome', google: 'chrome', 'google chrome': 'chrome', 'deep seek': 'deepseek', 'tu xa': 'rustdesk', 'dieu khien tu xa': 'rustdesk', 'claude code': 'claude' };
const appKey = (s) => { const k = noAccent(s); return ALIAS[k] || k.replace(/ /g, ''); };

function createQuick(o) {
  o = o || {};
  const desk = o.desk, kv = o.kiotviet;
  const clock = () => { const d = new Date(Date.now() + 7 * 3600 * 1000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };

  async function run(name, arg) {
    arg = String(arg || '').trim();
    try {
      switch (name) {
        case 'manhinh': {
          const r = await desk.call({ cmd: 'screenshot' });
          if (!r.ok) return '⚠️ ' + r.error;
          return { text: '📸 Màn hình máy lúc ' + clock(), files: [{ path: r.file, name: 'manhinh.png', kind: 'photo', temp: true }] };
        }
        case 'cuaso': {
          const r = await desk.call({ cmd: 'windows' });
          return r.ok ? (r.windows.length ? '🪟 Cửa sổ đang mở:\n• ' + r.windows.join('\n• ') : 'Không có cửa sổ nào đang mở.') : '⚠️ ' + r.error;
        }
        case 'mo': case 'dong': {
          if (!arg) return 'Cách dùng: /' + name + ' <ứng dụng>. Ứng dụng: zalo, kiotviet, deepseek, chrome, rustdesk' + (name === 'mo' ? ', claude, codex' : '') + '.';
          const r = await desk.call({ cmd: name === 'mo' ? 'open' : 'close', app: appKey(arg) });
          if (!r.ok) return '⚠️ ' + r.error;
          if (name === 'mo') return '✅ Đã mở ' + r.app + ' trên màn hình máy. Gõ /manhinh để xem.';
          return r.closed ? '✅ Đã đóng ' + r.app + '.' : r.app + ' đang không mở.';
        }
        case 'khoamay': {
          const r = await desk.call({ cmd: 'lock' });
          return r.ok ? '🔒 Đã khóa màn hình máy.' : '⚠️ ' + r.error;
        }
        case 'khoimay': case 'tatmay': {
          const reboot = name === 'khoimay';
          if (!/^(co|xacnhan|ok|dong y)$/.test(noAccent(arg))) return '⚠️ ' + (reboot ? 'Khởi động lại' : 'TẮT') + ' máy' + (reboot ? '' : ' (không bật lại từ xa được)') + '. Gõ /' + name + ' co để xác nhận.';
          const r = await desk.call({ cmd: reboot ? 'reboot' : 'poweroff' });
          return r.ok ? (reboot ? '🔄 Máy sẽ khởi động lại sau ' + r.after + ' giây, khoảng 2 phút sau bot nhắn lại.' : '⏻ Máy sẽ tắt sau ' + r.after + ' giây.') : '⚠️ ' + r.error;
        }
        case 'deepseek': {
          if (!arg) return 'Cách dùng: /deepseek <việc cần hỏi>. Bot mở DeepSeek trên máy và chép sẵn câu lệnh, anh bấm Ctrl+V rồi Gửi.';
          const c = await desk.call({ cmd: 'clip', text: arg });
          if (!c.ok) return '⚠️ ' + c.error;
          const r = await desk.call({ cmd: 'open', app: 'deepseek' });
          if (!r.ok) return '⚠️ Đã chép câu lệnh nhưng không mở được DeepSeek: ' + r.error;
          return '✅ Đã mở DeepSeek trên màn hình máy và chép sẵn câu lệnh vào bộ nhớ tạm.\nTrên máy: bấm vào ô chat → Ctrl+V → Gửi. (DeepSeek cấm robot tự gửi nên bước Gửi do anh làm.) Gõ /manhinh để xem màn hình.';
        }
        case 'doanhso': case 'ton': {
          if (!kv || !kv.configured()) return '⚠️ Chưa cấu hình KiotViet. Thêm KIOTVIET_CLIENT_ID, KIOTVIET_CLIENT_SECRET, KIOTVIET_RETAILER vào /etc/agentos/orchestrator.env rồi khởi động lại bộ điều phối.';
          return name === 'doanhso' ? await kv.revenue(arg) : await kv.stock(arg);
        }
        default: return null;
      }
    } catch (e) { return '⚠️ Lỗi: ' + e.message; }
  }

  return { names: NAMES, has: (n) => NAMES.includes(n), run, appKey };
}

module.exports = { createQuick, NAMES, appKey };
