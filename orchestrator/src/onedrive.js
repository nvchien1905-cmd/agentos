'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// OneDrive cho AI: ứng dụng khách mã nguồn mở `onedrive` (abraunegg, có trong Debian) đồng bộ HAI CHIỀU thư mục /srv/onedrive với OneDrive của chủ máy.
// AI đọc dữ liệu và lưu kết quả/ghi nhớ trong thư mục đó; người ngồi máy thấy cùng thư mục (~/OneDrive). Bộ điều phối chỉ lo phần KẾT NỐI qua Telegram:
//   /onedrive ketnoi  -> nhận đường dẫn đăng nhập Microsoft; chủ máy đăng nhập, copy địa chỉ trang trắng cuối cùng, nhắn lại (hoặc /onedrive <địa chỉ>)
//   /onedrive         -> tình trạng          /onedrive dongbo -> đồng bộ ngay          /onedrive ngat co -> ngắt kết nối (giữ tệp trên máy)
// Dịch vụ đồng bộ (onedrive-agentos.service) tự chạy khi có token (systemd path unit), không cần quyền root từ đây.
const AUTH_PREFIX = 'https://login.microsoftonline.com/common/oauth2/nativeclient?';

function createOneDrive(o) {
  o = o || {};
  const dir = o.dir || '/srv/onedrive';
  const home = o.home || process.env.HOME || '/var/lib/agentos';
  const conf = o.confDir || path.join(home, '.config', 'onedrive');
  const token = path.join(conf, 'refresh_token');
  const urlFile = path.join(conf, 'auth-url.txt'), respFile = path.join(conf, 'auth-response.txt');
  const bin = o.bin || 'onedrive';
  const spawn = o.spawn || cp.spawn;
  const run = o.run || ((cmd, args) => new Promise((resolve) => {
    cp.execFile(cmd, args, { timeout: 15000 }, (err, out, errOut) => resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, out: String(out || ''), err: String(errOut || '') }));
  }));
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const waitMs = o.waitMs === undefined ? 25000 : o.waitMs, tokenWaitMs = o.tokenWaitMs === undefined ? 90000 : o.tokenWaitMs, pollMs = o.pollMs || 500;
  let child = null, authTimer = null;

  const connected = () => fs.existsSync(token);
  const stopChild = () => { if (authTimer) { clearTimeout(authTimer); authTimer = null; } if (child) { try { child.kill('SIGTERM'); } catch (e) { /* đã thoát */ } child = null; } fs.rmSync(urlFile, { force: true }); fs.rmSync(respFile, { force: true }); };
  async function waitFor(pred, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(pollMs); } return pred(); }

  function stats() {
    let files = 0, bytes = 0, newest = 0, newestName = '', stack = [dir], seen = 0;
    while (stack.length && seen < 30000) {
      const d = stack.pop(); let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of ents) {
        seen++; const p = path.join(d, e.name);
        if (e.isDirectory()) { stack.push(p); continue; }
        try { const st = fs.statSync(p); files++; bytes += st.size; if (st.mtimeMs > newest) { newest = st.mtimeMs; newestName = path.relative(dir, p); } } catch (er) { /* tệp vừa bị xóa */ }
      }
    }
    return { files, bytes, newest, newestName, truncated: seen >= 30000 };
  }
  const human = (b) => b > 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

  return {
    connected, dir, AUTH_PREFIX,
    looksLikeAuthResponse: (text) => String(text || '').trim().startsWith(AUTH_PREFIX) && /[?&]code=/.test(String(text)),

    async status() {
      if (!connected()) return '☁️ OneDrive: CHƯA kết nối.\nGõ /onedrive ketnoi để kết nối (đăng nhập Microsoft một lần trên điện thoại).';
      const act = await run('systemctl', ['is-active', 'onedrive-agentos.service']);
      const on = String(act.out).trim() === 'active';
      const s = stats();
      const ago = s.newest ? Math.max(0, Math.round((Date.now() - s.newest) / 60000)) : null;
      return ['☁️ OneDrive: đã kết nối · dịch vụ đồng bộ ' + (on ? 'đang chạy ✅' : 'KHÔNG chạy ⚠️ (xem: journalctl -u onedrive-agentos)'),
        'Thư mục: ' + dir + ' · ' + s.files + (s.truncated ? '+' : '') + ' tệp · ' + human(s.bytes),
        s.newest ? 'Tệp mới nhất: ' + s.newestName + ' (' + (ago < 1 ? 'vừa xong' : ago + ' phút trước') + ')' : 'Chưa có tệp nào (lần đồng bộ đầu có thể mất vài phút).',
        'Lệnh: /onedrive dongbo (đồng bộ ngay) · /onedrive thumuc (xem thư mục) · /onedrive ngat co (ngắt)'].join('\n');
    },

    async startAuth() {
      stopChild();
      fs.mkdirSync(conf, { recursive: true });
      // Kết nối MỚI: mặc định chỉ đồng bộ thư mục AgentOS (không kéo cả OneDrive về máy; xem wizard/lib/synclist.js)
      try { const sl = path.join(conf, 'sync_list'); if (!fs.existsSync(token) && !fs.existsSync(sl)) fs.writeFileSync(sl, '# Do AgentOS tạo: chỉ đồng bộ thư mục này của OneDrive (đổi ở Cài đặt → Kết nối)\n/AgentOS\n'); } catch (e) { /* bỏ qua */ }
      child = spawn(bin, ['--confdir', conf, '--auth-files', urlFile + ':' + respFile], { stdio: 'ignore' });
      child.on('error', () => {}); child.on('exit', () => { child = null; });
      authTimer = setTimeout(stopChild, 15 * 60 * 1000); if (authTimer.unref) authTimer.unref();
      const ok = await waitFor(() => fs.existsSync(urlFile) && fs.statSync(urlFile).size > 20, waitMs);
      if (!ok) { stopChild(); return { ok: false, error: 'Không lấy được đường dẫn đăng nhập (kiểm tra mạng và gói onedrive đã cài).' }; }
      return { ok: true, url: fs.readFileSync(urlFile, 'utf8').trim() };
    },

    async finishAuth(responseUrl) {
      const u = String(responseUrl || '').trim();
      if (!this.looksLikeAuthResponse(u)) return { ok: false, error: 'Đó không phải địa chỉ đăng nhập OneDrive. Sau khi đăng nhập Microsoft, trình duyệt hiện trang trắng: copy TOÀN BỘ địa chỉ trên thanh địa chỉ (bắt đầu bằng ' + AUTH_PREFIX + 'code=...) rồi gửi lại.' };
      if (!child) return { ok: false, error: 'Chưa bắt đầu kết nối (hoặc đã quá 15 phút). Gõ /onedrive ketnoi để lấy đường dẫn đăng nhập mới.' };
      fs.writeFileSync(respFile, u + '\n', { mode: 0o600 });
      const ok = await waitFor(connected, tokenWaitMs);
      await sleep(o.settleMs === undefined ? 3000 : o.settleMs);
      stopChild();                                    // dịch vụ đồng bộ (systemd) sẽ tự chạy khi thấy token
      return ok ? { ok: true } : { ok: false, error: 'Microsoft không chấp nhận mã (mã chỉ dùng được một lần và hết hạn sau vài phút). Gõ /onedrive ketnoi để thử lại.' };
    },

    async sync() {
      if (!connected()) return { ok: false, error: 'Chưa kết nối OneDrive. Gõ /onedrive ketnoi.' };
      // SIGUSR1 = đồng bộ ngay; nếu bản client không hiểu tín hiệu này thì tiến trình thoát và systemd khởi động lại (cũng đồng bộ lúc khởi động)
      const r = await run('pkill', ['-USR1', '-x', 'onedrive']);
      return r.code === 0 ? { ok: true } : { ok: false, error: 'Dịch vụ đồng bộ không chạy (xem /onedrive).' };
    },

    async disconnect() {
      stopChild();
      await run('pkill', ['-TERM', '-x', 'onedrive']);
      fs.rmSync(token, { force: true });
      return { ok: true };
    },

    folders() {
      let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).map((e) => (e.isDirectory() ? '📁 ' : '📄 ') + e.name); } catch (e) { return null; }
      return names.sort().slice(0, 40);
    },
    _state: () => ({ child, token, conf }),
  };
}

module.exports = { createOneDrive, AUTH_PREFIX };
