'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// /ketnoi <máy>: chép KHÓA CÔNG KHAI SSH của máy đầu não sang một máy trong Đội máy (ví dụ máy Windows) để từ đó chạy lệnh/chép tệp không cần mật khẩu.
// Đây là chức năng CỐ ĐỊNH của AgentOS, không phải AI tự soạn lệnh:
//  - chỉ chủ máy gõ được, mỗi lần đều hiện nút "Cho phép" trên Telegram và chờ chủ máy bấm (5 phút không bấm thì tự hủy);
//  - chỉ chép KHÓA CÔNG KHAI (khóa riêng không bao giờ rời máy này), chỉ sang máy đã nằm trong Đội máy (đã có khóa ký);
//  - máy đích tự quyết: máy con Windows chỉ nhận khi chủ máy đó đã bật "allowSshKey" ở máy đó;
//  - ghi nhật ký mỗi lần.
const ID_RE = /^kn:([a-z0-9]{6,12}):([yn])$/;

// Ứng dụng cần để máy đầu não kiểm soát máy con. Lệnh CỐ ĐỊNH (không ghép dữ liệu người dùng vào lệnh).
const PS = (c) => 'powershell -NoProfile -NonInteractive -Command "' + c + '"';
const WG = (id) => 'winget install --id ' + id + ' -e --silent --accept-package-agreements --accept-source-agreements';
const APPS = {
  linux: [
    { label: 'Quyền sudo không hỏi mật khẩu', check: 'sudo -n true' },
    { label: 'Công cụ rsync, curl, jq', check: 'command -v rsync && command -v curl && command -v jq', install: "sudo -n sh -c 'apt-get update -qq && apt-get install -y -qq rsync curl jq'" },
    { label: 'Tailscale (đường vào dự phòng)', check: 'command -v tailscale', hint: 'AgentOS có sẵn; máy này không phải bản AgentOS?' },
    { label: 'RustDesk (điều khiển màn hình)', check: 'command -v rustdesk', hint: 'AgentOS có sẵn; máy này không phải bản AgentOS?' },
    { label: 'Bộ điều phối AgentOS đang chạy', check: 'systemctl is-active --quiet agentos-orchestrator' },
  ],
  windows: [
    { label: 'RustDesk (điều khiển màn hình)', check: PS('winget list --id RustDesk.RustDesk -e --accept-source-agreements | Out-Null; exit $LASTEXITCODE'), install: PS(WG('RustDesk.RustDesk')) },
    { label: 'Tailscale', check: PS('winget list --id Tailscale.Tailscale -e --accept-source-agreements | Out-Null; exit $LASTEXITCODE'), install: PS(WG('Tailscale.Tailscale')) },
    { label: 'Node.js (chạy máy con AgentOS)', check: 'node --version', install: PS(WG('OpenJS.NodeJS.LTS')) },
  ],
};

function createKetNoi(o) {
  const { fleet, ask, edit, send, log } = o;
  const keyDir = o.keyDir || process.env.AGENTOS_SSH_DIR || '/var/lib/agentos/.ssh';
  const run = o.run || ((bin, args, opt) => new Promise((resolve) => execFile(bin, args, { timeout: (opt && opt.timeout) || 30000 },(err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }))));
  const timeoutMs = o.timeoutMs || 300000;
  const pending = new Map();
  const ready = new Map();                                  // máy đã đăng nhập SSH bằng khóa được: tên (thường) -> { user, host }
  const logf = log || (() => {});

  // Lấy khóa công khai của máy này; chưa có thì tạo cặp khóa mới (không đặt mật khẩu vì bộ điều phối dùng không người nhập).
  async function publicKey() {
    const pub = path.join(keyDir, 'id_ed25519.pub'), priv = path.join(keyDir, 'id_ed25519');
    if (!fs.existsSync(pub)) {
      fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
      const r = await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'agentos-dau-nao', '-f', priv]);
      if (!r.ok) throw new Error('Không tạo được khóa SSH: ' + r.err.trim().slice(0, 200));
    }
    const k = fs.readFileSync(pub, 'utf8').trim().split(/\r?\n/)[0];
    if (!/^ssh-(ed25519|rsa) /.test(k)) throw new Error('Tệp khóa công khai không đúng dạng: ' + pub);
    return k;
  }

  // Bước 1 (chủ máy gõ /ketnoi <máy>): kiểm tra máy có trong Đội máy rồi gửi thẻ xin duyệt.
  async function request(chatId, name) {
    name = String(name || '').trim();
    if (!name) return 'Cách dùng: /ketnoi <tên máy trong Đội máy>. Xem tên bằng /may.';
    const m = fleet.findMachine(name);
    if (!m) return 'Không có máy "' + name + '" trong Đội máy. Thêm trước bằng /may them <tên> <địa chỉ> <khóa>, xem danh sách bằng /may.';
    const id = Math.random().toString(36).slice(2, 10);
    const p = { kind: 'key', name: m.name, chatId, timer: null, msgId: null };
    pending.set(id, p);
    p.timer = setTimeout(() => finish(id, false, '⏱ Hết thời gian chờ, đã tự hủy.'), timeoutMs);
    if (p.timer.unref) p.timer.unref();
    const text = '🔑 Xin chép KHÓA CÔNG KHAI SSH của máy này sang máy "' + m.name + '" (' + m.url + ').\n' +
      'Sau khi cho phép, máy này chạy được lệnh và chép tệp trên "' + m.name + '" mà không cần mật khẩu. Khóa riêng không rời máy này.\n' +
      'Máy đó phải đã bật "cho phép nhận khóa SSH" thì mới nhận.';
    try { p.msgId = await ask(chatId, text, [[{ text: '✅ Cho phép', data: 'kn:' + id + ':y' }, { text: '❌ Hủy', data: 'kn:' + id + ':n' }]]); } catch (e) { pending.delete(id); clearTimeout(p.timer); return '⚠️ Không gửi được thẻ xin duyệt: ' + e.message; }
    return null;
  }

  async function finish(id, ok, label) {
    const p = pending.get(id); if (!p) return false;
    pending.delete(id); clearTimeout(p.timer);
    if (p.msgId && edit) edit(p.chatId, p.msgId, '🔑 Kết nối SSH tới "' + p.name + '"\n\n' + label).catch(() => {});
    return true;
  }

  // Bước 2 (chủ máy bấm nút). Trả văn bản hiện cho người bấm.
  async function answer(data, userId, isAdmin) {
    const m = ID_RE.exec(String(data)); if (!m) return 'Nút không hợp lệ.';
    const p = pending.get(m[1]); if (!p) return 'Yêu cầu này đã hết hạn hoặc đã được trả lời.';
    if (isAdmin && !isAdmin(String(userId))) return 'Chỉ quản trị viên được duyệt việc này.';
    if (m[2] === 'n') { await finish(m[1], false, '❌ Đã hủy.'); logf('ketnoi: chủ máy hủy chép khóa sang ' + p.name); return 'Đã hủy.'; }
    pending.delete(m[1]); clearTimeout(p.timer);          // đã duyệt: không cho bấm lần nữa
    if (p.msgId && edit) edit(p.chatId, p.msgId, '🔑 Kết nối SSH tới "' + p.name + '"\n\n⏳ Đã cho phép, đang chép khóa...').catch(() => {});
    if (p.kind === 'apps') {
      logf('ketnoi: chủ máy cho phép cài ứng dụng trên ' + p.name);
      provision(p.name).then((t) => send(p.chatId, t), (e) => send(p.chatId, '⚠️ ' + e.message)).catch(() => {});
      return 'Đã cho phép, đang cài.';
    }
    logf('ketnoi: chủ máy cho phép chép khóa SSH sang ' + p.name);
    connect(p.name).then(async (t) => { await send(p.chatId, t); if (ready.has(p.name.toLowerCase())) await offerApps(p.chatId, p.name); }, (e) => send(p.chatId, '⚠️ ' + e.message)).catch(() => {});
    return 'Đã cho phép, đang làm.';
  }

  // Chép khóa rồi thử đăng nhập thật bằng khóa.
  async function connect(name) {
    const m = fleet.findMachine(name); if (!m) throw new Error('Không có máy "' + name + '".');
    const pub = await publicKey();
    let r;
    try { r = await fleet.installKey(name, pub); } catch (e) { throw new Error('Máy "' + name + '" không nhận khóa: ' + e.message); }
    const host = new URL(m.url).hostname, user = r && r.user;
    let out = '🔑 Đã ' + (r.added ? 'chép khóa' : 'xác nhận khóa có sẵn') + ' trên "' + name + '" (tài khoản ' + (user || '?') + ').';
    if (r.warn) out += '\n⚠️ ' + r.warn;
    if (!user) return out;
    const t = await run('ssh', ['-i', path.join(keyDir, 'id_ed25519'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(keyDir, 'known_hosts'), '-o', 'ConnectTimeout=10', user + '@' + host, 'echo agentos-ssh-ok']);
    if (t.ok && /agentos-ssh-ok/.test(t.out)) { ready.set(String(name).toLowerCase(), { user, host }); } 
    if (t.ok && /agentos-ssh-ok/.test(t.out)) return out + '\n✅ Thử đăng nhập bằng khóa: thành công. Từ giờ gõ /may ' + name + ' hoặc nhờ bot chạy lệnh trên máy đó: ssh ' + user + '@' + host + '.';
    return out + '\n⚠️ Chép xong nhưng thử đăng nhập chưa được: ' + (t.err.trim().split('\n').pop() || 'không rõ lý do') + '\n(Kiểm tra: dịch vụ OpenSSH Server đang chạy, tường lửa cổng 22 cho mạng Tailscale, tài khoản quản trị viên cần cấu hình ở cai-rustdesk-va-ssh.ps1 mục C.)';
  }

  // Thẻ thứ hai: xin duyệt cài các ứng dụng cần thiết để máy đầu não kiểm soát máy con
  async function offerApps(chatId, name) {
    const plat = await platformOf(name);
    const list = APPS[plat].map((a) => '• ' + a.label).join('\n');
    const id = Math.random().toString(36).slice(2, 10);
    const p = { kind: 'apps', name, chatId, timer: null, msgId: null };
    pending.set(id, p);
    p.timer = setTimeout(() => finish(id, false, '⏱ Hết thời gian chờ, đã tự hủy.'), timeoutMs); if (p.timer.unref) p.timer.unref();
    try { p.msgId = await ask(chatId, '🧰 Cài các ứng dụng cần thiết trên "' + name + '" (' + (plat === 'windows' ? 'Windows' : 'Linux') + ') để máy này kiểm soát máy đó đầy đủ?\n' + list + '\nMáy này sẽ chạy từng bước qua SSH' + (plat === 'windows' ? '' : ' (có sudo)') + ' và báo kết quả. Cái nào đã có thì bỏ qua.', [[{ text: '✅ Cài', data: 'kn:' + id + ':y' }, { text: '❌ Bỏ qua', data: 'kn:' + id + ':n' }]]); } catch (e) { pending.delete(id); clearTimeout(p.timer); await send(chatId, '⚠️ Không gửi được thẻ xin duyệt: ' + e.message); }
  }
  async function platformOf(name) {
    try { const s = await fleet.call(fleet.findMachine(name), 'GET', '/fleet/status', undefined, 6000); return s && s.platform === 'windows' ? 'windows' : 'linux'; } catch (e) { return 'linux'; }
  }
  const sshArgs = (r, cmd) => ['-i', path.join(keyDir, 'id_ed25519'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(keyDir, 'known_hosts'), '-o', 'ConnectTimeout=10', r.user + '@' + r.host, cmd];
  async function provision(name) {
    const r = ready.get(String(name).toLowerCase()); if (!r) throw new Error('Chưa đăng nhập SSH được vào "' + name + '": chạy /ketnoi ' + name + ' trước.');
    const plat = await platformOf(name), lines = [];
    for (const a of APPS[plat]) {
      let res = await run('ssh', sshArgs(r, a.check));
      if (res.ok) { lines.push('✅ ' + a.label + ': đã có'); continue; }
      if (!a.install) { lines.push('⚠️ ' + a.label + ': chưa có (' + (a.hint || 'cần cài tay') + ')'); continue; }
      res = await run('ssh', sshArgs(r, a.install), { timeout: 600000 });
      const again = res.ok ? await run('ssh', sshArgs(r, a.check)) : res;
      lines.push(again.ok ? '✅ ' + a.label + ': đã cài' : '❌ ' + a.label + ': không cài được — ' + ((res.err || res.out || 'không rõ lý do').trim().split('\n').filter(Boolean).pop() || '').slice(0, 160));
    }
    logf('ketnoi: cài ứng dụng trên ' + name + ': ' + lines.map((l) => l.slice(0, 1)).join(''));
    return '🧰 Kết quả trên "' + name + '":\n' + lines.join('\n');
  }

  return { request, answer, connect, offerApps, provision, publicKey, pendingCount: () => pending.size, isCallback: (d) => ID_RE.test(String(d || '')) };
}

// PHÍA MÁY CON Linux: nhận khóa công khai từ máy đầu não (đã qua kênh ký của Đội máy) rồi xin agentos-remote (root) tạo tài khoản SSH có sudo.
// Chỉ GHI TỆP YÊU CẦU và đọc kết quả; việc sửa hệ thống do tập lệnh root làm theo danh sách cố định.
const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/]{20,800}={0,2}( [^\x00-\x1f]{0,80})?$/;
function createRemoteAccess(o) {
  o = o || {};
  const reqFile = o.requestFile || '/var/lib/agentos/remote-request', resFile = o.resultFile || '/var/lib/agentos/remote-result.json';
  const waitMs = o.waitMs || 25000, now = o.now || Date.now;
  return {
    async request(key) {
      key = String(key || '').trim();
      if (!SSH_KEY_RE.test(key)) throw new Error('Khóa SSH không đúng dạng (cần 1 dòng khóa CÔNG KHAI ssh-ed25519/ssh-rsa).');
      const t0 = Math.floor(now() / 1000);
      try { fs.rmSync(resFile, { force: true }); } catch (e) { /* không xóa được: vẫn so theo thời gian */ }
      fs.writeFileSync(reqFile, key + '\n', { mode: 0o644 });
      const end = now() + waitMs;
      while (now() < end) {
        await new Promise((r) => setTimeout(r, o.pollMs || 300));
        let j = null; try { j = JSON.parse(fs.readFileSync(resFile, 'utf8')); } catch (e) { continue; }
        if (!j || Number(j.ts) < t0) continue;
        if (!j.ok) throw new Error('Máy này không tạo được tài khoản SSH: ' + (j.error || 'lỗi không rõ'));
        return { ok: true, added: !!j.added, user: j.user, host: require('os').hostname(), warn: '' };
      }
      throw new Error('Máy này chưa xử lý yêu cầu trong ' + Math.round(waitMs / 1000) + ' giây (dịch vụ agentos-remote.path có đang chạy không?).');
    },
  };
}

module.exports = { createKetNoi, createRemoteAccess, SSH_KEY_RE };
