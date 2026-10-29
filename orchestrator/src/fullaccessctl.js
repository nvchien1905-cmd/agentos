'use strict';
const fs = require('fs');
const net = require('net');
const { execFile } = require('child_process');

// Phía BỘ ĐIỀU PHỐI của "Toàn quyền cấp tới hệ điều hành".
//  - osState(): máy ĐANG thật sự cho AI dùng sudo/ghi hệ thống không? (cờ FULL_ACCESS trong bot chỉ là ý định; dịch vụ systemd bị gia cố
//    NoNewPrivileges/ProtectSystem thì sudo vẫn bị chặn và AI chỉ ghi được /var/lib/agentos.)
//  - request('on'|'off'|'status'): xin dịch vụ root agentos-fullaccess cấp/thu hồi. Dịch vụ chỉ nghe tiến trình CHÍNH của bot (kiểm SO_PEERCRED),
//    nên AI (tiến trình con) không gọi được; bot chỉ gọi khi quản trị viên Telegram gõ lệnh.
function createFullAccessCtl(o) {
  o = o || {};
  const sock = o.sock || '/run/agentos-fullaccess.sock';
  const statusFile = o.statusFile || '/proc/self/status';
  const run = o.run || ((bin, args) => new Promise((resolve) => execFile(bin, args, { timeout: 8000 }, (err, out, e) => resolve({ ok: !err, out: String(out || ''), err: String(e || (err && err.message) || '') }))));

  async function osState() {
    let nnp = null;
    try { const m = /^NoNewPrivs:\s*(\d)/m.exec(fs.readFileSync(statusFile, 'utf8')); nnp = m ? m[1] === '1' : null; } catch (e) { /* không phải Linux */ }
    const s = await run('sudo', ['-n', 'true']);
    const ok = nnp !== true && s.ok;
    return { ok, noNewPrivs: nnp, sudo: s.ok, why: ok ? '' : (nnp ? 'dịch vụ bot đang bị khóa "NoNewPrivileges" nên sudo không hoạt động và AI chỉ ghi được trong thư mục của bot' : 'người dùng bot chưa có sudo không mật khẩu') };
  }

  function request(cmd, timeoutMs) {
    return new Promise((resolve) => {
      let buf = '', settled = false;
      const done = (r) => { if (!settled) { settled = true; try { c.destroy(); } catch (e) { /* đã đóng */ } resolve(r); } };
      const c = net.connect(sock);
      c.setTimeout(timeoutMs || 90000, () => done({ ok: false, error: 'dịch vụ cấp quyền không trả lời' }));
      c.on('connect', () => c.write(cmd + '\n'));
      c.on('data', (d) => { buf += d; });
      c.on('error', (e) => done({ ok: false, error: e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'máy chưa có dịch vụ cấp quyền (agentos-fullaccess.socket): cập nhật AgentOS rồi thử lại' : e.code === 'EACCES' ? 'bộ điều phối không mở được cổng cấp quyền' : e.message }));
      c.on('close', () => { let j = null; try { j = JSON.parse(buf.trim().split('\n').pop()); } catch (e) { /* không phải JSON */ } done(j || { ok: false, error: buf.trim() || 'dịch vụ cấp quyền đóng kết nối không trả lời' }); });
    });
  }
  return { osState, request };
}

module.exports = { createFullAccessCtl };
