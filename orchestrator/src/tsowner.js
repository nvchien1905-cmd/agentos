'use strict';
const cp = require('child_process');

// TAILSCALE: nhận biết máy gọi tới có CÙNG TÀI KHOẢN Tailscale với máy này không (dùng `tailscale whois`, do Tailscale xác thực bằng khóa WireGuard của máy gọi,
// không giả mạo được từ ngoài). Dùng cho ghép đôi tự động của Đội máy: chỉ máy của chính chủ mới nhận được khóa ghép đôi.
const IPV4_TS = /^100\.(\d+)\.\d+\.\d+$/;
const inTailnet = (ip) => { const m = IPV4_TS.exec(String(ip || '')); return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127; };

function findBin(o) {
  if (o && o.bin) return o.bin;
  if (process.platform === 'win32') { const p = 'C:\\Program Files\\Tailscale\\tailscale.exe'; try { if (require('fs').existsSync(p)) return p; } catch (e) { /* dùng tên lệnh */ } }
  return 'tailscale';
}

function createTsOwner(o) {
  o = o || {};
  const bin = findBin(o);
  const run = o.run || ((args, ms) => new Promise((resolve) => cp.execFile(bin, args, { timeout: ms || 6000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, out) => resolve({ ok: !err, out: String(out || '') }))));
  const parse = (r) => { try { return r.ok ? JSON.parse(r.out) : null; } catch (e) { return null; } };

  // Tài khoản (UserID) của chính máy này, và danh sách máy khác CÙNG tài khoản đang bật: [{ ip, host, os }]
  async function peers() {
    const st = parse(await run(['status', '--json']));
    if (!st || !st.Self || st.BackendState !== 'Running') return { running: false, self: null, peers: [] };
    const me = st.Self.UserID;
    const list = Object.values(st.Peer || {}).filter((p) => p && p.Online && p.UserID === me && !(p.Tags && p.Tags.length)).map((p) => ({ ip: (p.TailscaleIPs || []).find((x) => inTailnet(x)) || '', host: p.HostName || '', os: p.OS || '' })).filter((p) => p.ip);
    return { running: true, self: { ip: (st.TailscaleIPs || st.Self.TailscaleIPs || []).find((x) => inTailnet(x)) || '', host: st.Self.HostName || '' }, peers: list };
  }

  // Máy có địa chỉ ip cùng tài khoản với máy này?
  async function sameOwner(ip) {
    if (!inTailnet(ip)) return false;
    const [st, who] = await Promise.all([run(['status', '--json']).then(parse), run(['whois', '--json', ip]).then(parse)]);
    const me = st && st.Self && st.Self.UserID, them = who && who.UserProfile && who.UserProfile.ID;
    if (!me || !them || who.Node && who.Node.Tags && who.Node.Tags.length) return false;
    return Number(me) === Number(them);
  }
  return { peers, sameOwner };
}

module.exports = { createTsOwner, inTailnet };
