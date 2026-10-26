'use strict';
const fs = require('fs');
const path = require('path');

// DỰ ÁN (giống Projects của Claude / Codex): mỗi dự án có thư mục riêng, chỉ dẫn riêng, sổ tay riêng, lịch sử + phiên riêng.
// Quan trọng: dữ liệu của dự án do AgentOS giữ (thư mục tệp, CHI-DAN.md, SO-TAY, tóm tắt hội thoại) chứ KHÔNG nằm trong phiên của một AI nào,
// nên Claude hết hạn mức thì Codex (rồi Gemini/DeepSeek) làm tiếp đúng dự án đó với cùng dữ liệu (memory.js ghép lại cho AI nào đang chạy).
//
//   <baseDir>/AgentOS/DU-AN/<mã>/CHI-DAN.md   lời dặn cố định cho AI (sửa trực tiếp được, kể cả từ Kho tệp riêng/OneDrive)
//                              /TAI-LIEU/      tài liệu, dữ liệu đầu vào
//                              /KET-QUA/       AI lưu kết quả ở đây
//                              /SO-TAY/        sổ tay riêng (cùng cấu trúc sổ tay chung)
//   <baseDir>/AgentOS/DU-AN/.thung-rac/       dự án đã xóa, giữ 30 ngày
// Danh sách dự án nằm trong tệp .du-an.json cạnh các thư mục dự án (để cả bộ điều phối lẫn trang Cài đặt cùng đọc/ghi, và đi theo kho tệp/sao lưu); ai đang ở dự án nào nằm trong cơ sở dữ liệu (kv).
const TRASH_DAYS = 30;
const INSTR_MAX = 6000;
const TEMPLATE = (name) => '# Chỉ dẫn dự án: ' + name + '\n\n<!-- Viết ở đây những lời dặn CỐ ĐỊNH cho AI mỗi khi làm việc trong dự án này: vai trò, giọng văn, quy tắc, bảng giá, định dạng báo cáo... ' +
  'Dòng trong ô chú thích này sẽ bị bỏ qua. Mọi AI (Claude, Codex, Gemini, DeepSeek) đều đọc cùng chỉ dẫn này. KHÔNG ghi mật khẩu hay khóa API. -->\n\n';

function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
}

function createProjects(o) {
  const db = o.db || { kvGet: () => null, kvSet() {}, kvDel() {} };     // không có db (trang Cài đặt): chỉ quản lý dự án, không có "đang ở dự án nào"
  const baseDir = o.baseDir || '', now = o.now || Date.now, log = o.log || (() => {});
  const root = () => path.join(baseDir, 'AgentOS', 'DU-AN');
  const trash = () => path.join(root(), '.thung-rac');

  const stateFile = () => path.join(root(), '.du-an.json');
  const load = () => { try { const j = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); return Array.isArray(j.list) ? j : { list: [] }; } catch (e) { return { list: [] }; } };
  const save = (st) => {
    fs.mkdirSync(root(), { recursive: true });
    const tmp = stateFile() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st, null, 1)); fs.renameSync(tmp, stateFile());
  };
  const pub = (p) => Object.assign({}, p, { dir: path.join(root(), p.id), users: (p.users || []).slice() });

  function list(opt) {
    const all = opt && opt.all;
    return load().list.filter((p) => !p.deleted && (all || !p.archived)).map(pub);
  }
  function get(ref) {
    if (ref == null || ref === '') return null;
    const s = String(ref).trim(), k = slugify(s), low = s.toLowerCase();
    const live = load().list.filter((p) => !p.deleted);
    const p = live.find((x) => x.id === s) || live.find((x) => x.id === k) || live.find((x) => x.name.toLowerCase() === low) || live.find((x) => slugify(x.name) === k) || null;
    return p ? pub(p) : null;
  }
  const dirOf = (id) => path.join(root(), id);
  const fileOf = (id) => path.join(dirOf(id), 'CHI-DAN.md');
  const bookDir = (id) => path.join(dirOf(id), 'SO-TAY');

  function ensureDirs(p) {
    const d = dirOf(p.id);
    for (const sub of ['', 'TAI-LIEU', 'KET-QUA', 'SO-TAY']) fs.mkdirSync(path.join(d, sub), { recursive: true, mode: 0o2775 });
    if (!fs.existsSync(fileOf(p.id))) fs.writeFileSync(fileOf(p.id), TEMPLATE(p.name));
    // AI (người dùng agentos) và Nextcloud cùng ghi được: thư mục cha đã có ACL mặc định nên chỉ cần quyền nhóm
    try { fs.chmodSync(d, 0o2775); } catch (e) { /* hệ thống tệp không hỗ trợ */ }
  }

  function create(name, by) {
    name = String(name || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60) throw new Error('Tên dự án dài 2–60 ký tự.');
    const base = slugify(name); if (!base) throw new Error('Tên dự án cần có chữ hoặc số.');
    if (!baseDir) throw new Error('Chưa có thư mục lưu dự án.');
    const st = load();
    if (st.list.some((p) => !p.deleted && p.name.toLowerCase() === name.toLowerCase())) throw new Error('Đã có dự án tên "' + name + '".');
    let id = base, n = 2; while (st.list.some((p) => p.id === id) || fs.existsSync(dirOf(id))) id = base.slice(0, 36) + '-' + n++;
    const p = { id, name, created: now(), createdBy: by == null ? null : String(by), archived: false, engine: null, users: [] };
    st.list.push(p); ensureDirs(p); save(st);
    log('tạo dự án "' + name + '" (' + id + ')');
    return pub(p);
  }
  function update(id, fn) {
    const st = load(), p = st.list.find((x) => x.id === id && !x.deleted);
    if (!p) throw new Error('Không có dự án này.');
    fn(p); save(st); return pub(p);
  }
  function rename(id, name) {
    name = String(name || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60) throw new Error('Tên dự án dài 2–60 ký tự.');
    if (load().list.some((p) => !p.deleted && p.id !== id && p.name.toLowerCase() === name.toLowerCase())) throw new Error('Đã có dự án tên "' + name + '".');
    return update(id, (p) => { p.name = name; });          // mã/thư mục giữ nguyên để tệp và lịch sử không đứt
  }
  const archive = (id, on) => update(id, (p) => { p.archived = on !== false; });
  function setEngine(id, eng) { return update(id, (p) => { p.engine = eng ? String(eng) : null; }); }
  function setUsers(id, uids) { return update(id, (p) => { p.users = [...new Set((uids || []).map((u) => String(u).trim()).filter((u) => /^\d{3,}$/.test(u)))]; }); }

  // Xóa = chuyển vào thùng rác 30 ngày (không xóa hẳn ngay)
  function remove(id) {
    const p = get(id); if (!p) throw new Error('Không có dự án này.');
    fs.mkdirSync(trash(), { recursive: true });
    const dest = path.join(trash(), p.id + '-' + now());
    try { fs.renameSync(dirOf(p.id), dest); } catch (e) { /* chưa có thư mục: vẫn đánh dấu xóa */ }
    update(p.id, (x) => { x.deleted = true; x.deletedAt = now(); x.trashDir = dest; });
    return { ok: true, dest };
  }
  function purge() {
    let n = 0;
    const st = load(), keep = [];
    for (const p of st.list) {
      if (p.deleted && p.deletedAt && now() - p.deletedAt > TRASH_DAYS * 86400000) { try { fs.rmSync(p.trashDir, { recursive: true, force: true }); } catch (e) { /* bỏ qua */ } n++; } else keep.push(p);
    }
    if (n) { st.list = keep; save(st); }
    return n;
  }

  // ---------- chỉ dẫn ----------
  function instructions(id) {
    let t = ''; try { t = fs.readFileSync(fileOf(id), 'utf8'); } catch (e) { return ''; }
    t = t.replace(/<!--[\s\S]*?-->/g, '').replace(/^#\s+Chỉ dẫn dự án:.*$/m, '').trim();
    return t.length > INSTR_MAX ? t.slice(0, INSTR_MAX) + '\n…(chỉ dẫn quá dài, đã cắt bớt)' : t;
  }
  function rawInstructions(id) { try { return fs.readFileSync(fileOf(id), 'utf8'); } catch (e) { return ''; } }
  function setInstructions(id, text) {
    const p = get(id); if (!p) throw new Error('Không có dự án này.');
    text = String(text == null ? '' : text); if (text.length > 20000) throw new Error('Chỉ dẫn quá dài (tối đa 20.000 ký tự).');
    ensureDirs(p); fs.writeFileSync(fileOf(id), text);
  }

  // ---------- ai đang ở dự án nào ----------
  const kActive = (chat) => 'proj:active:' + chat;
  function active(chatId) {
    const id = db.kvGet(kActive(chatId)); if (!id) return null;
    const p = get(id); if (!p || p.archived) { db.kvDel(kActive(chatId)); return null; }
    return p;
  }
  function setActive(chatId, id) { if (id) db.kvSet(kActive(chatId), id); else db.kvDel(kActive(chatId)); }

  // Chủ máy dùng mọi dự án; người khác chỉ dự án được gán
  const canUse = (uid, p, isAdmin) => !!p && (isAdmin(uid) || (p.users || []).includes(String(uid)));

  // "#ten-du-an câu hỏi": hỏi một lần trong dự án mà không đổi dự án đang ở
  function parseTag(text) {
    const m = String(text || '').match(/^#([^\s#]+)\s+([\s\S]+)$/);
    if (!m) return null;
    const p = get(m[1]); return p && !p.archived ? { project: p, text: m[2].trim() } : null;
  }

  function files(id, sub) {
    const base = path.join(dirOf(id), sub || '');
    if (path.relative(dirOf(id), base).startsWith('..')) return [];
    let names = []; try { names = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return []; }
    return names.filter((d) => !d.name.startsWith('.')).map((d) => { let st = null; try { st = fs.statSync(path.join(base, d.name)); } catch (e) { /* bỏ qua */ } return { name: d.name, dir: d.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 }; })
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  }
  const usage = (id) => { const f = (sub) => files(id, sub).filter((x) => !x.dir).length; return { docs: f('TAI-LIEU'), results: f('KET-QUA') }; };

  return { root, stateFile, list, get, create, rename, archive, remove, purge, setEngine, setUsers, instructions, rawInstructions, setInstructions, active, setActive, canUse, parseTag, files, usage, dirOf, bookDir, ensureDirs, slugify, TRASH_DAYS };
}

module.exports = { createProjects, slugify };
