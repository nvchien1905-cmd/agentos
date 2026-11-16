'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// /vps — truy cập VPS của chủ máy bằng khóa SSH (không mật khẩu).
//  - BOT QUẢN LÝ: khóa "full" → tài khoản có đủ quyền trên VPS (chủ máy chọn tài khoản); chạy được mọi lệnh.
//  - BOT THƯỜNG:  khóa "ro" → tài khoản CHỈ ĐỌC trên VPS (agentos-ro, không sudo, DB chỉ SELECT). Quyền chỉ-đọc được ép bằng chính VPS; phía bot chỉ thêm một lớp chặn lệnh ghi (phòng hờ, không phải hàng rào chính).
//  - Khóa riêng sinh tại máy này (ssh-keygen), KHÔNG rời máy; chỉ khóa "ro" được chép sang bot thường (agentctl). Chủ máy chỉ dán KHÓA CÔNG KHAI vào VPS.
//  - Việc chạy lệnh nằm trong bộ điều phối (AI chỉ nói tên VPS + lệnh qua bot_command), kết quả cắt gọn.
const NAME_RE = /^[A-Za-z0-9._-]{1,30}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,120}$|^[0-9a-fA-F:]{2,60}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const MAX_OUT = 6000;
// Lệnh ghi/phá — chặn phía bot ở chế độ chỉ-đọc (best-effort). Hàng rào thật là quyền của tài khoản agentos-ro trên VPS.
const WRITE_RE = new RegExp(
  '(^|[\\s;&|`(])(rm|rmdir|mv|cp|dd|mkfs\\S*|chmod|chown|chgrp|ln|kill|killall|pkill|reboot|shutdown|halt|poweroff|passwd|useradd|userdel|usermod|crontab|tee|truncate|touch|mkdir|wget|curl\\s+.*(-o|-O|--output)|apt(-get)?|dpkg|yum|dnf|pip3?|npm|yarn|sudo|su)(\\s|$)' +
  '|systemctl\\s+(start|stop|restart|reload|enable|disable|mask|kill)|service\\s+\\S+\\s+(start|stop|restart|reload)|pm2\\s+(start|stop|restart|reload|delete|kill|save|flush)' +
  '|git\\s+(push|reset|checkout|clean|commit|merge|rebase|pull)|sed\\s+(-\\S*i|--in-place)|(^|[^>])>>?[^>&]|<<' +
  '|\\b(drop|delete|update|insert|alter|truncate|create|grant|revoke|replace)\\s+(table|database|from|into|user|index|view|\\w+\\s+set)', 'i');

const trimOut = (s) => { s = String(s || '').replace(/\r/g, ''); return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + '\n…(đã cắt, còn ' + (s.length - MAX_OUT) + ' ký tự)' : s; };

function createVps(o) {
  o = o || {};
  const file = o.file, keyFull = o.keyFull, keyRo = o.keyRo, known = o.known;
  const role = o.role === 'ro' ? 'ro' : 'full';
  const log = o.log || (() => {}), chown = o.chown || (() => {});
  const run = o.run || ((bin, args, opts) => new Promise((resolve) => execFile(bin, args, Object.assign({ timeout: 70000, maxBuffer: 4 * 1024 * 1024 }, opts || {}), (err, out, errOut) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(errOut || '') }))));

  const read = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } };
  const write = (all) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(all, null, 1), { mode: 0o600 }); fs.renameSync(t, file); chown(file); };
  const find = (all, name) => { const w = String(name || '').toLowerCase(); return Object.keys(all).find((k) => k.toLowerCase() === w) || null; };

  async function ensureKey(p, label) {
    if (fs.existsSync(p) && fs.existsSync(p + '.pub')) return;
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.rmSync(p, { force: true }); fs.rmSync(p + '.pub', { force: true });
    const r = await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'agentos-' + label, '-f', p, '-q']);
    if (r.code !== 0) throw new Error('Không tạo được khóa SSH (' + (r.err || r.out).trim().slice(0, 100) + '). Máy cần cài openssh-client.');
    try { fs.chmodSync(p, 0o600); } catch (e) { /* bỏ qua */ }
    chown(p); chown(p + '.pub');
  }
  const pub = (p) => { try { return fs.readFileSync(p + '.pub', 'utf8').trim(); } catch (e) { return ''; } };

  const list = () => { const a = read(); return Object.keys(a).sort().map((n) => ({ name: n, host: a[n].host, port: a[n].port, fullUser: a[n].fullUser, roUser: a[n].roUser })); };

  function put(name, host, port, fullUser, roUser) {
    if (role === 'ro') throw new Error('Thêm/xóa VPS làm ở bot quản lý (bot thường tự nhận sau vài phút).');
    name = String(name || '').trim(); host = String(host || '').trim(); port = Number(port || 22); fullUser = String(fullUser || '').trim(); roUser = String(roUser || 'agentos-ro').trim();
    if (!NAME_RE.test(name)) throw new Error('Tên VPS 1–30 ký tự (chữ, số, . _ -), không dấu cách.');
    if (!HOST_RE.test(host)) throw new Error('Địa chỉ VPS không hợp lệ.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Cổng SSH không hợp lệ.');
    if (!USER_RE.test(fullUser)) throw new Error('Tên tài khoản đủ quyền không hợp lệ (vd root hoặc admin).');
    if (!USER_RE.test(roUser)) throw new Error('Tên tài khoản chỉ-đọc không hợp lệ (vd agentos-ro).');
    const all = Object.assign({}, read()), old = find(all, name); if (old && old !== name) delete all[old];
    all[name] = { host, port, fullUser, roUser, at: new Date().toISOString() };
    write(all); return { name, host, port, fullUser, roUser };
  }
  function remove(name) { if (role === 'ro') throw new Error('Xóa VPS làm ở bot quản lý.'); const all = Object.assign({}, read()), k = find(all, name); if (!k) return false; delete all[k]; write(all); return true; }

  // Chạy lệnh trên VPS. role 'full' dùng khóa + tài khoản đủ quyền; 'ro' dùng khóa + tài khoản chỉ-đọc và bị chặn lệnh ghi.
  async function exec(name, cmd) {
    const all = read(), k = find(all, name);
    if (!k) return { ok: false, text: 'Chưa có VPS "' + name + '". Đã có: ' + (Object.keys(all).join(', ') || '(chưa có)') };
    const s = all[k]; cmd = String(cmd || '').trim();
    if (!cmd || cmd.length > 4000 || /\x00/.test(cmd)) return { ok: false, text: 'Lệnh rỗng hoặc dài quá.' };
    if (role === 'ro' && WRITE_RE.test(cmd)) return { ok: false, text: '⛔ Bot này chỉ có quyền XEM trên VPS "' + k + '": lệnh có vẻ ghi/sửa/xóa nên bị chặn. Việc ghi do bot quản lý làm.' };
    const key = role === 'ro' ? keyRo : keyFull, user = role === 'ro' ? s.roUser : s.fullUser;
    if (!user) return { ok: false, text: 'VPS "' + k + '" chưa có tài khoản ' + (role === 'ro' ? 'chỉ-đọc' : 'đủ quyền') + '.' };
    if (!fs.existsSync(key)) return { ok: false, text: role === 'ro' ? 'Bot này chưa nhận khóa chỉ-đọc từ bot quản lý (chờ ~1 phút sau khi bot quản lý chạy /vps khoa).' : 'Chưa có khóa SSH — gõ /vps khoa ' + k + '.' };
    const args = ['-i', key, '-p', String(s.port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + known, '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', user + '@' + s.host, '--', cmd];
    const r = await run('ssh', args);
    const out = trimOut((r.out + (r.err ? '\n' + r.err : '')).trim());
    log('vps: ' + role + ' ' + k + ' (mã ' + r.code + ') ' + cmd.slice(0, 80).replace(/\s+/g, ' '));
    if (r.code === 255) return { ok: false, text: '❌ Không vào được VPS "' + k + '" (' + user + '@' + s.host + ':' + s.port + '): ' + (out || 'lỗi kết nối') + '\nKiểm tra khóa công khai đã dán vào VPS chưa: /vps khoa ' + k };
    return { ok: r.code === 0, text: (r.code === 0 ? '' : '⚠️ Lệnh trả mã ' + r.code + '\n') + (out || '(không có kết quả)') };
  }

  function setupText(name, s) {
    const f = pub(keyFull), r = pub(keyRo);
    return '🔑 Cài khóa cho VPS "' + name + '" (' + s.host + ':' + s.port + '). Anh đăng nhập VPS bằng tài khoản quản trị của anh rồi chạy:\n\n' +
      '① Tài khoản ĐỦ QUYỀN cho bot quản lý (' + s.fullUser + '):\n' +
      'mkdir -p ~' + s.fullUser + '/.ssh && echo \'' + f + '\' >> ~' + s.fullUser + '/.ssh/authorized_keys && chmod 700 ~' + s.fullUser + '/.ssh && chmod 600 ~' + s.fullUser + '/.ssh/authorized_keys\n\n' +
      '② Tài khoản CHỈ ĐỌC cho bot thường (' + s.roUser + ', không sudo):\n' +
      'id ' + s.roUser + ' >/dev/null 2>&1 || adduser --disabled-password --gecos "" ' + s.roUser + '\n' +
      'mkdir -p /home/' + s.roUser + '/.ssh && echo \'' + r + '\' >> /home/' + s.roUser + '/.ssh/authorized_keys && chown -R ' + s.roUser + ':' + s.roUser + ' /home/' + s.roUser + '/.ssh && chmod 700 /home/' + s.roUser + '/.ssh && chmod 600 /home/' + s.roUser + '/.ssh/authorized_keys\n\n' +
      '③ Cho tài khoản chỉ-đọc xem được dữ liệu cần xem: tạo người dùng cơ sở dữ liệu CHỈ SELECT (vd MySQL: GRANT SELECT ON tên_csdl.* TO \'' + s.roUser + '\'@\'localhost\'), và cho đọc thư mục báo cáo/nhật ký cần thiết (setfacl -R -m u:' + s.roUser + ':rX <thư mục>). Quyền chỉ-đọc do CHÍNH VPS giữ, nên đừng cho ' + s.roUser + ' vào nhóm sudo/docker.\n\n' +
      'Xong gõ: /vps thu ' + name;
  }

  async function command(argText) {
    const a = String(argText || '').trim();
    const m = /^(\S+)\s*([\s\S]*)$/.exec(a); const verb = m ? m[1].toLowerCase() : '', rest = m ? m[2].trim() : '';
    try {
      if (!a || verb === 'ds' || verb === 'list') {
        const l = list();
        return role === 'ro'
          ? (l.length ? '🖥️ VPS có thể XEM (chỉ-đọc):\n' + l.map((x) => '• ' + x.name + ' — ' + x.host).join('\n') + '\nXem: /vps chay <tên> <lệnh> (vd /vps chay ' + l[0].name + ' df -h)' : '🖥️ Chưa có VPS nào (cấu hình ở bot quản lý: /vps them).')
          : (l.length ? '🖥️ VPS đã lưu:\n' + l.map((x) => '• ' + x.name + ' — ' + x.host + ':' + x.port + ' — đủ quyền: ' + x.fullUser + ' · chỉ đọc: ' + x.roUser).join('\n') + '\n/vps chay <tên> <lệnh> · /vps thu <tên> · /vps khoa <tên> · /vps xoa <tên>' : '🖥️ Chưa có VPS nào.\nThêm: /vps them <tên> <địa chỉ> <cổng SSH> <tài khoản đủ quyền> [tài khoản chỉ-đọc, mặc định agentos-ro]\nVí dụ: /vps them sv1 203.0.113.5 22 root');
      }
      if (verb === 'them') {
        const p = rest.split(/\s+/); if (p.length < 4) return 'Cú pháp: /vps them <tên> <địa chỉ> <cổng> <tài khoản đủ quyền> [tài khoản chỉ-đọc]';
        const r = put(p[0], p[1], p[2], p[3], p[4]);
        await ensureKey(keyFull, 'full'); await ensureKey(keyRo, 'ro');
        return '✅ Đã lưu VPS "' + r.name + '". Bước tiếp: /vps khoa ' + r.name + ' (em đưa lệnh để anh dán vào VPS).';
      }
      if (verb === 'khoa' || verb === 'key') {
        if (role === 'ro') return 'Khóa do bot quản lý lo; bot này tự nhận khóa chỉ-đọc.';
        const all = read(), k = find(all, rest); if (!k) return 'Chưa có VPS "' + rest + '".';
        await ensureKey(keyFull, 'full'); await ensureKey(keyRo, 'ro');
        return setupText(k, all[k]);
      }
      if (verb === 'xoa') return remove(rest) ? '🗑️ Đã xóa VPS khỏi danh sách (khóa công khai trên VPS anh tự gỡ nếu muốn).' : 'Không có VPS tên đó.';
      if (verb === 'thu' || verb === 'test') { const r = await exec(rest, 'echo OK; whoami; hostname; uptime'); return (r.ok ? '✅ Vào được VPS (' + (role === 'ro' ? 'chỉ-đọc' : 'đủ quyền') + '):\n' : '') + r.text; }
      if (verb === 'chay' || verb === 'run') {
        const mm = /^(\S+)\s+([\s\S]+)$/.exec(rest); if (!mm) return 'Cú pháp: /vps chay <tên VPS> <lệnh>';
        return (await exec(mm[1], mm[2])).text;
      }
      return 'Dùng: /vps · /vps them … · /vps khoa <tên> · /vps thu <tên> · /vps chay <tên> <lệnh> · /vps xoa <tên>';
    } catch (e) { return '⚠️ ' + e.message; }
  }

  return { list, put, remove, exec, command, role, WRITE_RE };
}

module.exports = { createVps, WRITE_RE };
