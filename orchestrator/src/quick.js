'use strict';
const { noAccent } = require('./kiotviet');

// LỆNH NHANH: chạy ngay, KHÔNG qua AI (nhanh, không tốn hạn mức, không bị lừa bằng nội dung web). Chỉ dành cho quản trị viên.
//   /manhinh /cuaso /mo <ứng dụng> /dong <ứng dụng> /khoamay /khoimay co /tatmay co   -> qua trợ lý màn hình (deskd)
//   /deepseek <việc>  -> mở DeepSeek web trên màn hình máy + chép sẵn câu lệnh; NGƯỜI bấm Ctrl+V và Gửi (điều khoản DeepSeek cấm robot tự gửi)
//   /doanhso [hôm nay|hôm qua|tuần|tháng]  /ton <sản phẩm>   -> KiotViet API chính thức, chỉ đọc
const NAMES = ['manhinh', 'cuaso', 'mo', 'dong', 'khoamay', 'khoimay', 'tatmay', 'deepseek', 'doanhso', 'ton', 'onedrive', 'baocao', 'hen', 'tailscale', 'in', 'capnhat', 'nho', 'quen', 'trinho'];

const ALIAS = { kiot: 'kiotviet', 'kiot viet': 'kiotviet', 'trinh duyet': 'chrome', google: 'chrome', 'google chrome': 'chrome', 'deep seek': 'deepseek', 'tu xa': 'rustdesk', 'dieu khien tu xa': 'rustdesk', 'claude code': 'claude' };
const appKey = (s) => { const k = noAccent(s); return ALIAS[k] || k.replace(/ /g, ''); };

function createQuick(o) {
  o = o || {};
  const desk = o.desk, kv = o.kiotviet, od = o.onedrive, sched = o.schedule, ts = o.tailscale, printing = o.printing, upd = o.update, mem = o.memory;
  const clock = () => { const d = new Date(Date.now() + 7 * 3600 * 1000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };

  async function run(name, arg, ctx) {
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
          if (!arg) return 'Cách dùng: /' + name + ' <ứng dụng>. Ứng dụng: zalo, kiotviet, deepseek, chrome, rustdesk' + (name === 'mo' ? ', claude, codex, gemini' : '') + '.';
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
        case 'onedrive': {
          if (!od) return '⚠️ Máy này chưa có OneDrive (thiếu bộ đồng bộ).';
          const w = noAccent(arg.split(/\s+/)[0] || '');
          if (!arg) return await od.status();
          if (od.looksLikeAuthResponse(arg)) {                                       // chủ máy gửi lại địa chỉ trang trắng sau khi đăng nhập Microsoft
            const r = await od.finishAuth(arg);
            return r.ok ? '✅ Đã kết nối OneDrive! Máy bắt đầu đồng bộ về ' + od.dir + ' (lần đầu có thể mất vài phút tới vài giờ nếu nhiều dữ liệu). Gõ /onedrive để xem tiến độ.' : '⚠️ ' + r.error;
          }
          if (/^(ketnoi|ket|login|dangnhap)$/.test(w.replace(/ /g, ''))) {
            const r = await od.startAuth();
            if (!r.ok) return '⚠️ ' + r.error;
            return '🔑 Kết nối OneDrive (làm trong 15 phút):\n1) Mở link này trên điện thoại hoặc máy tính và đăng nhập tài khoản Microsoft có OneDrive, bấm "Đồng ý/Accept":\n' + r.url +
              '\n2) Sau đó trình duyệt hiện trang TRẮNG. Hãy copy TOÀN BỘ địa chỉ trên thanh địa chỉ của trang trắng đó (bắt đầu bằng https://login.microsoftonline.com/common/oauth2/nativeclient?code=...).\n3) Dán và gửi địa chỉ đó cho em ngay trong chat này.';
          }
          if (w === 'dongbo' || w === 'sync') { const r = await od.sync(); return r.ok ? '🔄 Đã yêu cầu đồng bộ ngay. Gõ /onedrive sau vài phút để xem.' : '⚠️ ' + r.error; }
          if (w === 'thumuc') { const f = od.folders(); return f ? (f.length ? '📂 ' + od.dir + ':\n' + f.join('\n') : 'Thư mục trống (chưa kết nối hoặc chưa đồng bộ xong).') : '⚠️ Không đọc được ' + od.dir; }
          if (/^(ngat|ngatketnoi|logout)$/.test(w.replace(/ /g, ''))) {
            if (!/\b(co|xacnhan|ok)\b/.test(noAccent(arg))) return '⚠️ Ngắt kết nối OneDrive: máy ngừng đồng bộ (tệp đã tải về vẫn giữ nguyên, không xóa gì trên OneDrive). Gõ /onedrive ngat co để xác nhận.';
            await od.disconnect(); return '✅ Đã ngắt kết nối OneDrive. Muốn nối lại: /onedrive ketnoi.';
          }
          return 'Cách dùng: /onedrive (tình trạng) · /onedrive ketnoi · /onedrive dongbo · /onedrive thumuc · /onedrive ngat co';
        }
        case 'doanhso': case 'ton': {
          if (!kv || !kv.configured()) return '⚠️ Chưa cấu hình KiotViet. Thêm KIOTVIET_CLIENT_ID, KIOTVIET_CLIENT_SECRET, KIOTVIET_RETAILER vào /etc/agentos/orchestrator.env rồi khởi động lại bộ điều phối.';
          return name === 'doanhso' ? await kv.revenue(arg) : await kv.stock(arg);
        }
        case 'baocao': case 'hen': return sched ? await sched.command(name, arg, ctx) : '⚠️ Máy này chưa có tính năng hẹn giờ.';
        case 'tailscale': {
          if (!ts) return '⚠️ Máy này chưa có Tailscale.';
          const w = noAccent(arg.split(/\s+/)[0] || '').replace(/ /g, '');
          if (!w) return await ts.status();
          if (/^(ketnoi|ket|login|dangnhap)$/.test(w)) {
            const r = await ts.connect();
            if (!r.ok) return '⚠️ ' + r.error;
            if (r.already) return await ts.status();
            return '🔑 Kết nối Tailscale (làm trong 10 phút): mở link này trên điện thoại hoặc máy tính, đăng nhập (Google/Microsoft/Apple...) và bấm Connect:\n' + r.url + '\nXong gõ /tailscale để xem địa chỉ.';
          }
          if (/^(ngat|logout|dangxuat)$/.test(w)) {
            if (!/\b(co|xacnhan|ok)\b/.test(noAccent(arg))) return '⚠️ Đăng xuất Tailscale: máy mất đường vào dự phòng. Gõ /tailscale ngat co để xác nhận.';
            const r = await ts.disconnect(); return r.code === 0 ? '✅ Đã đăng xuất Tailscale.' : '⚠️ ' + (r.err || r.out).trim().slice(0, 150);
          }
          return 'Cách dùng: /tailscale (tình trạng) · /tailscale ketnoi · /tailscale ngat co';
        }
        case 'capnhat': return upd ? await upd.command(arg) : '⚠️ Máy này chưa có tính năng cập nhật từ xa.';
        case 'nho': {
          if (!mem) return '⚠️ Máy này chưa có bộ nhớ.';
          if (!arg) return 'Cách dùng: /nho <điều cần nhớ lâu dài>, ví dụ /nho Cửa hàng nghỉ chủ nhật. Mọi AI (Claude, Codex, Gemini, DeepSeek) đều dùng chung. /trinho để xem, /quen <từ khóa> để xóa.';
          const r = mem.addFact(arg);
          return r.ok ? (r.duplicate ? 'Điều này đã có trong ghi nhớ rồi.' : '🧠 Đã ghi nhớ. Mọi AI sẽ biết điều này (/trinho để xem, /quen để xóa).') : '⚠️ ' + r.error;
        }
        case 'quen': {
          if (!mem) return '⚠️ Máy này chưa có bộ nhớ.';
          if (!arg) return 'Cách dùng: /quen <từ khóa>: xóa các dòng ghi nhớ có chứa từ khóa đó (có bản sao lưu GHI-NHO.md.bak).';
          const r = mem.forgetFact(arg);
          return r.removed ? '🗑️ Đã xóa ' + r.removed + ' dòng ghi nhớ:\n' + r.lines.map((l) => l.trim().slice(0, 140)).join('\n') : 'Không có dòng ghi nhớ nào chứa "' + arg + '".';
        }
        case 'trinho': {
          if (!mem) return '⚠️ Máy này chưa có bộ nhớ.';
          const i = mem.info(ctx && ctx.chatId);
          const facts = i.facts.trim() ? (i.facts.length > 2800 ? i.facts.slice(0, 2800) + '\n…(còn nữa, xem tệp ' + i.factsFile + ')' : i.facts.trim()) : '(chưa có điều nào; dùng /nho để thêm)';
          return '🧠 Ghi nhớ lâu dài (' + i.factLines + ' điều, dùng chung mọi AI)\n' + facts + '\n\n📝 Tóm tắt cuộc trò chuyện này: ' + (i.summary ? '\n' + i.summary.slice(0, 1200) : '(chưa có; có khi hội thoại dài)') +
            '\n\nNén ngữ cảnh bằng: ' + (i.summarizer ? (i.summarizer === 'gemini' ? 'Gemini (khóa API)' : 'DeepSeek (khóa API)') : 'cắt gọn (chưa có khóa Gemini/DeepSeek, thêm ở Cài đặt → AI và khóa API)') + ' · mở phiên mới sau ' + i.cfg.rotateAfter + ' lượt';
        }
        case 'in': return printing ? await printing.print(arg) : '⚠️ Máy này chưa có tính năng in.';
        default: return null;
      }
    } catch (e) { return '⚠️ Lỗi: ' + e.message; }
  }

  // Tin nhắn không có dấu "/" nhưng là đáp án của một lệnh đang chờ (địa chỉ đăng nhập OneDrive chủ máy dán lại)
  const match = (text) => (od && od.looksLikeAuthResponse(text) ? { name: 'onedrive', arg: String(text).trim() } : null);
  return { names: NAMES, has: (n) => NAMES.includes(n), run, match, appKey };
}

module.exports = { createQuick, NAMES, appKey };
