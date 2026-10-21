'use strict';
const { fmtTime } = require('./worker');

function helpText(profiles) {
  return 'AgentOS - nhắn việc bằng chữ, AI sẽ làm.\n' +
    '/claude, /codex, /gemini hoặc /deepseekapi <việc> - ép dùng một AI (khóa API hoặc tài khoản) (mặc định tự chọn, hết hạn mức thì tự chuyển)\n' +
    profiles.map((p) => '/' + p.name + ' <việc> - ' + (p.description || 'dùng bộ công cụ ' + p.name) + '\n').join('') +
    '/viec - xem 5 việc gần nhất\n' +
    '--- Lệnh nhanh (không qua AI, chỉ quản trị viên) ---\n' +
    '/manhinh - chụp màn hình máy gửi về đây · /cuaso - xem các cửa sổ đang mở\n' +
    '/mo <zalo|kiotviet|deepseek|chrome|rustdesk> · /dong <ứng dụng> · /khoamay · /khoimay co · /tatmay co\n' +
    '/deepseek <việc> - mở DeepSeek web trên máy + chép sẵn câu lệnh (anh bấm Ctrl+V và Gửi)\n' +
    '/doanhso [hôm nay|hôm qua|tuần|tháng] · /ton <sản phẩm> - KiotViet\n' +
    '/onedrive [ketnoi|dongbo|thumuc|ngat co] - OneDrive: AI đọc dữ liệu và lưu kết quả/ghi nhớ ở đó\n' +
    '/baocao [gio 21:30|tat|bat] - báo cáo doanh số, hàng sắp hết, ổ đĩa · /hen 08:00 <việc> - mỗi ngày giao việc cho AI · /hen xoa <số>\n' +
    '/capnhat [co|tudong bat|tudong tat] - cập nhật phần mềm AgentOS khi có bản mới (không cần boot lại)\n' +
    '/capnhat hedieuhanh [co] - cập nhật HỆ ĐIỀU HÀNH Debian (Linux, Chrome, LibreOffice...) lên bản mới nhất\n' +
    '/tailscale [ketnoi|ngat co] - đường vào dự phòng khi Telegram/mạng lỗi · /in <tệp trong OneDrive> [may <tên>] - in qua máy in của máy\n' +
    '🎙 Tin nhắn thoại: bot nghe và làm theo ("doanh số hôm nay", "tồn kho nồi chiên", "chụp màn hình"... chạy ngay; còn lại giao cho AI). Lệnh nguy hiểm (tắt máy, toàn quyền) chỉ gõ chữ mới làm được.\n' +
    '-----\n' +
    '/nhatky - nhật ký các lần AI xin dùng công cụ (cho phép/từ chối)\n' +
    '/trangthai - hàng đợi và tình trạng hạn mức\n' +
    '/huy - hủy việc đang chạy và các việc đang chờ\n' +
    '/toanquyen - bật chế độ TOÀN QUYỀN: AI tự làm một mạch, không hỏi xin phép, có sudo (chỉ quản trị viên)\n' +
    '/baove - quay về chế độ bảo vệ: AI hỏi trước khi ghi file/chạy lệnh (chỉ quản trị viên)\n' +
    '/moi - bắt đầu cuộc trò chuyện mới (quên ngữ cảnh cũ)\n' +
    '/id - xem ID Telegram của bạn';
}
const HELP = helpText([]);

const ICON = { queued: 'chờ', running: 'đang chạy', waiting: 'chờ hạn mức hồi', done: 'xong', error: 'lỗi', limit: 'hết hạn mức', cancelled: 'đã hủy', interrupted: 'bị ngắt' };

// Xử lý một tin nhắn. Trả về văn bản cần trả lời (hoặc null). Không gọi mạng trực tiếp -> dễ test.
// `profiles`: [{ name, description, adminOnly }] các bộ công cụ chọn bằng lệnh /<tên> (ví dụ /web).
// `isAdmin(uid)`: quản trị viên mới dùng được bộ adminOnly và duyệt lệnh/ghi file (mặc định: mọi người được phép).
// `approvals`: nhận lượt bấm nút duyệt.
function createBot({ db, worker, allowed, profiles, isAdmin, approvals, fullAccess, quick, voice }) {
  profiles = profiles || [];
  isAdmin = isAdmin || (() => true);
  const profileByName = new Map(profiles.map((p) => [p.name, p]));
  const help = helpText(profiles);

  function submit(chatId, prompt, pref, profile) {
    const id = db.addJob(chatId, prompt, pref, profile);
    const ahead = db.aheadOf(id);
    setImmediate(() => worker.wake());
    return ahead > 0 ? 'Đã nhận việc #' + id + ' (còn ' + ahead + ' việc trước đó).' : 'Đã nhận việc #' + id + ', đang làm...';
  }

  function handle(msg) {
    if (!msg || !msg.from || !msg.chat) return null;
    const text = String(msg.text || '').trim();
    const uid = String(msg.from.id);
    const chatId = String(msg.chat.id);

    // Người lạ: chỉ được hỏi ID của chính họ (để quản trị viên điền vào cấu hình). Còn lại im lặng.
    if (!allowed.has(uid)) {
      if (/^\/id(@\w+)?$/i.test(text)) return 'ID Telegram của bạn: ' + uid;
      return null;
    }
    // Chỉ nhận chat riêng với người được phép (không nhận trong nhóm).
    if (msg.chat.type && msg.chat.type !== 'private') return null;
    // Tin nhắn thoại / file âm thanh: nghe thành chữ rồi xử lý như chủ máy vừa gõ (trừ lệnh nguy hiểm: không có "/" nên không bao giờ thành /tatmay...)
    const media = msg.voice || msg.audio;
    if (!text && media && voice) {
      if (!isAdmin(uid)) return 'Tin nhắn thoại chỉ dành cho quản trị viên.';
      if (media.duration && media.duration > 180) return 'Tin nhắn thoại dài quá 3 phút, anh chia nhỏ giúp em.';
      return (async () => {
        const r = await voice.transcribe(media.file_id);
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

    const cmd = text.match(/^\/(\w+)(@\w+)?\s*([\s\S]*)$/);
    if (cmd) {
      const name = cmd[1].toLowerCase();
      if (worker.engineNames().includes(name)) {
        const prompt = cmd[3].trim();
        return prompt ? submit(chatId, prompt, name) : 'Cách dùng: /' + name + ' <việc cần làm>';
      }
      // Lệnh nhanh không qua AI (màn hình, mở/đóng ứng dụng, DeepSeek web, KiotViet): trả về Promise
      if (quick && quick.has(name)) {
        if (!isAdmin(uid)) return 'Lệnh /' + name + ' chỉ dành cho quản trị viên.';
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
        case 'moi':
          db.kvDelPrefix('session:' + chatId + ':');
          db.kvSet('ctxfrom:' + chatId, db.lastJobId(chatId));
          return 'Đã bắt đầu cuộc trò chuyện mới.';
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
          const rows = db.recentAudit(15);
          if (!rows.length) return 'Chưa có lần xin dùng công cụ nào.';
          const MARK = { allow: '✅', deny: '⛔' };
          const SRC = { auto: 'tự động', policy: 'bị chặn', user: 'bạn quyết', timeout: 'hết giờ', cancel: 'việc dừng', error: 'lỗi' };
          return rows.map((a) => {
            const d = new Date(a.ts), p = (n) => String(n).padStart(2, '0');
            return p(d.getHours()) + ':' + p(d.getMinutes()) + ' #' + a.job_id + ' ' + (MARK[a.decision] || '?') + ' ' + (SRC[a.source] || a.source) +
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
        case 'huy': {
          const queued = db.cancelQueued(chatId);
          const running = worker.cancelRunning(chatId);
          if (!queued && !running) return 'Không có việc nào để hủy.';
          return 'Đã hủy' + (running ? ' việc đang chạy' : '') + (queued ? (running ? ' và ' : ' ') + queued + ' việc đang chờ' : '') + '.';
        }
        default: return 'Lệnh không có. Gõ /help để xem danh sách.';
      }
    }
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
