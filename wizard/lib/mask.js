'use strict';

// CHE BỚT thông tin bí mật khi hiển thị cho khách hàng: cho biết "đã có" và nhận ra được là của mình, nhưng không lộ đủ để dùng được.
// Chỉ dùng cho hiển thị; không bao giờ ghi ngược giá trị đã che.
const DOTS = '••••';

// Khóa/token: giữ vài ký tự đầu (nhận biết loại khóa) và cuối; khóa ngắn che hết.  sk-ant-api03-AbCd…  ->  sk-a••••WxYz
function secret(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return '';
  if (s.length <= 12) return DOTS;
  return s.slice(0, 4) + DOTS + s.slice(-3);
}

// Token bot Telegram: 123456789:AAH… -> chỉ giữ 4 số đầu của mã bot và vài ký tự cuối
function telegramToken(s) {
  s = String(s == null ? '' : s).trim();
  const m = s.match(/^(\d{4})\d*:(.{4})/);
  if (!m) return secret(s);
  return m[1] + '••••:' + DOTS + s.slice(-3);
}

// Email: n•••@g•••.com
function email(s) {
  s = String(s == null ? '' : s).trim();
  const m = s.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!m) return s ? name(s) : '';
  const dom = m[2].split('.');
  return m[1].slice(0, 1) + '•••@' + dom[0].slice(0, 1) + '•••' + (dom.length > 1 ? '.' + dom.slice(1).join('.') : '');
}

// Tên người: giữ chữ cái đầu mỗi từ  "Nguyễn Văn An" -> "N••• V••• A••"
function name(s) {
  return String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean).map((w) => w.slice(0, 1) + '•••').join(' ');
}

// Số điện thoại / ID dài: giữ 3 số cuối
function digits(s) {
  s = String(s == null ? '' : s).replace(/\s+/g, '');
  return s.length <= 4 ? DOTS : DOTS + s.slice(-3);
}

module.exports = { secret, telegramToken, email, name, digits, DOTS };
