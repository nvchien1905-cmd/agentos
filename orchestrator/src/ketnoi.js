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

function createKetNoi(o) {
  const { fleet, ask, edit, send, log } = o;
  const keyDir = o.keyDir || process.env.AGENTOS_SSH_DIR || '/var/lib/agentos/.ssh';
  const run = o.run || ((bin, args) => new Promise((resolve) => execFile(bin, args, { timeout: 30000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }))));
  const timeoutMs = o.timeoutMs || 300000;
  const pending = new Map();
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
    const p = { name: m.name, chatId, timer: null, msgId: null };
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
    logf('ketnoi: chủ máy cho phép chép khóa SSH sang ' + p.name);
    connect(p.name).then((t) => send(p.chatId, t), (e) => send(p.chatId, '⚠️ ' + e.message)).catch(() => {});
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
    if (t.ok && /agentos-ssh-ok/.test(t.out)) return out + '\n✅ Thử đăng nhập bằng khóa: thành công. Từ giờ gõ /may ' + name + ' hoặc nhờ bot chạy lệnh trên máy đó: ssh ' + user + '@' + host + '.';
    return out + '\n⚠️ Chép xong nhưng thử đăng nhập chưa được: ' + (t.err.trim().split('\n').pop() || 'không rõ lý do') + '\n(Kiểm tra: dịch vụ OpenSSH Server đang chạy, tường lửa cổng 22 cho mạng Tailscale, tài khoản quản trị viên cần cấu hình ở cai-rustdesk-va-ssh.ps1 mục C.)';
  }

  return { request, answer, connect, publicKey, pendingCount: () => pending.size, isCallback: (d) => ID_RE.test(String(d || '')) };
}

module.exports = { createKetNoi };
