'use strict';

const RESUME_FAIL_RE = /no conversation found|session.*not found|thread.*not found|cannot resume|could not resume|error resuming|invalid session/i;
const NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', deepseekapi: 'DeepSeek (API)' };

const NL = String.fromCharCode(10);
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
// `context` (tùy chọn, memory.js): ghép ghi nhớ lâu dài + tóm tắt + việc gần nhất vào đầu câu lệnh khi AI chưa có phiên; afterJob() quyết định xoay phiên.
// `ui` (tùy chọn, live.js): begin/step/end — hiện "đang gõ" + tin trạng thái trực tiếp; `answer(job, text, meta)` (tùy chọn): gửi câu trả lời cuối (Markdown -> Telegram), meta = { engine, primary, name, secs, steps }.
// `router` (tùy chọn, router.js): sắp xếp lại thứ tự AI theo độ khó của việc (câu hỏi nhẹ đi AI rẻ trước).
function createWorker({ db, engines, order, notify, log, cooldownMs, now, outbox, sendFile, engineFilter, preflight, retryDelaysMs, context, router, ui, answer, lanes, projectEngine, overBudget }) {
  lanes = lanes && lanes.length ? lanes : ['main'];
  const isMain = lanes.length === 1 && lanes[0] === 'main';
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
  function buildPrompt(job, hasSession, eng) {
    if (context) return context.pack(job, hasSession, eng);
    if (hasSession) return job.prompt;
    const after = Number(db.kvGet('ctxfrom:' + db.scopeOf(job))) || 0;
    const hist = db.history(db.scopeOf(job), after, job.id, 3);
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
      try { h = engines[eng].start({ job, prompt: buildPrompt(job, !!resumeId, eng), resumeId, onProgress: ui ? (ev) => ui.step(job, ev) : undefined }); } catch (e) {
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
    // Phiên của AI được nhớ THEO DỰ ÁN (phạm vi = cuộc trò chuyện + dự án): đổi dự án thì phiên khác, không lẫn ngữ cảnh
    const scope = db.scopeOf(job);
    let resumeId = isMain ? db.kvGet(sessionKey(scope, eng)) : null;           // việc nền/sự kiện: phiên riêng, không dính phiên trò chuyện chính
    let res;
    for (let i = 0; i < 2; i++) {
      res = await runWithRetry(job, eng, resumeId);
      // Phiên cũ không còn -> làm lại không kèm phiên (một lần).
      if (!res.ok && resumeId && !res.limit && !res.cancelled && !res.timedOut && RESUME_FAIL_RE.test(res.error || '')) {
        db.kvDel(sessionKey(scope, eng));
        resumeId = null;
        continue;
      }
      break;
    }
    if (res.ok && res.sessionId && isMain) db.kvSet(sessionKey(scope, eng), res.sessionId);
    if (res.ok && context && isMain) {
      try { const r = await context.afterJob(job, eng, res); if (r && r.rotate) { db.kvDel(sessionKey(scope, eng)); log('xoay phiên ' + name(eng) + ' của cuộc trò chuyện ' + job.chat_id + ' (ngữ cảnh đã được tóm tắt)'); } }
      catch (e) { log('cập nhật ngữ cảnh lỗi: ' + e.message); }
    }
    return res;
  }

  // HỘI ĐỒNG AI: hai AI làm ĐỘC LẬP (không thấy bài của nhau), AI thứ ba (nếu có, không thì AI thứ nhất) đối chiếu rồi kết luận.
  // Mỗi bước chỉ dùng AI còn hạn mức; AI hết hạn mức giữa chừng thì bỏ qua, thiếu AI thì làm bình thường kèm ghi chú.
  async function councilRun(job, cands) {
    const live = () => cands.filter((e) => available(e));
    const asJob = (p) => Object.assign({}, job, { prompt: p, council: 0 });
    const answers = [];
    const tried = new Set();
    for (const e of live()) {
      if (answers.length >= 2) break;
      tried.add(e);
      const res = await runWithRetry(asJob(job.prompt), e, null);
      if (res.limit) { db.kvSet('cool:' + e, res.resetAt || now() + cooldownMs); continue; }
      if (res.cancelled) return { cancelled: true, error: res.error };
      if (res.ok) answers.push({ eng: e, text: String(res.text || '').trim() }); else await safeNotify(job.chat_id, name(e) + ' lỗi trong hội đồng, bỏ qua: ' + String(res.error || '').slice(0, 200));
    }
    if (answers.length < 2) return { fallback: true, answers };
    const pool = live().filter((e) => !tried.has(e)).concat(answers.map((a) => a.eng));
    const judge = pool[0];
    const rp = 'Bạn là TRỌNG TÀI của hội đồng AI. Yêu cầu gốc của chủ máy:' + NL + '<<<' + job.prompt + '>>>' + NL + NL +
      'Ý KIẾN 1 (' + name(answers[0].eng) + '):' + NL + '<<<' + answers[0].text.slice(0, 6000) + '>>>' + NL + NL +
      'Ý KIẾN 2 (' + name(answers[1].eng) + '):' + NL + '<<<' + answers[1].text.slice(0, 6000) + '>>>' + NL + NL +
      'Hãy: (1) nêu các điểm HAI Ý KIẾN KHÁC NHAU (số liệu, kết luận, các bước); (2) với mỗi điểm khác, kiểm tra lại bằng công cụ nếu có thể (đọc tệp, tính lại) và nói bên nào đúng, có căn cứ gì; ' +
      '(3) đưa KẾT LUẬN CUỐI rõ ràng, và nêu điều chủ máy nên tự xác nhận nếu vẫn chưa chắc. Nếu hai ý kiến giống nhau thì nói ngắn gọn là thống nhất. Không lặp lại nguyên văn hai ý kiến.';
    const jr = await runWithRetry(asJob(rp), judge, null);
    if (jr.limit) db.kvSet('cool:' + judge, jr.resetAt || now() + cooldownMs);
    const verdict = jr.ok ? String(jr.text || '').trim() : '(Trọng tài ' + name(judge) + ' không trả lời được: ' + String(jr.error || 'lỗi').slice(0, 150) + '. Xem hai ý kiến bên dưới tự đối chiếu.)';
    const cut = (s) => (s.length > 1500 ? s.slice(0, 1500) + '…' : s);
    return { ok: true, judge, answers, text: '🏛️ HỘI ĐỒNG AI — ' + name(answers[0].eng) + ' và ' + name(answers[1].eng) + ' làm độc lập, ' + name(judge) + ' đối chiếu' + NL + NL + verdict +
      NL + NL + '— Ý kiến ' + name(answers[0].eng) + ':' + NL + cut(answers[0].text) + NL + NL + '— Ý kiến ' + name(answers[1].eng) + ':' + NL + cut(answers[1].text) };
  }

  async function runOne() {
    const job = db.claimNext(now(), lanes);
    if (!job) return false;
    const wasWaiting = job.run_after != null;
    const permitted = engineFilter ? engineFilter(job) : null;
    let cands = (job.engine_pref ? [job.engine_pref] : order).filter((e) => engines[e] && (!permitted || permitted.includes(e)));
    if (router && cands.length) cands = router.order(job, cands);
    // AI ưu tiên của dự án (nếu chủ máy đặt) đứng đầu; các AI còn lại vẫn là dự phòng nên hết hạn mức thì tự chuyển, dữ liệu dự án dùng chung
    if (projectEngine && job.project && !job.engine_pref) { const pe = projectEngine(job); if (pe && cands.includes(pe)) cands = [pe].concat(cands.filter((e) => e !== pe)); }
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
    if (job.council) {
      if (ui) { try { ui.begin(job); } catch (e) { log('bắt đầu tin trạng thái lỗi: ' + e.message); } }
      let cr;
      try { cr = await councilRun(job, cands); } catch (e) { cr = { ok: false, error: e.message }; }
      let cmeta = { secs: 0, steps: 0 };
      if (ui) { try { cmeta = await ui.end(job); } catch (e) { /* bỏ qua */ } }
      if (cr.cancelled) { db.finishJob(job.id, 'cancelled', { error: cr.error }); await safeNotify(job.chat_id, 'Việc #' + job.id + ' đã hủy.'); return true; }
      if (cr.ok) {
        db.finishJob(job.id, 'done', { result: cr.text });
        if (answer) { try { await answer(job, cr.text, { engine: cr.judge, primary: order[0], name: name(cr.judge), secs: cmeta.secs, steps: cmeta.steps }); } catch (e) { await safeNotify(job.chat_id, cr.text); } } else await safeNotify(job.chat_id, cr.text);
        return true;
      }
      if (!cr.fallback) { db.finishJob(job.id, 'error', { error: cr.error || 'lỗi' }); await safeNotify(job.chat_id, 'Việc #' + job.id + ' (hội đồng) lỗi: ' + String(cr.error || '').slice(0, 300)); return true; }
      await safeNotify(job.chat_id, 'Hội đồng cần ít nhất 2 AI còn hạn mức (hiện chỉ có ' + cr.answers.length + '). Em làm bình thường bằng một AI.');
    }
    const tried = new Set();
    let res = null, used = null;
    log('bắt đầu việc #' + job.id + (wasWaiting ? ' (sau khi chờ hạn mức)' : ''));

    if (ui) { try { ui.begin(job); } catch (e) { log('bắt đầu tin trạng thái lỗi: ' + e.message); } }
    try {
    for (;;) {
      // Ưu tiên AI còn trong ngân sách tháng (trần mềm: AI nào cũng vượt thì vẫn chạy bình thường)
      const eng = cands.find((e) => !tried.has(e) && available(e) && !(overBudget && overBudget(e))) || cands.find((e) => !tried.has(e) && available(e));
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

    } catch (e) { if (ui) await Promise.resolve(ui.end(job)).catch(() => {}); throw e; }
    let meta = { secs: 0, steps: 0 };
    if (ui) { try { meta = await ui.end(job); } catch (e) { /* bỏ qua */ } }

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
      const body = res.text || '(không có nội dung trả về)';
      if (answer) {
        try { await answer(job, body, { engine: used, primary: order[0], name: name(used), secs: meta.secs, steps: meta.steps }); }
        catch (e) { log('gửi câu trả lời đẹp lỗi: ' + e.message); await safeNotify(job.chat_id, tag + ' xong:\n' + body); }
      } else await safeNotify(job.chat_id, tag + ' xong:\n' + body);
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
