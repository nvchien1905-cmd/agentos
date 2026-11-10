'use strict';
// Vòng lặp hộp thư giao việc (xem mail.js).
//  - Bot THƯỜNG (agent): mỗi vài giây nhận việc bot quản lý giao -> xếp vào hàng đợi như chủ máy nhắn -> việc xong thì ghi kết quả vào out/.
//  - Bot QUẢN LÝ: mỗi vài giây đọc kết quả của các bot thường -> nhắn lại cho người đã giao.
const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted', 'limit']);
const MAX_AGE_MS = 6 * 3600 * 1000;           // quá 6 giờ không xong thì báo lỗi, khỏi treo mãi

function startMailWorker({ mail, db, crew, cfg, log, now, intervalMs }) {
  now = now || Date.now;
  const load = () => { try { const j = JSON.parse(db.kvGet('mail_pending') || '{}'); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } };
  const save = (p) => { try { db.kvSet('mail_pending', JSON.stringify(p)); } catch (e) { /* bỏ qua */ } };
  function tick() {
    const pend = load();
    let changed = false;
    // 1) việc mới
    let jobs = [];
    try { jobs = mail.take(cfg.agentId, cfg.allowedUserIds); } catch (e) { log('hộp thư: ' + e.message); }
    for (const j of jobs) {
      try {
        const prompt = 'Việc do bot quản lý giao (làm xong, trả lời kết quả ngắn gọn, nêu rõ đã làm gì):\n' + j.text;
        const id = db.addJob(j.from, prompt, null, null, 'main');
        pend[j.jid] = { jobId: id, chat: j.chat, task: j.text.slice(0, 200), at: now() };
        changed = true;
        log('hộp thư: nhận việc ' + j.jid.slice(0, 6) + ' từ bot quản lý (việc #' + id + ')');
        setImmediate(() => crew.wake());
      } catch (e) {
        log('hộp thư: không xếp được việc: ' + e.message);
        try { mail.finish(cfg.agentId, { jid: j.jid, chat: j.chat, task: j.text, status: 'error', text: 'Bot không xếp được việc: ' + e.message }); } catch (e2) { /* bỏ qua */ }
      }
    }
    // 2) việc đã xong -> trả kết quả
    for (const [jid, p] of Object.entries(pend)) {
      let status = null, text = '';
      let job = null; try { job = db.getJob(p.jobId); } catch (e) { /* bỏ qua */ }
      if (!job) { status = 'error'; text = 'Không còn thấy việc trong bot (có thể bot vừa khởi động lại).'; }
      else if (TERMINAL.has(job.status)) {
        status = job.status === 'done' ? 'done' : job.status === 'cancelled' ? 'cancelled' : 'error';
        text = job.status === 'done' ? String(job.result || '(không có nội dung trả lời)') : job.status === 'limit' ? 'Bot hết hạn mức AI, việc dừng lại.' : String(job.error || (job.status === 'interrupted' ? 'Việc bị ngắt (bot khởi động lại).' : 'Lỗi không rõ.'));
      } else if (now() - (p.at || 0) > MAX_AGE_MS) { status = 'error'; text = 'Quá 6 giờ chưa xong, bot quản lý ngừng chờ.'; }
      if (!status) continue;
      try { mail.finish(cfg.agentId, { jid, chat: p.chat, task: p.task, status, text }); delete pend[jid]; changed = true; }
      catch (e) { log('hộp thư: không ghi được kết quả ' + jid.slice(0, 6) + ': ' + e.message); }
    }
    if (changed) save(pend);
  }
  const t = setInterval(() => { try { tick(); } catch (e) { log('hộp thư lỗi: ' + e.message); } }, intervalMs || 3000);
  if (t.unref) t.unref();
  return { tick, stop: () => clearInterval(t) };
}

function startMailCollector({ mail, agents, send, log, intervalMs }) {
  async function tick() {
    for (const a of agents.all()) {
      let rs = []; try { rs = mail.collect(a.id); } catch (e) { /* bỏ qua */ }
      for (const r of rs) {
        const head = (r.status === 'done' ? '✅ ' : '⚠️ ') + a.name + (a.bot && a.bot.username ? ' (@' + a.bot.username + ')' : '') + (r.status === 'done' ? ' đã xong việc' : r.status === 'rejected' ? ' từ chối việc' : ' báo lỗi việc') + (r.task ? ' "' + r.task.slice(0, 80) + '"' : '') + ':\n';
        try { await send(r.chat, head + (r.text || '(trống)').slice(0, 3500)); } catch (e) { log('hộp thư: không báo được kết quả của ' + a.id + ': ' + e.message); }
      }
    }
  }
  const t = setInterval(() => { tick().catch((e) => log('hộp thư lỗi: ' + e.message)); }, intervalMs || 4000);
  if (t.unref) t.unref();
  return { tick, stop: () => clearInterval(t) };
}

module.exports = { startMailWorker, startMailCollector };
