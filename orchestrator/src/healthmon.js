'use strict';

// GIÁM SÁT CHỦ ĐỘNG: cứ mỗi `intervalMs` (mặc định 15 phút) chạy tự chẩn đoán nhanh (không tốn hạn mức AI) và NHẮN CHỦ MÁY khi có chuyện:
//   - kiểm tra nào chuyển sang ❌ (lần đầu) → báo ngay; vẫn ❌ → nhắc lại sau `remindMs` (mặc định 6 giờ), không spam
//   - từ ❌ về ✅ → báo "đã ổn lại"
// ⚠️ (lưu ý) không nhắn, chỉ hiện khi gõ /tuchan. Trạng thái nhớ ở db kv 'mon_state' nên khởi động lại không báo trùng.
function createHealthMon({ selftest, db, notify, admins, log, intervalMs, remindMs, now, firstDelayMs }) {
  log = log || (() => {});
  now = now || Date.now;
  intervalMs = intervalMs || 15 * 60 * 1000;
  remindMs = remindMs || 6 * 3600 * 1000;
  let timer = null, first = null, busy = false;

  const read = () => { try { return JSON.parse(db.kvGet('mon_state') || '{}'); } catch (e) { return {}; } };

  async function tick() {
    if (busy) return { skipped: true };
    busy = true;
    try {
      const results = await selftest.light();
      const prev = read(); const next = {}; const lines = []; const fixed = [];
      for (const r of results) {
        if (r.status === 'fail') {
          const p = prev[r.id];
          next[r.id] = { since: p ? p.since : now(), told: p ? p.told : 0 };
          if (!p || now() - p.told >= remindMs) { lines.push('❌ ' + r.name + ' — ' + r.detail); next[r.id].told = now(); }
        } else if (prev[r.id]) fixed.push('✅ ' + r.name + ' đã ổn lại');
      }
      db.kvSet('mon_state', JSON.stringify(next));
      const msg = [];
      if (lines.length) msg.push('🚨 AgentOS phát hiện sự cố:\n' + lines.join('\n') + '\n\nGõ /tuchan để xem đầy đủ, /log để xem nhật ký.');
      if (fixed.length) msg.push(fixed.join('\n'));
      for (const m of msg) for (const a of admins || []) { try { await notify(a, m); } catch (e) { log('không báo được sự cố: ' + e.message); } }
      return { results, told: msg.length };
    } catch (e) { log('giám sát lỗi: ' + e.message); return { error: e.message }; } finally { busy = false; }
  }

  return {
    tick,
    start() { first = setTimeout(tick, firstDelayMs === undefined ? 120000 : firstDelayMs); timer = setInterval(tick, intervalMs); for (const t of [first, timer]) if (t && t.unref) t.unref(); },
    stop() { clearTimeout(first); clearInterval(timer); },
  };
}

module.exports = { createHealthMon };
