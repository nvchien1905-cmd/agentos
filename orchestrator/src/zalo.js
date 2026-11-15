'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { noAccent } = require('./kiotviet');

// TRỢ LÝ ZALO CÁ NHÂN qua Chrome (chat.zalo.me) — bot thao tác như người thật: mở Zalo, đọc tin, tự soạn và tự gửi.
// Zalo không có API cho tài khoản cá nhân nên AI dùng Chrome/màn hình thật. Mặc định TẮT; chủ máy bật bằng /zalo bat (tự chịu rủi ro Zalo nghi ngờ tự động hóa).
// Hàng rào nằm TRONG MÃ (không chỉ lời dặn AI): mỗi tin phải xin PHIẾU gửi (authorize) — phiếu chỉ cấp khi đang BẬT, trong khung giờ, chưa vượt hạn mức giờ/ngày,
// cách tin trước tối thiểu minGap giây (nhịp như người), người nhận không bị chặn, nội dung không có mật khẩu/OTP/số thẻ. Phiếu dùng đúng 1 lần, hết hạn sau 10 phút.
// Màn hình (desk-mcp) chỉ cho nhấn Enter/nút Gửi trong cửa sổ Zalo khi có phiếu; trình duyệt của bot (việc [ZALO-GỬI]) có hạn mức thao tác.
//   Chế độ nhap (mặc định khi bật): AI soạn nháp → chủ máy bấm ✅ mới gửi.  Chế độ tudong: AI tự gửi (trừ danh sách chặn / tin nhạy cảm vẫn chờ duyệt).
//   Chủ máy ra lệnh gửi trực tiếp (/zalo gui <nơi nhận> | <nội dung>) = đã duyệt, bỏ qua chế độ nhưng vẫn theo hạn mức và nhịp.
const MARK_SEND = '[ZALO-GỬI]';
const BROWSER_INTERACT = /^mcp__browser__browser_(click|type|press_key|fill_form|hover)$/;
const MAX_INTERACT = 60;
const GRANT_MS = 10 * 60000;
const SENSITIVE_OUT = /(mật khẩu|mat khau|password|passcode|\botp\b|mã xác (minh|thực|nhận)|ma xac (minh|thuc|nhan)|\bcvv\b|số thẻ|so the|thẻ tín dụng|the tin dung)/i;
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const cleanName = (s) => String(s || '').replace(/[\r\n"“”`\\|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const hhmm = (d) => d.getHours() * 60 + d.getMinutes();
const fmtHour = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const parseHour = (s) => { const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(s || '').trim()); return m && Number(m[1]) <= 24 ? Number(m[1]) * 60 + Number(m[2] || 0) : null; };
const defaults = () => ({ enabled: false, mode: 'nhap', block: [], from: 420, to: 1320, perHour: 12, perDay: 80, minGap: 30, maxGap: 90, instructions: '', history: [], grants: [], pending: [], since: 0 });

// Đọc/ghi tệp cấu hình dùng chung giữa bộ điều phối và desk-mcp (hai tiến trình): ghi nguyên tử.
function makeStore(file, now) {
  const load = () => { try { return Object.assign(defaults(), JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { return defaults(); } };
  const save = (c) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = file + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(c, null, 1), { mode: 0o600 }); fs.renameSync(t, file); };
  const mut = (fn) => { const c = load(); const r = fn(c); save(c); return r; };
  return { load, save, mut, now };
}
const inHours = (c, d) => { const m = hhmm(d); return c.from <= c.to ? m >= c.from && m < c.to : m >= c.from || m < c.to; };

// Hỏi xin phiếu gửi. opts: { byOwner } = chủ máy ra lệnh trực tiếp. Trả { ok, token?, reason?, needApproval?, retryInSec?, typingHint? }
function decide(c, to, text, t, opts) {
  opts = opts || {};
  to = cleanName(to); text = String(text == null ? '' : text).trim();
  if (!c.enabled) return { ok: false, reason: 'Trợ lý Zalo đang TẮT. Chủ máy bật bằng /zalo bat. KHÔNG được tự bấm Gửi.' };
  if (!to) return { ok: false, reason: 'Thiếu tên người/nhóm nhận.' };
  if (!text || text.length > 2000) return { ok: false, reason: 'Nội dung phải dài 1-2000 ký tự.' };
  const nTo = noAccent(to);
  if ((c.block || []).some((b) => noAccent(b) === nTo)) return { ok: false, reason: '"' + to + '" nằm trong danh sách KHÔNG tự gửi (/zalo chan). Không gửi.' };
  if (!opts.byOwner && !inHours(c, new Date(t))) return { ok: false, reason: 'Ngoài khung giờ trực ' + fmtHour(c.from) + '–' + fmtHour(c.to) + '. Không gửi lúc này.' };
  const hist = c.history || [];
  const lastH = hist.filter((h) => t - h.at < 3600000).length, lastD = hist.filter((h) => t - h.at < 86400000).length;
  if (lastH >= c.perHour) return { ok: false, reason: 'Đã gửi ' + lastH + ' tin trong 1 giờ qua (hạn mức ' + c.perHour + '/giờ, giữ nhịp như người thật). Chờ rồi hỏi lại.', retryInSec: 600 };
  if (lastD >= c.perDay) return { ok: false, reason: 'Đã gửi ' + lastD + ' tin trong 24 giờ qua (hạn mức ' + c.perDay + '/ngày). Dừng.' };
  const last = hist.length ? hist[hist.length - 1].at : 0, gap = c.minGap * 1000;
  if (last && t - last < gap) return { ok: false, reason: 'Vừa gửi tin trước ' + Math.round((t - last) / 1000) + ' giây. Người thật không nhắn dồn dập: chờ thêm rồi hỏi lại.', retryInSec: Math.ceil((gap - (t - last)) / 1000) };
  if (!opts.byOwner && SENSITIVE_OUT.test(text)) return { ok: false, needApproval: true, reason: 'Nội dung có mật khẩu/OTP/số thẻ — cần chủ máy duyệt, không tự gửi.' };
  if (!opts.byOwner && c.mode !== 'tudong') return { ok: false, needApproval: true, reason: 'Chế độ NHÁP: chủ máy phải bấm ✅ mới gửi.' };
  return { ok: true };
}

function createZalo(o) {
  o = o || {};
  const now = o.now || Date.now, log = o.log || (() => {});
  const file = o.file || '/var/lib/agentos/data/zalo.json';
  const st = makeStore(file, now);
  const admin = () => (typeof o.admin === 'function' ? o.admin() : o.admin);
  const tell = (text, buttons) => { const a = admin(); if (!a) return null; return buttons && o.ask ? o.ask(a, text, buttons) : o.notify ? o.notify(a, text) : null; };
  const rid = () => crypto.randomBytes(4).toString('hex');

  // Cấp phiếu: ghi vào lịch sử (tính hạn mức) và danh sách phiếu (desk-mcp tiêu thụ khi nhấn Enter)
  function issue(c, to, text, t, by) {
    const id = rid();
    c.history = (c.history || []).concat([{ at: t, to: cleanName(to), text: clip(text, 300), by }]).slice(-300);
    c.grants = (c.grants || []).filter((g) => !g.used && g.exp > t).concat([{ id, to: cleanName(to), exp: t + GRANT_MS, used: false }]).slice(-10);
    return id;
  }
  function typingHint(c) { return 'ĐƯỢC GỬI cho "' + '%TO%' + '". Làm như người thật: chờ 2–5 giây rồi mới gõ; gõ chậm từng cụm từ (không dán một lần), đọc lại, rồi nhấn Enter; kiểm tin đã hiện trong cuộc trò chuyện. Không gửi tin nào khác với phiếu này.'; }

  // AI/chủ máy xin phiếu. opts.byOwner: chủ máy ra lệnh trực tiếp.
  function authorize(to, text, opts) {
    const t = now(); let out;
    st.mut((c) => {
      const d = decide(c, to, text, t, opts);
      if (!d.ok) { out = d; return; }
      const token = issue(c, to, text, t, (opts && opts.byOwner) ? 'chu' : 'ai');
      out = { ok: true, token, text: typingHint(c).replace('%TO%', cleanName(to)) };
    });
    return out;
  }
  // AI xin gửi: chạy qua hạn mức; nếu cần chủ máy duyệt thì lưu nháp và gửi thẻ có nút ✅/❌.
  function request(to, text) {
    const d = authorize(to, text, {});
    if (d.ok) return d.text;
    if (!d.needApproval) return 'TỪ CHỐI: ' + d.reason + (d.retryInSec ? ' (hỏi lại sau ' + d.retryInSec + ' giây)' : '');
    const n = stagePending(to, text);
    return 'CHỜ CHỦ DUYỆT (' + d.reason + ') Đã gửi nháp #' + n + ' cho chủ máy bấm ✅. DỪNG: không gõ/gửi gì vào Zalo, báo chủ máy "đã soạn nháp chờ anh duyệt".';
  }
  function stagePending(to, text) {
    let n; const t = now();
    st.mut((c) => { n = ((c.pending || []).reduce((m, p) => Math.max(m, p.n), 0) || 0) + 1; c.pending = (c.pending || []).filter((p) => t - p.at < 86400000).concat([{ n, at: t, to: cleanName(to), text: clip(text, 1900), state: 'cho' }]).slice(-20); });
    tell('💬 Zalo — nháp gửi cho "' + cleanName(to) + '":\n' + clip(text, 1500), [[{ text: '✅ Gửi', data: 'zl:' + n + ':y' }, { text: '❌ Bỏ', data: 'zl:' + n + ':n' }]]);
    return n;
  }

  // Cổng duyệt: việc [ZALO-GỬI] (đã được chủ máy bấm ✅ hoặc ra lệnh) được tự bấm/gõ trong trình duyệt, tối đa MAX_INTERACT thao tác
  const counts = new Map();
  function allowInteract(job, tool) {
    if (!BROWSER_INTERACT.test(String(tool || ''))) return false;
    if (!String((job && job.prompt) || '').startsWith(MARK_SEND)) return false;
    const k = String(job.id), n = (counts.get(k) || 0) + 1; if (counts.size > 500) counts.clear(); counts.set(k, n);
    return n <= MAX_INTERACT;
  }
  function sendPrompt(to, text) {
    return MARK_SEND + ' Dùng trình duyệt (Chrome của bot, đã đăng nhập Zalo Web) vào https://chat.zalo.me, mở ĐÚNG cuộc trò chuyện "' + cleanName(to) + '" (kiểm tên khớp trước khi gõ; trùng tên hoặc không chắc thì DỪNG và báo). ' +
      'Làm như người thật: chờ vài giây, gõ CHẬM theo từng cụm từ (không dán một lần), đọc lại, rồi nhấn Enter; chụp ảnh xác nhận tin đã hiện. Gõ đúng nguyên văn giữa hai dấu """ (không sửa, không thêm), không mở cuộc trò chuyện khác, không bấm liên kết/tệp/cuộc gọi.\n"""\n' + text + '\n"""\nChỉ gửi đúng một tin này.';
  }
  // Chủ máy bấm ✅ (hoặc /zalo gui): cấp phiếu và nhờ AI gửi
  function sendNow(to, text, by) {
    const d = authorize(to, text, { byOwner: true });
    if (!d.ok) return { ok: false, text: '⛔ ' + d.reason };
    let id = null;
    if (o.submit) { try { id = o.submit(sendPrompt(to, text)); } catch (e) { return { ok: false, text: '⚠️ Không tạo được việc gửi: ' + e.message }; } }
    return { ok: true, text: '📤 Đang gửi cho "' + cleanName(to) + '"' + (id ? ' (việc #' + id + ')' : '') + ' — gõ chậm như người thật, xong có ảnh xác nhận.' };
  }
  const isCallback = (d) => /^zl:\d{1,4}:[yn]$/.test(String(d || ''));
  async function answerCallback(data) {
    const m = /^zl:(\d+):([yn])$/.exec(String(data)); if (!m) return 'Nút không hợp lệ.';
    const c = st.load(), p = (c.pending || []).find((x) => x.n === Number(m[1]));
    if (!p) return 'Nháp đã hết hạn.';
    if (p.state !== 'cho') return 'Nháp này đã xử lý rồi.';
    st.mut((x) => { const it = x.pending.find((y) => y.n === p.n); if (it) it.state = m[2] === 'y' ? 'gui' : 'bo'; });
    if (m[2] === 'n') return 'Đã bỏ nháp.';
    return sendNow(p.to, p.text, 'duyet').text;
  }

  // ---------- lệnh /zalo ----------
  const modeText = (c) => (c.mode === 'tudong' ? '🤖 TỰ ĐỘNG: AI tự soạn và gửi (trừ danh sách chặn; tin nhạy cảm vẫn chờ duyệt)' : '✍️ NHÁP: AI soạn, anh bấm ✅ mới gửi');
  function status() {
    const c = st.load(), t = now();
    const h = (c.history || []).filter((x) => t - x.at < 3600000).length, d = (c.history || []).filter((x) => t - x.at < 86400000).length;
    return '💬 Trợ lý Zalo cá nhân (Chrome): ' + (c.enabled ? '🟢 BẬT' : '⚪ TẮT') + '\nChế độ: ' + modeText(c) + '\nKhung giờ: ' + fmtHour(c.from) + '–' + fmtHour(c.to) + ' · hạn mức ' + c.perHour + ' tin/giờ, ' + c.perDay + ' tin/ngày (đã gửi ' + h + '/giờ, ' + d + '/24h) · cách nhau tối thiểu ' + c.minGap + ' giây\n' +
      'Chặn: ' + ((c.block || []).join(', ') || '(trống)') + '\n' + (c.instructions ? 'Chỉ dẫn: ' + clip(c.instructions, 200) + '\n' : '') +
      'Lệnh: /zalo bat · tat · dangnhap · tudong · nhap · gui <nơi nhận> | <nội dung> · chan <tên> · bochan <tên> · gioihan <giờ> [ngày] · nhip <giây> · gio 7-22 · chidan <nội dung> · nhatky';
  }
  function command(arg, ctx) {
    const t = String(arg || '').trim(); const m = /^(\S+)\s*([\s\S]*)$/.exec(t); if (!m) return status();
    const sub = noAccent(m[1]), rest = m[2].trim();
    if (sub === 'bat') {
      st.mut((c) => { c.enabled = true; c.since = now(); });
      return '🟢 Đã BẬT trợ lý Zalo (chế độ ' + (st.load().mode === 'tudong' ? 'TỰ ĐỘNG' : 'NHÁP') + ').\n⚠️ Zalo không cho phép tự động hóa tài khoản cá nhân: có thể bị khóa tạm hoặc đòi xác minh — anh tự chịu rủi ro này. Để an toàn bot gõ chậm như người, giữ hạn mức ' + st.load().perHour + ' tin/giờ, tin nhạy cảm luôn chờ anh duyệt.\n' +
        'Bước tiếp: 1) /zalo dangnhap (đăng nhập Zalo Web một lần)  2) /zalo tudong nếu muốn AI tự gửi (mặc định NHÁP).\nBây giờ anh chỉ cần nhắn bình thường: "nhắn nhóm Phương Đình: …", "trả lời tin Zalo mới giúp anh".';
    }
    if (sub === 'tat') { st.mut((c) => { c.enabled = false; c.grants = []; }); return '⚪ Đã TẮT trợ lý Zalo; mọi phiếu gửi đang chờ bị hủy.'; }
    if (sub === 'tudong') { st.mut((c) => { c.mode = 'tudong'; }); return '🤖 Chế độ TỰ ĐỘNG: AI tự soạn và tự gửi (vẫn theo hạn mức, khung giờ, danh sách chặn; tin có mật khẩu/OTP/số thẻ chờ anh duyệt). Quay lại nháp: /zalo nhap.' + (st.load().enabled ? '' : '\n(Trợ lý đang TẮT — bật bằng /zalo bat.)'); }
    if (sub === 'nhap') { st.mut((c) => { c.mode = 'nhap'; }); return '✍️ Chế độ NHÁP: AI soạn, anh bấm ✅ mới gửi.'; }
    if (sub === 'chan' || sub === 'bochan') {
      const nm = cleanName(rest); if (!nm) return 'Cách dùng: /zalo ' + sub + ' <tên người/nhóm>';
      st.mut((c) => { c.block = (c.block || []).filter((x) => noAccent(x) !== noAccent(nm)); if (sub === 'chan') c.block.push(nm); });
      return sub === 'chan' ? '🙅 "' + nm + '": KHÔNG bao giờ tự gửi tin (bỏ chặn: /zalo bochan ' + nm + ').' : '✅ Đã bỏ chặn "' + nm + '".';
    }
    if (sub === 'gioihan') {
      const g = /^(\d{1,3})(?:\s+(\d{1,4}))?$/.exec(rest); const h = g && Number(g[1]), d = g && g[2] ? Number(g[2]) : null;
      if (!g || h < 1 || h > 120 || (d !== null && (d < h || d > 1000))) return 'Cách dùng: /zalo gioihan <tin mỗi giờ 1–120> [tin mỗi ngày]. Hiện ' + st.load().perHour + '/giờ, ' + st.load().perDay + '/ngày.';
      st.mut((c) => { c.perHour = h; if (d !== null) c.perDay = d; else if (c.perDay < h) c.perDay = h; });
      return '✅ Tối đa ' + h + ' tin/giờ' + (d !== null ? ', ' + d + ' tin/ngày' : '') + '.';
    }
    if (sub === 'nhip') { const s = Number(rest); if (!(s >= 5 && s <= 600)) return 'Cách dùng: /zalo nhip <giây giữa hai tin, 5–600>. Hiện ' + st.load().minGap + ' giây.'; st.mut((c) => { c.minGap = Math.round(s); c.maxGap = Math.max(c.maxGap, c.minGap); }); return '✅ Hai tin liên tiếp cách nhau tối thiểu ' + Math.round(s) + ' giây.'; }
    if (sub === 'gio') { const g = /^(\d{1,2}(?::\d{2})?)\s*[-–]\s*(\d{1,2}(?::\d{2})?)$/.exec(rest); const a = g && parseHour(g[1]), b = g && parseHour(g[2]); if (a == null || b == null || a === b) return 'Cách dùng: /zalo gio 7-22'; st.mut((c) => { c.from = a; c.to = b; }); return '🕖 Khung giờ trực: ' + fmtHour(a) + '–' + fmtHour(b) + ' (chủ máy ra lệnh gửi trực tiếp thì không bị khung giờ này).'; }
    if (sub === 'chidan') { if (!rest) return 'Chỉ dẫn hiện tại: ' + (st.load().instructions || '(chưa có)') + '\nĐặt: /zalo chidan <giọng điệu, thông tin được nói...>'; st.mut((c) => { c.instructions = rest.slice(0, 2000); }); return '✅ Đã lưu chỉ dẫn (' + rest.length + ' ký tự).'; }
    if (sub === 'nhatky') { const h = st.load().history || []; return h.length ? '🧾 Tin đã được cấp phiếu gửi gần đây:\n' + h.slice(-10).reverse().map((x) => '• ' + new Date(x.at).toLocaleString('vi-VN') + ' → ' + x.to + (x.by === 'chu' ? ' (anh ra lệnh)' : '') + ': ' + x.text).join('\n') : 'Chưa gửi tin nào.'; }
    if (sub === 'dangnhap') return '🔐 Đăng nhập Zalo Web (MỘT lần): nhắn "mở Chrome cho anh đăng nhập Zalo" (hoặc /mo webbot), tự quét mã QR bằng điện thoại, xong nhắn "xong". Bot không bao giờ tự nhập mật khẩu hay mã xác minh.';
    if (sub === 'gui') {
      const g = /^([^|]+)\|([\s\S]+)$/.exec(rest); if (!g) return 'Cách dùng: /zalo gui <người/nhóm nhận> | <nội dung>';
      if (!st.load().enabled) return '⚪ Trợ lý Zalo đang TẮT — bật trước: /zalo bat.';
      return sendNow(g[1], g[2].trim(), 'chu').text;
    }
    if (sub === 'duyet') {                                         // AI xin phiếu: /zalo duyet <nơi nhận> | <nội dung>
      const g = /^([^|]+)\|([\s\S]+)$/.exec(rest); if (!g) return 'TỪ CHỐI: cú pháp /zalo duyet <người/nhóm nhận> | <nội dung>';
      return request(g[1], g[2].trim());
    }
    return status();
  }

  return { authorize, request, command, status, load: st.load, save: st.save, allowInteract, isCallback, answerCallback, sendNow, sendPrompt, MARK_SEND };
}

// Màn hình (desk-mcp): được nhấn Enter / bấm "Gửi" trong cửa sổ Zalo CHỈ khi có phiếu còn hạn chưa dùng. Phiếu dùng đúng 1 lần.
function consumeGrant(file, t) {
  t = t || Date.now(); let ok = false, to = null;
  try {
    const st = makeStore(file, () => t);
    st.mut((c) => { if (!c.enabled) return; const g = (c.grants || []).find((x) => !x.used && x.exp > t); if (g) { g.used = true; ok = true; to = g.to; } c.grants = (c.grants || []).filter((x) => !x.used && x.exp > t); });
  } catch (e) { ok = false; }
  return ok ? { ok: true, to } : { ok: false };
}
const isEnabled = (file) => { try { return !!JSON.parse(fs.readFileSync(file, 'utf8')).enabled; } catch (e) { return false; } };

module.exports = { createZalo, decide, consumeGrant, isEnabled, defaults, MARK_SEND, BROWSER_INTERACT, MAX_INTERACT, SENSITIVE_OUT };
