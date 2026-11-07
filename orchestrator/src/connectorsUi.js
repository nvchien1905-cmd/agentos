'use strict';

// GIAO DIỆN TELEGRAM của "Kết nối dịch vụ" (connectors.js). Chỉ chủ máy dùng.
//   /dichvu                                 → danh sách kết nối + nút Thử / Bật / Tắt / Xóa / Thêm từ danh mục
//   /dichvu them <tên> <lệnh> [đối số…]     → thêm kết nối tự chọn (máy chủ MCP bất kỳ), vd: /dichvu them Kho npx -y goi-mcp
//   /dichvu khoa <mã> <BIẾN> [giá trị]      → đặt khóa (không có giá trị thì bot hỏi ở tin kế tiếp; tin chứa khóa bị xóa ngay)
//   /dichvu bat|tat|xoa|thu <mã>
// Khóa nhập ở tin kế tiếp chỉ được nhận khi trông giống một khóa (một cụm ≥ 8 ký tự, không dấu cách); tin khác = anh đã đi việc khác → bỏ chờ, xử lý như tin thường.
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const KEYLIKE = /^\S{8,4000}$/;

function createConnectorsUi(o) {
  const C = o.connectors, now = o.now || Date.now;
  const onChange = o.onChange || (() => {});
  const send = o.send || null, del = o.deleteMessage || null;
  const clock = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()); };

  function line(x) {
    const st = x.enabled ? '✅' : x.last && !x.last.ok ? '⚠️' : '⚪';
    let s = st + ' ' + x.label + ' (' + x.id + ') — ' + (x.enabled ? 'đang bật' : 'chưa bật');
    if (x.missing.length) s += ' · còn thiếu ' + x.missing.join(', ');
    if (x.last) s += x.last.ok ? ' · thử ' + clock(x.last.at) + ': OK, ' + x.last.tools.length + ' công cụ' : ' · thử ' + clock(x.last.at) + ' LỖI: ' + cut(x.last.error, 90);
    return s;
  }
  function card() {
    const list = C.list(), cat = C.catalog().filter((c) => !c.installed);
    const rows = [];
    for (const x of list) {
      const r = [{ text: '🧪 ' + cut(x.label, 12), data: 'cn:test:' + x.id }, x.enabled ? { text: '⏸ Tắt', data: 'cn:off:' + x.id } : { text: '▶️ Bật', data: 'cn:on:' + x.id }];
      for (const s of x.secrets.filter((q) => !q.set && !q.plain).slice(0, 1)) r.push({ text: '🔑 ' + cut(s.name, 14), data: 'cn:key:' + x.id + ':' + s.name });
      r.push({ text: '🗑', data: 'cn:del:' + x.id });
      rows.push(r);
    }
    if (cat.length) rows.push(cat.map((c) => ({ text: '➕ ' + c.label, data: 'cn:add:' + c.key })));
    const text = '🔌 Kết nối dịch vụ — AI dùng khi anh giao việc ở chế độ TOÀN QUYỀN (ID thường không thấy). Việc gửi/ghi/xóa qua kết nối luôn hỏi anh trước.\n\n' +
      (list.length ? list.map(line).join('\n') : 'Chưa có kết nối nào.') +
      '\n\nThêm từ danh mục bằng nút ➕, hoặc kết nối tự chọn: /dichvu them <tên> <lệnh> [đối số…] (vd /dichvu them Kho npx -y ten-goi-mcp), đặt khóa: /dichvu khoa <mã> <BIẾN>.';
    return { text, buttons: rows };
  }

  // Thử chạy thật; nếu vừa đủ khóa và thử OK thì tự bật
  async function testAndMaybeEnable(id, autoEnable) {
    const x = C.get(id); if (!x) return 'Không có kết nối này.';
    const r = await C.test(id);
    if (!r.ok) return '⚠️ ' + x.label + ': thử LỖI — ' + cut(r.error, 300) + (x.manual ? '\n\n' + x.manual : '');
    let extra = '';
    if (autoEnable && !x.enabled) { const e = C.setEnabled(id, true); if (e.ok) { onChange(); extra = ' Đã BẬT.'; } }
    return '✅ ' + x.label + ': chạy tốt, ' + r.tools.length + ' công cụ (' + r.tools.slice(0, 8).join(', ') + (r.tools.length > 8 ? '…' : '') + ').' + extra;
  }
  const notice = (chatId, text) => (send ? send(chatId, text).catch(() => {}) : null);

  async function askNext(chatId, id) {
    const x = C.get(id), need = x.secrets.find((s) => !s.set);
    if (!need) return null;
    if (need.plain) return { text: 'Cần ' + need.name + ': ' + need.ask + '\n\nGõ: /dichvu khoa ' + id + ' ' + need.name + ' <giá trị>' };
    C.setPending(chatId, id, need.name);
    return { text: '🔑 ' + x.label + ' cần ' + need.name + '.\n' + (need.ask || '') + '\n\nGửi giá trị ở tin kế tiếp — em sẽ XÓA tin đó ngay và không hiện lại. (Gõ /dichvu để hủy.)' };
  }

  async function command(chatId, uid, arg, msg) {
    if (!o.isAdmin(uid)) return 'Chỉ chủ máy dùng được /dichvu.';
    C.clearPending(chatId);
    const words = String(arg || '').trim().split(/\s+/).filter(Boolean), sub = (words[0] || '').toLowerCase();
    if (!sub) return card();
    const id = words[1];
    if (!['them', 'khoa', 'bat', 'tat', 'xoa', 'thu'].includes(sub)) return 'Không hiểu "' + sub + '". Gõ /dichvu để xem hướng dẫn.';
    if (sub === 'them') {
      if (words.length < 3) return 'Cách dùng: /dichvu them <tên> <lệnh> [đối số…] — vd /dichvu them Kho npx -y ten-goi-mcp';
      const r = C.addCustom({ label: words[1], command: words[2], args: words.slice(3) });
      if (!r.ok) return '⚠️ ' + r.error;
      return { text: '➕ Đã thêm "' + words[1] + '" (mã ' + r.id + '). Cần khóa thì: /dichvu khoa ' + r.id + ' <BIẾN_MÔI_TRƯỜNG> — rồi thử: /dichvu thu ' + r.id, buttons: [[{ text: '🧪 Thử ngay', data: 'cn:test:' + r.id }, { text: '▶️ Bật', data: 'cn:on:' + r.id }]] };
    }
    if (!id) return 'Cách dùng: /dichvu ' + sub + ' <mã kết nối> (xem mã ở /dichvu)';
    if (!C.get(id)) return 'Không có kết nối "' + id + '". Gõ /dichvu để xem.';
    if (sub === 'khoa') {
      const name = String(words[2] || '').toUpperCase();
      if (!name) return 'Cách dùng: /dichvu khoa ' + id + ' <BIẾN> [giá trị]';
      const value = words.slice(3).join(' ');
      if (!value) { C.setPending(chatId, id, name); return { text: '🔑 Gửi giá trị của ' + name + ' ở tin kế tiếp (em xóa tin đó ngay).' }; }
      return setValue(chatId, id, name, value, msg);
    }
    if (sub === 'bat' || sub === 'tat') { const r = C.setEnabled(id, sub === 'bat'); if (!r.ok) return '⚠️ ' + r.error; onChange(); return (sub === 'bat' ? '▶️ Đã bật ' : '⏸ Đã tắt ') + C.get(id).label + '. Có hiệu lực từ việc kế tiếp.'; }
    if (sub === 'xoa') { const r = C.remove(id); if (!r.ok) return '⚠️ ' + r.error; onChange(); return '🗑 Đã xóa kết nối ' + id + ' (khóa đã lưu cũng bị xóa).'; }
    if (sub === 'thu') { notice(chatId, '⏳ Đang thử ' + C.get(id).label + ' (lần đầu có thể mất 1–2 phút vì phải tải gói)…'); return testAndMaybeEnable(id, false); }
    return 'Không hiểu "' + sub + '". Gõ /dichvu để xem hướng dẫn.';
  }

  // Ghi một giá trị khóa; tin nhắn chứa khóa bị xóa. Đủ khóa thì tự thử và bật.
  async function setValue(chatId, id, name, value, msg) {
    if (del && msg && msg.message_id) { try { await del(chatId, msg.message_id); } catch (e) { /* không xóa được: vẫn tiếp tục */ } }
    const r = C.setSecret(id, name, value);
    if (!r.ok) return '⚠️ ' + r.error;
    onChange();                                       // kết nối đang bật dùng giá trị mới ngay từ việc kế tiếp
    const nxt = await askNext(chatId, id);
    if (nxt) return { text: '✅ Đã lưu ' + name + '. ' + nxt.text };
    notice(chatId, '✅ Đã lưu ' + name + '. ⏳ Đang thử kết nối (lần đầu có thể mất 1–2 phút)…');
    return testAndMaybeEnable(id, true);
  }

  async function callback(cq) {
    const chatId = String(cq.message && cq.message.chat ? cq.message.chat.id : cq.from.id), d = String(cq.data);
    if (!o.isAdmin(String(cq.from.id))) return 'Chỉ chủ máy dùng được.';
    const reply = (t) => (send ? send(chatId, t) : null);
    let m;
    if ((m = d.match(/^cn:add:([\w-]+)$/))) {
      const r = C.addFromCatalog(m[1]); if (!r.ok) return r.error;
      const x = C.get(m[1]);
      await reply('➕ Đã thêm ' + x.label + '. ' + x.about + (x.manual ? '\n\n' + x.manual : ''));
      const nxt = await askNext(chatId, x.id);
      if (nxt) await reply(nxt);
      else await reply({ text: 'Làm xong phần chuẩn bị ở trên rồi bấm Thử.', buttons: [[{ text: '🧪 Thử ' + x.label, data: 'cn:test:' + x.id }]] });
      return 'Đã thêm';
    }
    if ((m = d.match(/^cn:(test|on|off|del|delyes):([\w-]+)$/))) {
      const id = m[2], x = C.get(id); if (!x) return 'Không có kết nối này nữa.';
      if (m[1] === 'test') { await reply('⏳ Đang thử ' + x.label + ' (lần đầu có thể mất 1–2 phút)…'); await reply(await testAndMaybeEnable(id, false)); return 'Đã thử'; }
      if (m[1] === 'on' || m[1] === 'off') { const r = C.setEnabled(id, m[1] === 'on'); if (!r.ok) { const nxt = await askNext(chatId, id); await reply('⚠️ ' + r.error); if (nxt) await reply(nxt); return 'Chưa bật được'; } onChange(); await reply(card()); return m[1] === 'on' ? 'Đã bật' : 'Đã tắt'; }
      if (m[1] === 'del') { await reply({ text: 'Xóa kết nối ' + x.label + '? Khóa đã lưu cũng bị xóa.', buttons: [[{ text: '🗑 Xóa hẳn', data: 'cn:delyes:' + id }, { text: 'Thôi', data: 'cn:list' }]] }); return ''; }
      C.remove(id); onChange(); await reply(card()); return 'Đã xóa';
    }
    if ((m = d.match(/^cn:key:([\w-]+):([A-Z0-9_]+)$/))) {
      const id = m[1], name = m[2]; if (!C.get(id)) return 'Không có kết nối này nữa.';
      C.setPending(chatId, id, name);
      await reply('🔑 Gửi giá trị của ' + name + ' ở tin kế tiếp — em xóa tin đó ngay và không hiện lại. (Gõ /dichvu để hủy.)'); return '';
    }
    if (d === 'cn:list') { await reply(card()); return ''; }
    return null;
  }

  // Tin chữ của chủ máy khi đang chờ khóa: true nếu tin này đúng là khóa (một cụm ≥ 8 ký tự, không dấu cách). Tin khác = anh đã đi việc khác → bỏ chờ, trả false để bot xử lý như tin thường.
  function wants(chatId, text) {
    if (!C.pendingOf(chatId)) return false;
    if (!KEYLIKE.test(String(text || ''))) { C.clearPending(chatId); return false; }
    return true;
  }
  async function takeSecret(chatId, text, msg) {
    const p = C.pendingOf(chatId);
    if (!p) return null;
    C.clearPending(chatId);
    return setValue(chatId, p.id, p.name, text, msg);
  }

  return { command, callback, wants, takeSecret, isCallback: (d) => /^cn:/.test(String(d || '')), card };
}

module.exports = { createConnectorsUi };
