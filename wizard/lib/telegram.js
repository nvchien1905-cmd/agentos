'use strict';

// Bước Telegram: kiểm tra token bot (getMe) rồi chờ người dùng nhắn tin cho bot để LẤY ID của họ (không phải tự tìm ID).
const TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

function api(token, base, f) {
  const root = (base || 'https://api.telegram.org') + '/bot' + token + '/';
  return async function call(method, params, signal) {
    const r = await (f || fetch)(root + method, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}), signal,
    });
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('Telegram trả dữ liệu không đọc được'); }
    if (!j.ok) { const err = new Error(j.description || 'Telegram báo lỗi'); err.code = j.error_code; throw err; }
    return j.result;
  };
}

async function getMe(token, opts) {
  opts = opts || {};
  if (!TOKEN_RE.test(String(token || '').trim())) throw new Error('Token không đúng dạng (123456789:ABC...). Lấy token từ @BotFather.');
  try {
    const me = await api(token.trim(), opts.base, opts.fetch)('getMe', {}, AbortSignal.timeout(15000));
    return { id: me.id, username: me.username, name: me.first_name };
  } catch (e) {
    if (e.code === 401) throw new Error('Token sai hoặc đã bị thu hồi.');
    throw new Error('Không kiểm tra được token: ' + e.message);
  }
}

// Chờ tối đa `waitSec` giây tới khi có người nhắn riêng cho bot. Trả { id, name, username } hoặc null nếu hết giờ.
// Gọi lặp lại được (mỗi lần cắt thành các lượt long-poll ngắn). Tin đã nhận được đánh dấu đã đọc.
async function waitForOwner(token, opts) {
  opts = opts || {};
  const call = api(token.trim(), opts.base, opts.fetch);
  const deadline = Date.now() + (opts.waitSec || 25) * 1000;
  let offset;
  while (Date.now() < deadline) {
    const left = Math.max(1, Math.min(10, Math.floor((deadline - Date.now()) / 1000)));
    const ups = await call('getUpdates', { offset, timeout: left, allowed_updates: ['message'] }, AbortSignal.timeout((left + 10) * 1000));
    for (const u of ups) {
      offset = u.update_id + 1;
      const m = u.message;
      if (m && m.chat && m.chat.type === 'private' && m.from && !m.from.is_bot) {
        await call('getUpdates', { offset, timeout: 0 }, AbortSignal.timeout(10000)).catch(() => {});   // đánh dấu đã đọc
        return { id: String(m.from.id), name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' '), username: m.from.username || '' };
      }
    }
  }
  return null;
}

async function send(token, chatId, text, opts) {
  opts = opts || {};
  await api(token.trim(), opts.base, opts.fetch)('sendMessage', { chat_id: chatId, text }, AbortSignal.timeout(15000));
}

module.exports = { TOKEN_RE, getMe, waitForOwner, send };
