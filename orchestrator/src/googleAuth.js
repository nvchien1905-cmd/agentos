'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ĐĂNG NHẬP GOOGLE của AgentOS (cho máy chủ MCP Google Lịch + Gmail riêng: google-mcp.js): OAuth "Desktop app" với PKCE, chuyển hướng về 127.0.0.1 (trang Cài đặt bắt mã).
//  - Mặc định CHỈ ĐỌC (calendar.readonly + gmail.readonly). Bật "cho phép ghi" mới xin thêm calendar.events (tạo/sửa/xóa sự kiện) và gmail.compose (soạn nháp/gửi thư)
//    — hẹp hơn nhiều so với gói cộng đồng (gmail.modify + gmail.settings.basic gồm cả bộ lọc/chuyển tiếp thư).
//  - Khóa client (client.json) và token (tokens.json) lưu 0600 trong thư mục dữ liệu; token tự làm mới; không bao giờ trả ra ngoài.
const SC = 'https://www.googleapis.com/auth/';
const SCOPES = { read: [SC + 'calendar.readonly', SC + 'gmail.readonly'], write: [SC + 'calendar.events', SC + 'gmail.compose'] };
const ORIGINS = { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke' };
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function createGoogleAuth(o) {
  const dir = o.dir, now = o.now || Date.now;
  const f = o.fetch || fetch;
  const origins = Object.assign({}, ORIGINS, o.origins || {});
  const clientFile = path.join(dir, 'client.json'), tokenFile = path.join(dir, 'tokens.json');
  const sharedFile = o.sharedClientFile || process.env.GOOGLE_SHARED_CLIENT || '';       // khóa DÙNG CHUNG do nhà phát hành AgentOS cấp sẵn (khách khỏi tự tạo); khóa khách tự nhập được ưu tiên
  const pending = new Map();                 // state -> { verifier, redirectUri, write, until }
  let refreshing = null;

  const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
  const write = (file, v) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const t = file + '.tmp' + process.pid;
    fs.writeFileSync(t, JSON.stringify(v), { mode: 0o600 });
    fs.renameSync(t, file); try { fs.chmodSync(file, 0o600); } catch (e) { /* hệ tệp không hỗ trợ */ }
  };

  const okClient = (c) => !!(c && c.client_id && c.client_secret);
  const getClient = () => { const c = read(clientFile); if (okClient(c)) return c; let s = sharedFile ? read(sharedFile) : null; s = s && (s.installed || s); return okClient(s) ? { client_id: s.client_id, client_secret: s.client_secret } : null; };

  const api = {
    SCOPES,
    clientSet: () => !!getClient(),
    // Nhận cả tệp JSON Google cho tải về ({installed:{client_id,client_secret…}}) lẫn {client_id, client_secret}
    saveClient(input) {
      let c = input;
      if (typeof c === 'string') {
        if (!c.trim()) return { ok: false, error: 'Chưa có nội dung. Bấm "Chọn tệp JSON" rồi chọn tệp client_secret_….json vừa tải từ Google.' };
        try { c = JSON.parse(c); } catch (e) { return { ok: false, error: 'Tệp này không phải JSON của Google (có thể bị cắt dở). Tải lại tệp từ Google rồi chọn lại, đừng dán thiếu.' }; }
      }
      if (c && c.type === 'service_account') return { ok: false, error: 'Đây là tệp "tài khoản dịch vụ", không dùng được. Cần tạo "Mã ứng dụng khách OAuth" loại Ứng dụng máy tính để bàn (Desktop app).' };
      if (c && c.web && !c.installed) return { ok: false, error: 'Anh đã tạo nhầm loại "Ứng dụng web". Quay lại Google Cloud tạo lại mã ứng dụng khách loại "Ứng dụng máy tính để bàn" (Desktop app), rồi tải tệp JSON mới.' };
      c = (c && c.installed) || c || {};
      const id = String(c.client_id || '').trim(), secret = String(c.client_secret || '').trim();
      if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) return { ok: false, error: 'Mã ứng dụng khách (client_id) phải kết thúc bằng .apps.googleusercontent.com' };
      if (secret.length < 8 || /\s/.test(secret)) return { ok: false, error: 'Mật khẩu ứng dụng khách (client_secret) không hợp lệ.' };
      write(clientFile, { client_id: id, client_secret: secret }); return { ok: true };
    },
    status() {
      const t = read(tokenFile);
      const sc = t && t.scope ? String(t.scope).split(/\s+/) : [];
      return { clientSet: api.clientSet(), ownClient: okClient(read(clientFile)), sharedClient: !okClient(read(clientFile)) && api.clientSet(), connected: !!(t && t.refresh_token), write: sc.includes(SCOPES.write[0]) || sc.includes(SCOPES.write[1]), scopes: sc, at: t && t.at ? t.at : 0 };
    },
    // Bắt đầu đăng nhập: trả đường link Google; redirectUri là địa chỉ loopback bắt mã (vd http://127.0.0.1:8089/google/callback)
    start({ write: wantWrite, redirectUri }) {
      const c = getClient(); if (!c) return { ok: false, error: 'Chưa nhập khóa ứng dụng Google (client).' };
      if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\//.test(String(redirectUri))) return { ok: false, error: 'Địa chỉ chuyển hướng phải là loopback (127.0.0.1).' };
      const verifier = b64url(crypto.randomBytes(48)), state = b64url(crypto.randomBytes(24));
      for (const [k, v] of pending) if (v.until < now()) pending.delete(k);
      pending.set(state, { verifier, redirectUri, write: !!wantWrite, until: now() + 10 * 60000 });
      const q = new URLSearchParams({ client_id: c.client_id, redirect_uri: redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false',
        scope: SCOPES.read.concat(wantWrite ? SCOPES.write : []).join(' '), state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
      return { ok: true, url: origins.auth + '?' + q.toString(), state };
    },
    async finish({ code, state }) {
      const p = pending.get(String(state)); pending.delete(String(state));
      if (!p || p.until < now()) return { ok: false, error: 'Phiên đăng nhập hết hạn hoặc không đúng — bấm Đăng nhập lại.' };
      const c = getClient(); if (!c) return { ok: false, error: 'Chưa có khóa ứng dụng Google.' };
      const r = await f(origins.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: String(code), client_id: c.client_id, client_secret: c.client_secret, redirect_uri: p.redirectUri, grant_type: 'authorization_code', code_verifier: p.verifier }).toString() });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) return { ok: false, error: 'Google từ chối: ' + String(j.error_description || j.error || r.status).slice(0, 200) };
      if (!j.refresh_token) return { ok: false, error: 'Google không cấp refresh token (đăng nhập lại, nhớ bấm Cho phép đủ quyền).' };
      write(tokenFile, { access_token: j.access_token, refresh_token: j.refresh_token, expiry: now() + (Number(j.expires_in) || 3600) * 1000, scope: j.scope || '', at: now() });
      return { ok: true, scope: j.scope || '' };
    },
    // Token truy cập còn hạn (tự làm mới bằng refresh token)
    async accessToken() {
      const t = read(tokenFile); if (!t || !t.refresh_token) throw new Error('Chưa đăng nhập Google (Cài đặt → Kết nối và kỹ năng → Google).');
      if (t.access_token && t.expiry - now() > 60000) return t.access_token;
      if (refreshing) return refreshing;
      refreshing = (async () => {
        const c = getClient(); if (!c) throw new Error('Thiếu khóa ứng dụng Google.');
        const r = await f(origins.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }).toString() });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.access_token) throw new Error('Làm mới đăng nhập Google lỗi: ' + String(j.error_description || j.error || r.status).slice(0, 160) + ' — đăng nhập lại ở Cài đặt.');
        write(tokenFile, Object.assign({}, t, { access_token: j.access_token, expiry: now() + (Number(j.expires_in) || 3600) * 1000 }));
        return j.access_token;
      })().finally(() => { refreshing = null; });
      return refreshing;
    },
    async revoke() {
      const t = read(tokenFile);
      if (t && t.refresh_token) { try { await f(origins.revoke, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(t.refresh_token) }); } catch (e) { /* mạng lỗi: vẫn xóa tệp */ } }
      try { fs.rmSync(tokenFile, { force: true }); } catch (e) { /* bỏ */ }
      return { ok: true };
    },
    removeClient() { try { fs.rmSync(clientFile, { force: true }); } catch (e) { /* bỏ */ } },
    hasWrite: () => api.status().write,
  };
  return api;
}

module.exports = { createGoogleAuth, SCOPES };
