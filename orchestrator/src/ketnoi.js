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
const PSF = (p) => PS("if (Test-Path '" + p + "') { exit 0 } else { exit 1 }");          // kiểm tệp (nhanh, đáng tin hơn winget qua SSH)
// Cài RustDesk bằng cách tải thẳng bản mới nhất từ GitHub (không dùng winget: winget hay không chạy được trong phiên SSH), đặt mật khẩu cố định NGẪU NHIÊN, lưu ID + mật khẩu vào rustdesk.json
const RD_INSTALL = String.raw`$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$d = 'C:\ProgramData\AgentOS'; New-Item -ItemType Directory -Force -Path $d | Out-Null
$log = Join-Path $d 'rustdesk-install.log'
function L($m) { Add-Content -Path $log -Value ((Get-Date -Format s) + ' ' + $m); Write-Output $m }
# Chay chuong trinh ngoai, lay ca stdout lan stderr thanh chu (stderr cua chuong trinh ngoai KHONG duoc lam script dung)
function Run-Native($exe, $argList) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { return ((& $exe @argList 2>&1 | ForEach-Object { $_.ToString() }) -join ' ').Trim() } finally { $ErrorActionPreference = $old }
}
try {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  $adm = (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  L ('user=' + $me.Name + ' quan tri=' + $adm)
  $rd = 'C:\Program Files\RustDesk\rustdesk.exe'
  if (-not (Test-Path $rd)) {
    if (-not $adm) { throw 'Phien SSH khong co quyen quan tri nen khong cai duoc chuong trinh. Chay cai-dat-may-con.ps1 bang Run as administrator mot lan tren may do.' }
    $r = Invoke-RestMethod 'https://api.github.com/repos/rustdesk/rustdesk/releases/latest' -UseBasicParsing
    $a = $r.assets | Where-Object { $_.name -match 'x86_64\.exe$' } | Select-Object -First 1
    if (-not $a) { throw 'Khong thay ban cai RustDesk x86_64 tren GitHub.' }
    $f = Join-Path $env:TEMP $a.name
    L ('tai ' + $a.name)
    Invoke-WebRequest $a.browser_download_url -OutFile $f -UseBasicParsing
    $p = Start-Process $f -ArgumentList '--silent-install' -PassThru
    if (-not $p.WaitForExit(240000)) { L 'bo cai chay qua 4 phut, tiep tuc kiem tra' } else { L ('cai xong, ma thoat ' + $p.ExitCode) }
    for ($i = 0; $i -lt 30 -and -not (Test-Path $rd); $i++) { Start-Sleep 2 }
    if (-not (Test-Path $rd)) { throw 'Chay bo cai xong nhung khong thay rustdesk.exe.' }
  }
  $info = Join-Path $d 'rustdesk.json'
  if (-not (Test-Path $info)) {
    if (-not $adm) { throw 'Da co RustDesk nhung dat mat khau can quyen quan tri (phien SSH khong co). Chay cai-dat-may-con.ps1 bang Run as administrator mot lan.' }
    for ($i = 0; $i -lt 30; $i++) { $s = Get-Service -Name RustDesk -ErrorAction SilentlyContinue; if ($s -and $s.Status -eq 'Running') { break }; if ($s -and $s.Status -ne 'Running') { try { Start-Service RustDesk } catch {} }; Start-Sleep 2 }
    $s = Get-Service -Name RustDesk -ErrorAction SilentlyContinue; L ('dich vu RustDesk: ' + $(if ($s) { $s.Status } else { 'khong co' }))
    $pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
    $o = Run-Native $rd @('--password', $pw); L ('dat mat khau: ' + $o)
    $id = ''
    for ($i = 0; $i -lt 10 -and $id -notmatch '^\d{6,12}$'; $i++) {
      $o = Run-Native $rd @('--get-id'); $m = [regex]::Match($o, '\b\d{6,12}\b'); $id = if ($m.Success) { $m.Value } else { '' }
      if ($id -eq '') { L ('lay ID lan ' + ($i + 1) + ': ' + $o); Start-Sleep 3 }
    }
    if ($id -eq '') { throw 'Da cai RustDesk nhung chua lay duoc ID.' }
    [IO.File]::WriteAllText($info, (@{ id = $id; password = $pw } | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    L ('RustDesk ID ' + $id)
  }
  L 'XONG'
} catch { L ('LOI: ' + $_.Exception.Message); exit 1 }
`;
// Kịch bản dài KHÔNG đưa vào dòng lệnh (Windows giới hạn 8191 ký tự: "The command line is too long"). Ghi thành tệp bằng MỘT dòng qua stdin (base64), rồi chạy bằng -File.
const RD_FILE = 'C:\\ProgramData\\AgentOS\\rd-install.ps1';
const RD_WRITE = (script) => '[IO.File]::WriteAllText(' + "'" + RD_FILE + "'" + ', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(' + "'" + Buffer.from(script, 'utf8').toString('base64') + "'" + ')))';
const RD_RUN = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + RD_FILE;
const APPS = {
  linux: [
    { label: 'Quyền sudo không hỏi mật khẩu', check: 'sudo -n true' },
    { label: 'Công cụ rsync, curl, jq', check: 'command -v rsync && command -v curl && command -v jq', install: "sudo -n sh -c 'apt-get update -qq && apt-get install -y -qq rsync curl jq'" },
    { label: 'Tailscale (đường vào dự phòng)', check: 'command -v tailscale', hint: 'AgentOS có sẵn; máy này không phải bản AgentOS?' },
    { label: 'RustDesk (điều khiển màn hình)', check: 'command -v rustdesk', hint: 'AgentOS có sẵn; máy này không phải bản AgentOS?' },
    { label: 'Bộ điều phối AgentOS đang chạy', check: 'systemctl is-active --quiet agentos-orchestrator' },
  ],
  windows: [
    { label: 'RustDesk (điều khiển màn hình)', check: PSF('C:\\Program Files\\RustDesk\\rustdesk.exe'), script: RD_INSTALL, hint: 'chạy lại cai-dat-may-con.ps1 (Run as administrator) trên máy đó', rustdesk: true },
    { label: 'Tailscale', check: PSF('C:\\Program Files\\Tailscale\\tailscale.exe'), hint: 'chạy lại cai-dat-may-con.ps1 (Run as administrator) trên máy đó' },
    { label: 'Node.js (chạy máy con AgentOS)', check: 'node --version', hint: 'chạy lại cai-dat-may-con.ps1 (Run as administrator) trên máy đó' },
  ],
};
// Lấy lý do lỗi dễ đọc từ kết quả lệnh: ưu tiên dòng LOI: của kịch bản; bỏ XML tiến trình (CLIXML) của PowerShell; nếu có XML lỗi thì giải mã.
function reason(res) {
  const txt = [res.out, res.err, res.msg].map((x) => String(x || '')).join('\n');
  const own = txt.split('\n').map((l) => l.trim()).filter((l) => /^LOI: /.test(l)).pop(); if (own) return own.slice(5).slice(0, 220);
  const xml = [...txt.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1].replace(/_x000D__x000A_/g, ' ').replace(/_x000A_/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()).filter(Boolean);
  if (xml.length) return xml.join(' ').slice(0, 220);
  const lines = txt.split('\n').map((l) => l.trim()).filter((l) => l && !/^#< CLIXML/.test(l) && !/^<Objs /.test(l) && !/^Command failed:/.test(l));
  return (lines.pop() || 'không rõ lý do').slice(0, 220);
}
const OSNAME = { linux: 'Linux', windows: 'Windows' };

function createKetNoi(o) {
  const { fleet, ask, edit, send, log } = o;
  const keyDir = o.keyDir || process.env.AGENTOS_SSH_DIR || '/var/lib/agentos/.ssh';
  const run = o.run || ((bin, args, opt) => new Promise((resolve) => { const c = execFile(bin, args, { timeout: (opt && opt.timeout) || 30000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || ''), msg: String((err && err.message) || '') })); if (opt && opt.input != null && c.stdin) c.stdin.end(opt.input); }));
  const tsPeers = o.tsPeers || (async () => ({ running: false, peers: [] }));      // () -> { running, self, peers: [{ ip, host, os }] } (máy khác cùng tài khoản Tailscale đang bật)
  const agentPort = o.agentPort || 8433;
  const credsFile = o.credsFile || null;                    // nơi lưu ID + mật khẩu RustDesk của các máy con (0600)
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
    const text = '🔗 Máy "' + c.name + '" (' + (OSNAME[p.platform] || 'Linux') + ' · ' + (c.ip || new URL(c.url).hostname) + ') cùng tài khoản Tailscale.' + '\n' +
      (c.inFleet ? 'Kết nối SSH + kiểm ứng dụng?' : 'Ghép đôi + SSH có sudo + cài ứng dụng cần thiết?');
    try { p.msgId = await ask(chatId, text, [[{ text: '✅ Kết nối', data: 'kn:' + id + ':y' }, { text: '❌ Bỏ qua', data: 'kn:' + id + ':n' }]]); } catch (e) { pending.delete(id); clearTimeout(p.timer); throw new Error('Không gửi được thẻ xin duyệt: ' + e.message); }
  }

  // /ketnoi (không tên): dò máy cùng tài khoản Tailscale đang chạy máy con AgentOS rồi gửi thẻ cho từng máy.
  async function scan(chatId) {
    const ts = await tsPeers();
    if (!ts.running) return '⚠️ Máy này chưa kết nối Tailscale. Gõ /tailscale ketnoi, đăng nhập CÙNG tài khoản với các máy kia rồi gõ lại /ketnoi.';
    if (!ts.peers.length) return 'Chưa thấy máy nào khác cùng tài khoản Tailscale đang bật. Bật máy kia, đăng nhập Tailscale cùng tài khoản rồi gõ lại /ketnoi.';
    const found = await discover(ts);
    if (!found.length) {
      return 'Thấy ' + ts.peers.length + ' máy cùng tài khoản Tailscale (' + ts.peers.map((x) => x.host + (x.os ? ' · ' + x.os : '')).join(', ') + ') nhưng chưa máy nào chạy máy con AgentOS.\n' +
        '• Máy AgentOS (Linux): cập nhật lên bản mới nhất (/capnhat co) và đảm bảo đã đăng nhập Tailscale.\n• Máy Windows: chạy cai-dat-may-con.ps1 một lần (Run as administrator).';
    }
    for (const c of found) await card(chatId, c);
    return null;
  }

  // Máy cùng tài khoản Tailscale đang chạy máy con AgentOS (hỏi thăm từng máy, không cần khóa)
  async function discover(ts) {
    const known = fleet.load().machines, found = [];
    await Promise.all(ts.peers.map(async (pr) => {
      const url = 'http://' + pr.ip + ':' + agentPort;
      try { const h = await fleet.hello(url, 3000); found.push({ name: h.name || pr.host, url, ip: pr.ip, platform: h.platform === 'windows' ? 'windows' : 'linux', inFleet: known.some((m) => m.url === url) }); } catch (e) { /* không phải máy AgentOS */ }
    }));
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Tự báo khi thấy máy MỚI cùng tài khoản Tailscale (chưa trong Đội máy, chưa từng hỏi): gửi thẻ Kết nối, mỗi máy hỏi một lần. Không làm gì khi chưa bấm.
  const offeredFile = o.offeredFile || null;
  const offered = new Set((() => { try { return JSON.parse(fs.readFileSync(offeredFile, 'utf8')); } catch (e) { return []; } })());
  async function offerNew(chatId) {
    const ts = await tsPeers(); if (!ts.running || !ts.peers.length) return 0;
    const fresh = (await discover(ts)).filter((c) => !c.inFleet && !offered.has(c.url));
    for (const c of fresh) {
      offered.add(c.url); if (offeredFile) { try { fs.writeFileSync(offeredFile, JSON.stringify([...offered])); } catch (e) { /* không ghi được: lần sau hỏi lại */ } }
      try { await card(chatId, c); } catch (e) { offered.delete(c.url); throw e; }
    }
    return fresh.length;
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
    if (p.msgId && edit) edit(p.chatId, p.msgId, '🔗 "' + p.name + '"\n⏳ Đang kết nối...').catch(() => {});
    logf('ketnoi: chủ máy cho phép kết nối ' + p.name + (p.inFleet ? '' : ' (ghép đôi mới)'));
    // Kết quả ghi thẳng vào thẻ vừa bấm (ít tin nhắn hơn); không sửa được thẻ thì gửi tin mới
    const show = (t) => (p.msgId && edit ? edit(p.chatId, p.msgId, t).catch(() => send(p.chatId, t)) : send(p.chatId, t));
    setup(p).then((t) => show('🔗 "' + p.name + '"\n' + t), (e) => show('🔗 "' + p.name + '"\n⚠️ ' + e.message)).catch(() => {});
    return 'Đang kết nối...';
  }

  // Làm một mạch: ghép đôi → chép khóa + thử SSH → cài ứng dụng. Mỗi bước lỗi được báo rõ, không làm hỏng bước đã xong.
  async function setup(p) {
    const out = []; let name = p.name;
    if (!p.inFleet) {
      try { const r = await fleet.pairWith(p.url); name = r.name; out.push('✅ Đã ghép đôi, vào Đội máy'); }
      catch (e) { throw new Error('Ghép đôi không được: ' + e.message + '\n(Máy đó phải cùng tài khoản Tailscale và đang chạy máy con AgentOS.)'); }
    } else out.push('✅ Đã trong Đội máy');
    let c;
    try { c = await connect(name); } catch (e) { out.push('⚠️ ' + e.message); return out.join('\n') + '\nXử lý xong gõ /ketnoi để thử lại.'; }
    out.push(c);
    if (!ready.has(String(name).toLowerCase())) return out.join('\n') + '\n⏭ Chưa cài ứng dụng vì chưa SSH vào được.';
    try { out.push(await provision(name)); } catch (e) { out.push('⚠️ ' + e.message); }
    return out.join('\n');
  }

  // Chép khóa rồi thử đăng nhập thật bằng khóa.
  async function connect(name) {
    const m = fleet.findMachine(name); if (!m) throw new Error('Không có máy "' + name + '".');
    const pub = await publicKey();
    let r;
    try { r = await fleet.installKey(name, pub); } catch (e) { throw new Error('Máy "' + name + '" không nhận khóa: ' + e.message); }
    const host = new URL(m.url).hostname, user = r && r.user;
    let out = '';
    if (r.warn) out += '⚠️ ' + r.warn + '\n';
    if (!user) return out + '⚠️ Máy đó nhận khóa nhưng không báo tên tài khoản để SSH.';
    const t = await run('ssh', ['-i', path.join(keyDir, 'id_ed25519'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(keyDir, 'known_hosts'), '-o', 'ConnectTimeout=10', user + '@' + host, 'echo agentos-ssh-ok']);
    if (t.ok && /agentos-ssh-ok/.test(t.out)) { ready.set(String(name).toLowerCase(), { user, host }); return out + '✅ SSH bằng khóa vào được: ' + user + '@' + host + (user === 'agentos-remote' ? ' (có sudo)' : ''); }
    return out + '⚠️ Đã chép khóa nhưng SSH chưa vào được: ' + ((t.err || t.msg || '').trim().split('\n').pop() || 'không rõ lý do') + '\n(Kiểm tra: dịch vụ OpenSSH Server đang chạy, tường lửa cổng 22 cho mạng Tailscale; máy Windows: chạy lại cai-dat-may-con.ps1.)';
  }

  const sshArgs = (r, cmd) => ['-i', path.join(keyDir, 'id_ed25519'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(keyDir, 'known_hosts'), '-o', 'ConnectTimeout=10', r.user + '@' + r.host, cmd];
  // Cài một ứng dụng: lệnh ngắn chạy thẳng; kịch bản dài ghi thành tệp (stdin, một dòng) rồi chạy -File
  async function installApp(r, a, timeout) {
    if (a.install) return run('ssh', sshArgs(r, a.install), { timeout });
    const w = await run('ssh', sshArgs(r, 'powershell -NoProfile -NonInteractive -Command -'), { input: RD_WRITE(a.script) + '\r\n', timeout: 60000 });
    if (!w.ok) return w;
    return run('ssh', sshArgs(r, RD_RUN), { timeout });
  }
  async function provision(name) {
    const r = ready.get(String(name).toLowerCase()); if (!r) throw new Error('Chưa đăng nhập SSH được vào "' + name + '": chạy /ketnoi ' + name + ' trước.');
    const plat = await platformOf(name), lines = [], list = APPS[plat]; let good = 0, rdId = '';
    for (const a of list) {
      let res = await run('ssh', sshArgs(r, a.check));
      if (res.ok && a.rustdesk) {                    // đã có RustDesk: vẫn cần ID + mật khẩu; chưa có thì chạy phần đặt mật khẩu của kịch bản
        rdId = await rustdeskCreds(name, r);
        if (!rdId && (a.install || a.script)) { const ins = await installApp(r, a, 300000); if (ins.ok) rdId = await rustdeskCreds(name, r); else lines.push('⚠️ ' + a.label + ': đã cài nhưng chưa đặt được mật khẩu/ID — ' + reason(ins)); }
      }
      if (res.ok) { good++; continue; }
      if (!a.install && !a.script) { lines.push('⚠️ ' + a.label + ': chưa có (' + (a.hint || 'cần cài tay') + ')'); continue; }
      res = await installApp(r, a, 600000);
      const again = res.ok ? await run('ssh', sshArgs(r, a.check)) : res;
      if (again.ok) { good++; lines.push('✅ ' + a.label + ': vừa cài'); if (a.rustdesk) rdId = await rustdeskCreds(name, r); } else lines.push('❌ ' + a.label + ': không cài được — ' + reason(res));
    }
    logf('ketnoi: ứng dụng trên ' + name + ': ' + good + '/' + list.length + ' sẵn sàng');
    return (good === list.length ? '✅' : '⚠️') + ' Ứng dụng: ' + good + '/' + list.length + ' sẵn sàng' + (lines.length ? '\n' + lines.join('\n') : '') + (rdId ? '\n🖥 RustDesk ID: ' + rdId + ' (mật khẩu đã lưu ở máy này)' : '');
  }

  // RustDesk trên máy Windows: script cài đặt đã đặt mật khẩu ngẫu nhiên và ghi rustdesk.json; máy này đọc qua SSH, lưu lại (0600) để mình tự vào được, không ai phải gõ gì.
  async function rustdeskCreds(name, r) {
    try {
      const q = await run('ssh', sshArgs(r, PS("Get-Content 'C:\\ProgramData\\AgentOS\\rustdesk.json' -Raw")));
      const j = q.ok ? JSON.parse(q.out.replace(/^\uFEFF/, '')) : null;
      if (!j || !/^\d{6,12}$/.test(String(j.id)) || !j.password) return '';
      if (credsFile) {
        let all = {}; try { all = JSON.parse(fs.readFileSync(credsFile, 'utf8')); } catch (e) { /* tệp mới */ }
        all[name] = { id: String(j.id), password: String(j.password), at: new Date().toISOString() };
        fs.writeFileSync(credsFile, JSON.stringify(all, null, 1), { mode: 0o600 });
      }
      return String(j.id);
    } catch (e) { return ''; }
  }

  return { request, scan, offerNew, discover, answer, connect, provision, setup, publicKey, pendingCount: () => pending.size, isCallback: (d) => ID_RE.test(String(d || '')) };
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
