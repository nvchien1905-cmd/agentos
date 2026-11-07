'use strict';
const fs = require('fs');
const path = require('path');
const { cleanRules, MODES: PERM_MODES } = require('./projectPerms');

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
  // CUỘC TRÒ CHUYỆN MỚI = DỰ ÁN MỚI (mỗi cuốn sách riêng): tên tạm theo giờ, sau khi có câu đầu tiên thì đặt theo câu đó (titleFromPrompt). Gộp lại được ở Cài đặt → Dự án.
  function newChat(chatId, uid) {
    const c = String(chatId == null ? '' : chatId), vn = new Date(now() + 7 * 3600 * 1000), p2 = (n) => String(n).padStart(2, '0');
    const base = 'Cuộc trò chuyện ' + p2(vn.getUTCDate()) + '/' + p2(vn.getUTCMonth() + 1) + ' ' + p2(vn.getUTCHours()) + ':' + p2(vn.getUTCMinutes());
    const taken = new Set(load().list.filter((x) => !x.deleted).map((x) => x.name.toLowerCase()));
    let name = base, n = 2; while (taken.has(name.toLowerCase())) name = base + ' (' + n++ + ')';
    const p = create(name, c);
    const users = [...new Set([c, uid == null ? '' : String(uid)].filter((u) => /^\d{3,}$/.test(u)))];
    const out = update(p.id, (x) => { x.auto = true; x.autoTitle = true; x.nameAuto = true; x.chat = c; x.users = users; });
    if (o.db) setActive(c, p.id);
    return out;
  }
  // Đặt tên dự án tự tạo theo câu đầu tiên của chủ máy (một lần)
  function titleFromPrompt(id, prompt) {
    const p = get(id); if (!p || !p.autoTitle) return null;
    let t = String(prompt || '').replace(/[\u0000-\u001f]/g, ' ').replace(/^#\S+\s+/, '').replace(/\s+/g, ' ').trim();
    if (t.length < 3) return null;
    t = t.length > 44 ? t.slice(0, 43).replace(/\s+\S*$/, '') + '…' : t;
    const taken = new Set(load().list.filter((x) => !x.deleted && x.id !== id).map((x) => x.name.toLowerCase()));
    let name = t, n = 2; while (taken.has(name.toLowerCase())) name = t + ' (' + n++ + ')';
    return update(id, (x) => { x.name = name; x.autoTitle = false; });
  }
  // Lần làm việc gần nhất của dự án (để xếp danh sách chọn: mới dùng nhất lên đầu)
  const markActive = (id) => { if (o.db && id) db.kvSet('proj:act:' + id, now()); };
  function lastActive(id) { const t = Number(db.kvGet('proj:act:' + id)); if (t) return t; const p = load().list.find((x) => x.id === id); return p ? (p.created || 0) : 0; }
  // Dự án vừa được GỘP, đang chờ AI sắp xếp lại sổ tay (bộ điều phối làm nền)
  const pending = () => load().list.filter((p) => !p.deleted && p.pendingOrganize).map(pub);
  function clearPending(id, result) { return update(id, (p) => { delete p.pendingOrganize; p.lastOrganized = Object.assign({ at: now() }, result || {}); }); }
  function update(id, fn) {
    const st = load(), p = st.list.find((x) => x.id === id && !x.deleted);
    if (!p) throw new Error('Không có dự án này.');
    fn(p); save(st); return pub(p);
  }
  function rename(id, name) {
    name = String(name || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60) throw new Error('Tên dự án dài 2–60 ký tự.');
    if (load().list.some((p) => !p.deleted && p.id !== id && p.name.toLowerCase() === name.toLowerCase())) throw new Error('Đã có dự án tên "' + name + '".');
    return update(id, (p) => { p.name = name; p.nameAuto = false; p.autoTitle = false; });          // mã/thư mục giữ nguyên để tệp và lịch sử không đứt
  }
  const archive = (id, on) => update(id, (p) => { p.archived = on !== false; });
  // Chế độ quyền + luật cho/hỏi/cấm của dự án (projectPerms.js): hoi | tusua | kehoach | chay
  function setMode(id, mode) {
    const m = String(mode || '').trim().toLowerCase();
    if (!PERM_MODES.includes(m)) throw new Error('Chế độ phải là: ' + PERM_MODES.join(', ') + '.');
    return update(id, (p) => { p.mode = m; });
  }
  // rules: { allow: [..]|chữ nhiều dòng, ask: .., deny: .. } — thay hẳn các nhóm được truyền
  function setRules(id, rules) {
    return update(id, (p) => { const cur = Object.assign({ allow: [], ask: [], deny: [] }, p.rules || {}); for (const k of ['allow', 'ask', 'deny']) if (rules && rules[k] !== undefined) cur[k] = cleanRules(rules[k]); p.rules = cur; });
  }
  function setEngine(id, eng) { return update(id, (p) => { p.engine = eng ? String(eng) : null; }); }
  const setChungTu = (id, on) => update(id, (p) => { p.chungtu = !!on; });
  // Dự án làm kho kiến thức cho hỏi đáp nhân viên bán hàng (chỉ một dự án: bật dự án này thì dự án khác tự tắt)
  function setHoiDap(id, on) {
    const st = load(); const p = st.list.find((x) => x.id === id && !x.deleted); if (!p) throw new Error('Không có dự án này.');
    if (on) for (const x of st.list) x.hoidap = false;
    p.hoidap = !!on; save(st); return pub(p);
  }
  const hoidapProject = () => { const p = load().list.find((x) => x.hoidap && !x.deleted && !x.archived); return p ? pub(p) : null; };
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

  // ---------- lịch tự làm của dự án (cùng tệp .du-an.json nên trang Cài đặt cũng sửa được) ----------
  // Mỗi mục: { id, time 'HH:MM' (giờ VN), days [1..7] (1=Thứ 2 ... 7=Chủ nhật; rỗng = mọi ngày), text, last 'YYYY-MM-DD' }
  const MAX_SCHEDULES = 20;
  const DAY_NAMES = { 1: 'T2', 2: 'T3', 3: 'T4', 4: 'T5', 5: 'T6', 6: 'T7', 7: 'CN' };
  function addSchedule(id, s) {
    const time = String((s && s.time) || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) throw new Error('Giờ không hợp lệ (ví dụ 08:00).');
    const text = String((s && s.text) || '').trim(); if (text.length < 2 || text.length > 2000) throw new Error('Việc cần giao dài 2–2000 ký tự.');
    const days = [...new Set((s.days || []).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
    let out;
    update(id, (p) => {
      p.schedule = Array.isArray(p.schedule) ? p.schedule : [];
      if (p.schedule.length >= MAX_SCHEDULES) throw new Error('Mỗi dự án tối đa ' + MAX_SCHEDULES + ' việc hẹn giờ.');
      out = { id: p.schedule.reduce((m, x) => Math.max(m, x.id), 0) + 1, time: String(time[1]).padStart(2, '0') + ':' + time[2], days, text, last: '' };
      p.schedule.push(out);
    });
    return out;
  }
  function removeSchedule(id, sid) {
    let n = 0;
    update(id, (p) => { const before = (p.schedule || []).length; p.schedule = (p.schedule || []).filter((x) => x.id !== Number(sid)); n = before - p.schedule.length; });
    return n > 0;
  }
  function setSchedulePaused(id, sid, on) { let n = 0; update(id, (p) => { const x = (p.schedule || []).find((y) => y.id === Number(sid)); if (x) { x.paused = !!on; n = 1; } }); return n > 0; }
  function markRan(id, sid, date) { update(id, (p) => { const x = (p.schedule || []).find((y) => y.id === Number(sid)); if (x) x.last = date; }); }
  const daysText = (days) => (!days || !days.length || days.length === 7 ? 'mỗi ngày' : days.map((d) => DAY_NAMES[d]).join(','));

  // ---------- chỉ dẫn ----------
  function instructions(id) {
    let t = ''; try { t = fs.readFileSync(fileOf(id), 'utf8'); } catch (e) { t = ''; }
    t = t.replace(/<!--[\s\S]*?-->/g, '').replace(/^#\s+Chỉ dẫn dự án:.*$/m, '').trim();
    if (t.length > INSTR_MAX) t = t.slice(0, INSTR_MAX) + '\n…(chỉ dẫn quá dài, đã cắt bớt)';
    const x = extras(id);
    return x ? (t ? t + '\n\n' : '') + x : t;
  }
  // Chỉ dẫn/kỹ năng AI tự để trong thư mục dự án (giống CLAUDE.md và skills của Claude Code): AGENTS.md hoặc CLAUDE.md hoặc GEMINI.md (lấy tệp đầu tiên có),
  // và kỹ năng trong KY-NANG/*.md, .agentos/skills/*.md, .claude/skills/<tên>/SKILL.md (có thể có phần đầu --- name: … description: … ---). Chỉ liệt kê tên + mô tả; AI đọc tệp khi việc khớp mô tả.
  const readHead = (file, max) => { try { return fs.readFileSync(file, 'utf8').slice(0, max); } catch (e) { return null; } };
  function skillsOf(id) {
    const base = dirOf(id), out = [], seen = new Set();
    const add = (file, fallbackName) => {
      const raw = readHead(file, 2000); if (raw === null) return;
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/), pick = (k) => { const m = fm && fm[1].match(new RegExp('^' + k + '\\s*:\\s*(.+)$', 'mi')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
      const body = raw.replace(/^---[\s\S]*?---\s*/, '').split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
      const name = pick('name') || fallbackName; if (seen.has(name.toLowerCase())) return; seen.add(name.toLowerCase());
      out.push({ name, description: (pick('description') || body).slice(0, 160), file });
    };
    const mdIn = (dir) => { let l = []; try { l = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; } for (const d of l) if (d.isFile() && /\.md$/i.test(d.name)) add(path.join(dir, d.name), d.name.replace(/\.md$/i, '')); };
    mdIn(path.join(base, 'KY-NANG')); mdIn(path.join(base, '.agentos', 'skills'));
    try { for (const d of fs.readdirSync(path.join(base, '.claude', 'skills'), { withFileTypes: true })) if (d.isDirectory()) add(path.join(base, '.claude', 'skills', d.name, 'SKILL.md'), d.name); } catch (e) { /* không có */ }
    out.length = Math.min(out.length, 20);
    // Kỹ năng của các plugin đã cài (plugins.js): dùng cho MỌI dự án; kỹ năng của dự án trùng tên thì thắng
    try { for (const d of (o.extraSkillDirs ? o.extraSkillDirs() : [])) mdIn(d); } catch (e) { /* bỏ qua */ }
    return out.slice(0, 40);
  }
  function extras(id) {
    const base = dirOf(id), parts = [];
    for (const n of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) { const t = readHead(path.join(base, n), INSTR_MAX + 1); if (t && t.trim()) { parts.push('(Từ tệp ' + n + ' trong thư mục dự án)\n' + (t.length > INSTR_MAX ? t.slice(0, INSTR_MAX) + '\n…(đã cắt bớt)' : t).trim()); break; } }
    const sk = skillsOf(id);
    if (sk.length) parts.push('KỸ NĂNG CỦA DỰ ÁN (mỗi kỹ năng là một tệp hướng dẫn cách làm một loại việc; khi việc đang làm khớp mô tả thì ĐỌC tệp đó rồi làm theo):\n' + sk.map((k) => '- ' + k.name + ': ' + k.description + ' → ' + k.file).join('\n'));
    return parts.join('\n\n');
  }
  function rawInstructions(id) { try { return fs.readFileSync(fileOf(id), 'utf8'); } catch (e) { return ''; } }
  function setInstructions(id, text) {
    const p = get(id); if (!p) throw new Error('Không có dự án này.');
    text = String(text == null ? '' : text); if (text.length > 20000) throw new Error('Chỉ dẫn quá dài (tối đa 20.000 ký tự).');
    ensureDirs(p); fs.writeFileSync(fileOf(id), text);
  }

  // ---------- ai đang ở dự án nào ----------
  const kActive = (chat) => 'proj:active:' + chat;
  // DỰ ÁN TỔNG của từng ID Telegram: mỗi ID mặc định làm việc trong dự án riêng (thư mục, phiên, sổ tay, lịch sử riêng) nên các ID không đụng nhau.
  // Tạo lười biếng lần đầu ID đó nhắn việc. Tắt bằng /duan tong tat (kv home_projects = '0'); khi tắt, ai chưa chọn dự án sẽ về chế độ chung như cũ.
  const homeEnabled = () => !!o.db && db.kvGet('home_projects') !== '0';
  const setHomeEnabled = (on) => { if (o.db) db.kvSet('home_projects', on ? '1' : '0'); };
  function homeOf(chatId) {
    const c = String(chatId == null ? '' : chatId);
    if (!baseDir || !homeEnabled() || !/^\d{3,}$/.test(c)) return null;
    try {
      const st = load(); let p = st.list.find((x) => x.home === c && !x.deleted);
      if (!p) {
        let id = 'tong-' + c, n = 2; while (st.list.some((x) => x.id === id) || fs.existsSync(dirOf(id))) id = 'tong-' + c + '-' + n++;
        p = { id, name: 'Tổng · ' + c, created: now(), createdBy: c, archived: false, engine: null, users: [c], home: c };
        st.list.push(p); ensureDirs(p); save(st);
        log('tạo dự án tổng cho ID ' + c + ' (' + id + ')');
      }
      if (p.mergedInto) { const t = get(p.mergedInto); if (t && !t.archived) return t; }          // dự án tổng đã gộp vào dự án khác
      return pub(p);
    } catch (e) { log('dự án tổng ' + c + ' lỗi: ' + e.message); return null; }
  }
  // Đặt tên dự án tổng theo tên Telegram ("Nguyễn Văn A (ID)") — chỉ khi chủ máy chưa tự đổi tên (rename() tắt nameAuto); mỗi ID chỉ tra một lần mỗi lần khởi động
  const noted = new Set();
  function noteName(chatId, tg) {
    const c = String(chatId); tg = String(tg || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!tg || noted.has(c + '|' + tg) || !homeEnabled()) return;
    noted.add(c + '|' + tg);
    const h = homeOf(c); if (!h) return;
    const want = tg + ' (' + c + ')';
    if (h.name === want || h.nameAuto === false || (h.nameAuto !== true && h.name !== 'Tổng · ' + c)) return;
    update(h.id, (p) => { p.name = want; p.nameAuto = true; });
  }
  function active(chatId) {
    const id = db.kvGet(kActive(chatId));
    if (id) {
      let p = get(id);
      for (let i = 0; p && p.mergedInto && i < 5; i++) p = get(p.mergedInto);          // dự án đã gộp: chuyển sang dự án đích
      if (p && !p.archived) return p; db.kvDel(kActive(chatId));
    }
    return homeOf(chatId);
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

  return { setMode, setRules, markActive, lastActive, newChat, titleFromPrompt, pending, clearPending, update, load, save, noteName, homeOf, homeEnabled, setHomeEnabled, setHoiDap, hoidapProject, setChungTu, addSchedule, removeSchedule, setSchedulePaused, markRan, daysText, MAX_SCHEDULES, root, stateFile, list, get, create, rename, archive, remove, purge, setEngine, setUsers, instructions, skillsOf, rawInstructions, setInstructions, active, setActive, canUse, parseTag, files, usage, dirOf, bookDir, ensureDirs, slugify, TRASH_DAYS };
}

module.exports = { createProjects, slugify };
