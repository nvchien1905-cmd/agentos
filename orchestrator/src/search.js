'use strict';

// TÌM LẠI HỘI THOẠI CŨ (ô tìm chung kiểu app Claude): tìm theo nội dung câu hỏi VÀ câu trả lời của mọi việc đã làm, không phân biệt hoa thường/dấu,
// trong MỌI cuộc trò chuyện (hoặc chỉ một chat), lọc theo ngày/dự án/trạng thái, kèm đoạn trích có tô sáng từ khớp.
// Cũng tìm trong SỔ TAY (chương/mục ghi nhớ) và BÀI HỌC đã dạy. Hàm nhận thẳng đối tượng better-sqlite3 nên dùng được cho cả cơ sở dữ liệu của bot khác (đọc thôi).
const MARK_L = '【', MARK_R = '】';

const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
// Từ khóa: chữ/số liền nhau, bỏ dấu. Giữ cả từ 1-2 ký tự nếu là số ("2026", "v2")
function terms(text) {
  const out = [];
  for (const w of fold(text).split(/[^a-z0-9]+/)) if (w && !out.includes(w)) out.push(w);
  return out.slice(0, 8);
}

// Cắt đoạn trích quanh chỗ khớp đầu tiên và tô sáng các từ khớp. Làm trên chữ gốc (có dấu): so khớp bằng bản bỏ dấu cùng độ dài.
function excerpt(text, tms, width) {
  const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  width = width || 160;
  // Bỏ dấu từng ký tự để chỉ số khớp với chữ gốc (NFD cả chuỗi làm lệch chỉ số)
  const flat = Array.from(raw).map((ch) => { const f = fold(ch); return f.length === 1 ? f : ch.toLowerCase(); }).join('');
  let first = -1;
  for (const t of tms) { const i = flat.indexOf(t); if (i >= 0 && (first < 0 || i < first)) first = i; }
  let start = 0;
  if (first > 40) start = Math.max(0, first - 40);
  let seg = raw.slice(start, start + width), fseg = flat.slice(start, start + width);
  if (start > 0) { const sp = seg.indexOf(' '); if (sp > 0 && sp < 20) { seg = seg.slice(sp + 1); fseg = fseg.slice(sp + 1); start += sp + 1; } }
  // Tô sáng
  const spans = [];
  for (const t of tms) { let i = 0; while ((i = fseg.indexOf(t, i)) >= 0) { spans.push([i, i + t.length]); i += t.length; } }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) { const l = merged[merged.length - 1]; if (l && s[0] <= l[1]) l[1] = Math.max(l[1], s[1]); else merged.push(s.slice()); }
  let out = '', pos = 0;
  for (const [a, b] of merged) { out += seg.slice(pos, a) + MARK_L + seg.slice(a, b) + MARK_R; pos = b; }
  out += seg.slice(pos);
  return (start > 0 ? '…' : '') + out + (start + width < raw.length ? '…' : '');
}

function hasFts(raw) {
  try { return !!raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'jobs_fts'").get(); } catch (e) { return false; }
}

// opts: { chatId, project ('' = chế độ chung; undefined = mọi dự án), status, from, to (ms), limit (<=50), offset, mode: 'all'|'any' }
// Trả { hits:[{id, chat, project, status, engine, at, prompt, result}], total, terms, mode }
function searchJobs(raw, text, opts) {
  opts = opts || {};
  const tms = terms(text);
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10)), offset = Math.max(0, Number(opts.offset) || 0);
  if (!tms.length) return { hits: [], total: 0, terms: [], mode: 'empty' };
  const where = [], args = [];
  if (opts.chatId != null && opts.chatId !== '') { where.push('j.chat_id = ?'); args.push(String(opts.chatId)); }
  if (opts.project !== undefined && opts.project !== null) { where.push("COALESCE(j.project,'') = ?"); args.push(String(opts.project)); }
  if (opts.status) { where.push('j.status = ?'); args.push(String(opts.status)); }
  if (opts.from) { where.push('COALESCE(j.finished_at, j.created_at) >= ?'); args.push(Number(opts.from)); }
  if (opts.to) { where.push('COALESCE(j.finished_at, j.created_at) <= ?'); args.push(Number(opts.to)); }
  const w = where.length ? ' AND ' + where.join(' AND ') : '';
  const cols = 'j.id AS id, j.chat_id AS chat, COALESCE(j.project,\'\') AS project, j.status AS status, j.engine AS engine, COALESCE(j.finished_at, j.created_at) AS at, j.prompt AS prompt, j.result AS result';
  const run = (sqlFrom, a) => ({ rows: raw.prepare('SELECT ' + cols + ' ' + sqlFrom + ' ORDER BY j.id DESC LIMIT ? OFFSET ?').all(...a, limit, offset), total: raw.prepare('SELECT COUNT(*) AS n ' + sqlFrom).get(...a).n });
  const pack = (rows) => rows.map((r) => ({ id: r.id, chat: r.chat, project: r.project, status: r.status, engine: r.engine, at: r.at, prompt: excerpt(r.prompt, tms, 140), result: excerpt(r.result, tms, 200) }));
  let mode = 'like', res = null;
  // 1) FTS5 (nhanh, theo tiền tố): mọi từ phải có; không ra gì thì thử "một trong các từ"
  if (hasFts(raw)) {
    try {
      for (const join of [' AND ', ' OR ']) {
        const match = tms.map((t) => '"' + t.replace(/"/g, '') + '"*').join(join);
        const r = run('FROM jobs_fts f JOIN jobs j ON j.id = f.rowid WHERE jobs_fts MATCH ?' + w, [match, ...args]);
        if (r.rows.length || offset > 0 || join === ' OR ' || tms.length === 1) { res = r; mode = join === ' AND ' ? 'fts' : 'fts-any'; break; }
      }
    } catch (e) { res = null; }
  }
  // 2) Dự phòng: LIKE trên chữ gốc (không có FTS5 hoặc câu tìm làm FTS lỗi). Không bỏ dấu được nên khớp theo chữ người dùng gõ.
  if (!res) {
    const q = String(text).trim().slice(0, 100).replace(/[%_\\]/g, '\\$&');
    res = run("FROM jobs j WHERE (j.prompt LIKE ? ESCAPE '\\' OR COALESCE(j.result,'') LIKE ? ESCAPE '\\')" + w, ['%' + q + '%', '%' + q + '%', ...args]);
    mode = 'like';
  }
  return { hits: pack(res.rows), total: res.total, terms: tms, mode };
}

// Sổ tay: chapters = [{slug,title,entries:[{id,date,text}]}]; lessons = [{id,text}]. Trả [{kind,where,text}] xếp theo số từ khớp.
function searchMemory(chapters, lessons, text, limit) {
  const tms = terms(text); if (!tms.length) return [];
  const out = [];
  const score = (s) => { const f = fold(s); let n = 0; for (const t of tms) if (f.includes(t)) n++; return n; };
  for (const c of chapters || []) for (const e of c.entries || []) { const sc = score(e.text); if (sc === tms.length || (tms.length > 2 && sc >= tms.length - 1)) out.push({ kind: 'book', where: c.title || c.slug, date: e.date || '', text: excerpt(e.text, tms, 200), score: sc }); }
  for (const l of lessons || []) { const sc = score(l.text); if (sc === tms.length || (tms.length > 2 && sc >= tms.length - 1)) out.push({ kind: 'lesson', where: 'Bài học đã dạy', date: '', text: excerpt(l.text, tms, 200), score: sc }); }
  return out.sort((a, b) => b.score - a.score).slice(0, limit || 8);
}

// Văn bản cho Telegram. rows từ searchJobs().hits.
const ICON = { done: '✅', error: '❌', cancelled: '⏹', limit: '⏸', interrupted: '⚠️', running: '🟢', queued: '⏳', waiting: '⏳' };
function when(ms, now) {
  const d = new Date((ms || 0) + 7 * 3600 * 1000), p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + (now && new Date(now + 7 * 3600 * 1000).getUTCFullYear() !== d.getUTCFullYear() ? '/' + d.getUTCFullYear() : '') + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}
const plainMarks = (s) => String(s || '').split(MARK_L).join('').split(MARK_R).join('');
function format(query, r, mem, o) {
  o = o || {};
  if (!r.hits.length && !(mem && mem.length)) return '🔎 Không thấy "' + query + '" trong hội thoại cũ' + (o.scope ? ' (' + o.scope + ')' : '') + '. Thử từ khóa ngắn hơn hoặc khác đi.';
  const lines = ['🔎 Tìm "' + query + '": ' + r.total + ' việc' + (r.mode === 'fts-any' ? ' (khớp một phần từ khóa)' : '') + (o.scope ? ' · ' + o.scope : '')];
  for (const h of r.hits) {
    const pj = h.project ? ' · dự án ' + h.project : '';
    const body = h.result && plainMarks(h.result) !== h.result ? h.result : (plainMarks(h.prompt) !== h.prompt ? h.prompt : (h.result || h.prompt));
    lines.push('\n#' + h.id + ' · ' + when(h.at, o.now) + ' · ' + (ICON[h.status] || h.status) + pj + '\n❓ ' + h.prompt + (h.result ? '\n💬 ' + h.result : ''));
    void body;
  }
  if (r.total > r.hits.length) lines.push('\n… còn ' + (r.total - r.hits.length) + ' việc nữa. Thêm từ khóa để thu hẹp.');
  if (mem && mem.length) lines.push('\n🧠 Trong sổ tay:\n' + mem.map((m) => '• [' + m.where + '] ' + m.text).join('\n'));
  lines.push('\nXem lại đầy đủ: /viec <số>   (chữ 【 】 là chỗ khớp)');
  return lines.join('\n');
}

module.exports = { searchJobs, searchMemory, excerpt, terms, fold, format, when, hasFts, MARK_L, MARK_R };
