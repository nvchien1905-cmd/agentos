'use strict';
const fs = require('fs');
const path = require('path');

// KỸ NĂNG CỦA DỰ ÁN trên Telegram (giống "skills" của Claude Code): mỗi kỹ năng là một tệp KY-NANG/<tên>.md trong thư mục dự án, dạy AI cách làm một loại việc
// (báo giá, chốt ca, nhập hàng…). projects.js đã liệt kê tên + mô tả vào chỉ dẫn của AI; module này cho chủ máy tạo/xem/sửa/xóa mà không phải đụng tệp bằng tay.
//   /kynang                 → danh sách kỹ năng của dự án đang ở + nút Xem / Xóa; kèm tệp chỉ dẫn đang có (CHI-DAN.md, AGENTS.md, CLAUDE.md…)
//   /kynang moi <tên>       → bot hỏi nội dung ở tin kế tiếp: dòng ĐẦU = mô tả ngắn (khi nào dùng), các dòng sau = các bước; /kynang sua <tên> ghi đè
//   /kynang xem <tên> · /kynang xoa <tên> · /kynang huy
// Chỉ chủ máy tạo/sửa/xóa (giống /duan chidan); mọi người dùng được dự án thì xem được. Chỉ quản lý tệp trong KY-NANG/ (kỹ năng ở .claude/skills… chỉ liệt kê).
const SKILLS_DIR = 'KY-NANG';
const MAX_BODY = 20000;
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const noAccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const slugOf = (name) => noAccent(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function createSkillsUi(o) {
  const { projects, isAdmin } = o;
  const now = o.now || Date.now, send = o.send || null;
  const pending = new Map();                          // chatId -> { projectId, slug, name, overwrite, until }

  const projectOf = (chatId, uid) => { const p = projects.active(chatId); return p && projects.canUse(uid, p, isAdmin) ? p : null; };
  const fileOf = (p, slug) => path.join(p.dir, SKILLS_DIR, slug + '.md');
  const managed = (p) => projects.skillsOf(p.id).map((s) => Object.assign({}, s, { mine: s.file.startsWith(path.join(p.dir, SKILLS_DIR) + path.sep), slug: path.basename(s.file).replace(/\.md$/i, '') }));
  const exists = (p, slug) => fs.existsSync(fileOf(p, slug));

  function card(p) {
    const list = managed(p);
    const files = ['CHI-DAN.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].filter((n) => { try { return fs.statSync(path.join(p.dir, n)).isFile(); } catch (e) { return false; } });
    const text = '🧠 Kỹ năng của ' + (p.home ? 'dự án tổng' : p.name) + ' — mỗi kỹ năng dạy AI cách làm một loại việc; AI tự đọc khi việc khớp mô tả.\n' +
      'Tệp chỉ dẫn đang có: ' + (files.join(', ') || '(chưa có)') + '  (sửa chỉ dẫn: /duan chidan)\n\n' +
      (list.length ? list.map((s, i) => (i + 1) + ') ' + s.name + ' — ' + cut(s.description, 90) + (s.mine ? '' : ' [tệp ngoài, chỉ xem]')).join('\n') : 'Chưa có kỹ năng nào.') +
      (list.length >= 20 ? '\n⚠️ AI chỉ thấy 20 kỹ năng đầu.' : '') +
      '\n\nThêm: /kynang moi <tên>  (vd /kynang moi Báo giá khách sỉ) · Sửa: /kynang sua <tên> · Xem: /kynang xem <tên> · Xóa: /kynang xoa <tên>';
    const rows = list.filter((s) => s.mine).slice(0, 8).map((s) => [{ text: '👁 ' + cut(s.name, 18), data: 'ky:view:' + s.slug }, { text: '✏️ Sửa', data: 'ky:edit:' + s.slug }, { text: '🗑', data: 'ky:del:' + s.slug }]);
    return { text, buttons: rows.length ? rows : undefined };
  }
  const template = (name) => '📝 Gửi nội dung kỹ năng "' + name + '" ở TIN KẾ TIẾP (gõ /kynang huy để thôi):\n' +
    '• Dòng ĐẦU: mô tả ngắn khi nào dùng kỹ năng này (vd "Lập báo giá cho khách mua sỉ").\n• Các dòng sau: từng bước làm, quy tắc, số liệu cần nhớ.\n\nVí dụ:\nLập báo giá cho khách mua sỉ\n1. Hỏi số lượng và mã hàng\n2. Lấy giá sỉ ở bảng giá tháng này\n3. Giảm 5% nếu từ 10 cái; ghi rõ đã gồm VAT';

  function begin(chatId, p, name, overwrite) {
    const slug = slugOf(name);
    if (!slug) return '⚠️ Tên kỹ năng cần có chữ hoặc số.';
    if (!overwrite && exists(p, slug)) return '⚠️ Đã có kỹ năng "' + slug + '". Sửa: /kynang sua ' + name + ' · hoặc đặt tên khác.';
    if (overwrite && !exists(p, slug)) return '⚠️ Không có kỹ năng "' + name + '" trong KY-NANG. Gõ /kynang để xem.';
    pending.set(String(chatId), { projectId: p.id, slug, name: String(name).trim().slice(0, 60), overwrite, until: now() + 10 * 60000 });
    return template(name);
  }

  async function command(chatId, uid, arg) {
    const p = projectOf(chatId, uid);
    if (!p) return 'Anh đang ở chế độ chung hoặc chưa có quyền với dự án này. Gõ /duan để vào một dự án.';
    const m = String(arg || '').trim().match(/^(\S+)\s*([\s\S]*)$/), sub = m ? noAccent(m[1]) : '', rest = m ? m[2].trim() : '';
    if (!sub || sub === 'ds' || sub === 'list') { pending.delete(String(chatId)); return card(p); }
    if (sub === 'huy') { pending.delete(String(chatId)); return 'Đã thôi.'; }
    if (sub === 'xem') {
      const s = managed(p).find((x) => noAccent(x.name) === noAccent(rest) || x.slug === slugOf(rest));
      if (!s) return 'Không có kỹ năng "' + rest + '". Gõ /kynang để xem danh sách.';
      let body = ''; try { body = fs.readFileSync(s.file, 'utf8'); } catch (e) { return 'Không đọc được tệp kỹ năng.'; }
      return '🧠 ' + s.name + '\n\n' + (body.length > 3500 ? body.slice(0, 3500) + '\n…(còn nữa, xem đủ trong ' + path.relative(p.dir, s.file) + ')' : body);
    }
    if (!isAdmin(uid)) return 'Chỉ chủ máy tạo/sửa/xóa kỹ năng.';
    if (sub === 'moi' || sub === 'them' || sub === 'sua') {
      if (!rest) return 'Cách dùng: /kynang ' + sub + ' <tên kỹ năng>';
      return begin(chatId, p, rest, sub === 'sua');
    }
    if (sub === 'xoa') {
      const slug = slugOf(rest); if (!slug || !exists(p, slug)) return 'Không có kỹ năng "' + rest + '" trong KY-NANG. Gõ /kynang để xem.';
      return { text: 'Xóa kỹ năng "' + slug + '"? Không khôi phục được.', buttons: [[{ text: '🗑 Xóa hẳn', data: 'ky:delyes:' + slug }, { text: 'Thôi', data: 'ky:no' }]] };
    }
    return 'Không hiểu "' + sub + '". Lệnh: /kynang · moi · sua · xem · xoa · huy';
  }

  // Tin chữ của chủ máy khi đang chờ nội dung kỹ năng (tin không bắt đầu bằng "/")
  const wants = (chatId) => { const p = pending.get(String(chatId)); if (!p) return false; if (p.until < now()) { pending.delete(String(chatId)); return false; } return true; };
  function take(chatId, uid, text) {
    const pd = pending.get(String(chatId)); pending.delete(String(chatId));
    const p = projects.get(pd.projectId);
    if (!p || !projects.canUse(uid, p, isAdmin) || !isAdmin(uid)) return 'Không lưu được: dự án không còn hoặc anh không còn quyền.';
    const lines = String(text).split(/\r?\n/), head = cut(lines[0], 160), body = lines.slice(1).join('\n').trim();
    if (!head) return '⚠️ Dòng đầu (mô tả ngắn) đang trống. Gõ lại /kynang ' + (pd.overwrite ? 'sua ' : 'moi ') + pd.name;
    if (text.length > MAX_BODY) return '⚠️ Nội dung quá dài (tối đa ' + MAX_BODY + ' ký tự). Rút gọn rồi gõ lại /kynang ' + (pd.overwrite ? 'sua ' : 'moi ') + pd.name;
    const safeName = pd.name.replace(/[\r\n:]/g, ' ').trim(), safeDesc = head.replace(/[\r\n]/g, ' ');
    const file = fileOf(p, pd.slug);
    try {
      projects.ensureDirs(p); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '---\nname: ' + safeName + '\ndescription: ' + safeDesc + '\n---\n# ' + safeName + '\n\n' + (body || head) + '\n');
    } catch (e) { return '⚠️ Không ghi được tệp kỹ năng: ' + e.message; }
    return '✅ Đã ' + (pd.overwrite ? 'cập nhật' : 'tạo') + ' kỹ năng "' + safeName + '" (' + SKILLS_DIR + '/' + pd.slug + '.md). AI dùng từ việc kế tiếp trong dự án này.';
  }

  async function callback(cq) {
    const chatId = String(cq.message && cq.message.chat ? cq.message.chat.id : cq.from.id), uid = String(cq.from.id), d = String(cq.data);
    const reply = (t) => (send ? send(chatId, t) : null);
    if (d === 'ky:no') return 'Thôi, giữ nguyên.';
    const m = d.match(/^ky:(view|edit|del|delyes):([a-z0-9-]{1,40})$/); if (!m) return null;
    const p = projectOf(chatId, uid); if (!p) return 'Chưa ở trong dự án nào.';
    const slug = m[2];
    if (!exists(p, slug)) return 'Kỹ năng này không còn.';
    if (m[1] === 'view') { await reply(await command(chatId, uid, 'xem ' + slug)); return ''; }
    if (!isAdmin(uid)) return 'Chỉ chủ máy sửa/xóa kỹ năng.';
    if (m[1] === 'edit') { const s = managed(p).find((x) => x.slug === slug); await reply(begin(chatId, p, s ? s.name : slug, true)); return ''; }
    if (m[1] === 'del') { await reply(await command(chatId, uid, 'xoa ' + slug)); return ''; }
    try { fs.rmSync(fileOf(p, slug), { force: true }); } catch (e) { return 'Không xóa được: ' + e.message; }
    await reply('🗑 Đã xóa kỹ năng "' + slug + '".'); return 'Đã xóa';
  }

  return { command, callback, wants, take, isCallback: (d) => /^ky:/.test(String(d || '')), card, slugOf };
}

module.exports = { createSkillsUi, SKILLS_DIR };
