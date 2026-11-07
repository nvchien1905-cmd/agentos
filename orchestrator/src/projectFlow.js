'use strict';

// ĐIỀU HƯỚNG DỰ ÁN TRÊN TELEGRAM (mỗi cuộc trò chuyện là một dự án = một cuốn sách riêng; xem projects.js / projectMerge.js):
//   /duan            → danh sách dự án, mỗi dòng có nút "▶️ Tiếp tục" (đặt dự án đó làm dự án đang làm việc, nhắc lại việc gần nhất) và nút "🆕 Dự án mới" ở cuối.
//   Quay lại sau vài giờ (mặc định 3 giờ, kv proj_idle_hours) và nhắn tin thường → KHÔNG giao việc ngay: bot hiện danh sách dự án để chọn, tin nhắn được giữ lại và giao vào dự án được chọn.
//   Mục cuối "🆕 Dự án mới" dành cho tin không liên quan dự án nào: bot hỏi TÊN dự án ngay trên Telegram (gõ tên, hoặc bấm "Bot tự đặt tên" thì tên lấy theo câu đầu tiên), rồi giao tin đã giữ.
//   Tên dự án sửa được ở Cài đặt → Dự án (cả dự án cũ lẫn mới).
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const DEFAULT_IDLE_H = 3;

function createProjectFlow(o) {
  const { db, projects, isAdmin, submit } = o;
  const sess = o.sessions || null, worker = o.worker || null;
  const now = o.now || Date.now;
  const kHold = (c) => 'pj:hold:' + c, kName = (c) => 'pj:name:' + c, kLast = (c) => 'pj:lastat:' + c;
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
  const idleMs = () => { const h = Number(db.kvGet('proj_idle_hours')); return (h > 0 ? h : DEFAULT_IDLE_H) * 3600000; };
  const label = (p) => (p.home ? 'Chung (dự án tổng)' : p.name);
  const ago = (t) => {
    const m = Math.max(0, Math.round((now() - t) / 60000));
    return m < 2 ? 'vừa xong' : m < 60 ? m + ' phút trước' : m < 48 * 60 ? Math.round(m / 60) + ' giờ trước' : Math.round(m / 1440) + ' ngày trước';
  };

  // Dự án người này dùng được, mới làm việc gần đây nhất trước (kèm dự án tổng của chính họ)
  function usable(chatId, uid) {
    const out = projects.list().filter((p) => !p.home && projects.canUse(uid, p, isAdmin));
    const h = projects.homeOf(chatId);
    if (h && !out.some((p) => p.id === h.id) && projects.canUse(uid, h, isAdmin)) out.push(h);
    return out.map((p) => Object.assign({ at: projects.lastActive(p.id) }, p)).sort((a, b) => b.at - a.at);
  }

  // Ghi mốc nhắn tin; trả mốc LẦN TRƯỚC (0 = chưa từng nhắn)
  function touch(chatId) { const prev = Number(db.kvGet(kLast(chatId))) || 0; db.kvSet(kLast(chatId), now()); return prev; }

  const lastRecap = (chatId, p) => {
    let h = null; try { h = db.history(chatId + '#' + p.id, 0, 1e12, 1)[0]; } catch (e) { /* bỏ qua */ }
    return h ? 'Việc gần nhất: "' + cut(h.prompt, 120) + '" → ' + cut(h.result, 220) : 'Dự án này chưa có việc nào.';
  };

  // /duan: danh sách + nút. Trả { text, buttons } (không có dự án nào thì chỉ có nút "Dự án mới").
  function listButtons(chatId, uid, max) {
    const cur = projects.active(chatId), list = usable(chatId, uid).slice(0, max || 8);
    const rows = list.map((p) => [{ text: (cur && cur.id === p.id ? '▶️ ' : '📁 ') + cut(label(p), 26), data: 'pj:info:' + p.id }, { text: '▶️ Tiếp tục', data: 'pj:go:' + p.id }]);
    rows.push([{ text: '🆕 Dự án mới', data: 'pj:new' }]);
    return { rows, list, cur };
  }

  // BẢNG PHIÊN (/phien, /duan): mỗi cuộc trò chuyện một dòng có trạng thái + nút Xem / Tiếp tục / Dừng (xem sessions.js)
  function board(chatId, uid) {
    const cur = projects.active(chatId), rows = sess ? sess.list(chatId, usable(chatId, uid)) : [], shown = rows.slice(0, 8);
    const btn = shown.map((r) => { const row = [{ text: r.state.icon + ' ' + cut(r.name, 14), data: 'pj:peek:' + r.id }, { text: '▶️ Tiếp tục', data: 'pj:go:' + r.id }]; if (['lam', 'hang', 'cho'].includes(r.state.key)) row.push({ text: '⏹ Dừng', data: 'pj:stop:' + r.id }); return row; });
    btn.push([{ text: '🆕 Dự án mới', data: 'pj:new' }]);
    return { empty: !rows.length, rows: btn, text: '📋 Các cuộc trò chuyện của anh (đang làm / cần duyệt lên đầu):\n\n' + shown.map((r) => sess.lineOf(r, cur)).join('\n\n') + (rows.length > 8 ? '\n…còn ' + (rows.length - 8) + ' cuộc nữa' : '') +
      '\n\nBấm tên để xem nhanh · ▶️ Tiếp tục để làm việc trong cuộc đó · ⏹ Dừng để hủy việc đang chạy/chờ. Chế độ quyền của cuộc hiện tại: /cheodo' };
  }
  // /cheodo: thẻ chọn chế độ quyền của dự án đang ở (hỏi từng lần / tự sửa / chỉ lập kế hoạch / chạy thẳng)
  const MODE_HELP = { hoi: 'mọi việc ghi/chạy lệnh đều hỏi anh qua Telegram', tusua: 'tự sửa tệp trong thư mục dự án; chạy lệnh vẫn hỏi', kehoach: 'chỉ được đọc/xem web, không sửa hay chạy gì — AI trình bày kế hoạch để anh duyệt', chay: 'MẶC ĐỊNH — AI làm một mạch, không hỏi xin phép (ID thường vẫn chạy trong hộp cô lập riêng)' };
  function modeCard(chatId, uid) {
    const p = projects.active(chatId);
    if (!p) return { text: 'Anh đang ở chế độ chung, chưa có dự án để đặt chế độ quyền. Gõ /duan để vào một dự án.' };
    const cur = p.mode || 'chay', R = p.rules || {}, nr = (R.allow || []).length + (R.ask || []).length + (R.deny || []).length;
    const names = (sess && sess.MODE_LABEL) || {};
    const modes = ['chay', 'hoi', 'tusua', 'kehoach'];
    const rows = []; for (let i = 0; i < modes.length; i += 2) rows.push(modes.slice(i, i + 2).map((m) => ({ text: (cur === m ? '✅ ' : '') + (names[m] || m), data: 'pj:mode:' + m })));
    return { text: '🛡 Chế độ quyền của ' + label(p) + ': ' + (names[cur] || cur) + '\n' + modes.map((m) => '• ' + (names[m] || m) + ': ' + MODE_HELP[m]).join('\n') + '\n\nLuật riêng: ' + (nr ? nr + ' luật (xem /duan luat)' : 'chưa có (thêm bằng /duan luat cam|hoi|cho …)'), buttons: rows };
  }

  // /hoantac: MỐC KHÔI PHỤC của dự án đang ở (checkpoints.js): bot tự chụp thư mục dự án trước mỗi việc; AI sửa hỏng thì xem thay đổi rồi quay về mốc
  const ck = o.checkpoints || null;
  const jr = o.journal || null;           // nhật ký "trước khi sửa" toàn máy (journal.js): chỉ chủ máy thấy/quay lại
  const clock = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, '0'); return (new Date(now()).toDateString() === d.toDateString() ? '' : p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ') + p(d.getHours()) + ':' + p(d.getMinutes()); };
  const names = (arr, mark) => arr.slice(0, 8).map((f) => mark + ' ' + cut(f, 60)).join('\n') + (arr.length > 8 ? '\n…và ' + (arr.length - 8) + ' tệp nữa' : '');
  async function checkCard(chatId, uid) {
    const base = await checkCardBase(chatId, uid);
    if (!jr || !isAdmin(uid)) return base;
    let list = []; try { list = (await jr.list(10)).filter((x) => x.files || (x.unsafe && x.unsafe.length)).slice(0, 5); } catch (e) { list = []; }
    if (!list.length) return base;
    const mb = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1048576)) + ' MB');
    const lines = list.map((x) => '#' + x.id + ' · ' + clock(x.at) + ' · ' + cut(x.label || 'việc', 34) + ' · ' + x.files + ' mục, ' + mb(x.bytes) + (x.unsafe && x.unsafe.length ? ' · ⚠️ ' + x.unsafe.length + ' việc không hoàn tác được tự động' : ''));
    const text = (typeof base === 'string' ? base : base.text) + '\n\n🗂 Việc đã sửa tệp trên máy (kể cả ngoài dự án, tệp lớn; bot lưu bản gốc TRƯỚC khi sửa):\n' + lines.join('\n');
    const buttons = ((base && base.buttons) || []).concat(list.map((x) => [{ text: '🗂 #' + x.id + ' · ' + cut(x.label || 'việc', 22), data: 'pj:jr:show:' + x.id }]));
    return { text, buttons };
  }
  async function checkCardBase(chatId, uid) {
    if (!ck) return 'Máy này chưa hỗ trợ mốc khôi phục.';
    const p = projects.active(chatId);
    if (!p) return 'Anh đang ở chế độ chung, chưa có thư mục dự án để quay về. Gõ /duan để vào một dự án.';
    if (!projects.canUse(uid, p, isAdmin)) return 'Dự án này không dùng được nữa.';
    const list = (await ck.list(p.id)).slice(0, 6);
    if (!list.length) return 'Dự án "' + label(p) + '" chưa có mốc nào. Bot tự lưu mốc trước mỗi việc AI làm trong dự án — làm một việc rồi gõ lại /hoantac.';
    return {
      text: '⏪ Mốc khôi phục của ' + label(p) + ' (bot tự lưu trước mỗi việc, giữ ' + ck.limits.keep + ' mốc gần nhất):\n\n' + list.map((s, i) => (i + 1) + ') ' + clock(s.at) + ' · ' + cut(s.label || 'mốc', 50) + ' · ' + s.files + ' tệp' + (s.partial ? ' (chụp một phần: thư mục quá lớn)' : '')).join('\n') +
        '\n\nBấm một mốc để xem AI đã đổi gì so với lúc đó, rồi quyết định quay về. Quay về cũng hoàn tác được (bot lưu lại trạng thái hiện tại thành một mốc mới).',
      buttons: list.map((s, i) => [{ text: (i + 1) + ') ' + clock(s.at) + ' · ' + cut(s.label || 'mốc', 20), data: 'pj:ck:show:' + s.id }]),
    };
  }
  async function journalCallback(d, chatId, uid, reply) {
    if (!jr || !isAdmin(uid)) return 'Chỉ chủ máy quay lại được việc này.';
    const m = d.match(/^pj:jr:(show|do):([\w.-]+)$/);
    if (!m) return null;
    const meta = await jr.get(m[2]);
    if (!meta) return 'Nhật ký này không còn (đã dọn).';
    if (m[1] === 'show') {
      const plan = await jr.plan(m[2]);
      const warn = (meta.unsafe || []).slice(0, 5).map((u) => '⚠️ ' + cut(u, 90)).join('\n');
      if (!plan.length && !warn) { await reply('🗂 Việc #' + meta.id + ': không có gì khác so với lúc đó, không cần quay lại.'); return ''; }
      const list = plan.length ? plan.slice(0, 12).map((x) => '• ' + cut(x.p, 60) + ' — ' + x.act).join('\n') + (plan.length > 12 ? '\n…và ' + (plan.length - 12) + ' mục nữa' : '') : 'Không có tệp nào cần trả lại.';
      await reply({
        text: '🗂 Việc #' + meta.id + ' (' + cut(meta.label || 'việc', 60) + '). Nếu quay lại:\n\n' + list + (warn ? '\n\nBot KHÔNG tự hoàn tác được:\n' + warn : '') + (meta.partial ? '\n\n(Một phần bản gốc không lưu được — xem cảnh báo ở trên.)' : '') + '\n\nQuay lại? (Bot lưu trạng thái hiện tại trước, nên hoàn tác được.)',
        buttons: plan.length ? [[{ text: '⏪ Quay lại như trước việc này', data: 'pj:jr:do:' + meta.id }, { text: 'Thôi', data: 'pj:ck:no' }]] : [[{ text: 'Đã rõ', data: 'pj:ck:no' }]],
      });
      return '';
    }
    if (o.running && o.running(chatId)) return 'Đang có việc chạy trong cuộc này — chờ xong hoặc gõ /huy rồi hãy quay lại.';
    const r = await jr.restore(meta.id);
    await reply((r.ok ? '✅ Đã quay lại như trước việc #' + meta.id + ': trả ' + r.restored + ' mục' + (r.deleted ? ', xóa ' + r.deleted + ' tệp do việc đó tạo' : '') + (r.skipped ? ', bỏ qua ' + r.skipped : '') + '.' : '⚠️ Quay lại chưa trọn vẹn: ' + (r.error || (r.errors || []).join('; '))) + (r.undoId ? '\nMuốn hủy việc quay lại: /hoantac rồi chọn nhật ký #' + r.undoId + '.' : ''));
    return r.ok ? 'Đã quay lại' : 'Chưa trọn vẹn';
  }
  async function checkCallback(d, chatId, uid, reply) {
    if (!ck) return 'Máy này chưa hỗ trợ mốc khôi phục.';
    const p = projects.active(chatId);
    if (!p || !projects.canUse(uid, p, isAdmin)) return 'Chưa ở trong dự án nào.';
    if (d === 'pj:ck:no') return 'Thôi, giữ nguyên.';
    const m = d.match(/^pj:ck:(show|do):([\w.-]+)$/);
    if (!m) return null;
    const meta = (await ck.list(p.id)).find((s) => s.id === m[2]);
    if (!meta) return 'Mốc này không còn (đã quá ' + ck.limits.keep + ' mốc gần nhất).';
    if (m[1] === 'show') {
      const df = await ck.diff(p.id, meta.id, p.dir);
      if (!df.ok) return df.error;
      const n = df.changed.length + df.added.length + df.removed.length;
      if (!n) { await reply('🕑 Mốc ' + clock(meta.at) + ' (' + cut(meta.label || 'mốc', 60) + '): không có gì khác so với bây giờ, không cần quay về.'); return ''; }
      const parts = [];
      if (df.changed.length) parts.push('✏️ ' + df.changed.length + ' tệp đã bị sửa (sẽ trả về như lúc đó):\n' + names(df.changed, '•'));
      if (df.added.length) parts.push('➕ ' + df.added.length + ' tệp mới tạo sau mốc (sẽ bị xóa):\n' + names(df.added, '•'));
      if (df.removed.length) parts.push('➖ ' + df.removed.length + ' tệp đã bị xóa (sẽ được khôi phục):\n' + names(df.removed, '•'));
      await reply({
        text: '🕑 Mốc ' + clock(meta.at) + ' (' + cut(meta.label || 'mốc', 60) + '). So với bây giờ:\n\n' + parts.join('\n\n') +
          '\n\nQuay về mốc này? (Bot lưu lại trạng thái hiện tại trước, nên hoàn tác được.)',
        buttons: [[{ text: '⏪ Quay về mốc này', data: 'pj:ck:do:' + meta.id }, { text: 'Thôi', data: 'pj:ck:no' }]],
      });
      return '';
    }
    if (o.running && o.running(chatId)) return 'Đang có việc chạy trong cuộc này — chờ xong hoặc gõ /huy rồi hãy quay về.';
    const r = await ck.restore(p.id, meta.id, p.dir);
    if (!r.ok) { await reply('⚠️ Chưa quay về được: ' + r.error); return 'Không quay về được'; }
    if (r.nothing) { await reply('Không có gì khác so với mốc này nên giữ nguyên.'); return 'Không cần'; }
    await reply('✅ Đã quay về mốc ' + clock(meta.at) + ': khôi phục ' + r.restored + ' tệp' + (r.deleted ? ', xóa ' + r.deleted + ' tệp mới tạo' : '') + '. Muốn hủy việc quay về: /hoantac rồi chọn mốc "Trước khi khôi phục".');
    return 'Đã quay về';
  }

  function picker(chatId, uid, text) {
    db.kvSet(kHold(chatId), JSON.stringify({ text: String(text).slice(0, 6000), at: now() }));
    const { list, cur } = listButtons(chatId, uid, 6);
    const rows = list.map((p) => [{ text: (cur && cur.id === p.id ? '▶️ ' : '📁 ') + cut(label(p), 34) + ' · ' + ago(p.at), data: 'pj:pick:' + p.id }]);
    rows.push([{ text: '🆕 Dự án mới (tin này không liên quan)', data: 'pj:new' }]);
    return { text: '📁 Anh nhắn lại sau một lúc. Tin này thuộc dự án nào?\n(Tin của anh đang được giữ, chọn xong em làm ngay.)', buttons: rows };
  }

  // Tên dự án mới do chủ máy gõ trên Telegram
  function naming(chatId, nm, text) {
    const name = String(text || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60) return 'Tên dự án dài 2–60 ký tự, anh gõ lại giúp em (hoặc bấm "Bot tự đặt tên" ở tin trên).';
    try { projects.rename(nm.id, name); projects.update(nm.id, (x) => { x.autoTitle = false; }); } catch (e) { return '⚠️ ' + e.message + ' Anh gõ tên khác giúp em.'; }
    db.kvDel(kName(chatId));
    if (!nm.hold) return '✅ Đã đặt tên dự án mới: "' + name + '". Anh nhắn việc đầu tiên nhé.';
    projects.setActive(chatId, nm.id);
    const r = submit(chatId, nm.hold, null, null, nm.id);
    return '✅ Đã đặt tên dự án mới: "' + name + '" và giao tin của anh vào đó.' + (r ? '\n' + r : '');
  }

  // Bắt đầu một dự án mới và hỏi tên (hold = tin đang giữ, có thể rỗng)
  function askNew(chatId, uid, hold) {
    const np = projects.newChat(chatId, uid);
    db.kvSet(kName(chatId), JSON.stringify({ id: np.id, hold: hold || '' }));
    db.kvDel(kHold(chatId));
    return { text: '🆕 Dự án mới. Anh đặt tên cho dự án này: gõ tên rồi gửi (ví dụ: Kế toán tháng 11).\nKhông muốn đặt thì bấm nút bên dưới, tên sẽ lấy theo câu đầu tiên.' + (hold ? '\n(Tin trước của anh đang được giữ, đặt tên xong em làm ngay.)' : ''), buttons: [[{ text: 'Bot tự đặt tên', data: 'pj:auto' }]] };
  }
  // /moi <tên>: tạo dự án mới có tên luôn
  function createNamed(chatId, uid, name) {
    const nm = String(name || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (nm.length < 2 || nm.length > 60) return { err: 'Tên dự án dài 2–60 ký tự.' };
    if (projects.list({ all: true }).some((p) => p.name.toLowerCase() === nm.toLowerCase())) return { err: 'Đã có dự án tên "' + nm + '".' };      // kiểm TRƯỚC khi tạo để không sinh dự án rác
    const np = projects.newChat(chatId, uid);
    projects.rename(np.id, nm);
    return { project: projects.get(np.id) };
  }

  // Tin thường: null = cứ giao việc như bình thường; còn lại = trả lời thay (chọn dự án / đang đặt tên).
  function gate(chatId, uid, text, prevAt) {
    const nm = parse(db.kvGet(kName(chatId)));
    if (nm) return naming(chatId, nm, text);
    const hold = parse(db.kvGet(kHold(chatId)));
    if (hold) return picker(chatId, uid, hold.text + '\n' + text);                       // gõ thêm lúc đang chọn: gộp vào tin đang giữ
    if (prevAt && now() - prevAt >= idleMs()) return picker(chatId, uid, text);
    return null;
  }

  const isCallback = (d) => /^pj:/.test(String(d || ''));
  async function callback(cq) {
    const chatId = String(cq.message && cq.message.chat ? cq.message.chat.id : cq.from.id), uid = String(cq.from.id), d = String(cq.data);
    const reply = (t) => (o.send ? o.send(chatId, t) : null);
    let m;
    if (/^pj:jr:/.test(d)) return journalCallback(d, chatId, uid, reply);
    if (d === 'pj:ck:no') return 'Thôi, giữ nguyên.';
    if (/^pj:ck:/.test(d)) return checkCallback(d, chatId, uid, reply);
    if ((m = d.match(/^pj:(go|info|pick):(.+)$/))) {
      const p = projects.get(m[2]);
      if (!p || !projects.canUse(uid, p, isAdmin)) return 'Dự án này không dùng được nữa.';
      if (m[1] === 'info') {
        const u = projects.usage(p.id);
        await reply('📁 ' + label(p) + '\n' + u.docs + ' tài liệu · ' + u.results + ' kết quả · làm việc gần nhất ' + ago(projects.lastActive(p.id)) + '\n' + lastRecap(chatId, p) + '\n\nBấm "▶️ Tiếp tục" để làm việc trong dự án này.');
        return '';
      }
      if (m[1] === 'go') {
        projects.setActive(chatId, p.id); projects.markActive(p.id);
        await reply('▶️ Tiếp tục dự án "' + label(p) + '".\n' + lastRecap(chatId, p) + '\n\nAnh cứ nhắn tiếp, em làm trong dự án này.');
        return 'Đã chuyển sang ' + cut(label(p), 40);
      }
      const hold = parse(db.kvGet(kHold(chatId)));
      if (!hold) return 'Tin này đã được xử lý rồi.';
      db.kvDel(kHold(chatId)); projects.setActive(chatId, p.id);
      const r = submit(chatId, hold.text, null, null, p.id);
      await reply('📁 Đã giao cho dự án "' + label(p) + '".' + (r ? '\n' + r : ''));
      return 'Đã chọn ' + cut(label(p), 40);
    }
    if ((m = d.match(/^pj:(peek|stop):(.+)$/))) {
      const key = m[2], p = key === '-' ? null : projects.get(key);
      if (key !== '-' && (!p || !projects.canUse(uid, p, isAdmin))) return 'Dự án này không dùng được nữa.';
      const r = sess ? sess.list(chatId, p ? [p] : []).find((x) => x.id === key) : null;
      if (!r) return 'Không thấy cuộc trò chuyện này.';
      if (m[1] === 'peek') { await reply(sess.peek(r)); return ''; }
      const proj = key === '-' ? '' : key; let n = db.cancelQueuedScope(chatId, proj);
      if (worker && worker.cancelRunning(chatId, proj)) n++;
      await reply(n ? '⏹ Đã dừng cuộc "' + r.name + '" (' + n + ' việc).' : 'Cuộc "' + r.name + '" không có việc nào đang chạy hay chờ.');
      return n ? 'Đã dừng' : 'Không có việc nào';
    }
    if ((m = d.match(/^pj:mode:(\w+)$/))) {
      const p = projects.active(chatId);
      if (!p || !projects.canUse(uid, p, isAdmin)) return 'Chưa ở trong dự án nào.';
      try { projects.setMode(p.id, m[1]); } catch (e) { return e.message; }
      await reply(modeCard(chatId, uid));
      return 'Đã đổi chế độ';
    }
    if (d === 'pj:go:-') { projects.setActive(chatId, null); await reply('▶️ Quay về chế độ chung (không gắn dự án).'); return 'Đã chuyển'; }
    if (d === 'pj:new') {
      const hold = parse(db.kvGet(kHold(chatId)));
      await reply(askNew(chatId, uid, hold ? hold.text : ''));
      return '';
    }
    if (d === 'pj:auto') {
      const nm = parse(db.kvGet(kName(chatId)));
      if (!nm) return 'Đã xong rồi.';
      db.kvDel(kName(chatId));
      if (!nm.hold) { await reply('Đã rõ. Anh nhắn việc đầu tiên, em sẽ đặt tên dự án theo câu đó.'); return ''; }
      projects.titleFromPrompt(nm.id, nm.hold); projects.setActive(chatId, nm.id);
      const r = submit(chatId, nm.hold, null, null, nm.id);
      await reply('✅ Đã đặt tên dự án theo tin của anh và giao việc.' + (r ? '\n' + r : ''));
      return 'Đã tự đặt tên';
    }
    return null;
  }

  return { board, modeCard, checkCard, touch, gate, listButtons, askNew, createNamed, callback, isCallback, usable, idleMs, label, ago, lastRecap };
}

module.exports = { createProjectFlow, DEFAULT_IDLE_H };
