'use strict';
const { describe, clean } = require('./progress');
const { esc } = require('./tgFormat');

// TIN TRẠNG THÁI TRỰC TIẾP (như thanh tiến trình của Claude Code): khi AI đang làm, bot hiện "đang gõ" và MỘT tin trạng thái được sửa liên tục
// ("⏳ Đang làm… 12 giây" + vài bước gần nhất: ▶️ lệnh đang chạy, 📖 tệp đang đọc, 💬 AI đang nói gì). Xong thì xóa tin trạng thái và gửi câu trả lời sạch.
// Tin trạng thái chỉ hiện nếu việc kéo dài hơn `showAfterMs` (câu hỏi nhanh không nháy tin thừa). Sửa tin tối đa 1 lần / `throttleMs` (Telegram giới hạn).
function createLive(o) {
  const tg = o.tg, log = o.log || (() => {});
  const now = o.now || Date.now;
  const setT = o.setTimeout || setTimeout, clearT = o.clearTimeout || clearTimeout, setI = o.setInterval || setInterval, clearI = o.clearInterval || clearInterval;
  const throttleMs = o.throttleMs === undefined ? 2500 : o.throttleMs, showAfterMs = o.showAfterMs === undefined ? 1800 : o.showAfterMs, typingMs = o.typingMs || 4500, maxSteps = o.maxSteps || 4, tickMs = o.tickMs || 4000;
  const subProgress = o.subProgress || (() => []);       // (mã việc) -> [{id, engine, status, task, last, secs}] các trợ lý phụ đang làm cho việc này
  const SUB_ICON = { running: '🤝', done: '✅', error: '⚠️', cancelled: '⏹️' };
  const jobs = new Map();

  function subLines(st) {
    let list; try { list = subProgress(st.jobId) || []; } catch (e) { list = []; }
    if (!list.length) return '';
    const rows = list.slice(-4).map((s) => {
      const what = s.status === 'running' ? (s.last || s.task) : ({ done: 'xong', error: 'lỗi', cancelled: 'đã dừng' }[s.status] || s.status);
      return (SUB_ICON[s.status] || '🤝') + ' Trợ lý #' + s.id + ' (' + s.engine + ') · ' + s.secs + ' giây: ' + esc(what);
    });
    return '\n<i>Trợ lý phụ:</i>\n' + rows.join('\n');
  }
  // Danh sách việc cần làm của AI (công cụ TodoWrite của Claude Code) → ☑ xong · ▶️ đang làm · ☐ chờ
  function todoLines(st) {
    if (!st.todos || !st.todos.length) return '';
    const done = st.todos.filter((t) => t.s === 'completed').length;
    const ico = { completed: '☑', in_progress: '▶️', pending: '☐' };
    const open = st.todos.filter((t) => t.s !== 'completed').slice(0, 6), lastDone = st.todos.filter((t) => t.s === 'completed').slice(-1);
    const rows = st.todos.filter((t) => open.includes(t) || lastDone.includes(t)).map((t) => ico[t.s] + ' ' + esc(t.s === 'in_progress' ? (t.a || t.c) : t.c));
    const more = st.todos.length - rows.length;
    return '\n<i>📋 Việc cần làm ' + done + '/' + st.todos.length + ':</i>\n' + rows.join('\n') + (more > 0 ? '\n<i>… ' + more + ' việc nữa</i>' : '');
  }
  function render(st) {
    const secs = Math.max(0, Math.round((now() - st.start) / 1000));
    const hidden = st.steps.length - maxSteps;
    const shown = st.steps.slice(-maxSteps).map((x) => esc(x));
    return '⏳ <b>Đang làm…</b> <i>' + secs + ' giây' + (st.steps.length ? ' · ' + st.steps.length + ' bước' : '') + '</i>' +
      todoLines(st) + (hidden > 0 ? '\n<i>… ' + hidden + ' bước trước</i>' : '') + (shown.length ? '\n' + shown.join('\n') : '') + subLines(st);
  }
  async function paint(st) {
    st.timer = null; st.last = now();
    if (st.ended) return;
    try {
      if (!st.msgId) { st.msgId = await tg.sendHtml(st.chat, render(st), { disable_notification: true }); if (st.ended && st.msgId) tg.deleteMessage(st.chat, st.msgId); }
      else await tg.editHtml(st.chat, st.msgId, render(st));
    } catch (e) { log('tin trạng thái lỗi: ' + e.message); }
  }
  function schedule(st) {
    if (st.ended || st.timer || !st.visible) return;
    const wait = Math.max(0, st.last + throttleMs - now());
    st.timer = setT(() => paint(st), wait);
    if (st.timer && st.timer.unref) st.timer.unref();
  }

  return {
    begin(job) {
      const st = { chat: job.chat_id, jobId: job.id, start: now(), steps: [], msgId: null, timer: null, last: 0, ended: false, visible: false, typing: null, show: null };
      jobs.set(job.id, st);
      Promise.resolve(tg.sendChatAction(st.chat, 'typing')).catch(() => {});
      st.typing = setI(() => { Promise.resolve(tg.sendChatAction(st.chat, 'typing')).catch(() => {}); }, typingMs);
      st.show = setT(() => { st.visible = true; schedule(st); }, showAfterMs);
      st.tick = setI(() => { if (st.visible) schedule(st); }, tickMs);   // đồng hồ chạy tiếp cả khi chưa có bước nào (vd bot đang lấy dữ liệu)
      for (const t of [st.typing, st.show, st.tick]) if (t && t.unref) t.unref();
    },
    step(job, ev) {
      const st = jobs.get(job.id); if (!st || st.ended) return;
      if (ev && ev.kind === 'tool' && ev.name === 'TodoWrite' && ev.input && Array.isArray(ev.input.todos)) {
        st.todos = ev.input.todos.slice(0, 25).map((t) => ({ c: clean(t && (t.content || t.activeForm), 90), a: clean(t && t.activeForm, 90), s: ['completed', 'in_progress', 'pending'].includes(t && t.status) ? t.status : 'pending' })).filter((t) => t.c);
        schedule(st); return;
      }
      const line = describe(ev);
      if (!line) return;
      if (ev.kind === 'text') { const prev = st.steps[st.steps.length - 1]; if (prev && prev.startsWith('💬 ')) { st.steps[st.steps.length - 1] = line; schedule(st); return; } }   // lời dẫn mới thay lời dẫn trước
      st.steps.push(line);
      if (st.steps.length > 40) st.steps.splice(0, st.steps.length - 40);
      schedule(st);
    },
    // Kết thúc: xóa tin trạng thái; trả { secs, steps } để chèn chân trang vào câu trả lời.
    async end(job) {
      const st = jobs.get(job.id); if (!st) return { secs: 0, steps: 0 };
      st.ended = true; jobs.delete(job.id);
      for (const t of [st.timer, st.show]) if (t) clearT(t);
      if (st.typing) clearI(st.typing);
      if (st.tick) clearI(st.tick);
      if (st.msgId) { try { await tg.deleteMessage(st.chat, st.msgId); } catch (e) { /* bỏ qua */ } }
      return { secs: Math.max(0, Math.round((now() - st.start) / 1000)), steps: st.steps.filter((x) => !x.startsWith('💬 ')).length };
    },
  };
}

module.exports = { createLive };
