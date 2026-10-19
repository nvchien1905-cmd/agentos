'use strict';

// Bước Telegram: kiểm tra token bot (getMe), rồi chờ chủ máy nhắn "/start <mã cài đặt>" cho bot để LẤY ID của họ.
// Mã cài đặt (hiện trên màn hình/trang cài đặt) ngăn người lạ biết tên bot chiếm quyền chủ máy.
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

// Tin có đúng mã cài đặt không: "/start 123456", "/start@ten_bot 123456", hoặc chỉ "123456".
function isPairing(text, code) {
  const t = String(text || '').trim().replace(/^\/start(@\w+)?\s*/i, '').trim();
  return t.length > 0 && t === String(code);
}

// Một lượt chờ (long-poll tối đa waitSec giây). Trả { owner|null, offset, strangers:[id] }.
// owner: người nhắn đúng mã; strangers: người khác nhắn riêng cho bot (để nhắc họ cách ghép đôi). Tin đã xử lý được đánh dấu qua offset.
async function pollOwner(token, opts) {
  opts = opts || {};
  const call = api(token.trim(), opts.base, opts.fetch);
  const waitSec = Math.max(1, Math.min(opts.waitSec || 20, 50));
  const ups = await call('getUpdates', { offset: opts.offset, timeout: waitSec, allowed_updates: ['message'] }, AbortSignal.timeout((waitSec + 10) * 1000));
  let offset = opts.offset, owner = null; const strangers = [];
  for (const u of ups) {
    offset = u.update_id + 1;
    const m = u.message;
    if (!m || !m.chat || m.chat.type !== 'private' || !m.from || m.from.is_bot) continue;
    if (isPairing(m.text, opts.code)) {
      owner = { id: String(m.from.id), name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' '), username: m.from.username || '' };
      break;
    }
    strangers.push(String(m.from.id));
  }
  if (owner && offset !== undefined) await call('getUpdates', { offset, timeout: 0 }, AbortSignal.timeout(10000)).catch(() => {});   // đánh dấu đã đọc
  return { owner, offset, strangers };
}

async function send(token, chatId, text, opts) {
  opts = opts || {};
  await api(token.trim(), opts.base, opts.fetch)('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }, AbortSignal.timeout(15000));
}

module.exports = { TOKEN_RE, getMe, isPairing, pollOwner, send };
