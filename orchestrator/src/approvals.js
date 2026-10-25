'use strict';
const { LABEL } = require('./policy');

// Quản lý yêu cầu xin quyền qua Telegram (nút bấm). Mỗi yêu cầu chờ tối đa timeoutMs rồi tự TỪ CHỐI.
//   ask(chatId, text, buttons) -> Promise<messageId>     buttons: [[{text, data}]]
//   edit(chatId, messageId, text) -> Promise
//   isAdmin(userId) -> bool        người không phải admin không duyệt được lệnh/ghi file/công cụ lạ
function createApprovals({ db, ask, edit, isAdmin, timeoutMs, log, now, askChat }) {
  log = log || (() => {});
  now = now || Date.now;
  isAdmin = isAdmin || (() => true);
  timeoutMs = timeoutMs || 300000;
  const pending = new Map();
  let seq = 0;

  const header = (job, d) => '🔐 Việc #' + job.id + (job.lane === 'hook' ? ' (từ webhook)' : '') + ' xin quyền: ' + (LABEL[d.cls] || 'Dùng công cụ') + '\n' + d.summary +
    (d.warn ? '\n\n⚠️ ' + d.warn : '');

  async function finish(id, allowed, remember, source, by, label) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    try { db.addAudit({ jobId: p.job.id, tool: p.tool, cls: p.d.cls, decision: allowed ? 'allow' : 'deny', source, summary: p.d.summary }); } catch (e) { log('ghi nhật ký lỗi: ' + e.message); }
    if (p.msgId) edit(p.target, p.msgId, header(p.job, p.d) + '\n\n' + label).catch(() => {});
    p.resolve({ allowed, remember: !!remember, source, by });
    return true;
  }

  return {
    // Gửi câu hỏi và chờ người dùng bấm. Luôn resolve (không bao giờ reject): lỗi gửi tin = từ chối.
    request(job, tool, d) {
      const id = String(++seq) + Math.random().toString(36).slice(2, 6);
      return new Promise((resolve) => {
        const p = { job, tool, d, resolve, msgId: null, timer: null, target: askChat ? askChat(job) : job.chat_id };
        pending.set(id, p);
        p.timer = setTimeout(() => finish(id, false, false, 'timeout', null, '⏱ Hết thời gian chờ, đã tự từ chối.'), timeoutMs);
        const row = [{ text: '✅ Cho phép', data: 'ap:' + id + ':y' }];
        if (d.canRemember) row.push({ text: '✅ Cho phép cả việc này', data: 'ap:' + id + ':r' });
        row.push({ text: '❌ Từ chối', data: 'ap:' + id + ':n' });
        Promise.resolve().then(() => ask(p.target, header(job, d) + (String(p.target) !== String(job.chat_id) ? '\n(việc của người dùng ' + job.chat_id + ')' : ''), [row])).then((mid) => { p.msgId = mid; }).catch((e) => {
          log('không gửi được câu hỏi duyệt: ' + e.message);
          finish(id, false, false, 'error', null, '⚠️ Không gửi được câu hỏi, đã tự từ chối.');
        });
      });
    },
    // Người dùng bấm nút. Trả { ok, text } để hiện lại cho người bấm.
    async answer(data, userId) {
      const m = /^ap:([\w]+):([yrn])$/.exec(String(data));
      if (!m) return { ok: false, text: 'Nút không hợp lệ.' };
      const p = pending.get(m[1]);
      if (!p) return { ok: false, text: 'Yêu cầu này đã hết hạn hoặc đã được trả lời.' };
      const risky = p.d.cls === 'exec' || p.d.cls === 'write' || p.d.cls === 'other';
      if (risky && !isAdmin(String(userId))) return { ok: false, text: 'Chỉ quản trị viên được duyệt việc này.' };
      if (m[2] === 'n') { await finish(m[1], false, false, 'user', userId, '❌ Đã từ chối.'); return { ok: true, text: 'Đã từ chối.' }; }
      const remember = m[2] === 'r' && p.d.canRemember;
      await finish(m[1], true, remember, 'user', userId, remember ? '✅ Đã cho phép (cả việc này).' : '✅ Đã cho phép.');
      return { ok: true, text: 'Đã cho phép.' };
    },
    // Việc kết thúc/bị hủy: từ chối mọi câu hỏi còn treo của việc đó.
    cancelJob(jobId) {
      for (const [id, p] of [...pending]) if (p.job.id === jobId) finish(id, false, false, 'cancel', null, '🚫 Việc đã dừng.');
    },
    pendingCount() { return pending.size; },
    now,
  };
}

module.exports = { createApprovals };
