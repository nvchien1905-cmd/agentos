'use strict';
// Khai báo các GIAN HÀNG KiotViet (mỗi gian = một cửa hàng KiotViet riêng) trong orchestrator.env, dùng cho trang Cài đặt → KiotViet.
// Lưu ở KIOTVIET_SHOPS (JSON một dòng). Bộ khóa cũ KIOTVIET_CLIENT_ID/SECRET/RETAILER được gộp vào danh sách khi lưu lần đầu rồi xóa khỏi tệp.
const { parseShops } = require('../../orchestrator/src/kiotviet');

const TOKEN_URL = 'https://id.kiotviet.vn/connect/token';
const API = 'https://public.kiotapi.com';
const LEGACY = ['KIOTVIET_CLIENT_ID', 'KIOTVIET_CLIENT_SECRET', 'KIOTVIET_RETAILER'];
const mask = (s) => (!s ? '' : String(s).length <= 10 ? '****' : String(s).slice(0, 4) + '…' + String(s).slice(-4));

function envMap(text) {
  const m = {};
  for (const l of String(text || '').split('\n')) { const i = l.indexOf('='); if (i > 0 && /^[A-Z0-9_]+$/.test(l.slice(0, i))) m[l.slice(0, i)] = l.slice(i + 1).trim(); }
  return m;
}
const shopsFromEnv = (text) => parseShops(envMap(text));

// Trả danh sách để HIỂN THỊ (khóa bí mật được che)
function view(text) {
  return shopsFromEnv(text).map((s) => ({ name: s.name || s.retailer, retailer: s.retailer, clientId: mask(s.clientId), clientSecret: mask(s.clientSecret) }));
}

// Kiểm khóa thật với KiotViet: lấy token rồi đọc danh sách chi nhánh. Trả { ok, detail, branches }.
async function check(s, fetchImpl) {
  const f = fetchImpl || fetch;
  if (!s.retailer || !s.clientId || !s.clientSecret) return { ok: false, detail: 'Cần đủ Retailer (tên cửa hàng KiotViet), Client ID và Client Secret.' };
  let r;
  try {
    r = await f(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ scopes: 'PublicApi.Access', grant_type: 'client_credentials', client_id: s.clientId, client_secret: s.clientSecret }), signal: AbortSignal.timeout(20000) });
  } catch (e) { return { ok: false, network: true, detail: 'Không kết nối được tới KiotViet (kiểm tra mạng): ' + (e.message || e) }; }
  if (r.status === 400 || r.status === 401 || r.status === 403) return { ok: false, detail: 'KiotViet báo Client ID hoặc Client Secret không đúng (HTTP ' + r.status + ').' };
  if (!r.ok) return { ok: false, network: true, detail: 'KiotViet trả HTTP ' + r.status + ' khi đăng nhập API, thử lại sau.' };
  const token = (await r.json()).access_token;
  let b;
  try { b = await f(API + '/branches?pageSize=100', { headers: { Authorization: 'Bearer ' + token, Retailer: s.retailer }, signal: AbortSignal.timeout(20000) }); }
  catch (e) { return { ok: false, network: true, detail: 'Không đọc được KiotViet: ' + (e.message || e) }; }
  if (b.status === 401 || b.status === 403 || b.status === 404 || b.status === 400) return { ok: false, detail: 'Khóa đúng nhưng tên cửa hàng (Retailer) "' + s.retailer + '" không khớp, hoặc khóa không thuộc cửa hàng này (HTTP ' + b.status + ').' };
  if (!b.ok) return { ok: false, network: true, detail: 'KiotViet trả HTTP ' + b.status + ' khi đọc chi nhánh, thử lại sau.' };
  const names = ((await b.json()).data || []).map((x) => x.branchName).filter(Boolean);
  return { ok: true, detail: 'Nối được "' + s.retailer + '"' + (names.length ? ' — chi nhánh: ' + names.join(', ') : ''), branches: names };
}

// Ghi lại tệp cấu hình với danh sách gian mới (bỏ bộ khóa cũ đã gộp)
function writeShops(text, shops) {
  const lines = String(text || '').split('\n').filter((l) => !LEGACY.some((k) => l.startsWith(k + '=')) && !l.startsWith('KIOTVIET_SHOPS='));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (shops.length) lines.push('KIOTVIET_SHOPS=' + JSON.stringify(shops));
  lines.push('');
  return lines.join('\n');
}

// Thêm/sửa một gian (khớp theo Retailer; để trống Client Secret/ID khi sửa = giữ khóa cũ)
function upsert(text, s) {
  const clean = (v) => String(v || '').trim();
  const n = { name: clean(s.name), retailer: clean(s.retailer), clientId: clean(s.clientId), clientSecret: clean(s.clientSecret) };
  for (const k of ['name', 'retailer', 'clientId', 'clientSecret']) if (/[\r\n\0]/.test(n[k])) throw new Error('Có ký tự không hợp lệ trong ô nhập');
  if (!/^[A-Za-z0-9._-]{2,60}$/.test(n.retailer)) throw new Error('Retailer là tên cửa hàng KiotViet (ví dụ tongkhohuyenanh01): chữ không dấu, số, gạch.');
  const shops = shopsFromEnv(text);
  const i = shops.findIndex((x) => x.retailer.toLowerCase() === n.retailer.toLowerCase());
  if (i >= 0) { n.clientId = n.clientId || shops[i].clientId; n.clientSecret = n.clientSecret || shops[i].clientSecret; shops[i] = n; } else shops.push(n);
  if (!n.clientId || !n.clientSecret) throw new Error('Cần Client ID và Client Secret.');
  return { text: writeShops(text, shops), shop: n };
}

function remove(text, retailer) {
  const shops = shopsFromEnv(text), i = shops.findIndex((x) => x.retailer.toLowerCase() === String(retailer || '').toLowerCase());
  if (i < 0) throw new Error('Không có gian hàng này.');
  shops.splice(i, 1);
  return writeShops(text, shops);
}

module.exports = { view, check, upsert, remove, shopsFromEnv, mask };
