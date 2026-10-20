'use strict';
const crypto = require('crypto');

// CẬP NHẬT PHẦN MỀM KHÔNG CẦN BOOT LẠI. Nguyên tắc an toàn:
//  - Mọi bản cập nhật được KÝ (Ed25519) bằng khóa riêng của chủ dự án, giữ ở máy của chủ, KHÔNG nằm trên GitHub. Máy khách chỉ có khóa công khai
//    (/etc/agentos/update-pubkey.pem) nên dù ai chiếm được tài khoản GitHub cũng không đẩy được mã vào máy khách.
//  - Chữ ký ký lên manifest.json (có phiên bản + sha256 + kích thước của gói) nên sửa gói/hạ phiên bản đều bị bắt.
//  - Gói chỉ được ghi vào các đường dẫn trong danh sách cho phép (ALLOW), không liên kết, không "..", không tuyệt đối.
const VERSION_RE = /^\d+(\.\d+){1,3}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/;

function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0), pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Kiểm chữ ký rồi đọc manifest. manifestBuf: nguyên văn tệp manifest.json (Buffer); sigB64: chữ ký base64; pubPem: khóa công khai PEM.
function verifyManifest(manifestBuf, sigB64, pubPem) {
  let ok = false;
  try { ok = crypto.verify(null, manifestBuf, crypto.createPublicKey(pubPem), Buffer.from(String(sigB64).trim(), 'base64')); } catch (e) { ok = false; }
  if (!ok) return { ok: false, error: 'Chữ ký bản cập nhật KHÔNG hợp lệ (không đúng khóa của nhà phát hành) — bỏ qua.' };
  let m;
  try { m = JSON.parse(manifestBuf.toString('utf8')); } catch (e) { return { ok: false, error: 'manifest.json không đọc được' }; }
  if (!m || !VERSION_RE.test(String(m.version))) return { ok: false, error: 'manifest: phiên bản không hợp lệ' };
  if (!FILE_RE.test(String(m.file))) return { ok: false, error: 'manifest: tên gói không hợp lệ' };
  if (!/^[0-9a-f]{64}$/.test(String(m.sha256))) return { ok: false, error: 'manifest: sha256 không hợp lệ' };
  if (!(Number.isInteger(m.size) && m.size > 0 && m.size < 500 * 1024 * 1024)) return { ok: false, error: 'manifest: kích thước không hợp lệ' };
  return { ok: true, manifest: m };
}

// Đường dẫn (tính từ gốc hệ thống, không có "/" đầu) mà một bản cập nhật được phép ghi.
const ALLOW = [
  /^opt\/agentos\/(orchestrator\/src|wizard|desk|update)\/[\w./-]+$/,
  /^opt\/agentos\/VERSION$/,
  /^usr\/local\/bin\/agentos-[\w-]+$/,
  /^usr\/local\/sbin\/agentos-[\w-]+$/,
  /^etc\/systemd\/system\/(agentos-[\w.-]+|onedrive-agentos\.[\w.-]+)$/,
  /^etc\/systemd\/system\/tailscaled\.service\.d\/[\w.-]+$/,
  /^usr\/share\/applications\/agentos-[\w-]+\.desktop$/,
  /^usr\/share\/icons\/hicolor\/scalable\/apps\/agentos-[\w-]+\.svg$/,
  /^etc\/agentos\/(update-pubkey\.pem|apps\.conf)$/,         // pubkey: cho phép xoay khóa (bản mới vẫn phải ký bằng khóa CŨ)
  /^apply\.sh$/,                                              // tập lệnh sau cập nhật (chạy bằng root, nằm TRONG phần được ký)
];

function checkEntries(names) {
  const bad = [];
  for (const n of names) {
    if (!n || n.startsWith('/') || n.includes('\\') || n.split('/').some((p) => p === '..' || p === '.') || !ALLOW.some((re) => re.test(n))) bad.push(n);
  }
  return { ok: bad.length === 0, bad };
}

// Quyền tệp sau khi ghi
function modeFor(rel) {
  if (/^usr\/local\/(s)?bin\//.test(rel) || /^opt\/agentos\/desk\/[\w-]+\.js$/.test(rel) || /^opt\/agentos\/wizard\/server\.js$/.test(rel)) return 0o755;
  return 0o644;
}

module.exports = { cmpVersion, verifyManifest, checkEntries, modeFor, ALLOW, VERSION_RE, FILE_RE };
