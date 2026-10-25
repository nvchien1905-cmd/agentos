'use strict';
const { describe } = require('./progress');
const { esc } = require('./tgFormat');

// TIN TRẠNG THÁI TRỰC TIẾP (như thanh tiến trình của Claude Code): khi AI đang làm, bot hiện "đang gõ" và MỘT tin trạng thái được sửa liên tục
// ("⏳ Đang làm… 12 giây" + vài bước gần nhất: ▶️ lệnh đang chạy, 📖 tệp đang đọc, 💬 AI đang nói gì). Xong thì xóa tin trạng thái và gửi câu trả lời sạch.
// Tin trạng thái chỉ hiện nếu việc kéo dài hơn `showAfterMs` (câu hỏi nhanh không nháy tin thừa). Sửa tin tối đa 1 lần / `throttleMs` (Telegram giới hạn).
function createLive(o) {
  const tg = o.tg, log = o.log || (() => {});
  const now = o.now || Date.now;
  const setT = o.setTimeout || setTimeout, clearT = o.clearTimeout || clearTimeout, setI = o.setInterval || setInterval, clearI = o.clearInterval || clearInterval;
  const throttleMs = o.throttleMs === undefined ? 2500 : o.throttleMs, showAfterMs = o.showAfterMs === undefined ? 1800 : o.showAfterMs, typingMs = o.typingMs || 4500, maxSteps = o.maxSteps || 4;
  const jobs = new Map();

  function render(st) {
    const secs = Math.max(0, Math.round((now() - st.start) / 1000));
    const hidden = st.steps.length - maxSteps;
    const shown = st.steps.slice(-maxSteps).map((x) => esc(x));
    return '⏳ <b>Đang làm…</b> <i>' + secs + ' giây' + (st.steps.length ? ' · ' + st.steps.length + ' bước' : '') + '</i>' +
      (hidden > 0 ? '\n<i>… ' + hidden + ' bước trước</i>' : '') + (shown.length ? '\n' + shown.join('\n') : '');
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
      const st = { chat: job.chat_id, start: now(), steps: [], msgId: null, timer: null, last: 0, ended: false, visible: false, typing: null, show: null };
      jobs.set(job.id, st);
      Promise.resolve(tg.sendChatAction(st.chat, 'typing')).catch(() => {});
      st.typing = setI(() => { Promise.resolve(tg.sendChatAction(st.chat, 'typing')).catch(() => {}); }, typingMs);
      st.show = setT(() => { st.visible = true; schedule(st); }, showAfterMs);
      for (const t of [st.typing, st.show]) if (t && t.unref) t.unref();
    },
    step(job, ev) {
      const st = jobs.get(job.id); if (!st || st.ended) return;
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
      if (st.msgId) { try { await tg.deleteMessage(st.chat, st.msgId); } catch (e) { /* bỏ qua */ } }
      return { secs: Math.max(0, Math.round((now() - st.start) / 1000)), steps: st.steps.filter((x) => !x.startsWith('💬 ')).length };
    },
  };
}

module.exports = { createLive };
