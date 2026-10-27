'use strict';
const { fmtTime } = require('./worker');
const { createProjectCommands } = require('./projectCmd');

function helpText(profiles) {
  return 'AgentOS - nhắn việc bằng chữ, AI sẽ làm.\n' +
    '/claude, /codex, /gemini hoặc /deepseekapi <việc> - ép dùng một AI (khóa API hoặc tài khoản) (mặc định tự chọn, hết hạn mức thì tự chuyển)\n' +
    profiles.map((p) => '/' + p.name + ' <việc> - ' + (p.description || 'dùng bộ công cụ ' + p.name) + '\n').join('') +
    '/viec - xem 5 việc gần nhất\n' +
    '📷 /camera <tên> [câu hỏi] - chụp ảnh camera cửa hàng (có câu hỏi thì AI nhìn ảnh trả lời) · 🔌 /dien <tên> bat|tat|xem - bật/tắt ổ cắm, đèn thông minh\n' +
    '🖥️ /may - ĐỘI MÁY: xem/giao việc/cập nhật các máy AgentOS khác của cửa hàng (qua Tailscale) · /may <tên> <việc> · /may them <tên> <địa chỉ> <khóa>\n' +
    '🩺 /bacsi - nhờ AI phân tích các lỗi máy đang gặp và đề xuất cách sửa (máy cũng tự sửa lỗi quen thuộc như dịch vụ chết, ổ đầy, rồi báo)\n' +
    '🏛️ /hoidong <việc> - HỘI ĐỒNG AI: hai AI làm độc lập, AI thứ ba đối chiếu và kết luận (cho việc quan trọng, tốn gấp ~3 lần hạn mức)\n' +
    '📁 /duan - DỰ ÁN: mỗi dự án có thư mục tệp, chỉ dẫn, sổ tay, lịch sử riêng; mọi AI dùng chung dữ liệu dự án (Claude hết hạn mức thì Codex làm tiếp). /duan moi <tên> · /duan <tên> · /duan thoat · #<tên-dự-án> <việc>\n' +
    '--- Lệnh nhanh (không qua AI, chỉ quản trị viên) ---\n' +
    '/manhinh - chụp màn hình máy gửi về đây · /cuaso - xem các cửa sổ đang mở\n' +
    '🕹 ĐIỀU KHIỂN TỪ XA: /maytinh - tình trạng máy (CPU, RAM, ổ đĩa, nhiệt độ, dịch vụ) · /lenh <lệnh> - chạy lệnh dòng lệnh (có sudo, cần chế độ toàn quyền) · /lay <tệp> - lấy tệp từ máy gửi về đây\n' +
    '/go <chữ> · /phim <phím> · /bam <x> <y> [dup|phai] - gõ chữ, bấm phím, bấm chuột trên màn hình máy (sau mỗi thao tác bot tự chụp lại)\n' +
    '/guilen - tạo link để gửi tệp LỚN (tới 5 GB) từ điện thoại lên máy · /lay <tệp> - tệp quá 49 MB tự tạo link tải về · /tuxa - mở RustDesk, bot gửi ID + mật khẩu tạm vào đây để anh điều khiển trực tiếp từ xa (/tuxa dong để đóng)\n' +
    '/timchu <chữ> · /bamchu <chữ> - tìm/bấm đúng nút theo CHỮ trên màn hình (đọc chữ OCR, không cần đoán toạ độ) · /chuyen <tên cửa sổ> · /dan [chữ] - xem/chép bộ nhớ tạm của máy · /mokhoa · /doc [tệp] - đọc nội dung Word/Excel/PowerPoint/PDF (không ghi tệp thì đọc tệp anh vừa gửi) · /doi <pdf|docx|xlsx|pptx...> [tệp] - đổi định dạng · /thay <chữ cũ> | <chữ mới> - sửa chữ trong .docx/.pptx/.xlsx, gửi lại bản mới · /saoluu [nhãn|ds] - điểm khôi phục cấu hình · /bat <tên|MAC> - bật máy khác trong nhà (Wake-on-LAN)\n' +
    '/mo <zalo|kiotviet|deepseek|chrome|rustdesk> · /dong <ứng dụng> · /khoamay · /khoimay co · /tatmay co\n' +
    '/deepseek <việc> - mở DeepSeek web trên máy + chép sẵn câu lệnh (anh bấm Ctrl+V và Gửi)\n' +
    '/doanhso [hôm nay|hôm qua|tuần|tháng] · /ton <sản phẩm> - KiotViet\n' +
    '/onedrive [ketnoi|dongbo|thumuc|ngat co] - OneDrive: AI đọc dữ liệu và lưu kết quả/ghi nhớ ở đó\n' +
    '/baocao [gio 21:30|tat|bat] - báo cáo doanh số, hàng sắp hết, ổ đĩa · /hen 08:00 <việc> - mỗi ngày giao việc cho AI · /hen xoa <số>\n' +
    '🔔 /canhbao - cảnh báo CHỦ ĐỘNG khi doanh số tụt bất thường hoặc có hàng mới sắp hết (bot tự nhắn, không tốn hạn mức AI) · /canhbao kiemtra\n' +
    '📊 /chiphi [tuan|thang|homnay] - thống kê dùng AI theo AI và theo dự án · /chiphi tran <AI> <số việc/tháng> - đặt trần tháng (vượt thì dồn sang AI khác)\n' +
    '💾 /saoluudia [chay] - xem/chạy ngay SAO LƯU dữ liệu ra ổ USB/HDD ngoài (phòng ổ trong máy hỏng)\n' +
    '/capnhat [co|tudong bat|tudong tat] - cập nhật phần mềm AgentOS khi có bản mới (không cần boot lại)\n' +
    '/capnhat hedieuhanh [co] - cập nhật HỆ ĐIỀU HÀNH Debian (Linux, Chrome, LibreOffice...) lên bản mới nhất\n' +
    '/tailscale [ketnoi|ngat co] - đường vào dự phòng khi Telegram/mạng lỗi · /in <tệp trong OneDrive> [may <tên>] - in qua máy in của máy\n' +
    '🎙 Tin nhắn thoại: bot nghe và làm theo ("doanh số hôm nay", "tồn kho nồi chiên", "chụp màn hình"... chạy ngay; còn lại giao cho AI). Lệnh nguy hiểm (tắt máy, toàn quyền) chỉ gõ chữ mới làm được.\n' +
    '-----\n' +
    '/nhatky [tuan] - nhật ký các lần AI xin dùng công cụ và các lệnh điều khiển máy anh đã gõ; /nhatky tuan = báo cáo 7 ngày (ai nhắn, AI làm gì, bị từ chối gì); xem chi tiết trên Cài đặt → Nhật ký\n' +
    '/tuchan [nhanh|ai] - tự chẩn đoán cả máy (bot, AI, đăng nhập, ổ đĩa, màn hình, mạng...) và báo chỗ nào hỏng · /log [số dòng] - xem nhật ký bộ điều phối (đã che khóa)\n' +
    '/hangrao [bat|tat] - hàng rào cho AI toàn quyền (cấm đọc khóa, hỏi trước khi gửi ra ngoài/dính tiền)\n' +
    '/nen <việc> - giao việc NỀN chạy song song (không chờ hàng đợi), xong báo riêng · /tieptuc [số việc] - làm tiếp việc bị ngắt/lỗi · /sukien - AI tự làm khi có hóa đơn mới, hàng sắp hết, hoặc webhook\n' +
    '/vaitro - phân vai cho nhân viên/kế toán (chỉ chủ máy); họ nhắn bot được nhưng việc luôn ở chế độ bảo vệ\n' +
    '/dung - NÚT DỪNG KHẨN CẤP: hủy mọi việc và ngắt điều khiển từ xa ngay\n' +
    '/trangthai - hàng đợi và tình trạng hạn mức\n' +
    '/huy - hủy việc đang chạy và các việc đang chờ\n' +
    '/toanquyen - bật chế độ TOÀN QUYỀN: AI tự làm một mạch, không hỏi xin phép, có sudo (chỉ quản trị viên)\n' +
    '/baove - quay về chế độ bảo vệ: AI hỏi trước khi ghi file/chạy lệnh (chỉ quản trị viên)\n' +
    '/moi - bắt đầu cuộc trò chuyện mới (quên ngữ cảnh cũ, GIỮ ghi nhớ lâu dài)\n' +
    '/nho <điều cần nhớ> · /quen <từ khóa> · /trinho - ghi nhớ LÂU DÀI dùng chung cho mọi AI (Claude/Codex/Gemini/DeepSeek)\n' +
    '📷 Gửi ảnh, nhiều ảnh (album), video hoặc tài liệu kèm chú thích: bot tải về, trích khung hình + lời nói trong video rồi giao AI xem (tệp tối đa 20 MB)\n' +
    '/id - xem ID Telegram của bạn';
}
const HELP = helpText([]);

const ICON = { queued: 'chờ', running: 'đang chạy', waiting: 'chờ hạn mức hồi', done: 'xong', error: 'lỗi', limit: 'hết hạn mức', cancelled: 'đã hủy', interrupted: 'bị ngắt' };

// Xử lý một tin nhắn. Trả về văn bản cần trả lời (hoặc null). Không gọi mạng trực tiếp -> dễ test.
// `profiles`: [{ name, description, adminOnly }] các bộ công cụ chọn bằng lệnh /<tên> (ví dụ /web).
// `isAdmin(uid)`: quản trị viên mới dùng được bộ adminOnly và duyệt lệnh/ghi file (mặc định: mọi người được phép).
// `approvals`: nhận lượt bấm nút duyệt.
// Lệnh điều khiển máy ghi vào /nhatky (lệnh /go chỉ ghi số ký tự vì có thể là mật khẩu)
const AUDITED = new Set(['lenh', 'lay', 'go', 'phim', 'bam', 'bamchu', 'chuyen', 'dan', 'tuxa', 'guilen', 'mo', 'dong', 'khoamay', 'khoimay', 'tatmay', 'mokhoa', 'saoluu', 'bat', 'doi', 'thay', 'hangrao', 'tuchan', 'log', 'nen', 'tieptuc', 'saoluudia', 'chiphi', 'canhbao', 'may', 'camera', 'dien']);
function createBot({ db, worker, allowed, profiles, isAdmin, approvals, fullAccess, quick, voice, media, memory, send, quietAck, roles, projects, auditlog, hoidap, diagnose, fleet, iot }) {
  const albums = new Map();                       // media_group_id -> { msgs, timer }: gom các ảnh/video của một album thành MỘT việc
  const ATT_KEYS = { photo: undefined, video: undefined, video_note: undefined, animation: undefined, document: undefined, caption: undefined, media_group_id: undefined };
  profiles = profiles || [];
  isAdmin = isAdmin || (() => true);
  const profileByName = new Map(profiles.map((p) => [p.name, p]));
  const help = helpText(profiles);
  const pcmd = projects ? createProjectCommands({ db, projects, isAdmin, memory, engines: () => worker.engineNames() }) : null;

  // project: undefined = dự án đang chọn của cuộc trò chuyện; null = chế độ chung; chuỗi = mã dự án (cú pháp #tên)
  function submit(chatId, prompt, pref, profile, project, council) {
    const cur = pcmd ? pcmd.current(chatId) : null;
    // Chứng từ: chỉ Claude ghi được sổ qua cổng duyệt (Codex/Gemini ở chế độ chỉ đọc) nên ưu tiên Claude
    if (!pref && /^\[CHỨNG TỪ/.test(prompt) && worker.engineNames().includes('claude')) pref = 'claude';
    const id = db.addJob(chatId, prompt, pref, profile, 'main', project === undefined ? (cur ? cur.id : null) : project, council);
    const ahead = db.aheadOf(id);
    setImmediate(() => worker.wake());
    if (quietAck) return ahead > 0 ? '⏳ Đã xếp hàng (còn ' + ahead + ' việc trước đó). Gõ /huy để hủy.' : null;        // việc làm ngay: bot hiện "đang gõ" + tin trạng thái thay cho tin báo nhận
    return ahead > 0 ? 'Đã nhận việc #' + id + ' (còn ' + ahead + ' việc trước đó).' : 'Đã nhận việc #' + id + ', đang làm...';
  }

  function handle(msg) {
    if (!msg || !msg.from || !msg.chat) return null;
    const text = String(msg.text || msg.caption || '').trim();
    const uid = String(msg.from.id);
    const chatId = String(msg.chat.id);

    // Người lạ: chỉ được hỏi ID của chính họ (để quản trị viên điền vào cấu hình). Còn lại im lặng.
    if (!allowed.has(uid)) {
      if (/^\/id(@\w+)?$/i.test(text)) return 'ID Telegram của bạn: ' + uid;
      return null;
    }
    // Chỉ nhận chat riêng với người được phép (không nhận trong nhóm).
    if (msg.chat.type && msg.chat.type !== 'private') return null;
    // Ảnh, video, album, tài liệu: tải về, trích khung hình + lời nói (video), gắn đường dẫn vào câu lệnh rồi xử lý như tin chữ (chú thích = yêu cầu).
    if (media && media.listAttachments(msg).length) {
      const finish = async (msgs, last) => {
        const p0 = await media.prepare(msgs);
        const p = pcmd ? pcmd.adoptFiles(chatId, uid, p0) : p0;
        const cap = msgs.map((m) => String(m.caption || m.text || '').trim()).filter(Boolean)[0] || '';
        if (!p.block) return p.errors.length ? '⚠️ ' + p.errors.join('\n') : 'Không đọc được tệp đính kèm.';
        const ct = pcmd ? pcmd.chungtuAsk(chatId, uid, cap, p.files.map((f) => f.path)) : null;
        const ask = ct || cap || 'Anh gửi tệp đính kèm. Hãy xem và mô tả ngắn gọn những gì thấy, rồi hỏi lại nếu chưa rõ anh cần làm gì.';
        const reply = await handle(Object.assign({}, last, ATT_KEYS, { text: ask + '\n\n' + p.block }));
        const warn = p.errors.length ? '⚠️ ' + p.errors.join('\n') + '\n' : '';
        if (reply && typeof reply === 'object') return Object.assign({}, reply, { text: warn + (reply.text || '') });
        return warn + (reply || '');
      };
      if (msg.media_group_id && send) {
        const g = albums.get(msg.media_group_id) || { msgs: [], timer: null };
        g.msgs.push(msg); albums.set(msg.media_group_id, g);
        clearTimeout(g.timer);
        g.timer = setTimeout(() => {
          albums.delete(msg.media_group_id);
          finish(g.msgs, g.msgs[g.msgs.length - 1]).then((r) => (r ? send(chatId, r) : null)).catch((e) => send(chatId, '⚠️ Không xử lý được album: ' + e.message).catch(() => {}));
        }, 1800);
        return null;
      }
      return finish([msg], msg);
    }
    // Tin nhắn thoại / file âm thanh: nghe thành chữ rồi xử lý như chủ máy vừa gõ (trừ lệnh nguy hiểm: không có "/" nên không bao giờ thành /tatmay...)
    const vmedia = msg.voice || msg.audio;
    if (!text && vmedia && voice) {
      if (!isAdmin(uid)) return 'Tin nhắn thoại chỉ dành cho quản trị viên.';
      if (vmedia.duration && vmedia.duration > 180) return 'Tin nhắn thoại dài quá 3 phút, anh chia nhỏ giúp em.';
      return (async () => {
        const r = await voice.transcribe(vmedia.file_id);
        if (!r.ok) return '🎙 ' + r.error;
        const said = r.text.replace(/^[\/\s]+/, '');                         // chữ nghe được không bao giờ thành lệnh "/..." tự do
        const cmdText = voice.spoken(said);
        const reply = await handle(Object.assign({}, msg, { voice: undefined, audio: undefined, text: cmdText || said }));
        const head = '🎙 Em nghe được: "' + r.text + '"' + (cmdText ? '  → ' + cmdText : '');
        if (reply && typeof reply === 'object') return Object.assign({}, reply, { text: head + (reply.text ? '\n' + reply.text : '') });
        return head + (reply ? '\n' + reply : '');
      })();
    }
    if (!text) return 'Hiện chỉ nhận tin nhắn chữ' + (voice ? ' và tin nhắn thoại' : '') + '.';

    // Địa chỉ đăng nhập OneDrive dán thẳng (không có lệnh): chuyển cho lệnh /onedrive
    const pending = quick && quick.match && quick.match(text);
    if (pending) return isAdmin(uid) ? quick.run(pending.name, pending.arg) : 'Lệnh /' + pending.name + ' chỉ dành cho quản trị viên.';

    // "#tên-dự-án câu hỏi": hỏi một lần trong dự án đó (không đổi dự án đang chọn)
    if (projects) {
      const t = projects.parseTag(text);
      if (t) {
        if (roles && !roles.canAsk(uid)) return 'Vai của bạn (' + roles.label(uid) + ') chỉ xem được báo cáo, chưa nhắn việc cho AI được.';
        if (!projects.canUse(uid, t.project, isAdmin)) return 'Bạn chưa được gán dự án "' + t.project.name + '". Nhờ chủ máy gõ /duan giao ' + uid + '.';
        return submit(chatId, t.text, null, null, t.project.id);
      }
    }

    const cmd = text.match(/^\/(\w+)(@\w+)?\s*([\s\S]*)$/);
    if (cmd) {
      const name = cmd[1].toLowerCase();
      if (worker.engineNames().includes(name)) {
        if (roles && !roles.canAsk(uid)) return 'Vai của bạn (' + roles.label(uid) + ') chỉ xem được báo cáo, chưa nhắn việc cho AI được.';
        const prompt = cmd[3].trim();
        return prompt ? submit(chatId, prompt, name) : 'Cách dùng: /' + name + ' <việc cần làm>';
      }
      // Lệnh nhanh không qua AI (màn hình, mở/đóng ứng dụng, DeepSeek web, KiotViet): trả về Promise
      if (quick && quick.has(name)) {
        if (!isAdmin(uid) && !(roles && roles.canQuick(uid, name))) return 'Lệnh /' + name + ' chỉ dành cho quản trị viên' + (roles ? ' (vai của bạn: ' + roles.label(uid) + ')' : '') + '.';
        if (db.addAudit && AUDITED.has(name)) { try { db.addAudit({ tool: '/' + name, cls: 'remote', decision: 'allow', source: 'user', summary: name === 'go' ? '(' + String(cmd[3] || '').length + ' ký tự)' : String(cmd[3] || '').replace(/(token|pass\w*|mat\s?khau|secret|key)\S*\s*[=:]?\s*\S+/gi, '$1 ***') }); } catch (e) { /* nhật ký lỗi không chặn lệnh */ } }
        return quick.run(name, cmd[3], { chatId, uid });
      }
      if (profileByName.has(name)) {
        if (profileByName.get(name).adminOnly && !isAdmin(uid)) return 'Bộ công cụ /' + name + ' chỉ dành cho quản trị viên.';
        const prompt = cmd[3].trim();
        return prompt ? submit(chatId, prompt, null, name) : 'Cách dùng: /' + name + ' <việc cần làm>';
      }
      switch (name) {
        case 'claude': case 'codex': case 'gemini': case 'deepseekapi': return 'Engine ' + name + ' chưa được bật trên máy này.';
        case 'start': case 'help': return help;
        case 'id': return 'ID Telegram của bạn: ' + uid;
        case 'camera': {                                      // chụp ảnh camera trong cửa hàng; có câu hỏi thì AI nhìn ảnh trả lời
          if (!isAdmin(uid)) return 'Chỉ chủ máy dùng được /camera.';
          if (!iot) return 'Máy này chưa có điều khiển thiết bị.';
          const L = iot.list().cameras, a = String(cmd[3] || '').trim();
          if (!a) return L.length ? '📷 Camera: ' + L.map((c) => c.name).join(', ') + '\nDùng: /camera <tên> (chụp ảnh) · /camera <tên> <câu hỏi> (AI nhìn ảnh trả lời, ví dụ có khách không)' : 'Chưa có camera nào. Thêm ở Cài đặt → Thiết bị.';
          const cam = L.slice().sort((x, y) => y.name.length - x.name.length).find((c) => a.toLowerCase() === c.name.toLowerCase() || a.toLowerCase().startsWith(c.name.toLowerCase() + ' '));
          if (!cam) return 'Không có camera trong "' + a.slice(0, 30) + '". Camera có: ' + L.map((c) => c.name).join(', ');
          const q = a.slice(cam.name.length).trim();
          return iot.snapshot(cam.name).then((s) => {
            const hm = new Date(s.at + 7 * 3600 * 1000).toISOString().slice(11, 16);
            if (!q) return { text: '📷 ' + cam.name + ' lúc ' + hm, files: [{ path: s.file, name: 'camera.jpg', kind: 'photo', temp: false }] };
            const ack = submit(chatId, '[Camera "' + cam.name + '" lúc ' + hm + '] ' + q + '\n\n[Tệp đính kèm — đã lưu trên máy. Hãy xem ảnh bằng công cụ đọc ảnh rồi trả lời dựa trên ảnh]\n- Ảnh: ' + s.file, null, null, null);
            return { text: '📷 ' + cam.name + ' lúc ' + hm + (ack ? '\n' + ack : ' — đang nhờ AI xem ảnh...'), files: [{ path: s.file, name: 'camera.jpg', kind: 'photo', temp: false }] };
          }, (e) => '⚠️ ' + e.message);
        }
        case 'may': {                                         // ĐỘI MÁY: giao việc / xem tình trạng / cập nhật máy AgentOS khác (qua Tailscale)
          if (!isAdmin(uid)) return 'Chỉ chủ máy dùng được /may.';
          if (!fleet) return 'Máy này chưa có đội máy.';
          const a = String(cmd[3] || '').trim(), m = a.match(/^(\S+)\s*([\s\S]*)$/), sub = m ? m[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd') : '';
          if (!a) {
            return fleet.statusAll().then((l) => (l.length ? '🖥️ Đội máy:\n' + l.map((x) => (x.online ? '🟢 ' + x.name + ' · bản ' + (x.version || '?') + ' · ' + (x.queued || 0) + ' việc chờ' + (x.running ? ', đang làm #' + x.running : '') + (x.diskFreeMb != null ? ' · ổ trống ' + Math.round(x.diskFreeMb / 1024) + ' GB' : '') : '🔴 ' + x.name + ' · không liên lạc được (' + x.error + ')')).join('\n') : 'Chưa có máy con nào.') + '\n\nThêm: /may them <tên> <địa chỉ> <khóa> · Giao việc: /may <tên> <việc> · Cập nhật: /may capnhat <tên> · Xóa: /may xoa <tên>');
          }
          if (sub === 'them') { const p = m[2].trim().split(/\s+/); if (p.length < 3) return 'Cách dùng: /may them <tên> <địa chỉ http://100.x.x.x:8433> <khóa>. Địa chỉ và khóa xem ở Cài đặt của máy con → Đội máy.'; try { fleet.addMachine({ name: p[0], url: p[1], key: p[2] }); } catch (e) { return '⚠️ ' + e.message; } return '✅ Đã thêm máy "' + p[0] + '". Gõ /may để xem có liên lạc được không. (Khóa vừa gõ nằm trong lịch sử chat này: nên xóa tin nhắn đó.)'; }
          if (sub === 'xoa') return fleet.removeMachine(m[2].trim()) ? '🗑️ Đã xóa máy "' + m[2].trim() + '".' : 'Không có máy "' + m[2].trim() + '".';
          if (sub === 'capnhat') return fleet.updateMachine(m[2].trim()).then((r) => '⬆️ ' + m[2].trim() + ': ' + r.text, (e) => '⚠️ ' + e.message);
          const name = m[1], task = m[2].trim();
          if (!task) return 'Cách dùng: /may ' + name + ' <việc cần làm>';
          return fleet.sendTask(name, task).then((r) => {
            const sendBack = (t) => (send ? send(chatId, t) : Promise.resolve()).catch(() => {});
            (async () => {                                                  // chờ máy con làm xong (tối đa 15 phút) rồi gửi kết quả về đây
              for (let i = 0; i < 180; i++) {
                await new Promise((res) => setTimeout(res, 5000));
                let j; try { j = await fleet.jobResult(name, r.jobId); } catch (e) { continue; }
                if (['done', 'error', 'cancelled', 'interrupted', 'limit'].includes(j.status)) return sendBack('🖥️ ' + name + ' (việc #' + r.jobId + ' · ' + j.status + (j.engine ? ' · ' + j.engine : '') + '):\n' + (j.result || j.error || '(không có nội dung)'));
              }
              sendBack('🖥️ ' + name + ': việc #' + r.jobId + ' chưa xong sau 15 phút (vẫn có thể đang làm; hỏi lại bằng /may).');
            })();
            return '📤 Đã giao cho "' + name + '" (việc #' + r.jobId + '). Xong em báo. Việc chạy chế độ bảo vệ trên máy đó; nếu cần duyệt, nút duyệt hiện ở Telegram của máy đó.';
          }, (e) => '⚠️ Không giao được cho "' + name + '": ' + e.message);
        }
        case 'bacsi': {                                      // nhờ AI chẩn đoán máy (chỉ đọc): tự chẩn đoán đầy đủ rồi giao AI giải thích nguyên nhân + đề xuất cách sửa
          if (!isAdmin(uid)) return 'Chỉ chủ máy dùng được /bacsi.';
          if (!diagnose) return 'Máy này chưa có bác sĩ máy.';
          return diagnose().then((d) => {
            if (!d.bad) return '🩺 Tự chẩn đoán: mọi thứ ổn, không có gì cần AI xem.\n' + d.report;
            const ack = submit(chatId, d.prompt, null, null, null);
            return '🩺 ' + d.bad + ' mục có vấn đề. Em đã nhờ AI phân tích nguyên nhân và đề xuất cách sửa (AI không tự sửa; lệnh cần quyền sẽ hỏi anh duyệt).' + (ack ? '\n' + ack : '');
          }, (e) => '⚠️ Không chẩn đoán được: ' + e.message);
        }
        case 'hoidong': {                                    // HỘI ĐỒNG AI: hai AI làm độc lập, AI thứ ba đối chiếu
          if (roles && !roles.canAsk(uid)) return 'Vai của bạn chỉ xem được báo cáo.';
          const prompt = String(cmd[3] || '').trim();
          if (!prompt) return 'Cách dùng: /hoidong <việc quan trọng>. Hai AI làm ĐỘC LẬP rồi AI thứ ba đối chiếu, chỉ ra chỗ khác nhau và kết luận. Tốn gấp khoảng 3 lần hạn mức nên chỉ dùng cho việc quan trọng (soạn hợp đồng, quyết định giá, số liệu thuế...).';
          if (worker.engineNames().length < 2) return 'Hội đồng cần bật ít nhất 2 AI (Cài đặt → AI và khóa API).';
          return submit(chatId, prompt, null, null, undefined, true) || '🏛️ Đã giao cho hội đồng AI (làm lâu hơn bình thường).';
        }
        case 'duan': case 'project': return pcmd ? pcmd.run(chatId, uid, cmd[3]) : 'Máy này chưa hỗ trợ dự án.';
        case 'moi': {
          const cur = pcmd ? pcmd.current(chatId, uid) : null;
          const scope = chatId + (cur ? '#' + cur.id : '');            // /moi trong dự án chỉ làm mới cuộc trò chuyện CỦA dự án đó
          db.kvDelPrefix('session:' + scope + ':');
          db.kvSet('ctxfrom:' + scope, db.lastJobId(scope));
          if (memory) memory.resetChat(scope);                  // xóa tóm tắt cuộn; ghi nhớ lâu dài (GHI-NHO.md) vẫn giữ, xóa bằng /quen
          return cur ? 'Đã bắt đầu cuộc trò chuyện mới trong dự án "' + cur.name + '" (chỉ dẫn và sổ tay dự án vẫn giữ).' : 'Đã bắt đầu cuộc trò chuyện mới.';
        }
        case 'trangthai': {
          const cur = worker.currentJobId();
          const eng = worker.engineStatus().map((e) => e.label + ': ' + (e.until ? 'hết hạn mức, hồi khoảng ' + fmtTime(e.until) : 'sẵn sàng')).join('\n');
          return (fullAccess ? 'Chế độ: ' + (fullAccess.get() ? '⚡ TOÀN QUYỀN (không hỏi, có sudo)' : '🛡️ bảo vệ (có hỏi duyệt)') + '\n' : '') +
            'Đang chạy: ' + (cur ? '#' + cur : 'không có') + '\nĐang chờ: ' + db.queuedCount() +
            ' việc' + (db.waitingCount() ? ' (trong đó ' + db.waitingCount() + ' chờ hạn mức hồi)' : '') + '\n' + eng;
        }
        case 'viec': {
          const rows = db.recentJobs(chatId, 5);
          if (!rows.length) return 'Chưa có việc nào.';
          return rows.map((j) => '#' + j.id + ' [' + (ICON[j.status] || j.status) + (j.engine ? ', ' + j.engine : '') + (j.profile ? ', /' + j.profile : '') + '] ' + j.prompt.slice(0, 60).replace(/\s+/g, ' ')).join('\n');
        }
        case 'nhatky': {
          if (auditlog && /^(tuan|week|7)$/.test(String(cmd[3] || '').trim().toLowerCase())) return isAdmin(uid) ? auditlog.weekText(7) : 'Chỉ chủ máy xem được báo cáo tuần.';
          const rows = db.recentAudit(15);
          if (!rows.length) return 'Chưa có lần xin dùng công cụ nào.';
          const MARK = { allow: '✅', deny: '⛔' };
          const SRC = { auto: 'tự động', policy: 'bị chặn', user: 'bạn quyết', timeout: 'hết giờ', cancel: 'việc dừng', error: 'lỗi' };
          return rows.map((a) => {
            const d = new Date(a.ts), p = (n) => String(n).padStart(2, '0');
            return p(d.getHours()) + ':' + p(d.getMinutes()) + ' ' + (a.job_id == null ? 'lệnh' : '#' + a.job_id) + ' ' + (MARK[a.decision] || '?') + ' ' + (SRC[a.source] || a.source) +
              ' · ' + a.tool + ': ' + String(a.summary || '').replace(/\s+/g, ' ').slice(0, 70);
          }).join('\n');
        }
        case 'toanquyen': case 'baove': {
          if (!fullAccess) return 'Máy này chưa hỗ trợ chế độ toàn quyền.';
          if (!isAdmin(uid)) return 'Chỉ quản trị viên được đổi chế độ.';
          const on = name === 'toanquyen';
          fullAccess.set(on);
          return on
            ? '⚡ ĐÃ BẬT chế độ TOÀN QUYỀN. AI tự làm một mạch, không hỏi xin phép, được dùng sudo trên máy này. Gõ /baove để quay về chế độ có hỏi.'
            : '🛡️ ĐÃ BẬT chế độ bảo vệ: AI hỏi bạn trước khi ghi file hoặc chạy lệnh, chạy trong hộp cô lập. Gõ /toanquyen để bật lại toàn quyền.';
        }
        case 'nen': {                                       // việc nền: chạy SONG SONG với hàng đợi chính
          if (roles && !roles.canAsk(uid)) return 'Vai của bạn chỉ xem được báo cáo.';
          const prompt = String(cmd[3] || '').trim();
          if (!prompt) return 'Cách dùng: /nen <việc>. Việc nền chạy song song với việc đang làm (không chờ hàng đợi), xong thì báo riêng. Không dùng chung phiên trò chuyện, nên nhờ rõ ràng đủ ý.';
          const curP = pcmd ? pcmd.current(chatId, uid) : null;
          const id = db.addJob(chatId, prompt, null, null, 'bg', curP ? curP.id : null);
          setImmediate(() => worker.wake());
          return '🧵 Đã giao việc nền #' + id + ' (chạy song song, xong em báo). Gõ /huy để hủy.';
        }
        case 'tieptuc': {                                    // làm tiếp việc bị ngắt giữa chừng (mất điện, khởi động lại) hoặc bị lỗi
          if (roles && !roles.canAsk(uid)) return 'Vai của bạn chỉ xem được báo cáo.';
          const want = Number(String(cmd[3] || '').replace(/\D/g, '')) || 0;
          const rows = db.recentJobs(chatId, 30);
          const j = want ? rows.find((r) => r.id === want) : rows.find((r) => ['interrupted', 'error', 'cancelled'].includes(r.status));
          if (!j) return want ? 'Không thấy việc #' + want + ' của anh (chỉ xem được 30 việc gần nhất).' : 'Không có việc nào bị ngắt/lỗi gần đây. Gõ /viec để xem.';
          if (!['interrupted', 'error', 'cancelled'].includes(j.status)) return 'Việc #' + j.id + ' đang ở trạng thái "' + (ICON[j.status] || j.status) + '", không cần làm tiếp.';
          const p = 'Tiếp tục việc #' + j.id + ' (trước đó bị ' + (j.status === 'interrupted' ? 'ngắt giữa chừng do máy khởi động lại' : j.status === 'error' ? 'lỗi' : 'hủy') + '). HÃY KIỂM TRA TRẠNG THÁI HIỆN TẠI (tệp đã tạo, việc đã làm) trước, chỉ làm phần CÒN DỞ, đừng lặp lại việc đã xong hay làm hai lần.\nYêu cầu gốc:\n' + j.prompt;
          return submit(chatId, p, j.engine_pref || null, j.profile || null) || '▶️ Đang làm tiếp việc #' + j.id + '...';
        }
        case 'vaitro': {                                  // phân vai: chỉ chủ máy
          if (!roles) return 'Máy này chưa có tính năng phân vai.';
          if (!isAdmin(uid)) return 'Chỉ chủ máy được phân vai.';
          const w = String(cmd[3] || '').trim().split(/\s+/).filter(Boolean);
          const sub = (w[0] || '').toLowerCase();
          if (sub === 'dat' || sub === 'them') { const r = roles.set(w[1], w[2]); return r.ok ? '✅ Đã đặt ' + w[1] + ' = ' + roles.ROLES[w[2].toLowerCase()].label + '. Người đó nhắn bot được ngay; việc của họ luôn chạy chế độ bảo vệ (không bao giờ toàn quyền).' : '⚠️ ' + r.error; }
          if (sub === 'xoa') { const r = roles.remove(w[1]); return r.ok ? (r.kept ? 'ID này nằm trong cấu hình nên vẫn được phép (đã đưa về vai Nhân viên).' : '🗑️ Đã gỡ ' + w[1] + (r.had ? '.' : ' (chưa từng có).')) : '⚠️ ' + r.error; }
          return '👥 Người dùng:\n' + roles.list().map((r) => '• ' + r.uid + ' — ' + r.label).join('\n') + '\n\nThêm/đổi: /vaitro dat <ID> <' + Object.keys(roles.ROLES).join('|') + '> (người đó gõ /id để biết ID)\nGỡ: /vaitro xoa <ID>\nXem = chỉ báo cáo · Nhân viên = báo cáo + đọc tệp + hỏi AI (chỉ đọc) · Kế toán = thêm sửa tệp Word/Excel.';
        }
        case 'dung': {                                   // NÚT DỪNG KHẨN CẤP: hủy mọi việc, ngắt điều khiển từ xa
          const queued = db.cancelQueued(chatId), running = worker.cancelRunning(chatId);
          const base = '🛑 DỪNG: ' + (running ? 'đã hủy việc đang chạy' : 'không có việc đang chạy') + (queued ? ', hủy ' + queued + ' việc đang chờ' : '') + '.';
          if (!(quick && isAdmin(uid))) return base;
          return quick.run('tuxa', 'dong').then((r) => base + '\n' + (typeof r === 'string' ? r : r.text), (e) => base + '\n⚠️ Không đóng được điều khiển từ xa: ' + e.message);
        }
        case 'huy': {
          const queued = db.cancelQueued(chatId);
          const running = worker.cancelRunning(chatId);
          if (!queued && !running) return 'Không có việc nào để hủy.';
          return 'Đã hủy' + (running ? ' việc đang chạy' : '') + (queued ? (running ? ' và ' : ' ') + queued + ' việc đang chờ' : '') + '.';
        }
        default: return 'Lệnh không có. Gõ /help để xem danh sách.';
      }
    }
    // Vai nhân viên bán hàng: tin nhắn thường = câu hỏi hỏi đáp (tra KiotViet rồi AI trả lời chỉ đọc)
    if (roles && roles.hoidapOnly && roles.hoidapOnly(uid)) {
      if (!hoidap) return 'Máy này chưa bật hỏi đáp bán hàng.';
      return hoidap.ask(chatId, text).then((r) => {
        setImmediate(() => worker.wake());
        const ahead = db.aheadOf(r.jobId);
        return quietAck ? (ahead > 0 ? '⏳ Đã xếp hàng (còn ' + ahead + ' việc trước đó).' : null) : 'Đang tra giúp bạn...';
      }, (e) => '⚠️ Chưa tra được: ' + e.message);
    }
    if (roles && !roles.canAsk(uid)) return 'Vai của bạn (' + roles.label(uid) + ') chỉ xem được báo cáo: gõ /doanhso hoặc /ton <sản phẩm>.';
    return submit(chatId, text, null);
  }
  // Lượt bấm nút "Cho phép / Từ chối". Trả văn bản hiện lại cho người bấm (hoặc null nếu không phải việc của mình).
  async function handleCallback(cq) {
    if (!cq || !cq.from || !approvals) return null;
    if (!allowed.has(String(cq.from.id))) return null;           // người lạ bấm nút: bỏ qua
    if (!/^ap:/.test(String(cq.data || ''))) return null;
    const r = await approvals.answer(cq.data, cq.from.id);
    return r.text;
  }

  return { handle, handleCallback };
}

module.exports = { createBot, HELP, helpText };
