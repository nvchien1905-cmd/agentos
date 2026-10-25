'use strict';
const { noAccent } = require('./kiotviet');

// LỆNH NHANH: chạy ngay, KHÔNG qua AI (nhanh, không tốn hạn mức, không bị lừa bằng nội dung web). Chỉ dành cho quản trị viên.
//   /manhinh /cuaso /mo <ứng dụng> /dong <ứng dụng> /khoamay /khoimay co /tatmay co   -> qua trợ lý màn hình (deskd)
//   /deepseek <việc>  -> mở DeepSeek web trên màn hình máy + chép sẵn câu lệnh; NGƯỜI bấm Ctrl+V và Gửi (điều khoản DeepSeek cấm robot tự gửi)
//   /doanhso [hôm nay|hôm qua|tuần|tháng]  /ton <sản phẩm>   -> KiotViet API chính thức, chỉ đọc
const NAMES = ['manhinh', 'cuaso', 'mo', 'dong', 'khoamay', 'khoimay', 'tatmay', 'deepseek', 'doanhso', 'ton', 'onedrive', 'baocao', 'hen', 'tailscale', 'in', 'capnhat', 'nho', 'quen', 'trinho', 'lenh', 'lay', 'maytinh', 'go', 'phim', 'bam', 'tuxa', 'guilen', 'timchu', 'bamchu', 'chuyen', 'dan', 'mokhoa', 'saoluu', 'bat', 'doc', 'doi', 'thay', 'hangrao', 'tuchan', 'log', 'sukien'];

const ALIAS = { kiot: 'kiotviet', 'kiot viet': 'kiotviet', 'trinh duyet': 'chrome', google: 'chrome', 'google chrome': 'chrome', 'deep seek': 'deepseek', 'tu xa': 'rustdesk', 'dieu khien tu xa': 'rustdesk', 'claude code': 'claude' };
const appKey = (s) => { const k = noAccent(s); return ALIAS[k] || k.replace(/ /g, ''); };

function createQuick(o) {
  o = o || {};
  const desk = o.desk, kv = o.kiotviet, od = o.onedrive, sched = o.schedule, ts = o.tailscale, printing = o.printing, upd = o.update, mem = o.memory, remote = o.remote, links = o.links, snap = o.snapshot, wol = o.wol, devices = o.devices || { get: () => ({}), set: () => {} }, office = o.office, guard = o.guard, selftest = o.selftest, triggers = o.triggers, shotWaitMs = o.shotWaitMs === undefined ? 900 : o.shotWaitMs;
  // Sau mỗi thao tác điều khiển: chờ màn hình cập nhật rồi chụp lại gửi kèm (không phải gõ /manhinh)
  async function withShot(text) {
    if (shotWaitMs) await new Promise((r) => setTimeout(r, shotWaitMs));
    let r = null; try { r = await desk.call({ cmd: 'screenshot' }); } catch (e) { /* không chụp được thì chỉ báo chữ */ }
    if (r && r.ok && r.file) return { text: text + ' (ảnh màn hình sau thao tác)', files: [{ path: r.file, name: 'manhinh.png', kind: 'photo', temp: true }] };
    return text;
  }
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
              '\n2) Sau đó trình duyệt hiện trang có cảnh báo, vài giây sau TỰ CHUYỂN sang "Đây không phải là trang phù hợp" (Microsoft đổi trang, không phải lỗi của máy). Hãy copy TOÀN BỘ địa chỉ trên thanh địa chỉ NGAY khi thấy (bắt đầu bằng https://login.microsoftonline.com/common/oauth2/nativeclient?code=...); lỡ rồi thì bấm nút ← Quay lại MỘT lần rồi copy.\n3) Dán và gửi địa chỉ đó cho em ngay trong chat này.\n💡 Dễ hơn: ngồi ở mini PC, mở "Cài đặt AgentOS" → Kết nối → Kết nối OneDrive: máy tự nhận mã, không cần copy gì.';
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
          if (!arg) return 'Cách dùng: /nho <điều cần nhớ lâu dài>, ví dụ /nho Cửa hàng nghỉ chủ nhật. Bot xếp vào đúng CHƯƠNG của sổ tay (cùng chủ đề gom lại; thông tin mới thay mục cũ). Mọi AI dùng chung. /trinho xem, /quen <từ khóa> xóa.';
          const r = await mem.addFact(arg);
          if (!r.ok) return '⚠️ ' + r.error;
          return r.duplicate ? 'Điều này đã có trong sổ tay (chương "' + r.chapter + '").' : '🧠 Đã ghi vào chương "' + r.chapter + '"' + (r.replaced ? ' (thay ' + r.replaced + ' mục cũ đã lỗi thời)' : '') + '. Mọi AI sẽ biết điều này (/trinho để xem, /quen để xóa).';
        }
        case 'quen': {
          if (!mem) return '⚠️ Máy này chưa có bộ nhớ.';
          if (!arg) return 'Cách dùng: /quen <từ khóa>: gỡ các mục trong sổ tay có chứa từ khóa đó (mục bị gỡ lưu ở thư mục .lichsu, có thể xem lại).';
          const r = mem.forgetFact(arg);
          return r.removed ? '🗑️ Đã gỡ ' + r.removed + ' mục khỏi sổ tay:\n' + r.lines.map((l) => l.slice(0, 150)).join('\n') : 'Không có mục nào chứa "' + arg + '".';
        }
        case 'trinho': {
          if (!mem) return '⚠️ Máy này chưa có bộ nhớ.';
          const i = mem.info(ctx && ctx.chatId);
          if (arg) {                                                         // /trinho <chủ đề>: xem CHI TIẾT chương liên quan
            const hit = mem.book.relevant(arg, 2, 1, 1);
            return hit.length ? hit.map((c) => mem.book.chapterText(c, 1800)).join('\n\n') : 'Không có chương nào khớp "' + arg + '". Gõ /trinho để xem mục lục.';
          }
          return '📖 Sổ tay của chủ máy (' + i.chapters + ' chương, ' + i.entries + ' mục, dùng chung mọi AI)\n' + (i.toc ? i.toc.replace(/ → \S+$/gm, '') : '(chưa có gì; dùng /nho để thêm)') +
            '\n\n📝 Tóm tắt cuộc trò chuyện này: ' + (i.summary ? '\n' + i.summary.slice(0, 1000) : '(chưa có; có khi hội thoại dài)') +
            '\n\nNén ngữ cảnh bằng: ' + (i.summarizer ? (i.summarizer === 'gemini' ? 'Gemini (khóa API)' : 'DeepSeek (khóa API)') : 'cắt gọn (chưa có khóa Gemini/DeepSeek, thêm ở Cài đặt → AI và khóa API)') + ' · mở phiên mới sau ' + i.cfg.rotateAfter + ' lượt\n/trinho <chủ đề> xem chi tiết một chương';
        }
        case 'sukien': {
          if (!triggers) return '⚠️ Máy này chưa có sự kiện tự kích hoạt.';
          const a = arg.trim(); const w = noAccent(a).split(' ');
          const usage = 'Cách dùng:\n/sukien them hoadon <tiền tối thiểu> [| việc cho AI] — có hóa đơn mới từ mức đó trở lên\n/sukien them tonthap [| việc cho AI] — có sản phẩm sắp hết hàng\n(không ghi việc cho AI thì chỉ nhắn thông báo, không tốn AI; ghi thì AI tự làm, dùng được {ma} {tong} {chinhanh} {khach} {danhsach})\n/sukien xoa <số> · /sukien tat <số> · /sukien bat <số>\n/sukien webhook [bat|tat|moi] — link bí mật để hệ thống khác báo sự kiện cho máy';
          if (!a) { const c = triggers.load(); const hs = await triggers.hookStatus(); return '⚡ Sự kiện tự kích hoạt (quét 5 phút/lần):\n' + (c.rules.length ? c.rules.map((r) => triggers.describe(r)).join('\n') : '(chưa có luật nào)') + '\nWebhook: ' + (hs.enabled ? 'BẬT' : 'tắt') + '\n\n' + usage; }
          if (w[0] === 'them') {
            const type = w[1]; const parts = a.replace(/^\S+\s+\S+\s*/, '').split('|'); const nums = (parts[0].match(/[\d.,]+/) || [''])[0].replace(/[.,]/g, '');
            const r = triggers.add(type, nums, parts.slice(1).join('|').trim());
            return r.ok ? '✅ Đã thêm luật ' + triggers.describe(r.rule) + (r.rule.prompt ? '\n(việc của AI sẽ chạy nền, kết quả báo riêng)' : '') : '⚠️ ' + r.error;
          }
          if (w[0] === 'xoa') return triggers.remove(w[1]) ? '🗑️ Đã xóa luật #' + w[1] : 'Không có luật #' + w[1];
          if (w[0] === 'tat' || w[0] === 'bat') return triggers.toggle(w[1], w[0] === 'bat') ? (w[0] === 'bat' ? '▶️ Đã bật' : '⏸ Đã tắt') + ' luật #' + w[1] : 'Không có luật #' + w[1];
          if (w[0] === 'webhook') {
            if (w[1] === 'bat' || w[1] === 'moi' || w[1] === 'tat') { const r = await triggers.hookSet(w[1]); if (!r.ok) return '⚠️ ' + r.error; }
            const hs = await triggers.hookStatus();
            if (!hs.enabled) return 'Webhook đang TẮT. Bật: /sukien webhook bat';
            return '🔗 Webhook (giữ bí mật như mật khẩu; đổi link: /sukien webhook moi):\n' + hs.url + '\nGửi: curl -X POST --data "Có đơn hàng lớn từ Zalo" <link>\nQua ' + hs.via + (hs.via === 'Tailscale' ? ' (mã hóa).' : ': chỉ dùng trong mạng nhà; muốn từ xa hãy bật Tailscale.') + '\nViệc từ webhook luôn chạy chế độ BẢO VỆ (chỉ đọc, hỏi duyệt) vì nội dung từ ngoài có thể chứa mệnh lệnh cài vào.';
          }
          return usage;
        }
        case 'tuchan': {
          if (!selftest) return '⚠️ Máy này chưa có tự chẩn đoán.';
          const w = noAccent(arg);
          if (w === 'ai') { const r = await selftest.full({ ai: true, engineNames: o.engineNames || [], startFn: o.pingStart }); return selftest.format(r, '🩺 Tự chẩn đoán đầy đủ + thử hỏi từng AI'); }
          if (w === 'nhanh') return selftest.format(await selftest.light(), '🩺 Chẩn đoán nhanh');
          return selftest.format(await selftest.full(), '🩺 Tự chẩn đoán') + '\n\n(Gõ /tuchan ai để thử hỏi từng AI một câu, tốn một ít hạn mức.)';
        }
        case 'log': return remote ? await remote.logs((arg.match(/\d+/) || [])[0]) : '⚠️ Máy này chưa có điều khiển từ xa.';
        case 'hangrao': {
          if (!guard) return '⚠️ Máy này chưa có hàng rào.';
          const w = noAccent(arg).split(' ')[0];
          if (w === 'tat' || w === 'bat') { guard.set(w === 'bat'); return w === 'bat' ? '🛡️ Đã BẬT hàng rào: AI toàn quyền vẫn không đọc được khóa API/biến môi trường, và phải hỏi anh trước khi gửi dữ liệu ra ngoài hoặc làm việc dính tiền.' : '⚠️ Đã TẮT hàng rào: AI toàn quyền không còn bị chặn/hỏi gì (có thể bị lừa qua nội dung web/email). Gõ /hangrao bat để bật lại.'; }
          return '🛡️ Hàng rào chế độ toàn quyền đang ' + (guard.get() ? 'BẬT' : 'TẮT') + '.\nBật: cấm đọc khóa API/biến môi trường/cấu hình bí mật; hỏi anh (nút bấm) trước khi gửi email, tin nhắn, POST/upload, scp, git push hoặc việc dính ngân hàng/thanh toán. Đổi: /hangrao bat | /hangrao tat. (Chỉ áp cho Claude; Codex/Gemini không có cơ chế này.)';
        }
        case 'doc': return office ? await office.read(arg) : '⚠️ Máy này chưa có công cụ văn phòng.';
        case 'doi': { if (!office) return '⚠️ Máy này chưa có công cụ văn phòng.'; const m = arg.match(/^(\S+)\s*([\s\S]*)$/); return await office.convert(m && m[1], m && m[2]); }
        case 'thay': return office ? await office.replace(arg) : '⚠️ Máy này chưa có công cụ văn phòng.';
        case 'timchu': {
          if (!arg) return 'Cách dùng: /timchu <chữ>, ví dụ /timchu Gửi. Bot đọc chữ trên màn hình máy và báo toạ độ từng chỗ thấy.';
          const r = await desk.call({ cmd: 'findtext', text: arg });
          if (!r.ok) return '⚠️ ' + r.error;
          return r.matches.length ? '🔎 Thấy "' + arg + '" ' + r.matches.length + ' chỗ:\n' + r.matches.map((m, i) => (i + 1) + '. (' + m.cx + ', ' + m.cy + ') "' + m.text + '"').join('\n') + '\nBấm bằng /bamchu ' + arg + ' (thêm "lan 2" để bấm chỗ thứ 2).' : 'Không thấy chữ "' + arg + '" trên màn hình. Gõ /manhinh để xem.';
        }
        case 'bamchu': {
          const m = arg.match(/^([\s\S]*?)(?:\s+lan\s+(\d{1,2}))?(\s+dup)?$/i);
          const text = (m && m[1] || '').trim();
          if (!text) return 'Cách dùng: /bamchu <chữ trên nút/menu>, ví dụ /bamchu Lưu hoặc /bamchu Gửi lan 2 (chỗ thứ 2) hoặc /bamchu Mở dup (bấm đôi).';
          const r = await desk.call({ cmd: 'clicktext', text, nth: m[2] ? Number(m[2]) : 1, double: !!m[3] });
          return r.ok ? await withShot('🖱️ Đã bấm vào "' + r.text + '" tại (' + r.x + ', ' + r.y + ')' + (r.found > 1 ? ' — thấy ' + r.found + ' chỗ, bấm chỗ ' + (m[2] || 1) : '') + '.') : '⚠️ ' + r.error;
        }
        case 'chuyen': {
          if (!arg) return 'Cách dùng: /chuyen <tên cửa sổ>, ví dụ /chuyen Chrome. Xem tên bằng /cuaso.';
          const r = await desk.call({ cmd: 'focus', name: arg });
          return r.ok ? await withShot('🪟 Đã đưa cửa sổ "' + arg + '" lên trước.') : '⚠️ ' + r.error;
        }
        case 'dan': {
          if (!arg) { const r = await desk.call({ cmd: 'clipget' }); return r.ok ? (r.text ? '📋 Bộ nhớ tạm trên máy:\n' + r.text.slice(0, 3500) : '📋 Bộ nhớ tạm trên máy đang trống.') : '⚠️ ' + r.error; }
          const r = await desk.call({ cmd: 'clip', text: arg });
          return r.ok ? '📋 Đã chép ' + arg.length + ' ký tự vào bộ nhớ tạm của máy. Trên máy bấm Ctrl+V để dán (hoặc /phim ctrl+v).' : '⚠️ ' + r.error;
        }
        case 'mokhoa': {
          const r = await desk.call({ cmd: 'unlock' });
          return r.ok ? (r.already ? '🔓 Màn hình không khóa.' : await withShot('🔓 Đã mở khóa màn hình.')) : '⚠️ ' + r.error;
        }
        case 'saoluu': {
          if (!snap) return '⚠️ Máy này chưa có tính năng điểm khôi phục.';
          if (/^(ds|danhsach|list)$/.test(noAccent(arg).replace(/ /g, ''))) { const l = snap.list(); return l.length ? '💾 Các điểm khôi phục (mới nhất cuối):\n' + l.map((x) => '• ' + x.name + ' (' + Math.max(1, Math.round(x.size / 1024)) + ' KB)').join('\n') + '\nKhôi phục cấu hình: nhờ AI hoặc /lenh xacnhan sudo tar -xzf ' + snap.dir + '/<tên> -C /' : 'Chưa có điểm khôi phục nào. Gõ /saoluu để tạo.'; }
          const r = await snap.create(arg || 'tay');
          return r.ok ? '💾 Đã tạo điểm khôi phục cấu hình (/etc + dữ liệu AgentOS): ' + require('path').basename(r.file) + ' (' + Math.max(1, Math.round(r.size / 1024)) + ' KB). Không chứa tệp cá nhân hay chương trình đã cài.' : '⚠️ ' + r.error;
        }
        case 'bat': {
          if (!wol) return '⚠️ Máy này chưa có tính năng bật máy khác.';
          const w = arg.split(/\s+/).filter(Boolean); const list = devices.get() || {};
          const key = (x) => noAccent(x).replace(/ /g, '');
          if (!w.length || key(w[0]) === 'ds') return Object.keys(list).length ? '🖧 Máy đã lưu:\n' + Object.keys(list).map((k) => '• ' + k + ' — ' + list[k]).join('\n') + '\nBật: /bat <tên>' : 'Chưa lưu máy nào. Thêm: /bat them <tên> <MAC>, ví dụ /bat them maychinh AA:BB:CC:DD:EE:FF. Bật theo MAC luôn: /bat AA:BB:CC:DD:EE:FF. (Máy kia phải bật Wake-on-LAN trong BIOS.)';
          if (key(w[0]) === 'them') { const mac = wol.parseMac(w[2]); if (!w[1] || !mac) return 'Cách dùng: /bat them <tên> <MAC>'; list[w[1].toLowerCase()] = mac; devices.set(list); return '✅ Đã lưu "' + w[1].toLowerCase() + '" = ' + mac + '. Bật bằng /bat ' + w[1].toLowerCase(); }
          if (key(w[0]) === 'xoa') { delete list[(w[1] || '').toLowerCase()]; devices.set(list); return '🗑️ Đã xóa "' + (w[1] || '') + '".'; }
          const mac = list[w[0].toLowerCase()] || wol.parseMac(w[0]);
          if (!mac) return 'Không biết máy "' + w[0] + '". Gõ /bat ds để xem danh sách hoặc /bat them <tên> <MAC>.';
          const r = await wol.send(mac);
          return r.ok ? '⚡ Đã gửi tín hiệu bật máy ' + mac + ' (Wake-on-LAN). Chờ 30-60 giây. Không có phản hồi nên em không biết chắc máy đã lên: máy cần bật WoL trong BIOS và nối dây mạng.' : '⚠️ ' + r.error;
        }
        case 'tuxa': {
          if (!remote) return '⚠️ Máy này chưa có điều khiển từ xa.';
          if (/^(dong|tat|ngat|stop)$/.test(noAccent(arg))) return await remote.remoteStop(() => desk.call({ cmd: 'close', app: 'rustdesk' }));
          return await remote.remoteStart(() => desk.call({ cmd: 'open', app: 'rustdesk' }));
        }
        case 'guilen': return links ? await links.uploadLink(ctx && ctx.chatId) : '⚠️ Máy này chưa có tính năng gửi tệp lớn.';
        case 'lenh': return remote ? await remote.runShell(arg) : '⚠️ Máy này chưa có điều khiển từ xa.';
        case 'lay': return remote ? remote.getFile(arg, links) : '⚠️ Máy này chưa có điều khiển từ xa.';
        case 'maytinh': return remote ? await remote.sysinfo() : '⚠️ Máy này chưa có điều khiển từ xa.';
        case 'go': {
          if (!arg) return 'Cách dùng: /go <chữ> - gõ chữ vào ô đang chọn trên màn hình máy (dùng /manhinh để xem trước).';
          const r = await desk.call({ cmd: 'type', text: arg });
          return r.ok ? await withShot('⌨️ Đã gõ ' + arg.length + ' ký tự.') : '⚠️ ' + r.error;
        }
        case 'phim': {
          if (!arg) return 'Cách dùng: /phim <phím>, ví dụ /phim Return, /phim ctrl+s, /phim alt+Tab, /phim ctrl+l.';
          const r = await desk.call({ cmd: 'key', key: arg });
          return r.ok ? await withShot('⌨️ Đã bấm ' + arg + '.') : '⚠️ ' + r.error;
        }
        case 'bam': {
          const m = arg.match(/^(\d{1,5})[\s,x]+(\d{1,5})(.*)$/i);
          if (!m) return 'Cách dùng: /bam <x> <y> [dup|phai], ví dụ /bam 640 360 hoặc /bam 640 360 dup. Toạ độ tính theo ảnh /manhinh (góc trên trái là 0 0).';
          const rest = noAccent(m[3] || '');
          const r = await desk.call({ cmd: 'click', x: Number(m[1]), y: Number(m[2]), button: /phai|right/.test(rest) ? 3 : 1, double: /dup|double|doi/.test(rest) });
          return r.ok ? await withShot('🖱️ Đã bấm (' + m[1] + ', ' + m[2] + ').') : '⚠️ ' + r.error;
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
