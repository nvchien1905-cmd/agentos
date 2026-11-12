'use strict';
// /daily (hoặc /agent): quản lý các AGENT = bot Telegram phụ chạy độc lập (xem agents.js, agentctl.js). Chỉ chủ máy dùng được.
//   /daily                              danh sách + nút Dừng/Chạy/Khởi động lại/Nhật ký/Xóa
//   /daily them <token> [tên]           thêm agent từ token @BotFather (tin chứa token được xóa ngay)
//   /daily dung|chay|khoidong <agent>   tạm dừng / chạy lại / khởi động lại
//   /daily nhatky <agent> [số dòng]     xem nhật ký
//   /daily gioihan <agent> <RAM MB> [CPU %]   ví dụ: /daily gioihan a1 2048 150
//   /daily quyen <agent> [khóa giá_trị]      xem/đổi quyền hạn, chế độ (toàn quyền, hộp cô lập, công cụ, thời gian...)
//   /daily chu <agent> <ID,ID,...>      ai được nhắn cho agent này
//   /daily ten <agent> <tên mới>
//   /daily xoa <agent>                  xóa (có hỏi lại; dữ liệu giữ lại trong thư mục lưu trữ)
const { LIMITS, SETTINGS } = require('./agentctl');

const noAcc = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
const esc = (s) => String(s == null ? '' : s);

const HELP = '🤖 Bot thường = bot Telegram riêng, mỗi cái làm việc ĐỘC LẬP (tài khoản, dữ liệu, bộ nhớ, giới hạn RAM/CPU riêng), anh quản lý ở đây.\n\n' +
  '➕ Thêm: tạo bot mới ở @BotFather (/newbot), chép token rồi gõ:\n/daily them <token> [tên agent]\n(bot tự xóa tin có token để khỏi lộ)\n\n' +
  '📨 Giao việc: /giao <bot> <việc> (hoặc nhắn "giao cho bot Bán hàng làm: …"); bot làm xong sẽ báo lại ở đây.\n\n' +
  'Lệnh khác: /daily dung|chay|khoidong <agent> · /daily nhatky <agent> · /daily gioihan <agent> <RAM MB> [CPU %] · /daily quyen <agent> [khóa giá_trị] · /daily chu <agent> <ID,ID> · /daily ten <agent> <tên> · /daily xoa <agent>';

function createAgentsUi(o) {
  const { agents, isAdmin, send, deleteMessage, mail } = o;

  function line(a) {
    const s = a.status || {};
    const dot = s.missing ? '⚪ mất dịch vụ' : s.active ? '🟢 đang chạy' : (s.state === 'inactive' ? '⏸ đã dừng' : s.state === 'failed' ? '🔴 lỗi' : '🟡 ' + (s.state || '?'));
    return a.id + ' · ' + esc(a.name) + (a.bot && a.bot.username ? ' · @' + a.bot.username : '') + '\n    ' + dot + (s.memMb != null ? ' · RAM ' + s.memMb + '/' + a.ramMb + ' MB' : ' · tối đa ' + a.ramMb + ' MB') + ' · CPU ≤' + a.cpuPct + '%' + (s.restarts ? ' · tự khởi động lại ' + s.restarts + ' lần' : '');
  }

  async function card() {
    const list = await agents.list();
    if (!list.length) return { text: HELP, buttons: [] };
    const rows = list.map((a) => [
      a.status.active ? { text: '⏸ Dừng ' + a.id, data: 'ag:stop:' + a.id } : { text: '▶️ Chạy ' + a.id, data: 'ag:start:' + a.id },
      { text: '🔄 ' + a.id, data: 'ag:restart:' + a.id }, { text: '📜 ' + a.id, data: 'ag:logs:' + a.id }, { text: '🗑 ' + a.id, data: 'ag:del:' + a.id },
    ]);
    return { text: '🤖 Agent (' + list.length + ')\n\n' + list.map(line).join('\n\n') + '\n\nThêm agent mới: /daily them <token>. Nút: ⏸ dừng · 🔄 khởi động lại · 📜 nhật ký · 🗑 xóa.', buttons: rows };
  }

  function logText(r) { const t = (r.text || '').trim(); return '📜 Nhật ký agent ' + r.agent.id + ' (' + esc(r.agent.name) + '):\n' + (t ? t.split('\n').slice(-30).join('\n').slice(-3500) : '(chưa có dòng nào)'); }
  const done = (a, what) => '✅ Agent ' + a.id + ' (' + esc(a.name) + '): ' + what;

  // Tạo agent từ token (dùng chung cho lệnh /daily them và câu thường "thêm bot đó")
  async function addAgent(chatId, token, name) {
    if (send) await send(chatId, '⏳ Đang tạo agent (tạo tài khoản + dịch vụ riêng, khoảng 10–30 giây)…');
    const r = await agents.add({ token, name: String(name || '').trim() });
    return '✅ Đã tạo agent ' + r.agent.id + ' "' + esc(r.agent.name) + '" — bot @' + r.agent.bot.username + '.\nMở @' + r.agent.bot.username + ' trên Telegram và nhắn thử (chỉ ID của anh được phép). Giới hạn: RAM ' + r.agent.ramMb + ' MB, CPU ' + r.agent.cpuPct + '%. Đổi: /daily gioihan ' + r.agent.id + ' <RAM MB> <CPU %>.' + (r.warn ? '\n⚠️ ' + r.warn : '');
  }

  // CHỦ MÁY DÁN TOKEN BOT (hoặc nói "thêm bot đó" sau khi đã dán) = muốn thêm bot Telegram: bot quản lý TỰ LÀM, không bắt chủ máy gõ lệnh và không đưa token cho AI.
  // - tin có token: xóa ngay (token là bí mật), nhớ token 60 phút, tạo agent luôn (tên lấy từ câu "bot <tên>" nếu có, không thì lấy tên bot ở Telegram);
  // - tin KHÔNG có token mà nói "thêm bot đó/này…" khi còn token nhớ: tạo agent bằng token đó.
  // Trả null nếu không phải việc này (câu đi tiếp cho AI). Lệnh bắt đầu bằng "/" không qua đây.
  const TOKEN_G = /\b\d{8,12}:[A-Za-z0-9_-]{30,}/;
  const pending = new Map();                                   // chatId -> { token, name, at }
  const FRESH_MS = 60 * 60 * 1000;
  const WANT_ADD = /\b(them|tao|add|cai|dua|bo sung|kich hoat)\b[^.\n]{0,50}\b(bot|agent)\b/;
  function nameFrom(text) {                                    // "…token của bot Facebook Huyền Anh, bot này chỉ…" → "Facebook Huyền Anh"
    const t = String(text || '').replace(TOKEN_G, ' ').replace(/\s+/g, ' ');
    const m = /\bbot\s+([^,.:;()\n]{2,60})/i.exec(t); if (!m) return '';
    const STOP = /^(nay|do|kia|chi|co|lam|de|la|nhe|di|telegram|cua|duoc|se|dang|vao|voi|va|bot|phan|moi)$/;
    const out = [];
    for (const w of m[1].trim().split(' ')) { if (STOP.test(noAcc(w))) { if (!out.length) continue; break; } out.push(w); if (out.length >= 4) break; }
    return out.join(' ').slice(0, 40);
  }
  function tryAdd(chatId, uid, text, msg) {
    if (!isAdmin(uid) || !agents || typeof agents.add !== 'function') return null;
    const t = String(text || '');
    if (/^\s*\//.test(t)) return null;
    const mt = TOKEN_G.exec(t);
    const p = pending.get(String(chatId));
    const fresh = p && Date.now() - p.at < FRESH_MS;
    if (!mt && !(fresh && WANT_ADD.test(noAcc(t)))) return null;
    let token, name;
    if (mt) {
      token = mt[0]; name = nameFrom(t);
      pending.set(String(chatId), { token, name, at: Date.now() });
      if (deleteMessage && msg && msg.message_id) Promise.resolve(deleteMessage(chatId, msg.message_id)).catch(() => {});       // token là bí mật: xóa tin ngay
    } else { token = p.token; name = p.name; }
    return run(async () => {
      const r = await addAgent(chatId, token, name);
      pending.delete(String(chatId));
      return r + '\n(Tin có token đã xóa khỏi cuộc trò chuyện. Việc cụ thể cho bot này, nhắn: "giao cho bot ' + (name || 'tên bot') + ' làm: …".)';
    });
  }

  async function run(fn) { try { return await fn(); } catch (e) { return '⚠️ ' + String(e && e.message || e).slice(0, 500); } }

  function command(chatId, uid, arg, msg) {
    if (!isAdmin(uid)) return 'Chỉ chủ máy quản lý được agent.';
    const t = String(arg || '').trim();
    const m = t.match(/^(\S+)\s*([\s\S]*)$/);
    const sub = m ? noAcc(m[1]) : '', rest = m ? m[2].trim() : '';
    return run(async () => {
      if (!sub || sub === 'ds' || sub === 'danhsach' || sub === 'list') return card();
      if (sub === 'them' || sub === 'add') {
        const mt = rest.match(/^(\d{6,}:[A-Za-z0-9_-]{30,})\s*([\s\S]*)$/);
        if (deleteMessage && msg && msg.message_id) Promise.resolve(deleteMessage(chatId, msg.message_id)).catch(() => {});      // token là bí mật: xóa tin ngay
        if (!mt) return 'Chưa thấy token đúng dạng. Tạo bot ở @BotFather (/newbot), chép token (dạng 123456789:AAAA…) rồi gõ: /daily them <token> [tên agent]';
        return await addAgent(chatId, mt[1], mt[2].trim());
      }
      const ref = rest.split(/\s+/)[0] || '';
      const args = rest.slice(ref.length).trim();
      if (['dung', 'stop', 'tamdung'].includes(sub)) { const r = await agents.control(ref, 'stop'); return done(r.agent, 'đã dừng. Gõ /daily chay ' + r.agent.id + ' để chạy lại.'); }
      if (['chay', 'start', 'bat'].includes(sub)) { const r = await agents.control(ref, 'start'); return done(r.agent, 'đã chạy.'); }
      if (['khoidong', 'restart', 'khoidonglai'].includes(sub)) { const r = await agents.control(ref, 'restart'); return done(r.agent, 'đã khởi động lại.'); }
      if (['nhatky', 'log', 'logs'].includes(sub)) return logText(await agents.logs(ref, Number(args) || 40));
      if (sub === 'gioihan') {
        const [ram, cpu] = args.split(/\s+/).map(Number);
        if (!ram) return 'Cách dùng: /daily gioihan <agent> <RAM MB> [CPU %] — RAM ' + LIMITS.ramMb[0] + '–' + LIMITS.ramMb[1] + ' MB, CPU ' + LIMITS.cpuPct[0] + '–' + LIMITS.cpuPct[1] + '% (100% = 1 nhân).';
        const f = { ramMb: ram }; if (cpu) f.cpuPct = cpu;
        const r = await agents.update(ref, f);
        return done(r.agent, 'giới hạn RAM ' + r.agent.ramMb + ' MB, CPU ' + r.agent.cpuPct + '% (đã khởi động lại).');
      }
      if (sub === 'quyen' || sub === 'chedo') {
        const a = agents.resolve(ref); if (!a) return 'Không có agent "' + ref + '".';
        const cur = a.settings || {};
        const [key, ...vv] = args.split(/\s+/).filter(Boolean);
        if (!key) {
          return '⚙️ Quyền hạn agent ' + a.id + ' (' + esc(a.name) + '):\n' + Object.keys(SETTINGS).map((k) => '• ' + k + ' = ' + (cur[k] === undefined ? '(mặc định' + (SETTINGS[k].def !== undefined ? ' ' + SETTINGS[k].def : '') + ')' : cur[k]) + ' — ' + SETTINGS[k].label).join('\n') + '\n\nĐổi: /daily quyen ' + a.id + ' <khóa> <bật|tắt|số|chữ|macdinh>. Ví dụ: /daily quyen ' + a.id + ' full bat';
        }
        const d = SETTINGS[key]; if (!d) return 'Không có mục "' + key + '". Gõ /daily quyen ' + a.id + ' để xem danh sách.';
        const raw = vv.join(' ').trim(); if (!raw) return 'Thiếu giá trị. Mục này: ' + d.label;
        let val;
        if (/^(macdinh|mặc định|default)$/i.test(raw)) val = null;
        else if (d.kind === 'bool') { if (/^(bat|bật|on|1|true|co|có)$/i.test(raw)) val = true; else if (/^(tat|tắt|off|0|false|khong|không)$/i.test(raw)) val = false; else return 'Giá trị phải là bật hoặc tắt.'; }
        else if (d.kind === 'int') val = Number(raw);
        else val = raw;
        const r = await agents.update(ref, { settings: { [key]: val } });
        return done(r.agent, 'đã đặt ' + key + ' = ' + (val === null ? 'mặc định' : val) + ' (đã khởi động lại).');
      }
      if (sub === 'giao') return assignCommand(chatId, uid, rest);
      if (sub === 'chu' || sub === 'owner') {
        const ids = args.split(/[\s,;]+/).filter(Boolean);
        if (!ids.length || !ids.every((x) => /^\d+$/.test(x))) return 'Cách dùng: /daily chu <agent> <ID Telegram,ID…> (ID là dãy số; người lạ gõ /id với bot để biết).';
        const r = await agents.update(ref, { owners: ids });
        return done(r.agent, 'từ giờ chỉ các ID ' + ids.join(', ') + ' được nhắn cho agent.');
      }
      if (sub === 'ten') {
        if (!args) return 'Cách dùng: /daily ten <agent> <tên mới>';
        const r = await agents.update(ref, { name: args });
        return done(r.agent, 'đã đổi tên.');
      }
      if (sub === 'xoa' || sub === 'delete') {
        const a = agents.resolve(ref); if (!a) return 'Không có agent "' + ref + '".';
        return { text: '⚠️ Xóa agent ' + a.id + ' "' + esc(a.name) + '"? Bot @' + (a.bot && a.bot.username) + ' ngừng trả lời. Dữ liệu của agent được GIỮ lại trong thư mục lưu trữ trên máy (chỉ quản trị máy mở được).', buttons: [[{ text: '🗑 Xóa', data: 'ag:xoa:' + a.id }, { text: 'Thôi', data: 'ag:no' }]] };
      }
      return HELP;
    });
  }

  // ===== GIAO VIỆC cho bot thường (hộp thư nội bộ, xem mail.js) =====
  function normMap(t) { let norm = ''; const idx = []; for (let i = 0; i < t.length; i++) for (const ch of noAcc(t[i])) { norm += ch; idx.push(i); } idx.push(t.length); return { norm, idx }; }
  const candidates = (a) => [a.id, a.name, a.bot && a.bot.username ? '@' + a.bot.username : '', a.bot && a.bot.username ? a.bot.username : ''].map((x) => noAcc(x).trim()).filter(Boolean);

  // "giao cho bot Bán hàng làm: lập báo cáo" -> { agent, task } (không khớp bot nào thì null để câu đi tiếp cho AI)
  function parseAssign(text) {
    if (!mail) return null;
    const t = String(text || '').trim();
    const { norm, idx } = normMap(t);
    const head = norm.match(/^(?:(?:hay|nho|xin|vui long) )*giao(?: (viec))?(?: (cho))?(?: (bot))? +/);
    if (!head) return null;
    const rest = norm.slice(head[0].length), explicit = !!(head[1] || head[2] || head[3]);
    let best = null;
    for (const a of agents.all()) {
      for (const c of candidates(a)) {
        const isRef = /^a\d+$/.test(c) || c[0] === '@' || c === noAcc((a.bot && a.bot.username) || '');
        if (!explicit && !isRef) continue;                                        // "giao hàng ..." không được hiểu nhầm là giao việc
        if (rest.startsWith(c) && (rest.length === c.length || /[\s:,;-]/.test(rest[c.length])) && (!best || c.length > best.len)) best = { a, len: c.length };
      }
    }
    if (!best) return null;
    let off = head[0].length + best.len;
    const tail = norm.slice(off).match(/^(?:\s*(?:lam|thuc hien|xu ly|nhe|viec|giup)\b)*\s*[:,;-]?\s*/);
    off += tail ? tail[0].length : 0;
    const task = t.slice(idx[Math.min(off, idx.length - 1)]).trim();
    return task ? { agent: best.a, task } : null;
  }

  async function assign(chatId, uid, a, task) {
    if (!(a.owners || []).map(String).includes(String(uid))) return '⚠️ ID của anh (' + uid + ') chưa nằm trong danh sách được nhắn cho bot "' + esc(a.name) + '", nên bot sẽ từ chối. Thêm ở Cài đặt → Bot Telegram (thẻ của bot) hoặc gõ /daily chu ' + a.id + ' <ID,ID>.';
    const st = await agents.status(a);
    if (!st.active) return '⚠️ Bot "' + esc(a.name) + '" đang dừng nên chưa nhận việc được. Gõ /daily chay ' + a.id + ' để chạy lại rồi giao lại.';
    const jid = mail.send(a.id, { from: uid, chat: chatId, text: task });
    return '📨 Đã giao cho "' + esc(a.name) + '"' + (a.bot && a.bot.username ? ' (@' + a.bot.username + ')' : '') + ' (mã ' + jid.slice(0, 6) + '). Làm xong bot báo lại ngay ở đây; anh cũng thấy bot làm trong cuộc trò chuyện với @' + (a.bot && a.bot.username || 'bot đó') + ' nếu anh đã bấm Start với bot đó.';
  }
  // Câu thường "giao cho bot X làm Y": trả null nếu không phải việc giao (câu đi tiếp cho AI)
  function tryAssign(chatId, uid, text) {
    if (!isAdmin(uid)) return null;
    const p = parseAssign(text); if (!p) return null;
    return run(() => assign(chatId, uid, p.agent, p.task));
  }
  function assignCommand(chatId, uid, arg) {
    if (!isAdmin(uid)) return 'Chỉ chủ máy giao việc cho bot được.';
    const p = parseAssign('giao cho bot ' + String(arg || '').trim());
    if (!p) {
      const names = agents.all().map((a) => '• ' + a.id + ' — ' + esc(a.name) + (a.bot && a.bot.username ? ' (@' + a.bot.username + ')' : '')).join('\n');
      return '📨 Giao việc cho bot thường: /giao <tên bot> <việc>\nVí dụ: /giao a1 lập báo cáo doanh số hôm nay\nHoặc cứ nhắn: "giao cho bot Bán hàng làm: lập báo cáo doanh số".\n\n' + (names ? 'Các bot:\n' + names : 'Chưa có bot thường nào. Thêm ở Cài đặt → Bot Telegram.');
    }
    return run(() => assign(chatId, uid, p.agent, p.task));
  }

  const isCallback = (d) => /^ag:/.test(String(d || ''));

  async function callback(cq) {
    const uid = String(cq.from.id), chatId = String(cq.message && cq.message.chat ? cq.message.chat.id : cq.from.id), d = String(cq.data);
    if (!isAdmin(uid)) return 'Chỉ chủ máy quản lý được agent.';
    const reply = (x) => (x && send ? send(chatId, x) : null);
    if (d === 'ag:no') return 'Thôi, không xóa.';
    const m = d.match(/^ag:(stop|start|restart|logs|del|xoa):(a\d+)$/);
    if (!m) return null;
    const verb = m[1], id = m[2];
    if (verb === 'del') { await reply(await command(chatId, uid, 'xoa ' + id)); return ''; }
    const text = await run(async () => {
      if (verb === 'logs') return logText(await agents.logs(id, 40));
      if (verb === 'xoa') { const r = await agents.remove(id, false); return '🗑 Đã xóa agent ' + r.agent.id + ' "' + esc(r.agent.name) + '".' + (r.kept ? ' Dữ liệu giữ ở ' + r.kept + '.' : ''); }
      const r = await agents.control(id, verb); return done(r.agent, r.msg.replace(/^Đã /, 'đã '));
    });
    await reply(text);
    if (verb !== 'logs') await reply(await card());
    return verb === 'logs' ? '' : 'Xong';
  }

  return { command, card, isCallback, callback, HELP, parseAssign, tryAssign, tryAdd, assignCommand };
}

module.exports = { createAgentsUi, HELP };
