'use strict';
const crypto = require('crypto');

// ĐĂNG NHẬP ONEDRIVE KHÔNG CẦN COPY-DÁN.
// Từ cuối 2025 Microsoft đổi trang https://login.microsoftonline.com/common/oauth2/nativeclient: hiện cảnh báo vài giây rồi TỰ chuyển sang
// /common/wrongplace ("Đây không phải là trang phù hợp") nên khách không kịp copy địa chỉ có mã (client onedrive 2.5.4 trong Debian chưa sửa).
// Cách làm ở đây (giống bản sửa 2.5.11 của chính tác giả): đổi địa chỉ nhận mã sang http://127.0.0.1:<cổng>/ — Cài đặt AgentOS tự nhận mã,
// tự đổi mã lấy khóa làm mới (refresh token) và ghi vào tệp `refresh_token` mà dịch vụ onedrive đọc (chuỗi thô, quyền 600).
const DEFAULT_CLIENT = 'd50ca740-c83f-4d1b-b616-12c519384f0c';            // ứng dụng đã đăng ký của client onedrive (abraunegg)
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const NATIVE = 'https://login.microsoftonline.com/common/oauth2/nativeclient';

// Lấy client_id và scope từ địa chỉ đăng nhập do client `onedrive --auth-files` tạo
function parseAuthUrl(u) {
  let url; try { url = new URL(String(u)); } catch (e) { return null; }
  if (url.hostname !== 'login.microsoftonline.com') return null;
  return { clientId: url.searchParams.get('client_id') || DEFAULT_CLIENT, scope: url.searchParams.get('scope') || 'Files.ReadWrite Files.ReadWrite.All Sites.ReadWrite.All offline_access' };
}

// Địa chỉ đăng nhập "tự động": đổi redirect_uri sang máy này và thêm state chống giả mạo
function autoUrl(u, redirect, state) {
  const url = new URL(String(u));
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('state', state);
  return url.toString();
}

const newState = () => crypto.randomBytes(18).toString('hex');

async function post(fetchImpl, body) {
  let r;
  try { r = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(30000) }); }
  catch (e) { throw new Error('Không kết nối được Microsoft: ' + (e.message || e)); }
  let j = null; try { j = await r.json(); } catch (e) { /* không phải JSON */ }
  if (!r.ok || !j || !j.refresh_token && !j.access_token) throw new Error('Microsoft không chấp nhận' + (j && (j.error_description || j.error) ? ': ' + String(j.error_description || j.error).split('\n')[0].slice(0, 200) : ' (HTTP ' + r.status + ')'));
  return j;
}

// Đổi mã đăng nhập (dùng một lần) lấy khóa làm mới
async function exchange({ fetch: f, clientId, scope, code, redirect }) {
  const j = await post(f || fetch, { client_id: clientId, scope, code, redirect_uri: redirect, grant_type: 'authorization_code' });
  if (!j.refresh_token) throw new Error('Microsoft không trả khóa làm mới (thiếu quyền offline_access).');
  return { refreshToken: String(j.refresh_token).trim(), accessToken: j.access_token || '' };
}

async function refresh({ fetch: f, clientId, refreshToken }) {
  const j = await post(f || fetch, { client_id: clientId || DEFAULT_CLIENT, refresh_token: refreshToken, grant_type: 'refresh_token', redirect_uri: NATIVE });
  return { accessToken: j.access_token || '', refreshToken: j.refresh_token ? String(j.refresh_token).trim() : null };
}

// Ai đang sở hữu ổ OneDrive này (tên hiển thị + loại tài khoản); lỗi thì trả null, không làm hỏng việc đăng nhập
async function whoami(f, accessToken) {
  try {
    const r = await (f || fetch)('https://graph.microsoft.com/v1.0/me/drive?$select=driveType,owner', { headers: { Authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    const u = (j.owner && (j.owner.user || j.owner.group)) || {};
    return { name: u.displayName || '', email: u.email || '', driveType: j.driveType || '' };
  } catch (e) { return null; }
}

module.exports = { DEFAULT_CLIENT, NATIVE, parseAuthUrl, autoUrl, newState, exchange, refresh, whoami };
