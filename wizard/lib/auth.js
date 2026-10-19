'use strict';
const crypto = require('crypto');

// Mã cài đặt 6 số + phiên đăng nhập. Người dùng ở MÁY (kiosk 127.0.0.1) hoặc ở mạng Wi-Fi tạm của máy (có mật khẩu riêng) được tin;
// điện thoại vào qua mạng LAN cửa hàng phải nhập mã hiện trên màn hình/nhãn. Sai quá nhiều lần thì khóa tạm (chống dò mã).
function createAuth(opts) {
  opts = opts || {};
  const now = opts.now || Date.now;
  const maxFails = opts.maxFails || 5;
  const lockMs = opts.lockMs || 5 * 60 * 1000;
  const sessionMs = opts.sessionMs || 12 * 3600 * 1000;
  let code = opts.code || newCode();
  const sessions = new Map();     // token -> hết hạn
  const fails = new Map();        // ip -> { n, until }

  function newCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  return {
    code: () => code,
    rotate() { code = newCode(); return code; },
    // Kiểm tra mã. Trả { ok, token } hoặc { ok:false, error, locked, retryAfterSec }.
    verify(ip, given) {
      const f = fails.get(ip) || { n: 0, until: 0 };
      if (f.until > now()) return { ok: false, locked: true, retryAfterSec: Math.ceil((f.until - now()) / 1000), error: 'Nhập sai quá nhiều lần, thử lại sau ' + Math.ceil((f.until - now()) / 60000) + ' phút.' };
      if (same(String(given || '').replace(/\s/g, ''), code)) {
        fails.delete(ip);
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, now() + sessionMs);
        return { ok: true, token };
      }
      f.n += 1;
      if (f.n >= maxFails) { f.until = now() + lockMs; f.n = 0; }
      fails.set(ip, f);
      return { ok: false, error: f.until > now() ? 'Nhập sai quá nhiều lần, thử lại sau 5 phút.' : 'Mã không đúng.' };
    },
    valid(token) {
      const exp = sessions.get(token);
      if (!exp) return false;
      if (exp < now()) { sessions.delete(token); return false; }
      return true;
    },
    revokeAll() { sessions.clear(); },
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

module.exports = { createAuth, parseCookies };
