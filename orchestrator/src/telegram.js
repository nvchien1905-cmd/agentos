'use strict';
const fs = require('fs');
const { toTelegramChunks } = require('./tgFormat');

const MAX_LEN = 4000; // giới hạn Telegram là 4096

function splitMessage(text, max) {
  max = max || MAX_LEN;
  text = String(text == null ? '' : text);
  if (!text) return [''];
  const parts = [];
  while (text.length > max) {
    let cut = text.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max; // không có xuống dòng hợp lý -> cắt cứng
    parts.push(text.slice(0, cut));
    text = text.slice(cut).replace(/^\n/, '');
  }
  parts.push(text);
  return parts;
}

function createTelegram(token, fetchImpl) {
  const f = fetchImpl || fetch;
  const base = 'https://api.telegram.org/bot' + token + '/';

  async function parse(r, method) {
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('Telegram trả dữ liệu không đọc được (HTTP ' + r.status + ')'); }
    if (!j.ok) {
      const err = new Error('Telegram ' + method + ': ' + (j.description || r.status));
      err.code = j.error_code;
      err.retryAfter = j.parameters && j.parameters.retry_after;
      throw err;
    }
    return j.result;
  }

  async function call(method, params, signal) {
    const guard = signal || AbortSignal.timeout(40000);                      // getUpdates tự đặt giới hạn riêng; lệnh khác quá 40 giây coi như treo
    const r = await f(base + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: guard,
    });
    return parse(r, method);
  }

  // Gửi file: { path, name, kind: 'photo' | 'document' }. Ảnh bị Telegram từ chối (kích thước lạ) -> gửi lại dạng tài liệu.
  async function upload(chatId, file, asPhoto) {
    const method = asPhoto ? 'sendPhoto' : 'sendDocument';
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set(asPhoto ? 'photo' : 'document', new Blob([fs.readFileSync(file.path)]), file.name);
    return parse(await f(base + method, { method: 'POST', body: form, signal: AbortSignal.timeout(180000) }), method);
  }

  return {
    call,
    async sendFile(chatId, file) {
      if (file.kind === 'photo') {
        try { return await upload(chatId, file, true); } catch (e) { if (e.retryAfter) throw e; }
      }
      return upload(chatId, file, false);
    },
    getMe: () => call('getMe'),
    // --- Trả lời "đẹp" như Claude Code: Markdown -> HTML Telegram, tiến trình sửa liên tục, hiện "đang gõ" ---
    sendChatAction: (chatId, action) => call('sendChatAction', { chat_id: chatId, action: action || 'typing' }).catch(() => null),
    async sendHtml(chatId, html, extra) {
      const m = await call('sendMessage', Object.assign({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }, extra || {}));
      return m && m.message_id;
    },
    async editHtml(chatId, messageId, html) {
      try { return await call('editMessageText', { chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }); }
      catch (e) { if (/not modified/i.test(e.message)) return null; throw e; }
    },
    deleteMessage: (chatId, messageId) => call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => null),
    // Gửi Markdown: đổi sang HTML, chia tin ≤ 3800 ký tự không cắt đôi khối mã; Telegram từ chối định dạng thì gửi bản chữ thường của đúng đoạn đó.
    async sendRich(chatId, markdown) {
      for (const c of toTelegramChunks(markdown)) {
        if (!c.html) continue;
        try { await call('sendMessage', { chat_id: chatId, text: c.html, parse_mode: 'HTML', disable_web_page_preview: true }); }
        catch (e) {
          if (e.retryAfter) throw e;
          if (/parse entities|can't parse|unsupported start tag|can't find end/i.test(e.message)) await call('sendMessage', { chat_id: chatId, text: c.text || c.html.replace(/<[^>]+>/g, ''), disable_web_page_preview: true });
          else throw e;
        }
      }
    },
    // Tải tệp người dùng gửi (tin nhắn thoại...) về `dest`. Giới hạn 20MB của Telegram Bot API.
    async downloadFile(fileId, dest) {
      const info = await call('getFile', { file_id: fileId });
      if (!info.file_path) throw new Error('Telegram không cho tải tệp này (quá 20MB?)');
      const r = await f('https://api.telegram.org/file/bot' + token + '/' + info.file_path);
      if (!r.ok) throw new Error('Tải tệp lỗi HTTP ' + r.status);
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()), { mode: 0o600 });
      return dest;
    },
    // Có giới hạn thời gian phía máy mình (timeout của Telegram + 15 giây): kết nối treo ngầm không làm đứng vòng nhận tin.
    getUpdates: (offset, timeoutSec, signal) => {
      const guard = AbortSignal.timeout((timeoutSec + 15) * 1000);
      return call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, signal ? AbortSignal.any([signal, guard]) : guard);
    },
    // Tin có nút bấm. buttons: [[{ text, data }]]. Trả message_id để sửa lại sau khi người dùng quyết.
    async sendButtons(chatId, text, buttons) {
      const m = await call('sendMessage', {
        chat_id: chatId, text, disable_web_page_preview: true,
        reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) },
      });
      return m.message_id;
    },
    // Sửa nội dung tin và gỡ nút.
    editMessage: (chatId, messageId, text) =>
      call('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } }),
    answerCallback: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text: text || '' }),
    async sendMessage(chatId, text) {
      for (const part of splitMessage(text)) {
        await call('sendMessage', { chat_id: chatId, text: part || '(trống)', disable_web_page_preview: true });
      }
    },
  };
}

module.exports = { createTelegram, splitMessage };
