'use strict';

// GIAO DIỆN TELEGRAM của CHỢ KỸ NĂNG / PLUGIN (plugins.js). Chỉ chủ máy dùng.
//   /cho                  → danh sách plugin trong chợ (đã cài / chưa cài / có bản mới) + nút Cài / Gỡ / Bật / Tắt / Xem
//   /cho cai <mã>         → cài plugin;  /cho go <mã> → gỡ;  /cho bat|tat <mã>;  /cho xem <mã> → xem chi tiết (kỹ năng + kết nối kèm theo)
// Plugin nằm trong bản cài AgentOS nên tự cập nhật cùng mỗi bản cập nhật hệ điều hành (có chữ ký).
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const noAccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

function createPluginsUi(o) {
  const P = o.plugins, C = o.connectors || null, onChange = o.onChange || (() => {});

  const status = (p) => (!p.installed ? '⚪ chưa cài' : p.enabled ? '✅ đang bật' + (p.updated ? ' · ⬆️ mới cập nhật v' + p.version : '') : '⏸ đã tắt');
  function card() {
    const list = P.list();
    const text = '🧩 Chợ kỹ năng — mỗi plugin gồm các KỸ NĂNG dạy AI (dùng cho mọi dự án) và các KẾT NỐI dịch vụ kèm theo. Plugin tự cập nhật cùng bản cập nhật AgentOS.\n\n' +
      (list.length ? list.map((p) => p.icon + ' ' + p.name + ' v' + p.version + ' — ' + status(p) + '\n   ' + cut(p.description, 110) + '\n   ' + p.skills.length + ' kỹ năng' + (p.connectors.length ? ' · ' + p.connectors.length + ' kết nối' : '') + ' · /cho xem ' + p.id).join('\n\n') : 'Chợ đang trống.') +
      '\n\nCài: /cho cai <mã> · Gỡ: /cho go <mã> · Xem chi tiết: /cho xem <mã>';
    const rows = list.slice(0, 12).map((p) => [{ text: p.icon + ' ' + cut(p.name, 16), data: 'pl:info:' + p.id }, p.installed ? { text: '🗑 Gỡ', data: 'pl:del:' + p.id } : { text: '⬇️ Cài', data: 'pl:add:' + p.id }]);
    return { text, buttons: rows };
  }
  function info(id) {
    const p = P.get(id); if (!p) return 'Không có plugin "' + id + '" trong chợ. Gõ /cho để xem.';
    const t = p.icon + ' ' + p.name + ' v' + p.version + ' (' + p.category + ', ' + p.author + ') — ' + status(p) + '\n' + p.description + '\n\n' +
      '🧠 Kỹ năng:\n' + (p.skills.length ? p.skills.map((s) => '• ' + s.name + ' — ' + cut(s.description, 100)).join('\n') : '(không có)') +
      (p.connectors.length ? '\n\n🔌 Kết nối kèm theo:\n' + p.connectors.map((c) => '• ' + c.label + (c.needs.length ? ' (cần ' + c.needs.join(', ') + ')' : '')).join('\n') + '\n(Cài plugin xong, vào /dichvu nhập khóa để bật kết nối.)' : '');
    const row = p.installed ? [p.enabled ? { text: '⏸ Tắt', data: 'pl:off:' + p.id } : { text: '▶️ Bật', data: 'pl:on:' + p.id }, { text: '🗑 Gỡ', data: 'pl:del:' + p.id }] : [{ text: '⬇️ Cài plugin này', data: 'pl:add:' + p.id }];
    return { text: t, buttons: [row, [{ text: '⬅️ Về chợ', data: 'pl:list' }]] };
  }
  function act(sub, id) {
    if (sub === 'add') { const r = P.install(id); if (!r.ok) return '⚠️ ' + r.error; onChange(); return '✅ Đã cài ' + P.get(id).name + ': ' + r.skills + ' kỹ năng dùng được ngay cho mọi dự án' + (r.connectors.length ? '. Thêm ' + r.connectors.length + ' kết nối vào /dichvu (cần nhập khóa rồi bật).' : '.'); }
    if (sub === 'del') { const r = P.uninstall(id); if (!r.ok) return '⚠️ ' + r.error; onChange(); return '🗑 Đã gỡ plugin ' + id + (r.removedConnectors.length ? ' (và kết nối ' + r.removedConnectors.join(', ') + ')' : '') + '.'; }
    const r = P.setEnabled(id, sub === 'on'); if (!r.ok) return '⚠️ ' + r.error; onChange(); return (sub === 'on' ? '▶️ Đã bật ' : '⏸ Đã tắt ') + id + '.';
  }

  async function command(chatId, uid, arg) {
    if (!o.isAdmin(uid)) return 'Chỉ chủ máy dùng được chợ kỹ năng.';
    const w = String(arg || '').trim().split(/\s+/).filter(Boolean), sub = noAccent(w[0] || ''), id = w[1];
    if (!sub) return card();
    const map = { cai: 'add', them: 'add', go: 'del', xoa: 'del', bat: 'on', tat: 'off' };
    if (sub === 'xem') return id ? info(id) : 'Cách dùng: /cho xem <mã plugin>';
    if (!map[sub]) return 'Không hiểu "' + sub + '". Gõ /cho để xem hướng dẫn.';
    if (!id) return 'Cách dùng: /cho ' + sub + ' <mã plugin> (xem mã ở /cho)';
    return act(map[sub], id);
  }
  async function callback(cq) {
    if (!o.isAdmin(String(cq.from.id))) return 'Chỉ chủ máy dùng được.';
    const chatId = String(cq.message && cq.message.chat ? cq.message.chat.id : cq.from.id), d = String(cq.data);
    const reply = (t) => (o.send ? o.send(chatId, t) : null);
    let m;
    if (d === 'pl:list') { await reply(card()); return ''; }
    if ((m = d.match(/^pl:info:([\w-]+)$/))) { await reply(info(m[1])); return ''; }
    if ((m = d.match(/^pl:(add|del|on|off):([\w-]+)$/))) { await reply(act(m[1], m[2])); await reply(card()); return 'Xong'; }
    return null;
  }
  return { command, callback, isCallback: (d) => /^pl:/.test(String(d || '')), card };
}

module.exports = { createPluginsUi };
