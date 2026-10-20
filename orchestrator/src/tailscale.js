'use strict';
const cp = require('child_process');

// TAILSCALE: đường vào dự phòng tới máy khi Telegram hoặc mạng nhà lỗi (SSH và RustDesk đi qua mạng riêng của chủ máy, không mở cổng ra Internet).
//   /tailscale            tình trạng         /tailscale ketnoi -> nhận đường dẫn đăng nhập (làm một lần)       /tailscale ngat co -> đăng xuất
// Dịch vụ tailscaled chạy bằng root; người dùng `agentos` được đặt làm "operator" (ExecStartPost trong drop-in) nên không cần sudo.
const URL_RE = /https:\/\/login\.tailscale\.com\/[^\s"'<>]+/;

function createTailscale(o) {
  o = o || {};
  const bin = o.bin || 'tailscale';
  const spawn = o.spawn || cp.spawn;
  const run = o.run || ((args, ms) => new Promise((resolve) => {
    cp.execFile(bin, args, { timeout: ms || 15000, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) =>
      resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, out: String(out || ''), err: String(errOut || ''), missing: !!(err && err.code === 'ENOENT') }));
  }));
  const waitMs = o.waitMs === undefined ? 20000 : o.waitMs;
  let child = null;

  async function info() {
    const r = await run(['status', '--json']);
    if (r.missing) return { state: 'missing' };
    let j = null; try { j = JSON.parse(r.out); } catch (e) { /* tailscaled chưa chạy */ }
    if (!j) return { state: 'down', err: (r.err || r.out).trim().slice(0, 200) };
    const self = j.Self || {};
    return { state: j.BackendState || 'unknown', ips: j.TailscaleIPs || self.TailscaleIPs || [], dns: String(self.DNSName || '').replace(/\.$/, ''), host: self.HostName || '' };
  }

  async function status() {
    const i = await info();
    if (i.state === 'missing') return '⚠️ Máy này chưa cài Tailscale (chạy lại cap-nhat-dieu-khien.sh).';
    if (i.state === 'down') return '⚠️ Dịch vụ Tailscale chưa chạy' + (i.err ? ' (' + i.err + ')' : '') + '. Thử: sudo systemctl restart tailscaled';
    if (i.state === 'Running') {
      return '🔐 Tailscale ĐÃ KẾT NỐI\nĐịa chỉ: ' + (i.ips[0] || '?') + (i.dns ? ' · ' + i.dns : '') + '\n' +
        'Cài ứng dụng Tailscale trên điện thoại/máy tính, đăng nhập cùng tài khoản rồi dùng: ssh <tên-người-dùng>@' + (i.dns || i.ips[0] || '<địa-chỉ>') + '\n(Tailscale SSH đã bật nên không cần khóa SSH.)';
    }
    if (i.state === 'NeedsLogin' || i.state === 'NoState') return 'Tailscale chưa đăng nhập. Gõ /tailscale ketnoi để nhận đường dẫn đăng nhập.';
    return 'Tailscale đang ở trạng thái: ' + i.state + '. Gõ /tailscale ketnoi để kết nối lại.';
  }

  async function connect() {
    const i = await info();
    if (i.state === 'missing') return { ok: false, error: 'Máy này chưa cài Tailscale (chạy lại cap-nhat-dieu-khien.sh).' };
    if (i.state === 'down') return { ok: false, error: 'Dịch vụ Tailscale chưa chạy.' };
    if (i.state === 'Running') return { ok: true, already: true };
    if (child) { try { child.kill('SIGTERM'); } catch (e) { /* đã thoát */ } child = null; }
    const c = spawn(bin, ['up', '--ssh', '--timeout=600s'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = c;
    let buf = '';
    const take = (d) => { buf += String(d); };
    if (c.stdout) c.stdout.on('data', take);
    if (c.stderr) c.stderr.on('data', take);
    c.on('exit', () => { if (child === c) child = null; });
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      const m = buf.match(URL_RE);
      if (m) return { ok: true, url: m[0] };
      if (c.exitCode !== null && c.exitCode !== undefined) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const m = buf.match(URL_RE);
    if (m) return { ok: true, url: m[0] };
    try { c.kill('SIGTERM'); } catch (e) { /* đã thoát */ }
    child = null;
    return { ok: false, error: 'Không lấy được đường dẫn đăng nhập Tailscale' + (buf.trim() ? ': ' + buf.trim().slice(0, 200) : '') + '.' };
  }

  async function disconnect() { return run(['logout']); }
  return { status, connect, disconnect, info };
}

module.exports = { createTailscale };
