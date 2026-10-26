'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { noAccent } = require('./kiotviet');

// SỔ TAY: ngữ cảnh lưu như MỘT CUỐN SÁCH (thay cho tệp ghi nhớ phẳng).
//   - Mỗi CHƯƠNG = một chủ đề (khách hàng, hàng hóa, quy trình...): tệp chuong-<tên>.md gồm tiêu đề, TÓM TẮT 1-2 câu và phần CHI TIẾT (mỗi dòng một mục, có ngày và mã).
//   - MỤC LỤC (MUC-LUC.md): tên chương + tóm tắt + đường dẫn. AI "lướt" mục lục; khi đụng tới chủ đề nào thì hệ thống nạp chi tiết chương đó (hoặc AI tự mở tệp).
//   - Cùng chủ đề gom cạnh nhau (cùng chương). Thông tin MỚI THAY bản cũ: mục cũ bị gỡ khỏi chương, lưu ở .lichsu/ (có thể xem lại), không chồng chất mâu thuẫn.
//   - Người và AI cùng sửa được (OneDrive đồng bộ). Dòng ghi thêm vào hộp thư GHI-NHO.md sẽ được xếp vào đúng chương.
const SECRET_RE = /(sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|\b\d{8,}:[A-Za-z0-9_-]{30,}|-----BEGIN|(mật khẩu|mat khau|password|passwd|token|secret|api[ _-]?key)[^\n]{0,25}?(?::|=|(?:\s|^)là(?=\s|$))|\b[A-Za-z0-9+/_-]{40,}\b)/i;
const STOP = new Set('la cua va co khong nhung cho den tu mot cac nay do duoc voi de trong the khi se da rat nhu tren duoi anh em chu may ban toi minh nay kia thi ma hay hoac neu cung con van chi moi'.split(' '));
const today = (ms) => { const d = new Date(ms + 7 * 3600 * 1000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); };
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const tokens = (s) => [...new Set(noAccent(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)))];
const slugOf = (title) => (noAccent(title).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'chung');
const idOf = (text) => crypto.createHash('sha1').update(noAccent(text)).digest('hex').slice(0, 6);
const ENTRY_RE = /^-\s+\[(\d{4}-\d{2}-\d{2})\]\s+(?:\{([0-9a-f]{6})\}\s+)?(.*\S)\s*$/;
const DEFAULT_TITLE = 'Ghi nhớ chung';

const ADD_SYSTEM = 'Bạn là biên tập viên một cuốn SỔ TAY (như cuốn sách) về chủ máy và cửa hàng của họ. Xếp thông tin mới vào ĐÚNG chương: cùng chủ đề gom một chương (dùng lại chương đã có nếu hợp), chỉ tạo chương mới (tên 2-4 từ, tiếng Việt) khi chưa có chủ đề đó. ' +
  'Viết lại thành MỘT dòng ngắn gọn rõ nghĩa (tối đa 200 ký tự). Nếu thông tin mới CẬP NHẬT/THAY THẾ/MÂU THUẪN với dòng cũ thì liệt kê mã dòng cũ cần thay. Viết lại tóm tắt chương (1-2 câu) sau khi thêm. KHÔNG chép mật khẩu/khóa/token. ' +
  'Chỉ trả về JSON: {"chapter":"<tên chương>","text":"<một dòng>","supersedes":["<mã>"],"summary":"<tóm tắt chương>"}';
const ORGANIZE_SYSTEM = 'Bạn sắp xếp các dòng ghi nhớ CHƯA PHÂN LOẠI vào các chương chủ đề của một cuốn sổ tay. Dùng lại chương đã có nếu hợp; chỉ tạo chương mới (tên 2-4 từ, tiếng Việt) khi có từ 2 dòng cùng chủ đề trở lên; dòng lẻ không thuộc chủ đề nào thì bỏ qua (không liệt kê). ' +
  'Viết lại tóm tắt (1-2 câu) cho mỗi chương có dòng mới. Chỉ trả về JSON: {"assign":[{"id":"<mã dòng>","chapter":"<tên chương>"}],"summaries":{"<tên chương>":"<tóm tắt>"}}';
const MERGE_SYSTEM = 'Bạn dọn một chương sổ tay quá dài. Gộp các dòng trùng ý, bỏ dòng lỗi thời/mâu thuẫn (giữ bản mới hơn), giữ nguyên ngày và thông tin cụ thể (tên, số, giờ). Viết lại tóm tắt chương 1-2 câu. ' +
  'Chỉ trả về JSON: {"summary":"<tóm tắt>","entries":[{"date":"YYYY-MM-DD","text":"<một dòng>"}]}';

function createBook(o) {
  o = o || {};
  const summarizer = o.summarizer || null, log = o.log || (() => {});
  const now = o.now || Date.now;
  const baseDir = o.dir || '';
  const cfg = Object.assign({ tocMax: 2600, chapterMax: 2600, compactAt: 4200, relevant: 2 }, o.cfg || {});
  // rootDir: đặt thẳng thư mục sổ tay (dùng cho sổ tay riêng của từng dự án); không đặt thì theo baseDir/AgentOS/SO-TAY như cũ
  const root = () => o.rootDir ? o.rootDir : (baseDir && fs.existsSync(baseDir) ? path.join(baseDir, 'AgentOS', 'SO-TAY') : (o.fallbackDir || path.join(process.cwd(), 'so-tay')));
  const fileOf = (slug) => path.join(root(), 'chuong-' + slug + '.md');
  const inboxFile = () => path.join(path.dirname(root()), 'GHI-NHO.md');          // hộp thư vào (tương thích lệnh cũ): dòng "- ..." ở đây được xếp vào chương

  // ---------- đọc / ghi chương ----------
  function parse(slug, text) {
    const lines = String(text).split('\n');
    const ch = { slug, title: slug, summary: '', updated: '', entries: [] };
    const h = lines.find((l) => /^#\s+\S/.test(l)); if (h) ch.title = h.replace(/^#\s+/, '').trim();
    for (const l of lines) {
      let m;
      if ((m = l.match(/^>\s*Tóm tắt:\s*(.*)$/))) ch.summary = m[1].trim();
      else if ((m = l.match(/^>\s*Cập nhật:\s*(\d{4}-\d{2}-\d{2})/))) ch.updated = m[1];
      else if ((m = l.match(ENTRY_RE))) ch.entries.push({ date: m[1], id: m[2] || idOf(m[3]), text: m[3] });
    }
    // mã trùng (hai dòng giống hệt) -> đánh lại
    const seen = new Set();
    for (const e of ch.entries) { while (seen.has(e.id)) e.id = idOf(e.id + e.text + seen.size); seen.add(e.id); }
    return ch;
  }
  function render(ch) {
    return '# ' + ch.title + '\n> Tóm tắt: ' + (ch.summary || '(chưa có)') + '\n> Cập nhật: ' + (ch.updated || today(now())) + '\n\n## Chi tiết\n' +
      ch.entries.map((e) => '- [' + e.date + '] {' + e.id + '} ' + e.text).join('\n') + (ch.entries.length ? '\n' : '');
  }
  function list() {
    let names = []; try { names = fs.readdirSync(root()); } catch (e) { return []; }
    return names.filter((n) => /^chuong-[a-z0-9-]+\.md$/.test(n)).map((n) => {
      const slug = n.slice(7, -3);
      try { return parse(slug, fs.readFileSync(path.join(root(), n), 'utf8')); } catch (e) { return null; }
    }).filter(Boolean).sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || a.title.localeCompare(b.title));
  }
  const get = (slug) => { try { return parse(slug, fs.readFileSync(fileOf(slug), 'utf8')); } catch (e) { return null; } };
  function save(ch) {
    fs.mkdirSync(root(), { recursive: true });
    const f = fileOf(ch.slug);
    if (fs.existsSync(f)) { try { fs.copyFileSync(f, f + '.bak'); } catch (e) { /* bỏ qua */ } }
    ch.updated = today(now());
    fs.writeFileSync(f, render(ch));
    writeToc();
  }
  function archive(ch, gone, newId) {
    if (!gone.length) return;
    try {
      const dir = path.join(root(), '.lichsu'); fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, ch.slug + '.md'), gone.map((e) => '- [đã thay ' + today(now()) + '] [' + e.date + '] {' + e.id + '} ' + e.text + (newId ? ' → thay bằng {' + newId + '}' : '')).join('\n') + '\n');
    } catch (err) { log('lưu lịch sử sổ tay lỗi: ' + err.message); }
  }
  function writeToc() {
    try { fs.writeFileSync(path.join(root(), 'MUC-LUC.md'), '# Mục lục sổ tay\n(Tự tạo. Muốn sửa thì sửa trong từng chương; AI mở tệp chương để xem chi tiết.)\n\n' + tocText(Infinity) + '\n'); } catch (e) { /* bỏ qua */ }
  }

  // ---------- mục lục / chương liên quan ----------
  function tocText(max) {
    const chs = list();
    const lines = chs.map((c) => '- ' + c.title + ' (' + c.entries.length + ' mục): ' + (c.summary && c.summary !== '(chưa có)' ? cut(c.summary, 160) : cut((c.entries[0] || {}).text, 100)) + ' → ' + fileOf(c.slug));
    let out = '', n = 0;
    for (const l of lines) { if (out.length + l.length > max) break; out += (out ? '\n' : '') + l; n++; }
    return out + (n < lines.length ? '\n…(còn ' + (lines.length - n) + ' chương, xem MUC-LUC.md)' : '');
  }
  const toc = () => tocText(cfg.tocMax);
  const hashOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
  const tocHash = () => hashOf(list().map((c) => c.slug + c.updated + c.entries.length + c.summary).join('|'));

  // Điểm liên quan của một chương với các từ khóa: trùng tên chương (x3), tóm tắt (x2), nội dung (x1); đếm cả số từ KHÁC NHAU trùng để tránh nạp chương chỉ vì một từ phổ biến.
  function score(ch, words) {
    const t = noAccent(ch.title), s2 = noAccent(ch.summary), body = noAccent(ch.entries.map((e) => e.text).join(' '));
    let sc = 0, distinct = 0, titleHits = 0;
    for (const w of words) {
      let hit = false;
      if (t.includes(w)) { sc += 3; hit = true; titleHits++; }
      if (s2.includes(w)) { sc += 2; hit = true; }
      if (body.includes(w)) { sc += 1; hit = true; }
      if (hit) distinct++;
    }
    return { sc, distinct, titleHits, titleTokens: tokens(ch.title).length };
  }
  // Chương liên quan tới đoạn văn: để nạp CHI TIẾT (cần ≥ minDistinct từ khác nhau trùng, mặc định 2).
  function relevant(text, n, minScore, minDistinct) {
    const words = tokens(text);
    if (!words.length) return [];
    return list().map((c) => ({ c, r: score(c, words) })).filter((x) => x.r.sc >= (minScore || 3) && x.r.distinct >= (minDistinct || 2)).sort((p, q) => q.r.sc - p.r.sc).slice(0, n || cfg.relevant).map((x) => x.c);
  }
  // Chương để XẾP một ghi chú mới (khi không có mô hình): tên chương phải trùng rõ (từ hết tên chương hoặc ≥ 2 từ tên), hoặc nội dung trùng ≥ 4 từ.
  function place(text) {
    const words = tokens(text);
    if (!words.length) return null;
    let best = null;
    for (const c of list()) {
      const r = score(c, words);
      const strong = (r.titleTokens > 0 && r.titleHits >= Math.min(2, r.titleTokens)) || r.distinct >= 4;
      if (strong && (!best || r.sc > best.sc)) best = { c, sc: r.sc };
    }
    return best ? best.c : null;
  }
  function chapterText(ch, max) {
    const head = '"' + ch.title + '" — ' + ch.summary + ' (tệp ' + fileOf(ch.slug) + ')\n';
    let body = ch.entries.map((e) => '- [' + e.date + '] ' + e.text).join('\n');
    if (head.length + body.length > (max || cfg.chapterMax)) body = body.slice(0, (max || cfg.chapterMax) - head.length - 20) + '\n…(còn nữa, mở tệp để xem hết)';
    return head + body;
  }

  // ---------- ghi / thay / quên ----------
  function jaccard(a, b) { const A = new Set(tokens(a)), B = new Set(tokens(b)); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); }

  // Thêm một mục vào chương (tạo chương nếu chưa có). supersedes: mã mục cũ bị thay. Trả { ok, chapter, replaced, duplicate }.
  function put(title, text, opts) {
    opts = opts || {};
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (text.length < 4) return { ok: false, error: 'Nội dung quá ngắn.' };
    if (text.length > 400) return { ok: false, error: 'Nội dung quá dài (tối đa 400 ký tự); chia nhỏ ra.' };
    if (SECRET_RE.test(text)) return { ok: false, error: 'Nội dung giống mật khẩu/khóa/token nên em KHÔNG ghi nhớ (sổ tay được gửi cho hãng AI).' };
    title = cut(String(title || DEFAULT_TITLE), 60) || DEFAULT_TITLE;
    const slug = slugOf(title);
    const ch = get(slug) || { slug, title, summary: '', updated: '', entries: [] };
    const key = noAccent(text);
    if (ch.entries.some((e) => noAccent(e.text) === key)) return { ok: true, duplicate: true, chapter: ch.title };
    let sup = new Set((opts.supersedes || []).map(String));
    if (!sup.size && opts.autoReplace !== false) {                           // không có mô hình: tự nhận ra mục cùng ý (giống ≥ 80%) để THAY thay vì chồng
      const best = ch.entries.map((e) => ({ e, j: jaccard(e.text, text) })).filter((x) => x.j >= 0.8).sort((a, b) => b.j - a.j)[0];
      if (best) sup = new Set([best.e.id]);
    }
    const gone = ch.entries.filter((e) => sup.has(e.id));
    ch.entries = ch.entries.filter((e) => !sup.has(e.id));
    const entry = { date: opts.date || today(now()), id: idOf(text), text };
    ch.entries.push(entry);
    if (opts.summary) ch.summary = cut(opts.summary, 300);
    archive(ch, gone, entry.id);
    save(ch);
    return { ok: true, chapter: ch.title, replaced: gone.length };
  }

  function forget(query) {
    const q = noAccent(query);
    if (q.length < 2) return { removed: 0, lines: [] };
    const removed = [];
    for (const ch of list()) {
      const gone = ch.entries.filter((e) => noAccent(e.text).includes(q) || e.id === String(query).trim());
      if (!gone.length) continue;
      ch.entries = ch.entries.filter((e) => !gone.includes(e));
      archive(ch, gone, null);
      if (ch.entries.length) save(ch);
      else { try { fs.copyFileSync(fileOf(ch.slug), fileOf(ch.slug) + '.bak'); fs.rmSync(fileOf(ch.slug)); writeToc(); } catch (e) { /* bỏ qua */ } }
      removed.push(...gone.map((e) => '[' + ch.title + '] ' + e.text));
    }
    return { removed: removed.length, lines: removed };
  }

  // Ngữ cảnh gửi cho mô hình khi xếp thông tin: danh sách chương + chi tiết (kèm mã dòng) của các chương, chương liên quan trước, tới hết ngân sách ký tự.
  // Cho mô hình thấy cả những chương không trùng từ khóa để nó nhận ra mục cũ bị thay/mâu thuẫn.
  function modelContext(text, budget) {
    budget = budget || 5500;
    const chs = list();
    const words = tokens(text);
    const ranked = chs.map((c) => ({ c, r: score(c, words) })).sort((x, y) => y.r.sc - x.r.sc).map((x) => x.c);
    let used = 0; const blocks = [];
    for (const c of ranked) {
      const lines = c.entries.slice(-14).map((e) => '{' + e.id + '} [' + e.date + '] ' + cut(e.text, 200));
      const blk = '## ' + c.title + '\n' + lines.join('\n');
      if (used + blk.length > budget) break;
      blocks.push(blk); used += blk.length;
    }
    return 'CÁC CHƯƠNG HIỆN CÓ:\n' + (chs.length ? chs.map((c) => '- ' + c.title + ': ' + cut(c.summary, 120)).join('\n') : '(chưa có chương nào)') +
      (blocks.length ? '\n\nCHI TIẾT CÁC CHƯƠNG (kèm mã dòng):\n' + blocks.join('\n') : '');
  }
  function parseJson(t) { try { const m = String(t).match(/\{[\s\S]*\}/); return JSON.parse(m ? m[0] : t); } catch (e) { return null; } }

  // Thêm một ghi chú: dùng mô hình rẻ để chọn chương + nhận ra mục cũ bị thay; không có mô hình thì xếp theo từ khóa.
  async function addNote(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (SECRET_RE.test(text)) return put(DEFAULT_TITLE, text);                       // để put() báo lỗi bí mật
    if (summarizer && summarizer.available()) {
      const r = await summarizer.run(ADD_SYSTEM, modelContext(text) + '\n\nTHÔNG TIN MỚI: ' + text);
      const j = r && parseJson(r.text);
      if (j && j.chapter && j.text) {
        const res = put(String(j.chapter), String(j.text), { supersedes: Array.isArray(j.supersedes) ? j.supersedes : [], summary: j.summary, autoReplace: false });
        if (res.ok) return Object.assign(res, { via: r.via });
      }
    }
    const best = place(text);
    return put(best ? best.title : DEFAULT_TITLE, text);
  }

  // Áp các ghi chú mô hình đề xuất khi nén hội thoại: [{chapter,text,supersedes,summary}]
  function applyNotes(notes) {
    let added = 0, replaced = 0;
    for (const n of (notes || []).slice(0, 6)) {
      if (!n || !n.text) continue;
      const r = put(String(n.chapter || DEFAULT_TITLE), String(n.text), { supersedes: Array.isArray(n.supersedes) ? n.supersedes : [], summary: n.summary, autoReplace: false });
      if (r.ok && !r.duplicate) { added++; replaced += r.replaced || 0; }
    }
    return { added, replaced };
  }

  // Hộp thư vào GHI-NHO.md: người/AI ghi thêm dòng "- ..." ở đó; xếp vào chương rồi dọn hộp thư.
  async function ingestInbox() {
    const f = inboxFile();
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return { moved: 0 }; }
    const lines = text.split('\n').map((l) => { const m = l.match(/^\s*[-*]\s+(?:\[\d{4}-\d{2}-\d{2}\]\s*)?(.*\S)\s*$/); return m ? m[1].trim() : ''; }).filter((l) => l.length >= 4);
    if (!lines.length) return { moved: 0 };
    let moved = 0;
    for (const l of lines) { const r = await addNote(l).catch(() => ({ ok: false })); if (r.ok) moved++; }
    try { fs.writeFileSync(f, '# Hộp thư ghi nhớ\n(Thêm dòng "- điều cần nhớ" ở đây; hệ thống tự xếp vào đúng chương của sổ tay rồi dọn hộp thư. Xem sổ tay ở thư mục SO-TAY.)\n\n'); } catch (e) { /* bỏ qua */ }
    return { moved };
  }

  // Khi đã có mô hình: xếp lại các dòng đang nằm ở chương chung (do ghi lúc chưa có khóa) vào chương theo chủ đề. Trả số dòng đã chuyển.
  async function organizeGeneral() {
    if (!summarizer || !summarizer.available()) return 0;
    const gslug = slugOf(DEFAULT_TITLE), gen = get(gslug);
    if (!gen || gen.entries.length < 3) return 0;
    const chs = list().filter((c) => c.slug !== gslug);
    const user = 'CÁC CHƯƠNG ĐÃ CÓ:\n' + (chs.length ? chs.map((c) => '- ' + c.title + ': ' + cut(c.summary, 120)).join('\n') : '(chưa có)') +
      '\n\nCÁC DÒNG CHƯA PHÂN LOẠI:\n' + gen.entries.map((e) => '{' + e.id + '} ' + cut(e.text, 220)).join('\n');
    const r = await summarizer.run(ORGANIZE_SYSTEM, user);
    const j = r && parseJson(r.text);
    if (!j || !Array.isArray(j.assign)) return 0;
    let moved = 0;
    const byId = new Map(gen.entries.map((e) => [e.id, e]));
    for (const a of j.assign.slice(0, 40)) {
      const e = a && byId.get(String(a.id));
      const title = a && String(a.chapter || '').trim();
      if (!e || !title || slugOf(title) === gslug) continue;
      const res = put(title, e.text, { date: e.date, autoReplace: false, summary: j.summaries && j.summaries[title] });
      if (res.ok) { moved++; byId.delete(e.id); }
    }
    if (moved) {
      const cur = get(gslug);
      if (cur) {
        cur.entries = cur.entries.filter((e) => byId.has(e.id));
        if (cur.entries.length) save(cur); else { try { fs.copyFileSync(fileOf(gslug), fileOf(gslug) + '.bak'); fs.rmSync(fileOf(gslug)); writeToc(); } catch (e) { /* bỏ qua */ } }
      }
    }
    return moved;
  }

  // Chương quá dài: gộp/dọn bằng mô hình rẻ (có bản .bak, mục bị bỏ vào .lichsu).
  async function compact(slug) {
    const ch = get(slug);
    if (!ch || !summarizer || !summarizer.available() || render(ch).length < cfg.compactAt) return false;
    const r = await summarizer.run(MERGE_SYSTEM, 'CHƯƠNG: ' + ch.title + '\n' + ch.entries.map((e) => '[' + e.date + '] ' + e.text).join('\n'));
    const j = r && parseJson(r.text);
    if (!j || !Array.isArray(j.entries) || j.entries.length < Math.max(2, Math.floor(ch.entries.length / 4))) return false;
    const entries = j.entries.filter((e) => e && e.text && !SECRET_RE.test(String(e.text))).map((e) => ({ date: /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : today(now()), id: idOf(String(e.text)), text: cut(e.text, 300) }));
    if (entries.length < 2) return false;
    archive(ch, ch.entries.filter((e) => !entries.some((n) => noAccent(n.text) === noAccent(e.text))), null);
    ch.entries = entries; if (j.summary) ch.summary = cut(j.summary, 300);
    save(ch);
    return true;
  }
  async function compactAll() { let n = 0; for (const c of list()) if (await compact(c.slug).catch(() => false)) n++; return n; }

  // Chuyển ghi nhớ phẳng cũ (GHI-NHO.md dạng "- [ngày] nội dung") sang chương "Ghi nhớ chung" một lần.
  function migrateLegacy() {
    if (list().length) return 0;
    const f = inboxFile(); let text; try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return 0; }
    const items = text.split('\n').map((l) => l.match(ENTRY_RE)).filter(Boolean);
    if (!items.length) return 0;
    const ch = { slug: slugOf(DEFAULT_TITLE), title: DEFAULT_TITLE, summary: 'Các điều đã ghi nhớ từ trước (chưa phân chương).', updated: '', entries: [] };
    for (const m of items) ch.entries.push({ date: m[1], id: m[2] || idOf(m[3]), text: m[3] });
    save(ch);
    try { fs.copyFileSync(f, f + '.cu'); fs.writeFileSync(f, '# Hộp thư ghi nhớ\n(Thêm dòng "- điều cần nhớ" ở đây; hệ thống tự xếp vào đúng chương của sổ tay.)\n\n'); } catch (e) { /* bỏ qua */ }
    return items.length;
  }

  return { root, inboxFile, list, get, save, parse, render, toc, tocText, tocHash, hashOf, relevant, place, chapterText, put, forget, addNote, applyNotes, ingestInbox, organizeGeneral, compact, compactAll, migrateLegacy, modelContext, fileOf, ADD_SYSTEM, SECRET_RE, slugOf, cfg };
}

module.exports = { createBook, SECRET_RE, ENTRY_RE };
