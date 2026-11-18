'use strict';
// BỘ ĐỊNH TUYẾN KÊNH: mọi nơi trong bộ điều phối vẫn gọi `tg.sendMessage(chat, …)` như cũ; chat có mã "zl:<id>" (chat RIÊNG của chủ máy với bot Zalo)
// được chuyển sang Zalo, còn lại đi Telegram như trước. Nhờ vậy bot Zalo dùng được TOÀN BỘ tính năng của bot quản lý (lệnh /, AI có công cụ, duyệt việc, gửi tệp...).
// Khác biệt do Zalo không có: sửa tin, xóa tin, nút bấm → tin trạng thái chỉ gửi MỘT lần, nút bấm đổi thành "trả lời 1/2 hoặc ok/huy".
// Mọi lỗi gửi sang Zalo chỉ ghi nhật ký, KHÔNG ném lên (nhiều nơi gọi không bắt lỗi; ném lên sẽ làm sập tiến trình).
const ZL = 'zl:';
const isZl = (chat) => typeof chat === 'string' && chat.startsWith(ZL);
const zlId = (chat) => String(chat).slice(ZL.length);

const decode = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const htmlToPlain = (h) => decode(String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
// Markdown → chữ thường cho Zalo (Zalo không hiển thị Markdown): bỏ ký hiệu đậm/nghiêng/tiêu đề/khối mã, giữ nội dung
const mdToPlain = (m) => String(m || '').replace(/```[a-z0-9]*\n?/gi, '').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/`([^`\n]+)`/g, '$1');

const YES = /^(ok|oke|okay|co|có|duyet|duyệt|dong y|đồng ý|dc|được|yes|y|cho phep|cho phép|dung|đúng)$/i;
const NO = /^(huy|hủy|khong|không|tu choi|từ chối|no|n|bo|bỏ|dung lai|dừng lại)$/i;

// tg: bộ gửi Telegram thật; zl: { send(chatId,text), sendPhoto(chatId,path,caption), sendFile(chatId,path,name,caption), typing(chatId) } (hàm Promise); log
function createChannelRouter(tg, zlRef, opts) {
  opts = opts || {};
  const log = opts.log || (() => {}), now = opts.now || Date.now;
  const pending = new Map();            // chat -> { opts:[{text,data}], at, prompt } : nút bấm đang chờ chủ máy trả lời bằng chữ
  const lastTyping = new Map();
  const z = () => zlRef.v;
  const safe = (what, p) => Promise.resolve().then(() => p).catch((e) => { log('kênh Zalo: ' + what + ' lỗi: ' + (e && e.message || e)); return null; });
  const sendZ = (chat, text) => (z() ? safe('gửi tin', z().send(zlId(chat), text)) : Promise.resolve(null));

  function flat(buttons) { const out = []; for (const row of buttons || []) for (const b of row) out.push({ text: String(b.text || ''), data: String(b.data || '') }); return out; }

  // Chủ máy trả lời việc đang chờ duyệt: "1", "2"..., "ok" (nút đầu), "huy" (nút cuối). Trả data của nút hoặc null (không phải trả lời nút bấm).
  function takePending(chat, text) {
    const p = pending.get(chat); if (!p) return null;
    if (now() - p.at > 3600000) { pending.delete(chat); return null; }
    const t = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '');
    let pick = null;
    if (/^\d{1,2}$/.test(t)) pick = p.opts[Number(t) - 1] || null;
    else if (YES.test(t)) pick = p.opts[0] || null;
    else if (NO.test(t)) pick = p.opts[p.opts.length - 1] || null;
    if (!pick) return null;
    pending.delete(chat);
    return pick.data;
  }

  const route = (chat, onZl, onTg) => (isZl(chat) ? onZl() : onTg());
  return Object.assign(Object.create(tg), {
    takePending, isZl, pendingFor: (chat) => pending.get(chat) || null,
    call: (method, params, signal) => (params && isZl(params.chat_id) ? (method === 'sendMessage' ? sendZ(params.chat_id, params.text) : Promise.resolve(null)) : tg.call(method, params, signal)),
    sendMessage: (chat, text) => route(chat, () => sendZ(chat, text), () => tg.sendMessage(chat, text)),
    sendRich: (chat, md) => route(chat, () => sendZ(chat, mdToPlain(md)), () => tg.sendRich(chat, md)),
    // Tin trạng thái "⏳ Đang làm…": Zalo không sửa được tin nên chỉ gửi MỘT lần rồi trả mã giả (các lần sửa/xóa sau là không làm gì)
    sendHtml: (chat, html, extra) => route(chat, async () => { await sendZ(chat, htmlToPlain(html)); return 'zl-status'; }, () => tg.sendHtml(chat, html, extra)),
    editHtml: (chat, mid, html) => route(chat, () => Promise.resolve(null), () => tg.editHtml(chat, mid, html)),
    deleteMessage: (chat, mid) => route(chat, () => Promise.resolve(null), () => tg.deleteMessage(chat, mid)),
    sendChatAction: (chat, action) => route(chat, () => {
      const k = String(chat), t = now(); if (t - (lastTyping.get(k) || 0) < 20000) return Promise.resolve(null);
      lastTyping.set(k, t); if (lastTyping.size > 100) lastTyping.clear();
      return z() && z().typing ? safe('typing', z().typing(zlId(chat))) : Promise.resolve(null);
    }, () => tg.sendChatAction(chat, action)),
    // Nút bấm → tin chữ kèm cách trả lời; nhớ các lựa chọn để lần nhắn kế của chủ máy được hiểu là trả lời
    sendButtons: (chat, text, buttons) => route(chat, async () => {
      const o = flat(buttons); if (!o.length) { await sendZ(chat, text); return 'zl-btn'; }
      pending.set(String(chat), { opts: o, at: now(), prompt: String(text || '').slice(0, 200) }); if (pending.size > 50) pending.delete(pending.keys().next().value);
      await sendZ(chat, text + '\n\nTrả lời bằng số hoặc chữ:\n' + o.map((b, i) => (i + 1) + ' = ' + b.text).join('\n') + (o.length >= 2 ? '\n(hoặc gõ "ok" = ' + o[0].text + ' · "huy" = ' + o[o.length - 1].text + ')' : ''));
      return 'zl-btn';
    }, () => tg.sendButtons(chat, text, buttons)),
    editMessage: (chat, mid, text) => route(chat, async () => { pending.delete(String(chat)); await sendZ(chat, text); return null; }, () => tg.editMessage(chat, mid, text)),
    answerCallback: (id, text) => (String(id).startsWith('zl-') ? Promise.resolve(null) : tg.answerCallback(id, text)),
    // Gửi tệp: ảnh → sendPhoto (JPEG/PNG/WebP ≤ 10 MB), còn lại → sendFile (≤ 50 MB); quá giới hạn/định dạng lạ thì báo bằng chữ
    sendFile: (chat, file) => route(chat, async () => {
      if (!z()) return null;
      const id = zlId(chat);
      const isPhoto = file && file.kind === 'photo' && /\.(jpe?g|png|webp)$/i.test(String(file.path || file.name || ''));
      try { if (isPhoto) return await z().sendPhoto(id, file.path, ''); return await z().sendFile(id, file.path, file.name || '', ''); }
      catch (e) { log('kênh Zalo: gửi tệp lỗi: ' + e.message); await sendZ(chat, '⚠️ Em chưa gửi được tệp "' + (file && file.name || '') + '" qua Zalo (' + String(e.message).slice(0, 120) + '). Tệp nằm ở: ' + (file && file.path || '') + '. Anh lấy qua Telegram nhé.'); return null; }
    }, () => tg.sendFile(chat, file)),
  });
}

module.exports = { createChannelRouter, isZl, zlId, mdToPlain, htmlToPlain, ZL };
