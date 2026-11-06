'use strict';

// ĐIỀU HƯỚNG DỰ ÁN TRÊN TELEGRAM (mỗi cuộc trò chuyện là một dự án = một cuốn sách riêng; xem projects.js / projectMerge.js):
//   /duan            → danh sách dự án, mỗi dòng có nút "▶️ Tiếp tục" (đặt dự án đó làm dự án đang làm việc, nhắc lại việc gần nhất) và nút "🆕 Dự án mới" ở cuối.
//   Quay lại sau vài giờ (mặc định 3 giờ, kv proj_idle_hours) và nhắn tin thường → KHÔNG giao việc ngay: bot hiện danh sách dự án để chọn, tin nhắn được giữ lại và giao vào dự án được chọn.
//   Mục cuối "🆕 Dự án mới" dành cho tin không liên quan dự án nào: bot hỏi TÊN dự án ngay trên Telegram (gõ tên, hoặc bấm "Bot tự đặt tên" thì tên lấy theo câu đầu tiên), rồi giao tin đã giữ.
//   Tên dự án sửa được ở Cài đặt → Dự án (cả dự án cũ lẫn mới).
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const DEFAULT_IDLE_H = 3;

function createProjectFlow(o) {
  const { db, projects, isAdmin, submit } = o;
  const now = o.now || Date.now;
  const kHold = (c) => 'pj:hold:' + c, kName = (c) => 'pj:name:' + c, kLast = (c) => 'pj:lastat:' + c;
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
  const idleMs = () => { const h = Number(db.kvGet('proj_idle_hours')); return (h > 0 ? h : DEFAULT_IDLE_H) * 3600000; };
  const label = (p) => (p.home ? 'Chung (dự án tổng)' : p.name);
  const ago = (t) => {
    const m = Math.max(0, Math.round((now() - t) / 60000));
    return m < 2 ? 'vừa xong' : m < 60 ? m + ' phút trước' : m < 48 * 60 ? Math.round(m / 60) + ' giờ trước' : Math.round(m / 1440) + ' ngày trước';
  };

  // Dự án người này dùng được, mới làm việc gần đây nhất trước (kèm dự án tổng của chính họ)
  function usable(chatId, uid) {
    const out = projects.list().filter((p) => !p.home && projects.canUse(uid, p, isAdmin));
    const h = projects.homeOf(chatId);
    if (h && !out.some((p) => p.id === h.id) && projects.canUse(uid, h, isAdmin)) out.push(h);
    return out.map((p) => Object.assign({ at: projects.lastActive(p.id) }, p)).sort((a, b) => b.at - a.at);
  }

  // Ghi mốc nhắn tin; trả mốc LẦN TRƯỚC (0 = chưa từng nhắn)
  function touch(chatId) { const prev = Number(db.kvGet(kLast(chatId))) || 0; db.kvSet(kLast(chatId), now()); return prev; }

  const lastRecap = (chatId, p) => {
    let h = null; try { h = db.history(chatId + '#' + p.id, 0, 1e12, 1)[0]; } catch (e) { /* bỏ qua */ }
    return h ? 'Việc gần nhất: "' + cut(h.prompt, 120) + '" → ' + cut(h.result, 220) : 'Dự án này chưa có việc nào.';
  };

  // /duan: danh sách + nút. Trả { text, buttons } (không có dự án nào thì chỉ có nút "Dự án mới").
  function listButtons(chatId, uid, max) {
    const cur = projects.active(chatId), list = usable(chatId, uid).slice(0, max || 8);
    const rows = list.map((p) => [{ text: (cur && cur.id === p.id ? '▶️ ' : '📁 ') + cut(label(p), 26), data: 'pj:info:' + p.id }, { text: '▶️ Tiếp tục', data: 'pj:go:' + p.id }]);
    rows.push([{ text: '🆕 Dự án mới', data: 'pj:new' }]);
    return { rows, list, cur };
  }

  function picker(chatId, uid, text) {
    db.kvSet(kHold(chatId), JSON.stringify({ text: String(text).slice(0, 6000), at: now() }));
    const { list, cur } = listButtons(chatId, uid, 6);
    const rows = list.map((p) => [{ text: (cur && cur.id === p.id ? '▶️ ' : '📁 ') + cut(label(p), 34) + ' · ' + ago(p.at), data: 'pj:pick:' + p.id }]);
    rows.push([{ text: '🆕 Dự án mới (tin này không liên quan)', data: 'pj:new' }]);
    return { text: '📁 Anh nhắn lại sau một lúc. Tin này thuộc dự án nào?\n(Tin của anh đang được giữ, chọn xong em làm ngay.)', buttons: rows };
  }

  // Tên dự án mới do chủ máy gõ trên Telegram
  function naming(chatId, nm, text) {
    const name = String(text || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60) return 'Tên dự án dài 2–60 ký tự, anh gõ lại giúp em (hoặc bấm "Bot tự đặt tên" ở tin trên).';
    try { projects.rename(nm.id, name); projects.update(nm.id, (x) => { x.autoTitle = false; }); } catch (e) { return '⚠️ ' + e.message + ' Anh gõ tên khác giúp em.'; }
    db.kvDel(kName(chatId));
    if (!nm.hold) return '✅ Đã đặt tên dự án mới: "' + name + '". Anh nhắn việc đầu tiên nhé.';
    projects.setActive(chatId, nm.id);
    const r = submit(chatId, nm.hold, null, null, nm.id);
    return '✅ Đã đặt tên dự án mới: "' + name + '" và giao tin của anh vào đó.' + (r ? '\n' + r : '');
  }

  // Bắt đầu một dự án mới và hỏi tên (hold = tin đang giữ, có thể rỗng)
  function askNew(chatId, uid, hold) {
    const np = projects.newChat(chatId, uid);
    db.kvSet(kName(chatId), JSON.stringify({ id: np.id, hold: hold || '' }));
    db.kvDel(kHold(chatId));
    return { text: '🆕 Dự án mới. Anh đặt tên cho dự án này: gõ tên rồi gửi (ví dụ: Kế toán tháng 11).\nKhông muốn đặt thì bấm nút bên dưới, tên sẽ lấy theo câu đầu tiên.' + (hold ? '\n(Tin trước của anh đang được giữ, đặt tên xong em làm ngay.)' : ''), buttons: [[{ text: 'Bot tự đặt tên', data: 'pj:auto' }]] };
  }
  // /moi <tên>: tạo dự án mới có tên luôn
  function createNamed(chatId, uid, name) {
    const nm = String(name || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (nm.length < 2 || nm.length > 60) return { err: 'Tên dự án dài 2–60 ký tự.' };
    if (projects.list({ all: true }).some((p) => p.name.toLowerCase() === nm.toLowerCase())) return { err: 'Đã có dự án tên "' + nm + '".' };      // kiểm TRƯỚC khi tạo để không sinh dự án rác
    const np = projects.newChat(chatId, uid);
    projects.rename(np.id, nm);
    return { project: projects.get(np.id) };
  }

  // Tin thường: null = cứ giao việc như bình thường; còn lại = trả lời thay (chọn dự án / đang đặt tên).
  function gate(chatId, uid, text, prevAt) {
    const nm = parse(db.kvGet(kName(chatId)));
    if (nm) return naming(chatId, nm, text);
    const hold = parse(db.kvGet(kHold(chatId)));
    if (hold) return picker(chatId, uid, hold.text + '\n' + text);                       // gõ thêm lúc đang chọn: gộp vào tin đang giữ
    if (prevAt && now() - prevAt >= idleMs()) return picker(chatId, uid, text);
    return null;
  }

  const isCallback = (d) => /^pj:/.test(String(d || ''));
  async function callback(cq) {
    const chatId = String(cq.message && cq.message.chat ? cq.message.chat.id : cq.from.id), uid = String(cq.from.id), d = String(cq.data);
    const reply = (t) => (o.send ? o.send(chatId, t) : null);
    let m;
    if ((m = d.match(/^pj:(go|info|pick):(.+)$/))) {
      const p = projects.get(m[2]);
      if (!p || !projects.canUse(uid, p, isAdmin)) return 'Dự án này không dùng được nữa.';
      if (m[1] === 'info') {
        const u = projects.usage(p.id);
        await reply('📁 ' + label(p) + '\n' + u.docs + ' tài liệu · ' + u.results + ' kết quả · làm việc gần nhất ' + ago(projects.lastActive(p.id)) + '\n' + lastRecap(chatId, p) + '\n\nBấm "▶️ Tiếp tục" để làm việc trong dự án này.');
        return '';
      }
      if (m[1] === 'go') {
        projects.setActive(chatId, p.id); projects.markActive(p.id);
        await reply('▶️ Tiếp tục dự án "' + label(p) + '".\n' + lastRecap(chatId, p) + '\n\nAnh cứ nhắn tiếp, em làm trong dự án này.');
        return 'Đã chuyển sang ' + cut(label(p), 40);
      }
      const hold = parse(db.kvGet(kHold(chatId)));
      if (!hold) return 'Tin này đã được xử lý rồi.';
      db.kvDel(kHold(chatId)); projects.setActive(chatId, p.id);
      const r = submit(chatId, hold.text, null, null, p.id);
      await reply('📁 Đã giao cho dự án "' + label(p) + '".' + (r ? '\n' + r : ''));
      return 'Đã chọn ' + cut(label(p), 40);
    }
    if (d === 'pj:new') {
      const hold = parse(db.kvGet(kHold(chatId)));
      await reply(askNew(chatId, uid, hold ? hold.text : ''));
      return '';
    }
    if (d === 'pj:auto') {
      const nm = parse(db.kvGet(kName(chatId)));
      if (!nm) return 'Đã xong rồi.';
      db.kvDel(kName(chatId));
      if (!nm.hold) { await reply('Đã rõ. Anh nhắn việc đầu tiên, em sẽ đặt tên dự án theo câu đó.'); return ''; }
      projects.titleFromPrompt(nm.id, nm.hold); projects.setActive(chatId, nm.id);
      const r = submit(chatId, nm.hold, null, null, nm.id);
      await reply('✅ Đã đặt tên dự án theo tin của anh và giao việc.' + (r ? '\n' + r : ''));
      return 'Đã tự đặt tên';
    }
    return null;
  }

  return { touch, gate, listButtons, askNew, createNamed, callback, isCallback, usable, idleMs, label, ago, lastRecap };
}

module.exports = { createProjectFlow, DEFAULT_IDLE_H };
