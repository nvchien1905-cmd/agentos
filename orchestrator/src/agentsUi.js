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

const HELP = '🤖 Agent = bot Telegram phụ, mỗi cái làm việc ĐỘC LẬP (tài khoản, dữ liệu, bộ nhớ, giới hạn RAM/CPU riêng), anh quản lý ở đây.\n\n' +
  '➕ Thêm: tạo bot mới ở @BotFather (/newbot), chép token rồi gõ:\n/daily them <token> [tên agent]\n(bot tự xóa tin có token để khỏi lộ)\n\n' +
  'Lệnh khác: /daily dung|chay|khoidong <agent> · /daily nhatky <agent> · /daily gioihan <agent> <RAM MB> [CPU %] · /daily quyen <agent> [khóa giá_trị] · /daily chu <agent> <ID,ID> · /daily ten <agent> <tên> · /daily xoa <agent>';

function createAgentsUi(o) {
  const { agents, isAdmin, send, deleteMessage } = o;

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
        if (send) await send(chatId, '⏳ Đang tạo agent (tạo tài khoản + dịch vụ riêng, khoảng 10–30 giây)…');
        const r = await agents.add({ token: mt[1], name: mt[2].trim() });
        return '✅ Đã tạo agent ' + r.agent.id + ' "' + esc(r.agent.name) + '" — bot @' + r.agent.bot.username + '.\nMở @' + r.agent.bot.username + ' trên Telegram và nhắn thử (chỉ ID của anh được phép). Giới hạn: RAM ' + r.agent.ramMb + ' MB, CPU ' + r.agent.cpuPct + '%. Đổi: /daily gioihan ' + r.agent.id + ' <RAM MB> <CPU %>.' + (r.warn ? '\n⚠️ ' + r.warn : '');
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

  return { command, card, isCallback, callback, HELP };
}

module.exports = { createAgentsUi, HELP };
