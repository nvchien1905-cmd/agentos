'use strict';
// KHÓA BẰNG VÂN TAY (passkey/WebAuthn) cho lệnh Telegram: bật thì sau mỗi N giờ (mặc định 24) phải quét vân tay/khuôn mặt trên ĐIỆN THOẠI mới ra lệnh được.
//  - Không phụ thuộc thư viện: tự đọc CBOR + kiểm chữ ký ES256 (ECDSA P-256) bằng crypto của Node. Chỉ nhận passkey có "xác minh người dùng" (UV: vân tay/khuôn mặt/PIN máy).
//  - Trang quét vân tay chạy ở 127.0.0.1:<cổng>, được đưa ra HTTPS CHỈ TRONG mạng Tailscale bằng `tailscale serve` (điện thoại phải bật Tailscale). KHÔNG dùng funnel (Internet).
//  - Mỗi đường dẫn là một mã dùng 1 lần, sống 10 phút. Mất điện thoại / hỏng: đặt UNLOCK_DISABLE=1 trong /etc/agentos/orchestrator.env rồi khởi động lại dịch vụ.
const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// ---- CBOR tối thiểu (đủ cho attestationObject + khóa COSE) ----
function cborDecode(buf, off) {
  off = off || 0;
  const ib = buf[off++], mt = ib >> 5, ai = ib & 31;
  let n = ai;
  if (ai === 24) n = buf[off++];
  else if (ai === 25) { n = buf.readUInt16BE(off); off += 2; }
  else if (ai === 26) { n = buf.readUInt32BE(off); off += 4; }
  else if (ai > 26) throw new Error('CBOR không hỗ trợ');
  if (mt === 0) return [n, off];
  if (mt === 1) return [-1 - n, off];
  if (mt === 2) { if (off + n > buf.length) throw new Error('CBOR cắt cụt'); return [buf.subarray(off, off + n), off + n]; }
  if (mt === 3) { if (off + n > buf.length) throw new Error('CBOR cắt cụt'); return [buf.toString('utf8', off, off + n), off + n]; }
  if (mt === 4) { const a = []; for (let i = 0; i < n; i++) { const r = cborDecode(buf, off); a.push(r[0]); off = r[1]; } return [a, off]; }
  if (mt === 5) { const m = new Map(); for (let i = 0; i < n; i++) { const k = cborDecode(buf, off); const v = cborDecode(buf, k[1]); m.set(k[0], v[0]); off = v[1]; } return [m, off]; }
  if (mt === 7 && (ai === 20 || ai === 21)) return [ai === 21, off];
  throw new Error('CBOR không hỗ trợ');
}

function parseAuthData(ad) {
  if (ad.length < 37) throw new Error('authData quá ngắn');
  const r = { rpIdHash: ad.subarray(0, 32), flags: ad[32], signCount: ad.readUInt32BE(33), rest: ad.subarray(37) };
  return r;
}
function checkClient(clientDataJSON, type, challenge, origin) {
  let cd; try { cd = JSON.parse(Buffer.from(clientDataJSON).toString('utf8')); } catch (e) { throw new Error('clientData hỏng'); }
  if (cd.type !== type) throw new Error('sai loại yêu cầu');
  if (cd.challenge !== challenge) throw new Error('sai mã thử thách');
  if (cd.origin !== origin) throw new Error('sai địa chỉ trang (' + cd.origin + ')');
  return cd;
}
function checkAuthData(ad, rpId) {
  if (!ad.rpIdHash.equals(sha256(rpId))) throw new Error('sai tên miền (rpId)');
  if (!(ad.flags & 0x01)) throw new Error('chưa xác nhận có mặt người dùng');
  if (!(ad.flags & 0x04)) throw new Error('chưa xác minh vân tay/khuôn mặt (UV)');
}

// Đăng ký: trả { id, pub(base64 DER SPKI), signCount }
function verifyRegistration(resp, challenge, origin, rpId) {
  checkClient(Buffer.from(resp.clientDataJSON, 'base64url'), 'webauthn.create', challenge, origin);
  const att = cborDecode(Buffer.from(resp.attestationObject, 'base64url'))[0];
  const authData = att.get('authData'); if (!Buffer.isBuffer(authData)) throw new Error('thiếu authData');
  const ad = parseAuthData(authData); checkAuthData(ad, rpId);
  if (!(ad.flags & 0x40)) throw new Error('thiếu khóa công khai');
  const rest = ad.rest; if (rest.length < 18) throw new Error('authData thiếu dữ liệu khóa');
  const idLen = rest.readUInt16BE(16), id = rest.subarray(18, 18 + idLen);
  const cose = cborDecode(rest, 18 + idLen)[0];
  if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) throw new Error('chỉ nhận khóa ES256 (P-256)');
  const x = cose.get(-2), y = cose.get(-3); if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new Error('khóa không hợp lệ');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }, format: 'jwk' });
  if (resp.id && resp.id !== b64u(id)) throw new Error('id không khớp');
  return { id: b64u(id), pub: key.export({ type: 'spki', format: 'der' }).toString('base64'), signCount: ad.signCount };
}

// Đăng nhập: trả signCount mới (ném lỗi nếu sai)
function verifyAssertion(resp, cred, challenge, origin, rpId) {
  const cdj = Buffer.from(resp.clientDataJSON, 'base64url');
  checkClient(cdj, 'webauthn.get', challenge, origin);
  const authData = Buffer.from(resp.authenticatorData, 'base64url'), ad = parseAuthData(authData); checkAuthData(ad, rpId);
  const key = crypto.createPublicKey({ key: Buffer.from(cred.pub, 'base64'), format: 'der', type: 'spki' });
  if (!crypto.verify('sha256', Buffer.concat([authData, sha256(cdj)]), key, Buffer.from(resp.signature, 'base64url'))) throw new Error('chữ ký sai');
  if ((ad.signCount || cred.signCount) && ad.signCount <= cred.signCount) throw new Error('bộ đếm lùi (nghi sao chép khóa)');
  return ad.signCount;
}

const PAGE = (kind) => `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mở khóa AgentOS</title>
<body style="font-family:system-ui;max-width:420px;margin:12vh auto;padding:0 20px;text-align:center"><h2>${kind === 'reg' ? '🔐 Đăng ký vân tay' : '🔓 Mở khóa AgentOS'}</h2><p id="m">Bấm nút rồi quét vân tay / khuôn mặt trên điện thoại.</p>
<button id="b" style="font-size:20px;padding:14px 28px;border-radius:12px;border:0;background:#2563eb;color:#fff">Tiếp tục</button>
<script>
const u=(s)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const e=(b)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const m=document.getElementById('m');
document.getElementById('b').onclick=async()=>{try{
 const o=await (await fetch('options',{method:'POST'})).json(); if(o.error) throw new Error(o.error);
 let body;
 if(o.kind==='reg'){const c=await navigator.credentials.create({publicKey:{challenge:u(o.challenge),rp:{id:o.rpId,name:'AgentOS'},user:{id:u(o.userId),name:'chu-may',displayName:'Chủ máy'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'preferred',userVerification:'required'},attestation:'none',timeout:120000}});
  body={id:e(c.rawId),clientDataJSON:e(c.response.clientDataJSON),attestationObject:e(c.response.attestationObject)};}
 else{const c=await navigator.credentials.get({publicKey:{challenge:u(o.challenge),rpId:o.rpId,allowCredentials:o.ids.map(i=>({type:'public-key',id:u(i)})),userVerification:'required',timeout:120000}});
  body={id:e(c.rawId),clientDataJSON:e(c.response.clientDataJSON),authenticatorData:e(c.response.authenticatorData),signature:e(c.response.signature)};}
 const r=await (await fetch('finish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
 m.textContent=r.ok?'✅ Xong! Quay lại Telegram.':('❌ '+(r.error||'lỗi')); if(r.ok) document.getElementById('b').remove();
}catch(x){m.textContent='❌ '+(x&&x.message||x);}};
</script></body></html>`;

function createUnlock(o) {
  const db = o.db, log = o.log || (() => {}), env = o.env || process.env, now = o.now || Date.now;
  const exec = o.exec || ((bin, args) => new Promise((res) => execFile(bin, args, { timeout: 15000 }, (err, out, serr) => res({ code: err ? (err.code || 1) : 0, out: String(out || ''), err: String(serr || '') }))));
  const hostName = o.hostName || (async () => { const r = await exec('tailscale', ['status', '--json']); try { return String(JSON.parse(r.out).Self.DNSName || '').replace(/\.$/, ''); } catch (e) { return ''; } });
  const port = Number(env.UNLOCK_PORT || o.port || 8095);
  const load = () => { try { return Object.assign({ enabled: false, hours: 24, creds: [], users: {} }, JSON.parse(db.kvGet('unlock_cfg') || '{}')); } catch (e) { return { enabled: false, hours: 24, creds: [], users: {} }; } };
  const save = (c) => db.kvSet('unlock_cfg', JSON.stringify(c));
  const disabledByEnv = () => String(env.UNLOCK_DISABLE || '') === '1';
  const tokens = new Map();                       // mã trong đường dẫn -> { kind, challenge, exp, chat }
  const sweep = () => { for (const [k, v] of tokens) if (v.exp < now()) tokens.delete(k); };
  let server = null, origin = '', rpId = '';

  // Khóa tính RIÊNG từng người (ID Telegram): vân tay/khuôn mặt của bất kỳ ai đã đăng ký đều mở được, nhưng chỉ mở cho người đang xin; người khác phải tự quét.
  const uid = (u) => (u === undefined || u === null ? '' : String(u));
  const untilOf = (c, u) => Number((c.users || {})[uid(u)]) || 0;
  const isLocked = (u) => { const c = load(); return !disabledByEnv() && c.enabled === true && untilOf(c, u) <= now(); };
  const status = (u) => { const c = load(); return { enabled: c.enabled && !disabledByEnv(), creds: c.creds.length, until: untilOf(c, u), hours: c.hours, locked: isLocked(u), disabledByEnv: disabledByEnv() }; };

  async function ensureServe() {
    if (!rpId) { const h = await hostName(); if (!h) throw new Error('chưa lấy được tên Tailscale của máy (Tailscale đang chạy chưa?)'); rpId = h; origin = 'https://' + h; }
    const r = await exec('tailscale', ['serve', '--bg', '--https=443', 'http://127.0.0.1:' + port]);
    if (r.code !== 0) throw new Error('tailscale serve lỗi: ' + (r.err || r.out).trim().split('\n').pop().slice(0, 200) + ' — cần bật HTTPS Certificates trong trang quản trị Tailscale (DNS → HTTPS Certificates).');
  }
  function listen() {
    if (server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = http.createServer(handle); s.headersTimeout = 10000; s.requestTimeout = 20000;
      s.once('error', reject); s.listen(port, '127.0.0.1', () => { server = s; resolve(); });
    });
  }
  function readBody(req) { return new Promise((res, rej) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 40000) { rej(new Error('quá lớn')); req.destroy(); } }); req.on('end', () => res(b)); req.on('error', rej); }); }
  const send = (res, code, body, type) => { res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  async function handle(req, res) {
    try {
      sweep();
      const m = /^\/u\/([0-9a-f]{48})\/?(options|finish)?$/.exec((req.url || '').split('?')[0]); const t = m && tokens.get(m[1]);
      if (!t) return send(res, 404, 'Liên kết hết hạn hoặc không đúng. Gõ /mokhoa trên Telegram để lấy liên kết mới.', 'text/plain; charset=utf-8');
      if (req.method === 'GET' && !m[2]) return send(res, 200, PAGE(t.kind), 'text/html; charset=utf-8');
      if (req.method !== 'POST') return send(res, 405, { error: 'sai phương thức' });
      const c = load();
      if (m[2] === 'options') {
        t.challenge = b64u(crypto.randomBytes(32));
        if (t.kind === 'reg') return send(res, 200, { kind: 'reg', challenge: t.challenge, rpId, userId: b64u(crypto.randomBytes(16)) });
        return send(res, 200, { kind: 'auth', challenge: t.challenge, rpId, ids: c.creds.map((x) => x.id) });
      }
      if (!t.challenge) return send(res, 400, { error: 'chưa có thử thách' });
      const resp = JSON.parse(await readBody(req));
      if (t.kind === 'reg') {
        const r = verifyRegistration(resp, t.challenge, origin, rpId);
        if (c.creds.some((x) => x.id === r.id)) throw new Error('khóa này đã đăng ký');
        c.creds.push({ id: r.id, pub: r.pub, signCount: r.signCount, at: now() }); save(c); tokens.delete(m[1]);
        log('khóa vân tay: đã đăng ký thêm 1 thiết bị (tổng ' + c.creds.length + ')');
        if (o.notify) o.notify(t.chat, '🔐 Đã đăng ký vân tay (tổng ' + c.creds.length + ' thiết bị). Gõ /khoa bat để bật khóa.').catch(() => {});
        return send(res, 200, { ok: true });
      }
      const cred = c.creds.find((x) => x.id === resp.id); if (!cred) throw new Error('thiết bị này chưa đăng ký');
      cred.signCount = verifyAssertion(resp, cred, t.challenge, origin, rpId);
      c.users = c.users || {}; const until = now() + c.hours * 3600 * 1000; c.users[uid(t.user)] = until; save(c); tokens.delete(m[1]);
      log('khóa vân tay: đã mở khóa cho ' + uid(t.user) + ' tới ' + new Date(until).toISOString());
      if (o.notify) o.notify(t.chat, '🔓 Đã mở khóa ' + c.hours + ' giờ (đến ' + new Date(until).toLocaleString('vi-VN') + '). Chỉ mở cho tài khoản Telegram này. Gõ /khoa để khóa lại ngay.').catch(() => {});
      return send(res, 200, { ok: true });
    } catch (e) { log('khóa vân tay: lỗi ' + e.message); return send(res, 400, { error: String(e.message || e).slice(0, 160) }); }
  }
  async function link(kind, chat, user) {
    await listen(); await ensureServe();
    const tok = crypto.randomBytes(24).toString('hex'); tokens.set(tok, { kind, exp: now() + 10 * 60 * 1000, chat, user });
    return origin + '/u/' + tok + '/';
  }

  // Lệnh /mokhoa, /khoa. Trả chuỗi trả lời, hoặc null nếu không phải lệnh của mô-đun này.
  async function command(text, chat, user) {
    if (user === undefined) user = chat;
    const mt = /^\/(mokhoa|khoa)(?:@\w+)?(?:\s+(.*))?$/i.exec(String(text || '').trim()); if (!mt) return null;
    const cmd = mt[1].toLowerCase(), arg = (mt[2] || '').trim().toLowerCase(), c = load();
    if (disabledByEnv()) return 'ℹ️ Khóa vân tay đang bị tắt bằng UNLOCK_DISABLE=1 trên máy.';
    if (cmd === 'mokhoa') {
      if (!c.creds.length) return 'Chưa đăng ký vân tay nào. Gõ /khoa dangky.';
      try { return '🔓 Mở bằng điện thoại (cần bật Tailscale), liên kết dùng 1 lần, hết hạn sau 10 phút:\n' + await link('auth', chat, user); } catch (e) { return '❌ ' + e.message; }
    }
    if (arg === 'dangky') { try { return '🔐 Mở liên kết này TRÊN ĐIỆN THOẠI (bật Tailscale), bấm Tiếp tục rồi quét vân tay. Dùng 1 lần, 10 phút:\n' + await link('reg', chat, user); } catch (e) { return '❌ ' + e.message; } }
    if (arg === 'bat') { if (!c.creds.length) return '❌ Chưa có vân tay nào. Gõ /khoa dangky trước (tránh tự khóa mình ngoài cửa).'; c.enabled = true; c.users = {}; c.users[uid(user)] = now() + c.hours * 3600 * 1000; save(c); return '🔒 Đã BẬT khóa vân tay. Bạn đang mở khóa tới ' + new Date(c.users[uid(user)]).toLocaleString('vi-VN') + ' (người khác phải tự quét); sau đó mỗi ' + c.hours + ' giờ phải quét vân tay (/mokhoa). /khoa để khóa ngay.'; }
    if (arg === 'tat') { c.enabled = false; save(c); return '🔓 Đã TẮT khóa vân tay (vân tay đã đăng ký vẫn giữ).'; }
    if (arg === 'xoa') { c.creds = []; c.enabled = false; save(c); return '🗑 Đã xóa mọi vân tay đã đăng ký và tắt khóa.'; }
    const h = /^gio\s+(\d{1,3})$/.exec(arg); if (h) { const n = Number(h[1]); if (n < 1 || n > 168) return 'Số giờ từ 1 đến 168.'; c.hours = n; save(c); return '⏱ Mỗi lần mở khóa có hiệu lực ' + n + ' giờ.'; }
    if (arg === 'trangthai') { const s = status(user); return 'Khóa vân tay: ' + (s.enabled ? 'BẬT' : 'tắt') + ' · ' + s.creds + ' thiết bị · hiệu lực ' + s.hours + ' giờ' + (s.enabled ? ' · ' + (s.locked ? '🔒 đang khóa' : '🔓 mở đến ' + new Date(s.until).toLocaleString('vi-VN')) : ''); }
    if (arg === '') { if (!c.enabled) return 'Khóa vân tay đang tắt. /khoa dangky → /khoa bat.'; c.users = c.users || {}; delete c.users[uid(user)]; save(c); return '🔒 Đã khóa (chỉ tài khoản này). Muốn dùng lại: /mokhoa (quét vân tay).'; }
    return 'Lệnh: /khoa dangky · /khoa bat · /khoa tat · /khoa (khóa ngay) · /khoa gio <số> · /khoa trangthai · /khoa xoa · /mokhoa';
  }

  // Cổng chặn: trả chuỗi báo khóa nếu phải chặn, null nếu cho qua.
  async function gate(text, chat, user) {
    if (user === undefined) user = chat;
    if (!isLocked(user)) return null;
    if (/^\/(mokhoa|khoa\s+trangthai)(?:@\w+)?\s*$/i.test(String(text || '').trim())) return null;   // khi khóa chỉ cho xin liên kết mở khóa/xem trạng thái (KHÔNG cho dangky/tat/xoa: kẻ có Telegram không tự thêm vân tay của nó được)
    let l = ''; try { l = await link('auth', chat, user); } catch (e) { return '🔒 Máy đang khóa nhưng chưa tạo được liên kết mở khóa: ' + e.message; }
    return '🔒 Máy đang khóa. Quét vân tay trên điện thoại để mở (cần bật Tailscale):\n' + l;
  }
  const stop = () => { if (server) { try { server.close(); } catch (e) { /* đã đóng */ } server = null; } };
  return { command, gate, isLocked, status, stop, _tokens: tokens, _handle: handle, _load: load, _save: save, _setHost: (r, oo) => { rpId = r; origin = oo; } };
}

module.exports = { createUnlock, cborDecode, verifyRegistration, verifyAssertion };
