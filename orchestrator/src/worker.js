'use strict';

const RESUME_FAIL_RE = /no conversation found|session.*not found|thread.*not found|cannot resume|could not resume/i;
const NAMES = { claude: 'Claude', codex: 'Codex' };

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ms) {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
}

// Hàng đợi tuần tự. `engines` = { claude: { start({job,prompt,resumeId}) -> {done,kill} }, codex: ... }
// `order` = thứ tự ưu tiên. Hết hạn mức ở engine nào -> ghi "nghỉ đến lúc hồi" rồi chuyển sang engine kế;
// hết cả thì việc chuyển sang 'waiting' và tự chạy lại khi tới giờ.
// `outbox(since)` (tùy chọn) trả danh sách file kết quả AI vừa tạo; `sendFile(chatId, file)` gửi từng file.
// `engineFilter(job)` (tùy chọn) trả danh sách engine được phép chạy việc đó (theo bộ công cụ); null = tất cả.
// `preflight(job)` (tùy chọn) trả chuỗi lỗi nếu máy chưa sẵn sàng chạy việc (ví dụ ổ đĩa gần đầy), null nếu ổn.
// `retryDelaysMs`: khoảng chờ giữa các lần thử lại khi gặp lỗi tạm thời (mặc định 15s, 60s, 180s).
function createWorker({ db, engines, order, notify, log, cooldownMs, now, outbox, sendFile, engineFilter, preflight, retryDelaysMs }) {
  retryDelaysMs = retryDelaysMs || [15000, 60000, 180000];
  log = log || (() => {});
  now = now || Date.now;
  cooldownMs = cooldownMs || 60 * 60 * 1000;
  let current = null;       // { jobId, chatId, kill }
  let running = false;
  let again = false;
  let stopped = false;

  const name = (e) => NAMES[e] || e;
  const sessionKey = (chatId, eng) => 'session:' + chatId + ':' + eng;
  const cooldownUntil = (eng) => Number(db.kvGet('cool:' + eng)) || 0;
  const available = (eng) => cooldownUntil(eng) <= now();

  async function safeNotify(chatId, text) {
    try { await notify(chatId, text); } catch (e) { log('gửi tin lỗi: ' + e.message); }
  }

  // Gửi ảnh/file AI tạo ra trong lúc làm việc này (mtime >= lúc bắt đầu việc).
  async function sendOutputs(job) {
    if (!outbox || !sendFile) return;
    let files = [];
    try { files = outbox(job.started_at || 0); } catch (e) { log('quét hộp thư ra lỗi: ' + e.message); return; }
    for (const f of files) {
      try { await sendFile(job.chat_id, f); } catch (e) { log('gửi file ' + f.name + ' lỗi: ' + e.message); }
    }
  }

  // Khi engine mới chưa có phiên (vừa chuyển engine hoặc phiên mất), đưa kèm tóm tắt các việc trước
  // trong cuộc trò chuyện để nó nối tiếp được. /moi đặt mốc cắt nên không lòi ngữ cảnh cũ.
  function buildPrompt(job, hasSession) {
    if (hasSession) return job.prompt;
    const after = Number(db.kvGet('ctxfrom:' + job.chat_id)) || 0;
    const hist = db.history(job.chat_id, after, job.id, 3);
    if (!hist.length) return job.prompt;
    const lines = hist.map((h) => 'Việc #' + h.id + ': ' + h.prompt.slice(0, 500) + '\nKết quả: ' + String(h.result || '').slice(0, 600));
    return '[Ngữ cảnh các việc trước trong cuộc trò chuyện này, chỉ để tham khảo]\n' + lines.join('\n\n') +
      '\n[Hết ngữ cảnh]\n\nYêu cầu mới:\n' + job.prompt;
  }

  // Chờ có thể hủy được (/huy trong lúc chờ thử lại). Trả true nếu bị hủy.
  function waitCancellable(job, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { current = null; resolve(false); }, ms);
      current = { jobId: job.id, chatId: job.chat_id, kill: () => { clearTimeout(t); current = null; resolve(true); } };
    });
  }

  // Một lần chạy engine; gặp lỗi TẠM THỜI (máy chủ AI quá tải, rớt mạng) thì thử lại sau vài giây thay vì cho engine nghỉ cả giờ.
  async function runWithRetry(job, eng, resumeId) {
    for (let n = 0; ; n++) {
      let h;
      try { h = engines[eng].start({ job, prompt: buildPrompt(job, !!resumeId), resumeId }); } catch (e) {
        return { ok: false, limit: false, error: 'Không khởi động được ' + name(eng) + ': ' + e.message };
      }
      current = { jobId: job.id, chatId: job.chat_id, kill: h.kill };
      const res = await h.done;
      current = null;
      if (res.ok || !res.transient || n >= retryDelaysMs.length || stopped) return res;
      log(name(eng) + ' lỗi tạm thời (' + String(res.error || '').slice(0, 120) + '), thử lại lần ' + (n + 1) + ' sau ' + Math.round(retryDelaysMs[n] / 1000) + 's');
      if (n === 0) await safeNotify(job.chat_id, 'Dịch vụ AI đang quá tải hoặc mất kết nối, em sẽ tự thử lại (việc #' + job.id + ').');
      if (await waitCancellable(job, retryDelaysMs[n])) return { ok: false, limit: false, cancelled: true, error: 'Đã hủy' };
    }
  }

  async function attempt(job, eng) {
    db.setEngine(job.id, eng);
    let resumeId = db.kvGet(sessionKey(job.chat_id, eng));
    let res;
    for (let i = 0; i < 2; i++) {
      res = await runWithRetry(job, eng, resumeId);
      // Phiên cũ không còn -> làm lại không kèm phiên (một lần).
      if (!res.ok && resumeId && !res.limit && !res.cancelled && !res.timedOut && RESUME_FAIL_RE.test(res.error || '')) {
        db.kvDel(sessionKey(job.chat_id, eng));
        resumeId = null;
        continue;
      }
      break;
    }
    if (res.ok && res.sessionId) db.kvSet(sessionKey(job.chat_id, eng), res.sessionId);
    return res;
  }

  async function runOne() {
    const job = db.claimNext(now());
    if (!job) return false;
    const wasWaiting = job.run_after != null;
    const permitted = engineFilter ? engineFilter(job) : null;
    const cands = (job.engine_pref ? [job.engine_pref] : order).filter((e) => engines[e] && (!permitted || permitted.includes(e)));
    if (!cands.length) {
      // Ví dụ: /web chỉ chạy trên Claude (Codex không qua cổng duyệt) mà người dùng ép /codex, hoặc Claude không được bật.
      const why = 'Việc #' + job.id + ' không chạy được: bộ công cụ' + (job.profile ? ' /' + job.profile : '') + ' chỉ chạy trên ' +
        ((permitted && permitted.map(name).join(', ')) || 'engine nào đó') + ', mà engine đó không có hoặc không được chọn.';
      db.finishJob(job.id, 'error', { error: why });
      await safeNotify(job.chat_id, why);
      return true;
    }
    const notReady = preflight ? preflight(job) : null;
    if (notReady) {
      db.finishJob(job.id, 'error', { error: notReady });
      await safeNotify(job.chat_id, 'Việc #' + job.id + ' chưa chạy được: ' + notReady);
      return true;
    }
    const tried = new Set();
    let res = null, used = null;
    log('bắt đầu việc #' + job.id + (wasWaiting ? ' (sau khi chờ hạn mức)' : ''));

    for (;;) {
      const eng = cands.find((e) => !tried.has(e) && available(e));
      if (!eng) break;
      used = eng;
      res = await attempt(job, eng);
      if (!res.limit) break;
      const until = res.resetAt || now() + cooldownMs;
      db.kvSet('cool:' + eng, until);
      tried.add(eng);
      log(name(eng) + ' chạm giới hạn, nghỉ đến ' + fmtTime(until));
      const next = cands.find((e) => !tried.has(e) && available(e));
      if (next) await safeNotify(job.chat_id, name(eng) + ' đã hết hạn mức (hồi khoảng ' + fmtTime(until) + '). Chuyển việc #' + job.id + ' sang ' + name(next) + '.');
    }

    // Không còn engine nào dùng được lúc này -> chờ engine hồi sớm nhất.
    if (!res || res.limit) {
      const times = cands.map(cooldownUntil).filter((t) => t > now());
      const until = times.length ? Math.min(...times) : now() + 60000;
      db.setWaiting(job.id, until);
      if (!wasWaiting) {
        await safeNotify(job.chat_id, 'Việc #' + job.id + ' đang chờ vì ' + cands.map(name).join(' và ') +
          ' đều hết hạn mức. Sẽ tự chạy lại khoảng ' + fmtTime(until) + '. Gõ /huy nếu không cần nữa.');
      }
      return true;
    }

    const tag = 'Việc #' + job.id + (used !== order[0] ? ' (' + name(used) + ')' : '');
    if (res.ok) {
      db.finishJob(job.id, 'done', { result: res.text, sessionId: res.sessionId, costUsd: res.costUsd });
      await safeNotify(job.chat_id, tag + ' xong:\n' + (res.text || '(không có nội dung trả về)'));
      await sendOutputs(job);
    } else if (res.cancelled) {
      db.finishJob(job.id, 'cancelled', { error: res.error });
      await safeNotify(job.chat_id, 'Việc #' + job.id + ' đã hủy.');
    } else if (res.timedOut) {
      db.finishJob(job.id, 'error', { error: res.error });
      await safeNotify(job.chat_id, 'Việc #' + job.id + ' dừng vì quá thời gian cho phép.');
    } else {
      db.finishJob(job.id, 'error', { error: res.error });
      await safeNotify(job.chat_id, tag + ' lỗi: ' + String(res.error || 'không rõ').slice(0, 800));
    }
    return true;
  }

  async function loop() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        while (!stopped && (await runOne())) { /* làm hết hàng đợi */ }
      } while (again && !stopped);
    } catch (e) {
      log('worker lỗi: ' + (e && e.stack || e));
    } finally { running = false; }
  }

  return {
    wake() { return loop(); },
    // Hủy việc đang chạy của chat này (nếu có). Trả true nếu có việc bị hủy.
    cancelRunning(chatId) {
      if (current && String(current.chatId) === String(chatId)) { current.kill('cancelled'); return true; }
      return false;
    },
    currentJobId() { return current ? current.jobId : null; },
    engineNames() { return Object.keys(engines); },
    // Tình trạng các engine: until > now nghĩa là đang nghỉ vì hết hạn mức.
    engineStatus() { return order.filter((e) => engines[e]).map((e) => ({ name: e, label: name(e), until: cooldownUntil(e) > now() ? cooldownUntil(e) : 0 })); },
    async stop() {
      stopped = true;
      if (current) current.kill('cancelled');
      while (running) await new Promise((r) => setTimeout(r, 50));
    },
  };
}

module.exports = { createWorker, fmtTime, NAMES };
