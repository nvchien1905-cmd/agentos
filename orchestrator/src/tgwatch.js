'use strict';

// PHÁT HIỆN BOT "ĐIẾC": tiến trình vẫn sống, vòng nhận tin vẫn quay (watchdog thấy khỏe) nhưng tin của chủ máy không tới được bot.
// Nguyên nhân thường gặp, đều là lỗi của Telegram chứ không phải của máy:
//   409 Conflict  — có chương trình KHÁC cùng nhận tin bằng đúng token này (vd. một bot/agent khác chạy chung token) hoặc token đang đặt webhook;
//                   hai bên giành nhau nên tin lúc được lúc mất -> bot "im" ngẫu nhiên.
//   401 Unauthorized / 404 — token bị thu hồi hoặc sai (BotFather đổi token).
// Module này phân loại lỗi, nhắn chủ máy MỘT lần (tối đa mỗi 6 giờ) bằng chính Telegram (gửi tin đi vẫn được khi nhận bị tranh), ghi trạng thái cho heartbeat.
function createTgWatch({ tg, db, log, admins, now, notifyEveryMs, conflictAfter }) {
  log = log || (() => {});
  now = now || Date.now;
  notifyEveryMs = notifyEveryMs || 6 * 3600 * 1000;
  conflictAfter = conflictAfter || 3;                   // số lần 409 liên tiếp mới coi là xung đột thật (1–2 lần có thể do khởi động lại)
  const st = { kind: 'ok', since: now(), conflicts: 0, lastError: '' };
  const KEY = 'tg_deaf_notified';

  async function explain409() {
    let hook = null;
    try { hook = await tg.call('getWebhookInfo'); } catch (e) { /* bỏ qua */ }
    if (hook && hook.url) return 'Token này đang được đặt WEBHOOK (' + String(hook.url).replace(/^(https?:\/\/[^/]+).*$/, '$1') + ') nên bot không nhận tin kiểu hỏi-đáp được.';
    return 'Có chương trình KHÁC đang cùng nhận tin bằng đúng token bot này (ví dụ một bot/agent khác dùng chung token) nên hai bên giành tin của nhau.';
  }

  async function tell(text) {
    const last = Number(db.kvGet(KEY)) || 0;
    if (now() - last < notifyEveryMs) return false;
    db.kvSet(KEY, now());
    for (const a of admins || []) { try { await tg.sendMessage(a, text); } catch (e) { log('không báo được lỗi nhận tin: ' + e.message); } }
    return true;
  }

  return {
    state: () => Object.assign({}, st),
    // Gọi khi getUpdates lỗi
    async onError(e) {
      st.lastError = String(e && e.message || e).slice(0, 200);
      const code = e && e.code;
      if (code === 409) {
        st.conflicts++;
        if (st.kind !== 'conflict' && st.conflicts >= conflictAfter) {
          st.kind = 'conflict'; st.since = now();
          const why = await explain409();
          log('XUNG ĐỘT NHẬN TIN TELEGRAM (409): ' + why);
          await tell('⚠️ Bot AgentOS đang bị "điếc" một phần: ' + why + '\n\nCách sửa dứt điểm: tạo MỘT BOT RIÊNG cho AgentOS ở @BotFather (/newbot), rồi dán token mới vào Cài đặt → Telegram trên mini PC. Trong lúc chưa sửa, tin anh nhắn có thể không tới bot.').catch(() => {});
        }
      } else if (code === 401 || code === 404) {
        st.kind = 'badtoken'; st.since = st.since || now();
        log('TOKEN TELEGRAM KHÔNG DÙNG ĐƯỢC (' + code + '): ' + st.lastError + ' — tạo token mới ở @BotFather và dán vào Cài đặt.');
      } else if (st.kind === 'ok') { /* lỗi mạng thường: để backoff xử lý */ }
    },
    // Gọi khi getUpdates thành công
    async onOk() {
      if (st.kind === 'conflict' || st.kind === 'badtoken') {
        const was = st.kind, secs = Math.round((now() - st.since) / 1000);
        log('nhận tin Telegram đã bình thường lại (trước đó: ' + was + ' ' + secs + ' giây)');
        if (db.kvGet(KEY)) { db.kvDel(KEY); for (const a of admins || []) tg.sendMessage(a, '✅ Bot đã nhận tin bình thường lại.').catch(() => {}); }
      }
      st.kind = 'ok'; st.conflicts = 0; st.since = now(); st.lastError = '';
    },
  };
}

module.exports = { createTgWatch };
