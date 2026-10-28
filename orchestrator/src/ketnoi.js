'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// /ketnoi: máy đầu não TỰ DÒ các máy AgentOS cùng tài khoản Tailscale rồi, sau MỘT lần chủ máy bấm "Kết nối" trên Telegram, làm hết:
//   ① ghép đôi vào Đội máy (máy con chỉ đưa khóa ký cho máy CÙNG tài khoản Tailscale — xem fleet.js /fleet/pair và tsowner.js)
//   ② chép KHÓA CÔNG KHAI SSH sang máy con (máy Linux: tài khoản agentos-remote có sudo; máy Windows: tài khoản chạy máy con)
//   ③ cài các ứng dụng cần thiết qua SSH (danh sách cố định bên dưới), rồi báo kết quả từng bước.
// Đây là chức năng CỐ ĐỊNH của AgentOS, không phải AI tự soạn lệnh:
//  - chỉ chủ máy gõ được, mỗi lần đều hiện nút trên Telegram và chờ chủ máy bấm (5 phút không bấm thì tự hủy);
//  - chỉ chép KHÓA CÔNG KHAI (khóa riêng không bao giờ rời máy này);
//  - máy Windows chỉ nhận khóa khi chủ máy đó đã cài một lần (cai-dat-may-con.ps1: bật "allowSshKey"); máy Linux tắt được bằng agent.allowSshKey=false;
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
const OSNAME = { linux: 'Linux', windows: 'Windows' };

function createKetNoi(o) {
  const { fleet, ask, edit, send, log } = o;
  const keyDir = o.keyDir || process.env.AGENTOS_SSH_DIR || '/var/lib/agentos/.ssh';
  const run = o.run || ((bin, args, opt) => new Promise((resolve) => execFile(bin, args, { timeout: (opt && opt.timeout) || 30000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }))));
  const tsPeers = o.tsPeers || (async () => ({ running: false, peers: [] }));      // () -> { running, self, peers: [{ ip, host, os }] } (máy khác cùng tài khoản Tailscale đang bật)
  const agentPort = o.agentPort || 8433;
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

  async function platformOf(name) {
    try { const s = await fleet.call(fleet.findMachine(name), 'GET', '/fleet/status', undefined, 6000); return s && s.platform === 'windows' ? 'windows' : 'linux'; } catch (e) { return 'linux'; }
  }

  // Gửi thẻ xin duyệt cho MỘT máy. c: { name, url, platform, ip, inFleet }
  async function card(chatId, c) {
    const id = Math.random().toString(36).slice(2, 10);
    const p = { kind: 'setup', name: c.name, url: c.url, platform: c.platform || 'linux', inFleet: !!c.inFleet, chatId, timer: null, msgId: null };
    pending.set(id, p);
    p.timer = setTimeout(() => finish(id, false, '⏱ Hết thời gian chờ, đã tự hủy.'), timeoutMs);
    if (p.timer.unref) p.timer.unref();
    const apps = (APPS[p.platform] || APPS.linux).map((a) => '   · ' + a.label).join('\n');
    const text = '🔗 Máy "' + c.name + '" (' + (OSNAME[p.platform] || 'Linux') + ', ' + (c.ip || new URL(c.url).hostname) + ') cùng tài khoản Tailscale với máy này.\n' +
      'Bấm Kết nối để máy này làm một mạch:\n' +
      (c.inFleet ? '   ① (đã trong Đội máy)\n' : '   ① ghép đôi vào Đội máy (không cần nhập khóa)\n') +
      '   ② chép khóa SSH công khai sang máy đó' + (p.platform === 'windows' ? '' : ' (tài khoản agentos-remote, có sudo không hỏi mật khẩu)') + '\n' +
      '   ③ cài/kiểm các ứng dụng cần thiết:\n' + apps + '\nKhóa riêng không rời máy này.';
    try { p.msgId = await ask(chatId, text, [[{ text: '✅ Kết nối', data: 'kn:' + id + ':y' }, { text: '❌ Bỏ qua', data: 'kn:' + id + ':n' }]]); } catch (e) { pending.delete(id); clearTimeout(p.timer); throw new Error('Không gửi được thẻ xin duyệt: ' + e.message); }
  }

  // /ketnoi (không tên): dò máy cùng tài khoản Tailscale đang chạy máy con AgentOS rồi gửi thẻ cho từng máy.
  async function scan(chatId) {
    const ts = await tsPeers();
    if (!ts.running) return '⚠️ Máy này chưa kết nối Tailscale. Gõ /tailscale ketnoi, đăng nhập CÙNG tài khoản với các máy kia rồi gõ lại /ketnoi.';
    if (!ts.peers.length) return 'Chưa thấy máy nào khác cùng tài khoản Tailscale đang bật. Bật máy kia, đăng nhập Tailscale cùng tài khoản rồi gõ lại /ketnoi.';
    const known = fleet.load().machines;
    const found = [], other = [];
    await Promise.all(ts.peers.map(async (pr) => {
      const url = 'http://' + pr.ip + ':' + agentPort;
      try { const h = await fleet.hello(url, 3000); found.push({ name: h.name || pr.host, url, ip: pr.ip, platform: h.platform === 'windows' ? 'windows' : 'linux', inFleet: known.some((m) => m.url === url) }); } catch (e) { other.push(pr); }
    }));
    if (!found.length) {
      return 'Thấy ' + ts.peers.length + ' máy cùng tài khoản Tailscale (' + ts.peers.map((x) => x.host + (x.os ? ' · ' + x.os : '')).join(', ') + ') nhưng chưa máy nào chạy máy con AgentOS.\n' +
        '• Máy AgentOS (Linux): cập nhật lên bản mới nhất (/capnhat co) và đảm bảo đã đăng nhập Tailscale.\n• Máy Windows: chạy cai-dat-may-con.ps1 một lần (Run as administrator).';
    }
    found.sort((a, b) => a.name.localeCompare(b.name));
    await send(chatId, '🔍 Tìm thấy ' + found.length + ' máy AgentOS cùng tài khoản Tailscale: ' + found.map((f) => f.name).join(', ') + '. Bấm nút ở từng thẻ bên dưới.');
    for (const c of found) await card(chatId, c);
    return null;
  }

  // /ketnoi <tên>: máy đã có trong Đội máy.
  async function request(chatId, name) {
    name = String(name || '').trim();
    if (!name) return scan(chatId);
    const m = fleet.findMachine(name);
    if (!m) return 'Không có máy "' + name + '" trong Đội máy. Gõ /ketnoi (không kèm tên) để tự dò các máy cùng tài khoản Tailscale.';
    try { await card(chatId, { name: m.name, url: m.url, platform: await platformOf(m.name), ip: new URL(m.url).hostname, inFleet: true }); } catch (e) { return '⚠️ ' + e.message; }
    return null;
  }

  async function finish(id, ok, label) {
    const p = pending.get(id); if (!p) return false;
    pending.delete(id); clearTimeout(p.timer);
    if (p.msgId && edit) edit(p.chatId, p.msgId, '🔗 Kết nối "' + p.name + '"\n\n' + label).catch(() => {});
    return true;
  }

  // Chủ máy bấm nút. Trả văn bản hiện cho người bấm.
  async function answer(data, userId, isAdmin) {
    const m = ID_RE.exec(String(data)); if (!m) return 'Nút không hợp lệ.';
    const p = pending.get(m[1]); if (!p) return 'Yêu cầu này đã hết hạn hoặc đã được trả lời.';
    if (isAdmin && !isAdmin(String(userId))) return 'Chỉ quản trị viên được duyệt việc này.';
    if (m[2] === 'n') { await finish(m[1], false, '❌ Đã bỏ qua.'); logf('ketnoi: chủ máy bỏ qua ' + p.name); return 'Đã bỏ qua.'; }
    pending.delete(m[1]); clearTimeout(p.timer);          // đã duyệt: không cho bấm lần nữa
    if (p.msgId && edit) edit(p.chatId, p.msgId, '🔗 Kết nối "' + p.name + '"\n\n⏳ Đã cho phép, đang làm...').catch(() => {});
    logf('ketnoi: chủ máy cho phép kết nối ' + p.name + (p.inFleet ? '' : ' (ghép đôi mới)'));
    setup(p).then((t) => send(p.chatId, t), (e) => send(p.chatId, '⚠️ ' + e.message)).catch(() => {});
    return 'Đã cho phép, đang làm.';
  }

  // Làm một mạch: ghép đôi → chép khóa + thử SSH → cài ứng dụng. Mỗi bước lỗi được báo rõ, không làm hỏng bước đã xong.
  async function setup(p) {
    const out = []; let name = p.name;
    if (!p.inFleet) {
      try { const r = await fleet.pairWith(p.url); name = r.name; out.push('✅ ① Đã ghép đôi: máy "' + name + '" đã vào Đội máy.'); }
      catch (e) { throw new Error('Ghép đôi với "' + p.name + '" không được: ' + e.message + '\n(Máy đó phải cùng tài khoản Tailscale và đang chạy máy con AgentOS.)'); }
    } else out.push('✅ ① "' + name + '" đã trong Đội máy.');
    let c;
    try { c = await connect(name); } catch (e) { out.push('⚠️ ② ' + e.message); return out.join('\n') + '\nXử lý xong thì gõ /ketnoi ' + name + ' để thử lại.'; }
    out.push('② ' + c);
    if (!ready.has(String(name).toLowerCase())) return out.join('\n') + '\n⏭ Bỏ qua bước ③ (cài ứng dụng) vì chưa SSH vào được.';
    try { out.push('③ ' + await provision(name)); } catch (e) { out.push('⚠️ ③ ' + e.message); }
    return out.join('\n');
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
    if (t.ok && /agentos-ssh-ok/.test(t.out)) { ready.set(String(name).toLowerCase(), { user, host }); return out + '\n✅ Thử đăng nhập bằng khóa: thành công (ssh ' + user + '@' + host + ').'; }
    return out + '\n⚠️ Chép xong nhưng thử đăng nhập chưa được: ' + (t.err.trim().split('\n').pop() || 'không rõ lý do') + '\n(Kiểm tra: dịch vụ OpenSSH Server đang chạy, tường lửa cổng 22 cho mạng Tailscale; máy Windows: chạy lại cai-dat-may-con.ps1.)';
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
    return 'Ứng dụng trên "' + name + '":\n' + lines.join('\n');
  }

  return { request, scan, answer, connect, provision, setup, publicKey, pendingCount: () => pending.size, isCallback: (d) => ID_RE.test(String(d || '')) };
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
