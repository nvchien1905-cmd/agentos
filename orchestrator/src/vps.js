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

// Quyền của từng bot với từng VPS (chủ máy tích ở Cài đặt → VPS): 'none' | 'ro' (chỉ xem) | 'full' (đủ quyền/sudo). Chưa tích: bot quản lý = full, còn lại = ro (như trước). Chỉ bot quản lý và bot Zalo (cùng tiến trình) được 'full'; bot phụ tối đa 'ro'.
const FULL_OK = new Set(['main', 'zalobot']);
const levelOf = (s, bot) => { const a = s && s.access && s.access[bot]; let l = (a === 'full' || a === 'ro' || a === 'none') ? a : (bot === 'main' ? 'full' : 'ro'); if (l === 'full' && !FULL_OK.has(bot)) l = 'ro'; return l; };

const trimOut = (s) => { s = String(s || '').replace(/\r/g, ''); return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + '\n…(đã cắt, còn ' + (s.length - MAX_OUT) + ' ký tự)' : s; };

function createVps(o) {
  o = o || {};
  const file = o.file, keyFull = o.keyFull, keyRo = o.keyRo, known = o.known;
  const role = o.role === 'ro' ? 'ro' : 'full';
  const log = o.log || (() => {}), chown = o.chown || (() => {});
  const run = o.run || ((bin, args, opts) => new Promise((resolve) => { const ch = execFile(bin, args, Object.assign({ timeout: 70000, maxBuffer: 4 * 1024 * 1024 }, opts || {}), (err, out, errOut) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(errOut || '') })); if (opts && opts.input !== undefined && ch.stdin) { ch.stdin.on('error', () => {}); ch.stdin.end(String(opts.input)); } }));
  const botId = o.botId || 'main';
  const tmpDir = o.tmpDir || require('os').tmpdir();

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

  const list = (opt) => { const a = read(); const bot = opt && opt.bot; return Object.keys(a).sort().filter((n) => !bot || levelOf(a[n], bot) !== 'none').map((n) => ({ name: n, host: a[n].host, port: a[n].port, fullUser: a[n].fullUser, roUser: a[n].roUser, access: a[n].access || {} })); };

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
  async function exec(name, cmd, opt) {
    const bot = (opt && opt.bot) || botId;
    const all = read(), k = find(all, name);
    if (!k) return { ok: false, text: 'Chưa có VPS "' + name + '". Đã có: ' + (Object.keys(all).join(', ') || '(chưa có)') };
    const s = all[k]; cmd = String(cmd || '').trim();
    let lv = levelOf(s, bot); if (opt && opt.readOnly && lv === 'full') lv = 'ro';
    if (lv === 'none') return { ok: false, text: '⛔ Bot này không được phép vào VPS "' + k + '" (chủ máy chưa tích quyền ở Cài đặt → VPS).' };
    const eff = lv === 'full' && role === 'full' ? 'full' : 'ro';
    if (!cmd || cmd.length > 4000 || /\x00/.test(cmd)) return { ok: false, text: 'Lệnh rỗng hoặc dài quá.' };
    if (eff === 'ro' && WRITE_RE.test(cmd)) return { ok: false, text: '⛔ Bot này chỉ có quyền XEM trên VPS "' + k + '": lệnh có vẻ ghi/sửa/xóa nên bị chặn. Việc ghi do bot quản lý làm.' };
    const key = eff === 'ro' ? keyRo : keyFull, user = eff === 'ro' ? s.roUser : s.fullUser;
    if (!user) return { ok: false, text: 'VPS "' + k + '" chưa có tài khoản ' + (eff === 'ro' ? 'chỉ-đọc' : 'đủ quyền') + '.' };
    if (!fs.existsSync(key)) return { ok: false, text: eff === 'ro' && role === 'ro' ? 'Bot này chưa nhận khóa chỉ-đọc từ bot quản lý (chờ ~1 phút sau khi bot quản lý chạy /vps khoa).' : 'Chưa có khóa SSH — gõ /vps khoa ' + k + '.' };
    const args = ['-i', key, '-p', String(s.port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + known, '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', user + '@' + s.host, '--', cmd];
    const r = await run('ssh', args);
    const out = trimOut((r.out + (r.err ? '\n' + r.err : '')).trim());
    log('vps: ' + eff + ' ' + k + ' (mã ' + r.code + ') ' + cmd.slice(0, 80).replace(/\s+/g, ' '));
    if (r.code === 255) return { ok: false, text: '❌ Không vào được VPS "' + k + '" (' + user + '@' + s.host + ':' + s.port + '): ' + (out || 'lỗi kết nối') + '\nKiểm tra khóa công khai đã dán vào VPS chưa: /vps khoa ' + k };
    return { ok: r.code === 0, level: eff, text: (r.code === 0 ? '' : '⚠️ Lệnh trả mã ' + r.code + '\n') + (out || '(không có kết quả)') };
  }

  // MỘT lệnh duy nhất để dán vào VPS: cài khóa cho tài khoản đủ quyền + tạo tài khoản chỉ-đọc (không sudo)
  function setupText(name, s) {
    const f = pub(keyFull), r = pub(keyRo), u = s.fullUser, ro = s.roUser;
    const cmd = "mkdir -p ~" + u + "/.ssh && echo '" + f + "' >> ~" + u + "/.ssh/authorized_keys && chmod 700 ~" + u + "/.ssh && chmod 600 ~" + u + "/.ssh/authorized_keys; " +
      "id " + ro + " >/dev/null 2>&1 || adduser --disabled-password --gecos '' " + ro + "; " +
      "mkdir -p /home/" + ro + "/.ssh && echo '" + r + "' >> /home/" + ro + "/.ssh/authorized_keys && chown -R " + ro + ":" + ro + " /home/" + ro + "/.ssh && chmod 700 /home/" + ro + "/.ssh && chmod 600 /home/" + ro + "/.ssh/authorized_keys";
    return '🔑 Anh dán ĐÚNG MỘT dòng này vào VPS "' + name + '" (đăng nhập bằng ' + u + '):\n\n' + cmd + '\n\nDán xong gõ: /vps thu ' + name;
  }

  // Lệnh cài khóa chạy TRÊN VPS (bằng root hoặc sudo): khóa đủ quyền cho tài khoản fullUser + tài khoản chỉ-đọc không sudo
  function installCmd(s) {
    const f = pub(keyFull), r = pub(keyRo), u = s.fullUser, ro = s.roUser;
    return "mkdir -p ~" + u + "/.ssh && grep -qxF '" + f + "' ~" + u + "/.ssh/authorized_keys 2>/dev/null || echo '" + f + "' >> ~" + u + "/.ssh/authorized_keys; chown -R " + u + ": ~" + u + "/.ssh; chmod 700 ~" + u + "/.ssh; chmod 600 ~" + u + "/.ssh/authorized_keys; " +
      "id " + ro + " >/dev/null 2>&1 || adduser --disabled-password --gecos '' " + ro + "; " +
      "mkdir -p /home/" + ro + "/.ssh && (grep -qxF '" + r + "' /home/" + ro + "/.ssh/authorized_keys 2>/dev/null || echo '" + r + "' >> /home/" + ro + "/.ssh/authorized_keys) && chown -R " + ro + ":" + ro + " /home/" + ro + "/.ssh && chmod 700 /home/" + ro + "/.ssh && chmod 600 /home/" + ro + "/.ssh/authorized_keys";
  }
  // ĐĂNG NHẬP VPS BẰNG MẬT KHẨU MỘT LẦN: AgentOS tự cài khóa SSH rồi từ đó chỉ dùng khóa. Mật khẩu chỉ đi qua biến môi trường của tiến trình ssh (qua SSH_ASKPASS) + stdin của sudo; KHÔNG ghi tệp, KHÔNG vào dòng lệnh, KHÔNG lưu, KHÔNG vào nhật ký.
  async function addWithPassword(b) {
    if (role === 'ro') throw new Error('Thêm VPS làm ở bot quản lý.');
    const pw = String(b && b.password || ''); if (!pw || pw.length > 500 || /\x00/.test(pw)) throw new Error('Chưa nhập mật khẩu đăng nhập VPS.');
    const r0 = put(b.name, b.host, b.port || 22, b.user || 'root', b.roUser);
    const s = read()[r0.name];
    await ensureKey(keyFull, 'full'); await ensureKey(keyRo, 'ro');
    const scriptPath = path.join(tmpDir, 'agentos-askpass-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.sh');
    fs.writeFileSync(scriptPath, '#!/bin/sh\nprintf %s "$AGENTOS_VPS_PW"\n', { mode: 0o700 });
    const body = s.fullUser === 'root' ? installCmd(s) : "sudo -S -p '' sh -c " + JSON.stringify(installCmd(s)).replace(/\$/g, '\\$');
    const args = ['-p', String(s.port), '-o', 'BatchMode=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + known, '-o', 'ConnectTimeout=20', s.fullUser + '@' + s.host, '--', body];
    let r;
    try {
      r = await run('ssh', args, { env: Object.assign({}, process.env, { SSH_ASKPASS: scriptPath, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 'agentos:0', AGENTOS_VPS_PW: pw }), input: s.fullUser === 'root' ? undefined : pw + '\n' });
    } finally { try { fs.rmSync(scriptPath, { force: true }); } catch (e) { /* bỏ qua */ } }
    const clean = (t) => String(t || '').split('\n').filter((l) => !/^Warning: Permanently added/.test(l)).join('\n').split(pw).join('***');
    log('vps: cài khóa vào ' + r0.name + ' (mã ' + r.code + ')');
    if (r.code !== 0) { const all = Object.assign({}, read()); delete all[r0.name]; write(all); throw new Error('Không đăng nhập/cài khóa được (' + (r.code === 255 ? 'sai mật khẩu, sai địa chỉ/cổng, hoặc VPS không cho đăng nhập bằng mật khẩu' : 'mã ' + r.code) + ')' + (clean(r.err || r.out).trim() ? ': ' + clean(r.err || r.out).trim().slice(0, 200) : '') + '. Chưa lưu VPS này.'); }
    const t1 = await exec(r0.name, 'echo OK', { bot: 'main' }), t2 = await exec(r0.name, 'echo OK', { bot: 'zalobot', readOnly: true });
    if (!t1.ok || !t2.ok) { const all = Object.assign({}, read()); delete all[r0.name]; write(all); throw new Error('Đã cài khóa nhưng đăng nhập thử bằng khóa không được: ' + clean((t1.ok ? t2 : t1).text).slice(0, 200) + '. Chưa lưu VPS này.'); }
    return { name: r0.name, host: s.host, port: s.port, fullUser: s.fullUser, roUser: s.roUser };
  }
  // Chủ máy tích bot nào được vào VPS nào, với quyền gì: access = { main: 'full', zalobot: 'ro', a1: 'none' ... }
  function setAccess(name, access) {
    if (role === 'ro') throw new Error('Đổi quyền làm ở bot quản lý.');
    const all = Object.assign({}, read()), k = find(all, name); if (!k) throw new Error('Không có VPS này.');
    const out = {}; for (const [bot, lv] of Object.entries(access || {})) { if (!/^(main|zalobot|a\d{1,3})$/.test(bot)) throw new Error('Bot không hợp lệ: ' + bot); if (!['none', 'ro', 'full'].includes(lv)) throw new Error('Quyền không hợp lệ.'); out[bot] = (lv === 'full' && !FULL_OK.has(bot)) ? 'ro' : lv; }
    all[k] = Object.assign({}, all[k], { access: out }); write(all); return out;
  }

  async function command(argText, opt) {
    const ro = !!(opt && (opt.noManage || opt.readOnly));        // ro: kênh không được thêm/xóa VPS hay lấy khóa (Zalo)
    const a = String(argText || '').trim();
    const m = /^(\S+)\s*([\s\S]*)$/.exec(a); const verb = m ? m[1].toLowerCase() : '', rest = m ? m[2].trim() : '';
    try {
      if (!a || verb === 'ds' || verb === 'list') {
        const l = list({ bot: (opt && opt.bot) || botId });
        return role === 'ro' || ro
          ? (l.length ? '🖥️ VPS có thể XEM (chỉ-đọc):\n' + l.map((x) => '• ' + x.name + ' — ' + x.host).join('\n') + '\nXem: /vps chay <tên> <lệnh> (vd /vps chay ' + l[0].name + ' df -h)' : '🖥️ Chưa có VPS nào (cấu hình ở bot quản lý: /vps them).')
          : (l.length ? '🖥️ VPS đã lưu:\n' + l.map((x) => '• ' + x.name + ' — ' + x.host + ':' + x.port + ' — đủ quyền: ' + x.fullUser + ' · chỉ đọc: ' + x.roUser).join('\n') + '\n/vps chay <tên> <lệnh> · /vps thu <tên> · /vps khoa <tên> · /vps xoa <tên>' : '🖥️ Chưa có VPS nào.\nThêm: /vps them <tên> <địa chỉ VPS>\nVí dụ: /vps them sv1 203.0.113.5');
      }
      if (ro && /^(them|khoa|key|xoa)$/.test(verb)) return '⛔ Từ Zalo chỉ XEM VPS được (/vps ds · /vps thu <tên> · /vps chay <tên> <lệnh xem>). Thêm/xóa VPS và lấy khóa làm ở Telegram.';
      if (verb === 'them') {
        const p = rest.split(/\s+/); if (!p[0] || !p[1]) return 'Cú pháp: /vps them <tên> <địa chỉ VPS> [cổng, mặc định 22] [tài khoản, mặc định root]';
        const r = put(p[0], p[1], p[2] || 22, p[3] || 'root', p[4]);
        await ensureKey(keyFull, 'full'); await ensureKey(keyRo, 'ro');
        return setupText(r.name, read()[r.name]);
      }
      if (verb === 'khoa' || verb === 'key') {
        if (role === 'ro') return 'Khóa do bot quản lý lo; bot này tự nhận khóa chỉ-đọc.';
        const all = read(), k = find(all, rest); if (!k) return 'Chưa có VPS "' + rest + '".';
        await ensureKey(keyFull, 'full'); await ensureKey(keyRo, 'ro');
        return setupText(k, all[k]);
      }
      if (verb === 'xoa') return remove(rest) ? '🗑️ Đã xóa VPS khỏi danh sách (khóa công khai trên VPS anh tự gỡ nếu muốn).' : 'Không có VPS tên đó.';
      if (verb === 'thu' || verb === 'test') { const r = await exec(rest, 'echo OK; whoami; hostname; uptime', opt); return (r.ok ? '✅ Vào được VPS (' + (r.level === 'ro' ? 'chỉ-đọc' : 'đủ quyền') + '):\n' : '') + r.text; }
      if (verb === 'chay' || verb === 'run') {
        const mm = /^(\S+)\s+([\s\S]+)$/.exec(rest); if (!mm) return 'Cú pháp: /vps chay <tên VPS> <lệnh>';
        return (await exec(mm[1], mm[2], opt)).text;
      }
      return 'Dùng: /vps · /vps them … · /vps khoa <tên> · /vps thu <tên> · /vps chay <tên> <lệnh> · /vps xoa <tên>';
    } catch (e) { return '⚠️ ' + e.message; }
  }

  return { list, put, remove, exec, command, role, WRITE_RE, addWithPassword, setAccess, levelOf: (name, bot) => { const a = read(), k = find(a, name); return k ? levelOf(a[k], bot) : 'none'; } };
}

module.exports = { createVps, WRITE_RE };
