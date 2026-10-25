'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// ĐIỀU KHIỂN TỪ XA bằng lệnh nhanh (không qua AI): chạy lệnh dòng lệnh, lấy tệp từ máy, xem tình trạng máy.
// Chỉ quản trị viên gọi được (bot.js kiểm); /lenh còn đòi chế độ TOÀN QUYỀN đang bật (index.js truyền isFull).
const MAX_OUT = 3500;
const MAX_FILE = 49 * 1024 * 1024;                       // Telegram cho bot gửi tệp tối đa 50 MB
const IMG = /\.(png|jpe?g|gif|webp)$/i;

const tail = (s, n) => (s.length > n ? '…(cắt bớt phần đầu)\n' + s.slice(s.length - n) : s);

function createRemote(o) {
  o = o || {};
  const cwd = o.cwd || os.homedir();
  const sh = o.shell || '/bin/bash';
  const timeoutMs = o.timeoutMs || 60000;
  const isFull = o.isFull || (() => true);

  // Chạy một dòng lệnh bằng bash. Trả { text } hoặc { text, files } để bot gửi lại.
  function runShell(cmd) {
    cmd = String(cmd || '').trim();
    if (!cmd) return Promise.resolve({ text: 'Cách dùng: /lenh <lệnh>, ví dụ /lenh df -h hoặc /lenh sudo systemctl restart agentos-orchestrator. Quá ' + Math.round(timeoutMs / 1000) + ' giây thì bị dừng (việc dài hãy nhờ AI).' });
    if (!isFull()) return Promise.resolve({ text: '⚠️ /lenh chỉ dùng được ở chế độ TOÀN QUYỀN. Gõ /toanquyen để bật.' });
    return new Promise((resolve) => {
      let out = '', killed = false;
      let child;
      try { child = spawn(sh, ['-lc', cmd], { cwd, env: Object.assign({}, process.env, { TERM: 'dumb' }), stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
      catch (e) { return resolve({ text: '⚠️ Không chạy được: ' + e.message }); }
      const add = (d) => { out += d; if (out.length > 200000) out = out.slice(out.length - 100000); };
      child.stdout.on('data', add); child.stderr.on('data', add);
      const t = setTimeout(() => { killed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* đã chết */ } } }, timeoutMs);
      child.on('error', (e) => { clearTimeout(t); resolve({ text: '⚠️ Không chạy được: ' + e.message }); });
      child.on('close', (code) => {
        clearTimeout(t);
        const body = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').trim();
        const head = killed ? '⏱ Dừng vì quá ' + Math.round(timeoutMs / 1000) + ' giây.' : (code === 0 ? '✅ Xong (mã 0).' : '⚠️ Thoát với mã ' + code + '.');
        resolve({ text: head + (body ? '\n```\n' + tail(body, MAX_OUT) + '\n```' : '\n(không có kết quả in ra)') });
      });
    });
  }

  // Lấy một tệp từ máy gửi về Telegram
  async function getFile(p, links) {
    p = String(p || '').trim().replace(/^["']|["']$/g, '');
    if (!p) return { text: 'Cách dùng: /lay <đường dẫn tệp>, ví dụ /lay /srv/onedrive/AgentOS/bao-cao.xlsx (tối đa 49 MB; thư mục thì nén lại trước bằng /lenh zip -r).' };
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) p = path.join(cwd, p);
    let st;
    try { st = fs.statSync(p); } catch (e) { return { text: '⚠️ Không thấy tệp: ' + p }; }
    if (st.isDirectory()) return { text: '⚠️ Đây là thư mục. Nén lại trước: /lenh cd ' + path.dirname(p) + ' && zip -r /tmp/' + path.basename(p) + '.zip ' + path.basename(p) + ' rồi /lay /tmp/' + path.basename(p) + '.zip' };
    if (!st.isFile()) return { text: '⚠️ Không phải tệp thường: ' + p };
    if (st.size > MAX_FILE) return links ? links.downloadLink(p) : { text: '⚠️ Tệp quá lớn (' + Math.round(st.size / 1048576) + ' MB, giới hạn 49 MB của Telegram). Chia nhỏ hoặc đưa lên OneDrive.' };
    return { text: '📎 ' + path.basename(p) + ' (' + (st.size < 1048576 ? Math.max(1, Math.round(st.size / 1024)) + ' KB' : (st.size / 1048576).toFixed(1) + ' MB') + ')', files: [{ path: p, name: path.basename(p), kind: IMG.test(p) && st.size < 9 * 1024 * 1024 ? 'photo' : 'document' }] };
  }

  const run = (bin, args) => new Promise((res) => execFile(bin, args, { timeout: 8000, maxBuffer: 1 << 20 }, (e, so) => res(e ? '' : String(so).trim())));
  const fmtUp = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + ' ngày ' : '') + h + ' giờ ' + m + ' phút'; };

  // Tình trạng máy: tải, RAM, ổ đĩa, nhiệt độ, mạng, dịch vụ AgentOS, dịch vụ lỗi
  async function sysinfo() {
    const L = ['🖥️ ' + os.hostname() + ' · bật ' + fmtUp(os.uptime())];
    const la = os.loadavg();
    L.push('CPU: ' + os.cpus().length + ' nhân · tải ' + la.map((x) => x.toFixed(2)).join(' / '));
    const tot = os.totalmem(), free = os.freemem();
    L.push('RAM: dùng ' + Math.round((tot - free) / 1048576) + ' / ' + Math.round(tot / 1048576) + ' MB');
    const df = await run('df', ['-hP', '/', '/srv/onedrive', '/var/lib/agentos']);
    if (df) L.push('Ổ đĩa:\n' + df.split('\n').slice(1).map((l) => { const c = l.split(/\s+/); return '  ' + c[5] + ': dùng ' + c[2] + '/' + c[1] + ' (' + c[4] + ')'; }).filter((v, i, a) => a.indexOf(v) === i).join('\n'));
    try {
      const temps = fs.readdirSync('/sys/class/thermal').filter((n) => /^thermal_zone/.test(n)).map((n) => Number(fs.readFileSync('/sys/class/thermal/' + n + '/temp', 'utf8')) / 1000).filter((x) => x > 0 && x < 150);
      if (temps.length) L.push('Nhiệt độ: ' + Math.max.apply(null, temps).toFixed(0) + '°C');
    } catch (e) { /* không có cảm biến */ }
    const ip = await run('hostname', ['-I']);
    if (ip) L.push('Địa chỉ mạng: ' + ip);
    const svc = await run('systemctl', ['is-active', 'agentos-orchestrator', 'agentos-deskd', 'agentos-settings', 'tailscaled']);
    if (svc) L.push('Dịch vụ: ' + svc.split('\n').map((s, i) => ['bộ điều phối', 'trợ lý màn hình', 'Cài đặt', 'Tailscale'][i] + ' ' + (s === 'active' ? '✅' : '❌ ' + s)).join(' · '));
    const failed = await run('systemctl', ['--failed', '--no-legend', '--plain']);
    if (failed) L.push('⚠️ Dịch vụ lỗi:\n' + failed.split('\n').slice(0, 6).map((l) => '  ' + l.split(/\s+/)[0]).join('\n'));
    return { text: L.join('\n') };
  }

  // ĐIỀU KHIỂN TỪ XA TRỰC TIẾP bằng RustDesk: bật dịch vụ, đặt mật khẩu TẠM ngẫu nhiên, lấy ID rồi trả cho chủ máy (gửi vào Telegram).
  // Mật khẩu tự đổi sang chuỗi ngẫu nhiên không ai biết khi hết hạn hoặc khi gõ /tuxa dong, nên tin nhắn cũ thành vô dụng.
  const sudo = o.exec || ((args) => new Promise((res) => execFile('sudo', ['-n'].concat(args), { timeout: 20000, maxBuffer: 1 << 20 }, (e, so, se) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(so || '').trim(), err: String(se || '').trim() }))));
  const ttlMs = o.remoteTtlMs || 2 * 3600 * 1000;
  const randomPw = () => { const al = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = crypto.randomBytes(14); let s = ''; for (let i = 0; i < 14; i++) s += al[b[i] % al.length]; return s; };
  const state = o.state || { get: () => null, set: () => {} };
  let timer = null;

  async function setPassword(pw) { const r = await sudo(['rustdesk', '--password', pw]); return r.code === 0; }
  async function getId() {
    for (let i = 0; i < (o.idTries || 8); i++) {
      const r = await sudo(['rustdesk', '--get-id']);
      const m = String(r.out).match(/\b\d{6,12}\b/);
      if (m) return m[0];
      await new Promise((x) => setTimeout(x, o.idWaitMs === undefined ? 1500 : o.idWaitMs));
    }
    return null;
  }
  async function expire(why) {                         // đổi sang mật khẩu ngẫu nhiên không ai biết
    if (timer) { clearTimeout(timer); timer = null; }
    state.set(null);
    await setPassword(randomPw());
    if (o.log) o.log('RustDesk: đã đổi mật khẩu tạm sang ngẫu nhiên (' + why + ')');
  }
  if (state.get()) expire('khởi động lại khi còn phiên cũ').catch(() => {});

  // /tuxa: trả { text } có ID + mật khẩu; deskOpen (tùy chọn) mở cửa sổ RustDesk trên màn hình máy
  async function remoteStart(deskOpen) {
    const test = await sudo(['-v']).catch(() => ({ code: 1 }));
    await sudo(['systemctl', 'enable', '--now', 'rustdesk']);
    await sudo(['rustdesk', '--option', 'approve-mode', 'password']);              // vào bằng mật khẩu, không cần ai bấm "Chấp nhận" trên máy
    const pw = randomPw();
    const okPw = await setPassword(pw);
    if (deskOpen) { try { await deskOpen(); } catch (e) { /* không mở được cửa sổ cũng không sao: dịch vụ vẫn chạy nền */ } }
    const id = await getId();
    if (!id) return { text: '⚠️ Chưa lấy được ID RustDesk' + (test.code !== 0 ? ' (bot chưa có quyền sudo: gõ /toanquyen hoặc chạy lại trình cài)' : ' (RustDesk chưa cài hoặc dịch vụ chưa lên)') + '. Gõ /mo rustdesk rồi /manhinh để đọc ID trên màn hình máy.' };
    if (!okPw) return { text: '🖥 ID RustDesk của máy: ' + id + '\n⚠️ Bot chưa đặt được mật khẩu tự động. Mở RustDesk trên máy (/mo rustdesk), vào Cài đặt → Bảo mật đặt mật khẩu rồi nhập ID này.' };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => expire('hết hạn').catch(() => {}), ttlMs); if (timer.unref) timer.unref();
    state.set(Date.now() + ttlMs);
    let ts = ''; try { const i = o.tailscale ? await o.tailscale.info() : null; if (i && i.state === 'Running' && i.ips && i.ips[0]) ts = '\n(Tailscale của máy: ' + i.ips[0] + ' — nếu RustDesk không nối được thì bật app Tailscale trên thiết bị rồi nhập địa chỉ này thay ID.)'; } catch (e) { /* bỏ qua */ }
    const hrs = Math.round(ttlMs / 360000) / 10;
    return { text: '🖥 ĐIỀU KHIỂN TỪ XA SẴN SÀNG\n\nID: ' + id + '\nMật khẩu: ' + pw + '\n\nCách vào: tải RustDesk (rustdesk.com, có bản Windows/Mac/Android/iPhone), nhập ID rồi mật khẩu.\nMật khẩu tự đổi sau ' + hrs + ' giờ. Xong việc gõ /tuxa dong để đóng ngay.' + ts + '\n\n⚠️ Ai có ID + mật khẩu này là điều khiển được máy: đừng chuyển tiếp tin nhắn.' };
  }

  async function remoteStop(deskClose) {
    await expire('đóng theo lệnh');
    await sudo(['systemctl', 'stop', 'rustdesk']);                                // ngắt luôn phiên đang nối
    if (deskClose) { try { await deskClose(); } catch (e) { /* bỏ qua */ } }
    return { text: '🔒 Đã đóng điều khiển từ xa: ngắt phiên đang nối, đổi mật khẩu sang ngẫu nhiên, tắt dịch vụ RustDesk. Gõ /tuxa để mở lại.' };
  }

  return { runShell, getFile, sysinfo, remoteStart, remoteStop };
}

module.exports = { createRemote };
