'use strict';

// TRỢ LÝ PHỤ (giống subagent của Claude Code): AI chính của một việc giao các phần độc lập cho AI phụ chạy SONG SONG rồi tự gom kết quả.
// Cách dùng với AI: lệnh `node subcli.js spawn "việc"` / `wait` / `list` / `cancel` → gọi cổng nội bộ 127.0.0.1 (gate.js, đường /sub) → ở đây.
// Quy tắc an toàn:
//  - Chỉ việc của AI chính đang chạy (đã đăng ký) mới giao được; trợ lý phụ KHÔNG giao tiếp được nữa (một cấp, không đệ quy).
//  - Trợ lý phụ là việc "ảo" của CÙNG cuộc trò chuyện (chat + dự án + bộ công cụ) nên chịu đúng quyền, hộp cô lập, luật CẤM và cổng duyệt như AI chính.
//  - Giới hạn số trợ lý chạy cùng lúc cho mỗi việc và toàn máy; AI chính xong/bị hủy thì trợ lý phụ bị dừng theo.
const { describe } = require('./progress');
const BASE_ID = 2000000000;          // mã việc ảo của trợ lý phụ (lớn hơn mọi mã việc thật)
const RESULT_MAX = 20000;

const SUB_PROMPT = (task) => 'Bạn là TRỢ LÝ PHỤ do AI chính giao MỘT việc cụ thể. Chỉ làm đúng việc dưới đây, không làm thêm, không hỏi lại người dùng, không giao việc cho ai khác. ' +
  'Trả về kết quả ngắn gọn, đủ ý, có dẫn nguồn/đường dẫn tệp nếu có; nếu không làm được thì nói rõ vì sao. AI chính sẽ đọc và tổng hợp kết quả của bạn.\n\nVIỆC ĐƯỢC GIAO:\n' + task;

function createSubagents(o) {
  const { engines, log } = o;
  const now = o.now || Date.now;
  const cfg = Object.assign({ enabled: true, perJob: 4, total: 8, timeoutMs: 20 * 60000, keepMs: 60 * 60000 }, o.cfg || {});
  const candidates = o.candidates || ((job) => Object.keys(engines));          // engine được phép cho việc này (đã theo bộ công cụ/vai trò)
  const available = o.available || (() => true);                                // engine đang không nghỉ hạn mức
  const budgetOk = o.budgetOk || (() => true);
  const parents = new Map();            // mã việc chính -> job (đang chạy)
  const subs = new Map();               // mã trợ lý -> trạng thái
  let seq = 0;

  const running = (pid) => [...subs.values()].filter((s) => s.parent === pid && s.status === 'running');
  const pub = (s) => ({ id: s.id, status: s.status, engine: s.engine, task: s.task.slice(0, 120), text: s.text, error: s.error, secs: Math.round(((s.endedAt || now()) - s.startedAt) / 1000) });
  const forget = () => { const cut = now() - cfg.keepMs; for (const [id, s] of subs) if (s.endedAt && s.endedAt < cut) subs.delete(id); };

  function pick(job, want) {
    const list = candidates(job).filter((e) => engines[e] && available(e) && budgetOk(e));
    if (want && list.includes(want)) return want;
    return list[0] || null;
  }

  return {
    enabled: () => !!cfg.enabled,
    // Đăng ký/gỡ AI chính (gọi quanh mỗi lần chạy engine của một việc thật)
    register(job) { if (cfg.enabled && job && job.lane !== 'sub') parents.set(Number(job.id), job); },
    unregister(jobId) { parents.delete(Number(jobId)); for (const s of running(Number(jobId))) { try { s.kill(); } catch (e) { /* đã dừng */ } s.status = 'cancelled'; s.endedAt = now(); } forget(); },
    isParent: (jobId) => parents.has(Number(jobId)),

    spawn(parentId, task, want) {
      forget();
      const job = parents.get(Number(parentId));
      if (!cfg.enabled) return { ok: false, error: 'Tính năng trợ lý phụ đang tắt.' };
      if (!job) return { ok: false, error: 'Chỉ AI chính của một việc đang chạy mới giao được trợ lý phụ (trợ lý phụ không được giao tiếp).' };
      task = String(task || '').trim();
      if (task.length < 5) return { ok: false, error: 'Thiếu mô tả việc giao.' };
      if (task.length > 8000) return { ok: false, error: 'Mô tả việc quá dài (tối đa 8000 ký tự).' };
      if (running(job.id).length >= cfg.perJob) return { ok: false, error: 'Đã có ' + cfg.perJob + ' trợ lý phụ đang chạy cho việc này: dùng `wait` lấy kết quả trước khi giao thêm.' };
      if ([...subs.values()].filter((s) => s.status === 'running').length >= cfg.total) return { ok: false, error: 'Máy đang chạy nhiều trợ lý phụ (tối đa ' + cfg.total + '). Thử lại sau.' };
      const eng = pick(job, want);
      if (!eng) return { ok: false, error: 'Không có AI nào sẵn sàng (hết hạn mức hoặc không được phép).' };
      const id = ++seq;
      const sub = { id: BASE_ID + id, chat_id: job.chat_id, project: job.project || null, profile: job.profile || null, lane: 'sub', prompt: task, started_at: now(), parent: job.id };
      const s = { id, parent: job.id, task, engine: eng, status: 'running', text: '', error: '', startedAt: now(), endedAt: 0, last: '', kill() {}, done: null };
      subs.set(id, s);
      let h;
      try { h = engines[eng].start({ job: sub, prompt: SUB_PROMPT(task), resumeId: null, onProgress(ev) { const l = describe(ev); if (l) s.last = l; } }); }   // bước gần nhất hiện trong tin trạng thái của AI chính
      catch (e) { s.status = 'error'; s.error = e.message; s.endedAt = now(); return { ok: false, error: 'Không chạy được trợ lý phụ: ' + e.message }; }
      s.kill = h.kill;
      const timer = setTimeout(() => { if (s.status === 'running') { s.status = 'error'; s.error = 'quá thời gian'; s.endedAt = now(); try { h.kill(); } catch (e) { /* đã dừng */ } } }, cfg.timeoutMs);
      if (timer.unref) timer.unref();
      s.done = Promise.resolve(h.done).then((r) => {
        if (s.status !== 'running') return;
        s.endedAt = now();
        if (r && r.ok) { s.status = 'done'; s.text = String(r.text || '').trim().slice(0, RESULT_MAX) || '(không có nội dung)'; }
        else { s.status = 'error'; s.error = String((r && r.error) || 'lỗi không rõ').slice(0, 500); }
      }, (e) => { if (s.status === 'running') { s.status = 'error'; s.error = String(e && e.message || e); s.endedAt = now(); } }).then(() => clearTimeout(timer));
      log('trợ lý phụ #' + id + ' (' + eng + ') của việc #' + job.id + ': ' + task.slice(0, 80).replace(/\s+/g, ' '));
      return { ok: true, id, engine: eng };
    },

    // Chờ các trợ lý (ids trống = tất cả của việc này) xong, tối đa sec giây; trả trạng thái từng trợ lý
    async wait(parentId, ids, sec) {
      const mine = [...subs.values()].filter((s) => s.parent === Number(parentId) && (!ids || !ids.length || ids.includes(s.id)));
      if (!mine.length) return { ok: false, error: 'Chưa giao trợ lý phụ nào (hoặc mã không đúng). Dùng `list` để xem.' };
      const limit = Math.min(Math.max(Number(sec) || 90, 1), 110) * 1000;
      let t; const timeout = new Promise((r) => { t = setTimeout(r, limit); });
      await Promise.race([Promise.all(mine.filter((s) => s.done).map((s) => s.done)), timeout]);
      clearTimeout(t);
      return { ok: true, subs: mine.map(pub), pending: mine.filter((s) => s.status === 'running').length };
    },
    list(parentId) { return { ok: true, subs: [...subs.values()].filter((s) => s.parent === Number(parentId)).map(pub) }; },
    // Tiến độ các trợ lý của một việc (cho tin trạng thái trực tiếp): đang chạy + vừa xong; kèm bước gần nhất
    progress(parentId) {
      return [...subs.values()].filter((s) => s.parent === Number(parentId)).map((s) => ({ id: s.id, engine: s.engine, status: s.status, task: s.task.slice(0, 80), last: s.last, secs: Math.round(((s.endedAt || now()) - s.startedAt) / 1000) }));
    },
    cancel(parentId, id) {
      const s = subs.get(Number(id));
      if (!s || s.parent !== Number(parentId)) return { ok: false, error: 'Không có trợ lý này.' };
      if (s.status === 'running') { try { s.kill(); } catch (e) { /* đã dừng */ } s.status = 'cancelled'; s.endedAt = now(); }
      return { ok: true };
    },
    count: () => [...subs.values()].filter((s) => s.status === 'running').length,
    SUB_PROMPT,
  };
}

module.exports = { createSubagents, BASE_ID };
