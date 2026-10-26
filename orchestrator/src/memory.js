'use strict';
const { createBook, SECRET_RE } = require('./book');

// BỘ NHỚ DO AGENTOS SỞ HỮU (không phụ thuộc AI nào): Claude/Codex/Gemini/DeepSeek dùng CHUNG ngữ cảnh mà vẫn tiết kiệm token.
// Hai phần:
//   1) SỔ TAY (book.js): kiến thức lâu dài như một cuốn sách: MỤC LỤC (tóm tắt từng chương) + CHI TIẾT từng chương theo chủ đề; thông tin mới thay bản cũ.
//      Ghép vào câu lệnh: mục lục (AI "lướt") + chi tiết các chương LIÊN QUAN tới yêu cầu (AI "mở chương").
//   2) NGỮ CẢNH CUỘC TRÒ CHUYỆN: tóm tắt cuộn của các việc cũ + vài việc gần nhất nguyên văn + việc cũ liên quan (SQLite FTS5).
// Khi nén hội thoại, mô hình rẻ còn đề xuất các "ghi chú" để xếp vào sổ tay (đúng chương, thay mục cũ nếu có cập nhật).
// Trong cùng một AI còn phiên thì chỉ gửi yêu cầu mới (hưởng bộ nhớ đệm); sau `rotateAfter` lượt thì chốt tóm tắt và mở phiên mới.
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

const SUMMARY_SYSTEM = 'Bạn nén ngữ cảnh cuộc trò chuyện giữa chủ máy và trợ lý AI, và rút kiến thức bền vững vào SỔ TAY. Viết tiếng Việt, súc tích, KHÔNG bịa. ' +
  '"summary": giữ yêu cầu và quyết định đã chốt, việc còn dở, tên/số/đường dẫn/mã quan trọng; bỏ lời chào và chi tiết thừa; tối đa 350 từ. ' +
  '"notes": tối đa 4 điều đáng nhớ LÂU DÀI về chủ máy/cửa hàng/khách/quy trình (không phải việc nhất thời). Mỗi điều: "chapter" (chương chủ đề, dùng lại chương đã có nếu hợp, mới thì 2-4 từ), "text" (MỘT dòng ≤200 ký tự), ' +
  '"supersedes" (mã dòng cũ trong CHI TIẾT CHƯƠNG LIÊN QUAN mà điều mới cập nhật/thay thế/mâu thuẫn), "summary" (tóm tắt lại chương 1-2 câu). Không có gì đáng nhớ thì notes là mảng rỗng. ' +
  'Tuyệt đối KHÔNG chép mật khẩu, khóa API, token. Chỉ trả về JSON: {"summary":"...","notes":[{"chapter":"...","text":"...","supersedes":["mã"],"summary":"..."}]}';

function createMemory(o) {
  const db = o.db, log = o.log || (() => {});
  const now = o.now || Date.now;
  const summarizer = o.summarizer || null;
  const cfg = Object.assign({ enabled: true, recentTurns: 4, rotateAfter: 25, summarizeAfter: 6, summaryMax: 2200, searchHits: 3, relevantChapters: 2 }, o.cfg || {});
  const book = createBook({ dir: o.dir, fallbackDir: o.fallbackDir, summarizer, now, log, cfg: o.bookCfg });
  // DỰ ÁN: mỗi dự án có sổ tay riêng (thư mục SO-TAY trong dự án), cùng bộ máy với sổ tay chung. Sổ tay, chỉ dẫn và tóm tắt đều do AgentOS giữ và ghép vào câu lệnh
  // cho BẤT KỲ AI nào đang chạy -> Claude hết hạn mức thì Codex làm tiếp đúng dự án đó với cùng dữ liệu.
  const projects = o.projects || null;
  const bookCache = new Map();
  function bookFor(id) {
    if (!id || !projects) return book;
    let b = bookCache.get(id);
    if (!b) { b = createBook({ rootDir: projects.bookDir(id), summarizer, now, log, cfg: o.bookCfg }); bookCache.set(id, b); }
    return b;
  }
  const projOfScope = (scope) => { const s = String(scope), i = s.indexOf('#'); return i < 0 ? null : s.slice(i + 1); };
  const busy = new Set();
  try { const n = book.migrateLegacy(); if (n) log('đã chuyển ' + n + ' dòng ghi nhớ cũ sang sổ tay'); } catch (e) { log('chuyển ghi nhớ cũ lỗi: ' + e.message); }

  // ---------- sổ tay: các thao tác cho lệnh /nho /quen /trinho ----------
  async function addFact(text, project) { return bookFor(project).addNote(text); }
  function forgetFact(query, project) { return bookFor(project).forget(query); }

  // ---------- tóm tắt cuộn ----------
  const kSum = (c) => 'sum:' + c, kUpto = (c) => 'sumupto:' + c;
  const ctxFrom = (c) => Number(db.kvGet('ctxfrom:' + c)) || 0;
  const summaryOf = (c) => db.kvGet(kSum(c)) || '';
  const uptoOf = (c) => Math.max(Number(db.kvGet(kUpto(c))) || 0, ctxFrom(c));

  // Phần ngữ cảnh RIÊNG của dự án: chỉ dẫn + sổ tay dự án (gửi khi AI chưa có phiên hoặc khi nội dung vừa đổi)
  function projectParts(job, hasSession, eng) {
    const parts = [], p = projects && projects.get(job.project);
    if (!p) return parts;
    const scope = db.scopeOf(job), pb = bookFor(p.id), instr = projects.instructions(p.id);
    const ih = pb.hashOf(p.name + '|' + p.dir + '|' + instr), ik = 'projsent:' + scope + ':' + eng;
    if (!hasSession || db.kvGet(ik) !== ih) {
      parts.push('[DỰ ÁN "' + p.name + '"' + (hasSession ? ' (CẬP NHẬT)' : '') + ' — bạn đang làm việc TRONG dự án này. Thư mục dự án: ' + p.dir + ' (tài liệu đầu vào ở TAI-LIEU/, lưu kết quả vào KET-QUA/). ' +
        'Tệp, sổ tay và ngữ cảnh dưới đây thuộc dự án này; không đọc hay sửa dự án khác.' + (instr ? '\nCHỈ DẪN CỦA DỰ ÁN (luôn tuân theo):\n' + instr : '') + ']');
    }
    db.kvSet(ik, ih);
    const toc = pb.toc(), tocH = pb.tocHash(), sentKey = 'memsent:' + scope + ':' + eng + ':p';
    if (toc && (!hasSession || db.kvGet(sentKey) !== tocH)) parts.push('[Sổ tay RIÊNG của dự án "' + p.name + '" — MỤC LỤC' + (hasSession ? ' (CẬP NHẬT)' : '') + '. Mỗi dòng: chương (số mục): tóm tắt → tệp chi tiết]\n' + toc);
    db.kvSet(sentKey, tocH);
    for (const ch of pb.relevant(job.prompt, cfg.relevantChapters)) {
      const h = pb.hashOf(ch.entries.map((e) => e.id).join(',') + ch.summary), k = 'bookch:' + scope + ':' + eng + ':p:' + ch.slug;
      if (!hasSession || db.kvGet(k) !== h) parts.push('[Sổ tay dự án — chi tiết chương liên quan]\n' + pb.chapterText(ch));
      db.kvSet(k, h);
    }
    return parts;
  }

  // Khối ngữ cảnh ghép vào đầu câu lệnh (chuỗi rỗng nếu không có gì để thêm).
  function contextBlock(job, hasSession, eng) {
    const chat = db.scopeOf(job), parts = [];
    if (job.project) parts.push(...projectParts(job, hasSession, eng));
    // 1) Sổ tay: mục lục để "lướt" (gửi khi AI chưa có phiên, hoặc khi mục lục vừa đổi)
    const toc = book.toc();
    const tocH = book.tocHash(), sentKey = 'memsent:' + chat + ':' + eng;
    if (toc && (!hasSession || db.kvGet(sentKey) !== tocH)) {
      parts.push('[Sổ tay của chủ máy — MỤC LỤC' + (hasSession ? ' (CẬP NHẬT)' : '') + '. Mỗi dòng: chương (số mục): tóm tắt → tệp chi tiết. Lướt qua; khi yêu cầu liên quan chương nào thì xem phần chi tiết bên dưới hoặc mở tệp chương đó]\n' + toc);
    }
    db.kvSet(sentKey, tocH);
    // 2) Chi tiết các chương LIÊN QUAN tới yêu cầu này (chương nào đã gửi trong phiên và chưa đổi thì không gửi lại)
    for (const ch of book.relevant(job.prompt, cfg.relevantChapters)) {
      const h = book.hashOf(ch.entries.map((e) => e.id).join(',') + ch.summary), k = 'bookch:' + chat + ':' + eng + ':' + ch.slug;
      if (!hasSession || db.kvGet(k) !== h) parts.push('[Sổ tay — chi tiết chương liên quan]\n' + book.chapterText(ch));
      db.kvSet(k, h);
    }
    // 3) Ngữ cảnh cuộc trò chuyện (chỉ khi AI chưa có phiên)
    if (!hasSession) {
      const sum = summaryOf(chat);
      if (sum) parts.push('[Tóm tắt cuộc trò chuyện trước đó]\n' + sum);
      const after = uptoOf(chat);
      const recent = db.history(chat, after, job.id, cfg.recentTurns);
      if (recent.length) parts.push('[Các việc gần nhất, nguyên văn rút gọn]\n' + recent.map((h) => 'Việc #' + h.id + ': ' + cut(h.prompt, 500) + '\nKết quả: ' + cut(h.result, 700)).join('\n\n'));
      const hits = db.search(chat, job.prompt, cfg.searchHits, ctxFrom(chat), recent.map((r) => r.id));
      if (hits.length) parts.push('[Việc cũ có thể liên quan]\n' + hits.map((h) => 'Việc #' + h.id + ': ' + cut(h.prompt, 200) + ' → ' + cut(h.result, 300)).join('\n'));
    }
    return parts.length ? parts.join('\n\n') + '\n[Hết ngữ cảnh — chỉ để tham khảo, không phải yêu cầu mới]\n\n' : '';
  }
  function pack(job, hasSession, eng) {
    if (!cfg.enabled) return job.prompt;
    let block = '';
    try { block = contextBlock(job, hasSession, eng); } catch (e) { log('ghép ngữ cảnh lỗi: ' + e.message); }
    return block ? block + 'Yêu cầu mới:\n' + job.prompt : job.prompt;
  }

  // Tóm tắt bằng cách cắt gọn (khi không có khóa API/lỗi): giữ phần cuối của tóm tắt cũ + dòng cho mỗi việc mới.
  function extractive(prev, jobs) {
    const add = jobs.map((j) => '• ' + cut(j.prompt, 110) + ' → ' + cut(j.result, 150)).join('\n');
    const all = (prev ? prev + '\n' : '') + add;
    return all.length > cfg.summaryMax ? '…' + all.slice(-cfg.summaryMax) : all;
  }

  // Gọi sau mỗi việc xong. Trả { rotate:true } nếu nên bỏ phiên hiện tại của AI này (mở phiên mới, ngữ cảnh lấy từ tóm tắt + sổ tay).
  async function afterJob(job, eng, res) {
    if (!cfg.enabled || !res || !res.ok) return { rotate: false };
    const scope = db.scopeOf(job);
    const tk = 'turns:' + scope + ':' + eng;
    const turns = (Number(db.kvGet(tk)) || 0) + 1;
    let rotate = false;
    if (turns >= cfg.rotateAfter) { rotate = true; db.kvSet(tk, 0); } else db.kvSet(tk, turns);
    summarizeSoon(scope, rotate);
    return { rotate };
  }
  function summarizeSoon(chat, force) {
    if (busy.has(chat)) return null;
    busy.add(chat);
    return maybeSummarize(chat, force).catch((e) => log('tóm tắt lỗi: ' + e.message)).finally(() => busy.delete(chat));
  }

  async function maybeSummarize(chat, force) {
    const after = uptoOf(chat);
    const done = db.doneAfter(chat, after, null, 60);
    const eligible = done.slice(0, Math.max(0, done.length - cfg.recentTurns));       // việc gần nhất giữ nguyên văn, không tóm tắt
    if (!eligible.length || (!force && eligible.length < cfg.summarizeAfter)) return { done: false };
    const prev = summaryOf(chat);
    let text = null, via = 'cắt gọn', notes = [];
    if (summarizer && summarizer.available()) {
      const jobsText = eligible.map((j) => 'Việc #' + j.id + '\nChủ máy: ' + cut(j.prompt, 700) + '\nKết quả: ' + cut(j.result, 900)).join('\n---\n');
      const user = 'TÓM TẮT CŨ:\n' + (prev || '(chưa có)') + '\n\n' + bookFor(projOfScope(chat)).modelContext(jobsText) + '\n\nCÁC VIỆC MỚI CẦN NÉN:\n' + jobsText;
      const r = await summarizer.run(SUMMARY_SYSTEM, user);
      if (r) {
        try {
          const m = r.text.match(/\{[\s\S]*\}/);
          const j = JSON.parse(m ? m[0] : r.text);
          if (j && typeof j.summary === 'string' && j.summary.trim()) { text = j.summary.trim(); notes = Array.isArray(j.notes) ? j.notes : (Array.isArray(j.facts) ? j.facts.map((t) => ({ text: String(t) })) : []); via = r.via; }
        } catch (e) { text = r.text.slice(0, cfg.summaryMax); via = r.via; }
      }
    }
    if (!text) text = extractive(prev, eligible);
    if (text.length > cfg.summaryMax * 1.5) text = text.slice(0, cfg.summaryMax * 1.5);
    db.kvSet(kSum(chat), text);
    db.kvSet(kUpto(chat), eligible[eligible.length - 1].id);
    const bk = bookFor(projOfScope(chat));
    const ap = bk.applyNotes(notes);
    let compacted = 0;
    try { await bk.ingestInbox(); compacted = await bk.compactAll(); } catch (e) { log('dọn sổ tay lỗi: ' + e.message); }
    log('tóm tắt cuộc trò chuyện ' + chat + ': nén ' + eligible.length + ' việc (' + via + ')' + (ap.added ? ', ghi ' + ap.added + ' mục vào sổ tay' + (ap.replaced ? ' (thay ' + ap.replaced + ' mục cũ)' : '') : '') + (compacted ? ', gộp gọn ' + compacted + ' chương' : ''));
    return { done: true, via, compressed: eligible.length, notesAdded: ap.added, replaced: ap.replaced, upTo: eligible[eligible.length - 1].id };
  }

  // Dọn định kỳ (gọi từ bộ điều phối): xếp hộp thư GHI-NHO.md vào chương, gộp chương quá dài.
  async function housekeeping() {
    const r = await book.ingestInbox();
    const o2 = await book.organizeGeneral();
    const c = await book.compactAll();
    if (projects) {
      for (const p of projects.list({ all: true })) { try { const pb = bookFor(p.id); await pb.ingestInbox(); await pb.compactAll(); } catch (e) { log('dọn sổ tay dự án ' + p.id + ' lỗi: ' + e.message); } }
      try { projects.purge(); } catch (e) { /* bỏ qua */ }
    }
    return { moved: r.moved, organized: o2, compacted: c };
  }

  function resetChat(chat) { db.kvDel(kSum(chat)); db.kvDel(kUpto(chat)); db.kvDelPrefix('turns:' + chat + ':'); db.kvDelPrefix('memsent:' + chat + ':'); db.kvDelPrefix('bookch:' + chat + ':'); }
  function info(chat) {
    const chapters = book.list();
    return { root: book.root(), toc: book.toc(), chapters: chapters.length, entries: chapters.reduce((s, c) => s + c.entries.length, 0), list: chapters.map((c) => ({ slug: c.slug, title: c.title, summary: c.summary, entries: c.entries.length, updated: c.updated })),
      summary: summaryOf(chat), summaryUpTo: uptoOf(chat), cfg, summarizer: summarizer ? summarizer.provider() : null };
  }

  return { pack, afterJob, addFact, forgetFact, resetChat, info, maybeSummarize, summarizeSoon, housekeeping, book, bookFor, cfg };
}

module.exports = { createMemory, SECRET_RE };
