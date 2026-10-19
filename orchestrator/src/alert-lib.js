'use strict';

// Gửi cảnh báo Telegram độc lập với bộ điều phối (nó có thể đang hỏng): chỉ cần token và danh sách ID.
async function sendAlert({ token, chatIds, text, fetchImpl }) {
  const f = fetchImpl || fetch;
  let sent = 0;
  for (const chat_id of chatIds) {
    try {
      const r = await f('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id, text: String(text).slice(0, 3900) }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      if (j.ok) sent++;
    } catch (e) { /* thử người kế tiếp */ }
  }
  return sent;
}

// Quản trị viên: ADMIN_USER_IDS; không đặt thì ALLOWED_USER_IDS (giống config.js).
function idsFromEnv(env) {
  const raw = env.ADMIN_USER_IDS === undefined ? env.ALLOWED_USER_IDS : env.ADMIN_USER_IDS;
  return String(raw || '').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
}

module.exports = { sendAlert, idsFromEnv };
