'use strict';

// Câu chữ báo chạm giới hạn của các CLI (Claude Code, Codex). CLI đổi câu chữ theo thời gian -> test định kỳ.
const LIMIT_RE = /usage limit|rate limit|limit reached|limit will reset|hit your limit|quota|out of (credits|usage)|too many requests|try again (at|in|after)/i;

// Lỗi TẠM THỜI (máy chủ AI quá tải, rớt mạng): thử lại sau vài giây, KHÔNG cho engine nghỉ cả giờ như khi hết hạn mức.
const TRANSIENT_RE = /overloaded|\b(500|502|503|504|529)\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network error|fetch failed|temporarily unavailable|internal server error|service unavailable|bad gateway/i;

// Phân loại lỗi của một lần chạy: { limit, transient }. Lỗi tạm thời được ưu tiên (câu "try again in a moment" của lúc quá tải
// trông giống câu hết hạn mức).
function classifyFailure(text) {
  const transient = TRANSIENT_RE.test(text);
  return { transient, limit: !transient && LIMIT_RE.test(text) };
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const UNIT_MS = { d: 86400000, h: 3600000, m: 60000 };
const MAX_AHEAD = 8 * 86400000;

// Đoán thời điểm hạn mức hồi (ms epoch) từ câu chữ của CLI. Trả null nếu không đoán được.
// Giờ không kèm múi giờ được hiểu theo giờ của máy (máy AgentOS đặt giờ Việt Nam).
function parseResetTime(text, now) {
  text = String(text || '');
  now = now == null ? Date.now() : now;
  let t = null;

  // 1) "Claude AI usage limit reached|1760000000" (giây epoch)
  let m = text.match(/limit reached\|(\d{10})\b/i);
  if (m) t = Number(m[1]) * 1000;

  // 2) "try again at Oct 22nd, 2026 3:15 PM" / "Oct 22, 3:15 PM"
  if (t == null) {
    m = text.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?(\d{1,2}):(\d{2})\s*([AP]M)?/i);
    const mon = m && MONTHS[m[1].toLowerCase()];
    if (m && mon !== undefined) {
      let h = Number(m[4]); const ap = (m[6] || '').toUpperCase();
      if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0;
      const d = new Date(m[3] ? Number(m[3]) : new Date(now).getFullYear(), mon, Number(m[2]), h, Number(m[5]), 0, 0);
      t = d.getTime();
      if (!m[3] && t <= now) t = new Date(d.getFullYear() + 1, mon, Number(m[2]), h, Number(m[5])).getTime();
    }
  }

  // 3) "try again in 2 hours 30 minutes" / "resets in 45 minutes"
  if (t == null) {
    m = text.match(/\b(?:in|after)\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[\s,]*(?:and\s*)?)+)/i);
    if (m) {
      let sum = 0; const re = /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi; let p;
      while ((p = re.exec(m[1]))) sum += Number(p[1]) * UNIT_MS[p[2][0].toLowerCase()];
      if (sum > 0) t = now + sum;
    }
  }

  // 4) "reset at 5pm" / "resets at 17:30" (lần tới của giờ đó)
  if (t == null) {
    m = text.match(/\b(?:at|until)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    if (m && (m[3] || m[2])) {
      let h = Number(m[1]); const ap = (m[3] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
      if (h <= 23) {
        const d = new Date(now); d.setHours(h, Number(m[2] || 0), 0, 0);
        t = d.getTime();
        if (t <= now) t += 86400000;
      }
    }
  }

  if (t == null || !(t > now) || t - now > MAX_AHEAD) return null;
  return t;
}

module.exports = { LIMIT_RE, TRANSIENT_RE, classifyFailure, parseResetTime };
