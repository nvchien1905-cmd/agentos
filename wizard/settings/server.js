#!/usr/bin/env node
'use strict';
// CÀI ĐẶT AGENTOS: giao diện đồ họa để làm MỌI VIỆC thay cho gõ lệnh (cập nhật AgentOS và hệ điều hành, cài/gỡ ứng dụng, khóa API và đăng nhập AI,
// bot Telegram, Wi-Fi, OneDrive, Tailscale, dịch vụ, nhật ký, sao lưu, tắt/khởi động lại máy).
// Chạy bằng ROOT (dịch vụ agentos-settings), chỉ nghe 127.0.0.1:8089. Cửa sổ giao diện do Chrome mở (lệnh agentos-settings / biểu tượng "Cài đặt").
// AN TOÀN: máy chủ xác định NGƯỜI GỌI bằng uid của kết nối loopback (đọc /proc/net/tcp) và chỉ nhận người dùng thuộc nhóm sudo (chủ máy);
// tài khoản `agentos` (AI) và mọi người dùng khác bị từ chối. Thêm kiểm Host + tiêu đề X-AgentOS-Settings để chặn trang web lạ gọi vào.
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const nm = require('../lib/nm');
const tgLib = require('../lib/telegram');
const engines = require('../lib/engines');
const apikeys = require('../lib/apikeys');
const envfile = require('../lib/envfile');
const fullaccess = require('../lib/fullaccess');
const { createTailscale } = require('../../orchestrator/src/tailscale');
const { createUpdater } = require('../../update/updater');
const { createSummarizer } = require('../../orchestrator/src/summarizer');
const { createBook } = require('../../orchestrator/src/book');

const PORT = 8089;
const SERVICES = { orchestrator: 'agentos-orchestrator', deskd: 'agentos-deskd', onedrive: 'onedrive-agentos', tailscale: 'tailscaled', cups: 'cups', network: 'NetworkManager', capnhat: 'agentos-update.path', saoluu: 'agentos-sao-luu.timer' };
const RESTARTABLE = ['orchestrator', 'deskd', 'onedrive', 'tailscale', 'cups', 'network'];
const PKG_RE = /^[a-z0-9][a-z0-9+.-]{1,80}$/;
const SECRET_LINE = /(sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|\b\d{8,}:[A-Za-z0-9_-]{30,}|-----BEGIN|(mật khẩu|mat khau|password|passwd|token|secret|api[ _-]?key)[^\n]{0,25}?(?::|=|(?:\s|^)là(?=\s|$)))/i;

// Ứng dụng gợi ý (gói trong kho Debian chính thức)
const CATALOG = [
  { id: 'vlc', name: 'VLC - xem phim, nghe nhạc', pkgs: ['vlc'] },
  { id: 'gimp', name: 'GIMP - chỉnh sửa ảnh', pkgs: ['gimp'] },
  { id: 'inkscape', name: 'Inkscape - vẽ đồ họa vector', pkgs: ['inkscape'] },
  { id: 'audacity', name: 'Audacity - thu và sửa âm thanh', pkgs: ['audacity'] },
  { id: 'obs', name: 'OBS Studio - quay/phát màn hình', pkgs: ['obs-studio'] },
  { id: 'kdenlive', name: 'Kdenlive - dựng video', pkgs: ['kdenlive'] },
  { id: 'thunderbird', name: 'Thunderbird - thư điện tử', pkgs: ['thunderbird'] },
  { id: 'firefox', name: 'Firefox', pkgs: ['firefox-esr'] },
  { id: 'telegram', name: 'Telegram Desktop', pkgs: ['telegram-desktop'] },
  { id: 'filezilla', name: 'FileZilla - truyền tệp FTP', pkgs: ['filezilla'] },
  { id: 'remmina', name: 'Remmina - điều khiển máy tính từ xa (RDP/VNC)', pkgs: ['remmina', 'remmina-plugin-rdp', 'remmina-plugin-vnc'] },
  { id: 'evince', name: 'Evince - đọc PDF', pkgs: ['evince'] },
  { id: 'simplescan', name: 'Simple Scan - quét tài liệu', pkgs: ['simple-scan'] },
  { id: 'impress', name: 'LibreOffice Impress - trình chiếu', pkgs: ['libreoffice-impress'] },
  { id: 'draw', name: 'LibreOffice Draw/Base', pkgs: ['libreoffice-draw', 'libreoffice-base'] },
  { id: 'vscode-oss', name: 'Geany - soạn thảo mã nguồn', pkgs: ['geany'] },
];

const defaultRun = (cmd, args, o) => new Promise((resolve) => {
  cp.execFile(cmd, args, Object.assign({ timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, o || {}), (err, out, errOut) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(errOut || ''), missing: !!(err && err.code === 'ENOENT') }));
});
const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(b); };
const human = (b) => (b > 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b > 1048576 ? Math.round(b / 1048576) + ' MB' : Math.round(b / 1024) + ' KB');

// uid của tiến trình đang kết nối tới ta qua loopback (đọc bảng socket của nhân)
function peerUid(socket, procFile) {
  try {
    const hex = Number(socket.remotePort).toString(16).toUpperCase().padStart(4, '0');
    const lines = fs.readFileSync(procFile || '/proc/net/tcp', 'utf8').split('\n').slice(1);
    for (const l of lines) {
      const f = l.trim().split(/\s+/);
      if (f.length > 7 && f[1] === '0100007F:' + hex) return Number(f[7]);
    }
  } catch (e) { /* không đọc được */ }
  return null;
}
// uid được phép: root + thành viên nhóm sudo (chủ máy), KHÔNG gồm `agentos`
function sudoUids(groupFile, passwdFile) {
  const set = new Set([0]);
  try {
    const g = fs.readFileSync(groupFile || '/etc/group', 'utf8').split('\n').find((l) => l.startsWith('sudo:'));
    const members = g ? g.split(':')[3].split(',').filter(Boolean) : [];
    for (const l of fs.readFileSync(passwdFile || '/etc/passwd', 'utf8').split('\n')) {
      const p = l.split(':');
      if (p.length > 2 && members.includes(p[0]) && p[0] !== 'agentos') set.add(Number(p[2]));
    }
  } catch (e) { /* bỏ qua */ }
  return set;
}

function createSettings(o) {
  o = Object.assign({
    port: PORT, host: '127.0.0.1', envFile: '/etc/agentos/orchestrator.env', versionFile: '/opt/agentos/VERSION', backupDir: '/srv/onedrive/AgentOS/sao-luu',
    onedriveConf: '/var/lib/agentos/.config/onedrive', onedriveDir: '/srv/onedrive', fullAccessPaths: undefined,
  }, o || {});
  const run = o.run || defaultRun;
  const spawn = o.spawn || cp.spawn;
  const pageFile = o.pageFile || path.join(__dirname, 'index.html');
  const allowedUids = o.allowedUids || (() => sudoUids());
  const getPeerUid = o.peerUid || ((s) => peerUid(s));
  const fetchImpl = o.fetch || fetch;
  const ts = createTailscale({ run: o.tsRun, spawn: o.tsSpawn, waitMs: o.tsWaitMs });
  const updater = o.updater || createUpdater({ url: o.updateUrl || undefined, log() {} });
  const userName = (uid) => { try { const l = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((x) => Number(x.split(':')[2]) === uid && x.split(':').length > 2); return l ? l.split(':')[0] : null; } catch (e) { return null; } };

  // ---------- công việc chạy nền (có nhật ký) ----------
  const jobs = new Map(); let jobSeq = 0;
  function startJob(title, steps, opts) {
    const id = String(++jobSeq);
    const job = { id, title, status: 'running', lines: [], code: null, started: Date.now() };
    jobs.set(id, job);
    for (const old of [...jobs.keys()].slice(0, Math.max(0, jobs.size - 20))) jobs.delete(old);
    const push = (s) => { for (const line of String(s).split(/\r?\n/)) if (line.trim()) { job.lines.push(line.slice(0, 400)); if (job.lines.length > 3000) job.lines.shift(); } };
    (async () => {
      for (const [cmd, args] of steps) {
        push('$ ' + [cmd].concat(args).join(' '));
        const code = await new Promise((resolve) => {
          let c;
          try { c = spawn(cmd, args, { env: Object.assign({}, process.env, { DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C.UTF-8' }, (opts && opts.env) || {}), stdio: ['ignore', 'pipe', 'pipe'] }); }
          catch (e) { push('LỖI: ' + e.message); return resolve(127); }
          if (c.stdout) c.stdout.on('data', push); if (c.stderr) c.stderr.on('data', push);
          c.on('error', (e) => { push('LỖI: ' + e.message); resolve(127); });
          c.on('close', (k) => resolve(k === null ? 1 : k));
        });
        job.code = code;
        if (code !== 0 && !(opts && opts.keepGoing)) { job.status = 'error'; push('✗ Lệnh trả mã ' + code); return; }
      }
      job.status = 'done'; push('✓ Xong');
    })().catch((e) => { job.status = 'error'; push('LỖI: ' + e.message); });
    return id;
  }
  const busy = () => [...jobs.values()].some((j) => j.status === 'running');

  // ---------- tệp cấu hình ----------
  const readEnv = () => { try { return fs.readFileSync(o.envFile, 'utf8'); } catch (e) { return null; } };
  const envVal = (text, key) => { const m = String(text || '').match(new RegExp('^' + key + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
  function setEnvLine(text, key, value) {
    if (/[\r\n\0]/.test(String(value))) throw new Error('Giá trị chứa ký tự không hợp lệ');
    const lines = String(text || '').split('\n');
    const i = lines.findIndex((l) => l.startsWith(key + '='));
    if (value === null) { if (i >= 0) lines.splice(i, 1); }
    else if (i >= 0) lines[i] = key + '=' + value;
    else { if (lines.length && lines[lines.length - 1] === '') lines.pop(); lines.push(key + '=' + value, ''); }
    return lines.join('\n');
  }
  const saveEnv = (text) => envfile.writeSecure(o.envFile, text);
  const needEnv = () => { const t = readEnv(); if (t == null) throw new Error('Máy chưa cấu hình xong. Hoàn tất trình hướng dẫn lần đầu (Telegram + AI) trước.'); return t; };
  const restart = (unit) => run('systemctl', ['restart', unit + '.service']);

  const isActive = async (unit) => (await run('systemctl', ['is-active', unit])).out.trim() || 'unknown';

  // ---------- OneDrive (chạy bằng người dùng agentos) ----------
  let odChild = null;
  const odUrlFile = () => path.join(o.onedriveConf, 'auth-url.txt'), odRespFile = () => path.join(o.onedriveConf, 'auth-response.txt'), odToken = () => path.join(o.onedriveConf, 'refresh_token');
  const bookOf = () => createBook({ dir: o.onedriveDir, fallbackDir: o.memFallback || '/var/lib/agentos/data/so-tay' });
  const chownTree = (p) => { chownAgentos(p); try { if (fs.statSync(p).isDirectory()) for (const n of fs.readdirSync(p)) chownTree(path.join(p, n)); } catch (e) { /* bỏ qua */ } };
  const asAgentos = (cmd, args) => ['runuser', ['-u', 'agentos', '--', cmd, ...args]];
  function odStop() { if (odChild) { try { odChild.kill('SIGTERM'); } catch (e) { /* đã thoát */ } odChild = null; } fs.rmSync(odUrlFile(), { force: true }); fs.rmSync(odRespFile(), { force: true }); }
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const chownAgentos = (p) => { try { const l = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((x) => x.startsWith('agentos:')).split(':'); fs.chownSync(p, Number(l[2]), Number(l[3])); } catch (e) { /* máy thử */ } };

  // ---------- xử lý yêu cầu ----------
  const A = {
    async 'GET /api/overview'() {
      const stats = (() => { try { const s = fs.statfsSync('/'); return { freeMb: Math.floor((s.bavail * s.bsize) / 1048576), totalMb: Math.floor((s.blocks * s.bsize) / 1048576) }; } catch (e) { return { freeMb: null, totalMb: null }; } })();
      const services = {};
      for (const [k, u] of Object.entries(SERVICES)) services[k] = await isActive(u);
      let version = '?'; try { version = fs.readFileSync(o.versionFile, 'utf8').trim(); } catch (e) { /* chưa có */ }
      const reboot = fs.existsSync('/var/run/reboot-required');
      return { version, host: require('os').hostname(), uptimeSec: Math.floor(require('os').uptime()), disk: stats, services, rebootRequired: reboot, configured: readEnv() != null, busy: busy(),
        ips: Object.values(require('os').networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address) };
    },

    // ----- Cập nhật -----
    async 'POST /api/updates/agentos/check'() { try { return await updater.check(); } catch (e) { throw new Error(e.message); } },
    async 'POST /api/updates/agentos/apply'() {
      if (busy()) throw new Error('Đang có một công việc khác chạy, đợi xong rồi thử lại.');
      return { job: startJob('Cập nhật AgentOS', [['/usr/local/bin/agentos-update', ['apply']]]) };
    },
    async 'POST /api/updates/os/check'() {
      const r = await run('apt-get', ['update'], { timeout: 180000 });
      if (r.code !== 0) throw new Error('Không tải được danh sách cập nhật (kiểm tra mạng): ' + (r.err || r.out).trim().slice(-160));
      const s = await run('apt-get', ['-s', 'dist-upgrade'], { timeout: 120000 });
      const inst = s.out.split('\n').filter((l) => l.startsWith('Inst ')).map((l) => l.split(' ')[1]);
      return { upgradable: inst.length, packages: inst.slice(0, 40), rebootRequired: fs.existsSync('/var/run/reboot-required') };
    },
    async 'POST /api/updates/os/upgrade'() {
      if (busy()) throw new Error('Đang có một công việc khác chạy, đợi xong rồi thử lại.');
      const dpkgOpts = ['-o', 'Dpkg::Options::=--force-confold', '-o', 'Dpkg::Options::=--force-confdef'];
      return { job: startJob('Cập nhật hệ điều hành (Debian)', [['apt-get', ['update']], ['apt-get', ['-y', ...dpkgOpts, 'dist-upgrade']], ['apt-get', ['-y', 'autoremove']]]) };
    },
    // Sau khi cập nhật AgentOS: tự thoát để systemd (Restart=always) chạy lại bằng mã mới. Chỉ khi không có công việc nền nào đang chạy.
    async 'POST /api/self-restart'() {
      if (busy()) throw new Error('Đang có công việc chạy, thử lại sau khi xong.');
      setTimeout(() => (o.exit || process.exit)(0), 600);
      return { ok: true };
    },
    async 'POST /api/power'(b) {
      if (b.confirm !== true) throw new Error('Cần xác nhận');
      if (b.action !== 'reboot' && b.action !== 'poweroff') throw new Error('Thao tác không hợp lệ');
      setTimeout(() => { run('systemctl', [b.action]); }, 2000);
      return { ok: true, after: 2 };
    },

    // ----- Ứng dụng -----
    async 'GET /api/apps'() {
      const all = [...new Set(CATALOG.flatMap((a) => a.pkgs))];
      const r = await run('dpkg-query', ['-W', '-f=${Package} ${db:Status-Abbrev}\\n', ...all]);
      const installed = new Set(r.out.split('\n').filter((l) => /\sii\s*$/.test(l)).map((l) => l.split(' ')[0]));
      return { apps: CATALOG.map((a) => ({ id: a.id, name: a.name, installed: a.pkgs.every((p) => installed.has(p)) })) };
    },
    async 'POST /api/apps/install'(b) { return appJob('install', b); },
    async 'POST /api/apps/remove'(b) { return appJob('remove', b); },

    // ----- AI & khóa API -----
    async 'GET /api/ai'() {
      const text = readEnv() || '';
      const keys = apikeys.keysFrom(Object.fromEntries(Object.values(apikeys.VAR).map((v) => [v, envVal(text, v)])));
      const order = envVal(text, 'ENGINE_ORDER').split(',').map((s) => s.trim()).filter(Boolean);
      const out = [];
      for (const e of apikeys.ENGINES) {
        const ver = await engines.installed(run, e).catch(() => null);
        out.push({ id: e, name: apikeys.NAMES[e], where: apikeys.WHERE[e], key: keys[e] ? apikeys.mask(keys[e]) : null, installed: ver, enabled: order.includes(e) });
      }
      return { engines: out, order, configured: readEnv() != null };
    },
    async 'POST /api/ai/key'(b) {
      const eng = String(b.engine), key = String(b.key || '').trim();
      if (!apikeys.ENGINES.includes(eng)) throw new Error('AI không biết');
      const text = needEnv();
      const r = await apikeys.check(eng, key, fetchImpl);
      if (!r.ok) throw new Error(r.detail);
      if (eng === 'gemini') engines.prepareGemini({ authType: 'gemini-api-key' });
      saveEnv(apikeys.applyToEnv(text, eng, key));
      const need = !(await engines.installed(run, eng).catch(() => null));
      let job = null;
      if (need) job = startJob('Cài ' + (eng === 'deepseekapi' ? 'Claude Code' : apikeys.NAMES[eng]), [['runuser', ['-u', 'agentos', '--', 'env', 'HOME=' + engines.HOME, 'PATH=' + engines.PREFIX + '/bin:/usr/bin:/bin', 'npm', 'install', '-g', '--prefix', engines.PREFIX, '--no-audit', '--no-fund', engines.PACKAGES[eng]]]]);
      await restart('agentos-orchestrator');
      return { saved: true, detail: r.detail, masked: apikeys.mask(key), job };
    },
    async 'POST /api/ai/key/clear'(b) {
      const eng = String(b.engine);
      if (!apikeys.ENGINES.includes(eng)) throw new Error('AI không biết');
      if (eng === 'gemini') engines.prepareGemini();
      saveEnv(apikeys.applyToEnv(needEnv(), eng, null));
      await restart('agentos-orchestrator');
      return { cleared: true };
    },
    async 'POST /api/ai/install'(b) {
      const eng = String(b.engine);
      if (!engines.PACKAGES[eng]) throw new Error('AI không biết');
      return { job: startJob('Cài ' + apikeys.NAMES[eng], [['runuser', ['-u', 'agentos', '--', 'env', 'HOME=' + engines.HOME, 'PATH=' + engines.PREFIX + '/bin:/usr/bin:/bin', 'npm', 'install', '-g', '--prefix', engines.PREFIX, '--no-audit', '--no-fund', engines.PACKAGES[eng]]]]) };
    },
    async 'POST /api/ai/login'(b, ctx) {
      const eng = String(b.engine);
      if (!['claude', 'codex', 'gemini'].includes(eng)) throw new Error('AI này dùng khóa API, không đăng nhập tài khoản');
      const user = userName(ctx.uid) || 'user';
      const home = user === 'root' ? '/root' : '/home/' + user;
      await run('runuser', ['-u', user, '--', 'env', 'DISPLAY=:0', 'XAUTHORITY=' + home + '/.Xauthority', 'sh', '-c', 'setsid nohup xfce4-terminal --title="Đăng nhập ' + eng + '" -x /usr/local/bin/agentos-ai ' + eng + ' >/dev/null 2>&1 &']);
      return { opened: true, hint: 'Cửa sổ dòng lệnh đã mở trên màn hình. Làm theo hướng dẫn trong đó để đăng nhập, xong thì đóng cửa sổ.' };
    },
    async 'POST /api/ai/order'(b) {
      const order = (Array.isArray(b.order) ? b.order : []).map(String).filter((e) => apikeys.ENGINES.includes(e));
      if (!order.length) throw new Error('Cần ít nhất một AI');
      if (new Set(order).size !== order.length) throw new Error('AI bị lặp');
      saveEnv(setEnvLine(needEnv(), 'ENGINE_ORDER', order.join(',')));
      await restart('agentos-orchestrator');
      return { order };
    },

    // ----- Bot Telegram -----
    async 'GET /api/bot'() {
      const t = readEnv();
      if (t == null) return { configured: false };
      const token = envVal(t, 'TELEGRAM_TOKEN');
      let bot = null; try { bot = token ? await tgLib.getMe(token, { fetch: fetchImpl }) : null; } catch (e) { bot = null; }
      return { configured: true, token: token ? apikeys.mask(token) : null, bot: bot ? { username: bot.username, name: bot.first_name } : null, owners: envVal(t, 'ALLOWED_USER_IDS').split(',').filter(Boolean), admins: envVal(t, 'ADMIN_USER_IDS').split(',').filter(Boolean),
        fullAccessEnabled: fullaccess.isEnabled(o.fullAccessPaths), fullAccessEnv: envVal(t, 'FULL_ACCESS') === '1', service: await isActive('agentos-orchestrator') };
    },
    async 'POST /api/bot/token'(b) {
      const token = String(b.token || '').trim();
      if (!tgLib.TOKEN_RE.test(token)) throw new Error('Token không đúng dạng (123456789:ABC...). Lấy ở @BotFather.');
      const bot = await tgLib.getMe(token, { fetch: fetchImpl });
      saveEnv(setEnvLine(needEnv(), 'TELEGRAM_TOKEN', token));
      await restart('agentos-orchestrator');
      return { bot: { username: bot.username }, masked: apikeys.mask(token) };
    },
    async 'POST /api/bot/owner'(b) {
      const ids = String(b.ids || '').split(/[,\s]+/).filter(Boolean);
      if (!ids.length || !ids.every((x) => /^\d+$/.test(x))) throw new Error('ID Telegram phải là số (nhắn /id cho bot để biết). Nhiều ID ngăn cách bằng dấu phẩy.');
      let t = setEnvLine(needEnv(), 'ALLOWED_USER_IDS', ids.join(','));
      t = setEnvLine(t, 'ADMIN_USER_IDS', ids.join(','));
      saveEnv(t); await restart('agentos-orchestrator');
      return { owners: ids };
    },
    async 'POST /api/bot/mode'(b) {
      const on = b.full === true;
      let t = needEnv();
      if (on) { await fullaccess.enable(run, o.fullAccessPaths); } else if (fullaccess.isEnabled(o.fullAccessPaths)) { await fullaccess.disable(run, o.fullAccessPaths); }
      t = setEnvLine(t, 'FULL_ACCESS', on ? '1' : '0'); t = setEnvLine(t, 'JOB_TIMEOUT_SEC', on ? '3600' : '900');
      saveEnv(t); await restart('agentos-orchestrator');
      return { full: on };
    },

    // ----- Bộ nhớ dùng chung cho mọi AI, nén ngữ cảnh, định tuyến theo độ khó -----
    async 'GET /api/memory'() {
      const text = readEnv() || '';
      const keys = apikeys.keysFrom(Object.fromEntries(Object.values(apikeys.VAR).map((v) => [v, envVal(text, v)])));
      const bk = bookOf();
      const chapters = bk.list().map((c) => ({ slug: c.slug, title: c.title, summary: c.summary, entries: c.entries.length, updated: c.updated, text: fs.readFileSync(bk.fileOf(c.slug), 'utf8') }));
      let inbox = ''; try { inbox = fs.readFileSync(bk.inboxFile(), 'utf8'); } catch (e) { /* chưa có */ }
      const flag = (k, d) => { const v = envVal(text, k); return v === '' ? d : v.toLowerCase() !== 'false'; };
      return { root: bk.root(), chapters, inbox, configured: readEnv() != null, summarizer: { gemini: !!keys.gemini, deepseek: !!keys.deepseekapi }, config: {
        enabled: flag('MEMORY_ENABLED', true), route: flag('ROUTE_BY_DIFFICULTY', true), provider: envVal(text, 'SUMMARY_PROVIDER') || 'auto', rotateAfter: Number(envVal(text, 'MEMORY_ROTATE_AFTER')) || 25 } };
    },
    // Sửa trực tiếp một chương (người đọc/chỉnh sổ tay): giữ định dạng, gán mã cho dòng mới, chặn dòng giống bí mật.
    async 'POST /api/memory/chapter'(b) {
      const text = String(b.text == null ? '' : b.text);
      if (text.length > 20000) throw new Error('Chương quá dài (tối đa 20.000 ký tự). Hãy tách nhỏ.');
      const bad = text.split('\n').find((l) => SECRET_LINE.test(l));
      if (bad) throw new Error('Có dòng giống mật khẩu/khóa/token nên không lưu (sổ tay được gửi cho hãng AI): ' + bad.slice(0, 60));
      const bk = bookOf();
      const title = (text.match(/^#\s+(.+)$/m) || [])[1];
      if (!title) throw new Error('Dòng đầu mỗi chương phải là "# Tên chương".');
      const slug = b.slug ? String(b.slug).replace(/[^a-z0-9-]/g, '') : bk.slugOf(title);
      if (!slug) throw new Error('Tên chương không hợp lệ');
      const ch = bk.parse(slug, text); ch.slug = slug;
      bk.save(ch); chownTree(bk.root());
      return { saved: true, slug, entries: ch.entries.length };
    },
    async 'POST /api/memory/chapter/delete'(b) {
      if (b.confirm !== true) throw new Error('Cần xác nhận');
      const bk = bookOf(), slug = String(b.slug || '').replace(/[^a-z0-9-]/g, '');
      const f = bk.fileOf(slug);
      if (!slug || !fs.existsSync(f)) throw new Error('Không có chương này');
      const dir = path.join(bk.root(), '.lichsu'); fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(f, path.join(dir, slug + '.da-xoa-' + new Date().toISOString().slice(0, 10) + '.md'));
      fs.rmSync(f); bk.save({ slug: '__toc__', title: '', summary: '', updated: '', entries: [] }); fs.rmSync(bk.fileOf('__toc__'), { force: true });
      chownTree(bk.root());
      return { deleted: true };
    },
    async 'POST /api/memory/note'(b) {
      const bk = bookOf();
      const r = await bk.addNote(String(b.text || ''));
      if (!r.ok) throw new Error(r.error);
      chownTree(bk.root());
      return { chapter: r.chapter, replaced: r.replaced || 0, duplicate: !!r.duplicate };
    },
    // Thử gọi mô hình nén bằng khóa đã lưu (một câu ngắn, tốn không đáng kể): cho chủ máy biết khóa Gemini/DeepSeek dùng được chưa.
    async 'POST /api/memory/test'() {
      const text = readEnv() || '';
      const keys = apikeys.keysFrom(Object.fromEntries(Object.values(apikeys.VAR).map((v) => [v, envVal(text, v)])));
      let err = '';
      const s = createSummarizer({ keys, provider: envVal(text, 'SUMMARY_PROVIDER') || 'auto', fetch: fetchImpl, log: (m) => { err = m; } });
      if (!s.available()) throw new Error('Chưa có khóa Gemini hoặc DeepSeek (hoặc nguồn nén đang đặt là "Không"). Thêm khóa ở mục “AI và khóa API”.');
      const r = await s.run('Tóm tắt trong một câu tiếng Việt.', 'Chủ máy hỏi giá nồi chiên không dầu, trợ lý trả lời khoảng 2,9 triệu, chủ máy quyết định mua 2 cái cho cửa hàng.');
      if (!r) throw new Error('Gọi mô hình nén thất bại' + (err ? ' (' + err + ')' : '') + '. Kiểm tra khóa và mạng.');
      return { via: r.via, text: r.text.slice(0, 400) };
    },
    async 'POST /api/memory/config'(b) {
      let t = needEnv();
      if (typeof b.enabled === 'boolean') t = setEnvLine(t, 'MEMORY_ENABLED', String(b.enabled));
      if (typeof b.route === 'boolean') t = setEnvLine(t, 'ROUTE_BY_DIFFICULTY', String(b.route));
      if (b.provider !== undefined) { if (!['auto', 'gemini', 'deepseek', 'none'].includes(b.provider)) throw new Error('Nguồn nén không hợp lệ'); t = setEnvLine(t, 'SUMMARY_PROVIDER', b.provider); }
      if (b.rotateAfter !== undefined) { const n = Number(b.rotateAfter); if (!(n >= 5 && n <= 200)) throw new Error('Số lượt mỗi phiên phải từ 5 đến 200'); t = setEnvLine(t, 'MEMORY_ROTATE_AFTER', String(Math.round(n))); }
      saveEnv(t); await restart('agentos-orchestrator');
      return { saved: true };
    },

    // ----- Mạng -----
    async 'GET /api/net'() { return { status: await nm.status(run), ips: Object.values(require('os').networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address) }; },
    async 'POST /api/net/scan'() { return { networks: await nm.scan(run) }; },
    async 'POST /api/net/connect'(b) { await nm.connect(run, String(b.ssid || ''), b.password == null ? null : String(b.password)); return { status: await nm.status(run) }; },

    // ----- OneDrive -----
    async 'GET /api/onedrive'() {
      const connected = fs.existsSync(odToken());
      let files = null; try { files = fs.readdirSync(o.onedriveDir).filter((n) => !n.startsWith('.')).length; } catch (e) { /* chưa có */ }
      return { connected, service: await isActive('onedrive-agentos'), dir: o.onedriveDir, entries: files, authPending: !!odChild };
    },
    async 'POST /api/onedrive/start'() {
      odStop();
      fs.mkdirSync(o.onedriveConf, { recursive: true }); chownAgentos(o.onedriveConf);
      const [cmd, args] = asAgentos('onedrive', ['--confdir', o.onedriveConf, '--auth-files', odUrlFile() + ':' + odRespFile()]);
      odChild = spawn(cmd, args, { stdio: 'ignore' });
      odChild.on('error', () => {}); odChild.on('exit', () => { odChild = null; });
      for (let i = 0; i < 50; i++) { if (fs.existsSync(odUrlFile()) && fs.statSync(odUrlFile()).size > 20) return { url: fs.readFileSync(odUrlFile(), 'utf8').trim() }; await sleep(o.odPollMs || 500); }
      odStop(); throw new Error('Không lấy được đường dẫn đăng nhập (kiểm tra mạng).');
    },
    async 'POST /api/onedrive/finish'(b) {
      const u = String(b.response || '').trim();
      if (!/^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/nativeclient\?/.test(u) || !/[?&]code=/.test(u)) throw new Error('Đó không phải địa chỉ đăng nhập OneDrive. Sau khi đăng nhập Microsoft, trình duyệt hiện trang trắng: copy TOÀN BỘ địa chỉ trên thanh địa chỉ và dán vào đây.');
      if (!odChild) throw new Error('Chưa bắt đầu kết nối (hoặc đã quá lâu). Bấm "Kết nối OneDrive" để lấy đường dẫn mới.');
      fs.writeFileSync(odRespFile(), u + '\n', { mode: 0o644 }); chownAgentos(odRespFile());
      for (let i = 0; i < 180; i++) { if (fs.existsSync(odToken())) break; await sleep(o.odPollMs || 500); }
      const ok = fs.existsSync(odToken()); await sleep(o.odSettleMs === undefined ? 3000 : o.odSettleMs); odStop();
      if (!ok) throw new Error('Microsoft không chấp nhận mã (chỉ dùng được một lần, hết hạn sau vài phút). Bấm kết nối lại.');
      await run('systemctl', ['start', 'onedrive-agentos.service']);
      return { connected: true };
    },
    async 'POST /api/onedrive/sync'() { const r = await run('pkill', ['-USR1', '-x', 'onedrive']); if (r.code !== 0) throw new Error('Dịch vụ đồng bộ không chạy'); return { ok: true }; },
    async 'POST /api/onedrive/disconnect'(b) {
      if (b.confirm !== true) throw new Error('Cần xác nhận');
      odStop(); await run('pkill', ['-TERM', '-x', 'onedrive']); fs.rmSync(odToken(), { force: true }); return { connected: false };
    },

    // ----- Tailscale -----
    async 'GET /api/tailscale'() { const i = await ts.info(); return i; },
    async 'POST /api/tailscale/connect'() { const r = await ts.connect(); if (!r.ok) throw new Error(r.error); return r; },
    async 'POST /api/tailscale/disconnect'(b) { if (b.confirm !== true) throw new Error('Cần xác nhận'); const r = await ts.disconnect(); if (r.code !== 0) throw new Error((r.err || r.out).trim().slice(0, 150)); return { ok: true }; },

    // ----- Dịch vụ, nhật ký, sao lưu -----
    async 'GET /api/services'() { const out = {}; for (const [k, u] of Object.entries(SERVICES)) out[k] = await isActive(u); return { services: out, restartable: RESTARTABLE }; },
    async 'POST /api/services/restart'(b) {
      const name = String(b.name);
      if (!RESTARTABLE.includes(name)) throw new Error('Dịch vụ không được phép khởi động lại từ đây');
      const r = await restart(SERVICES[name]); if (r.code !== 0) throw new Error(r.err.trim().slice(0, 150));
      return { state: await isActive(SERVICES[name]) };
    },
    async 'GET /api/logs'(b, ctx) {
      const unit = ctx.query.get('unit') || 'orchestrator';
      if (!SERVICES[unit]) throw new Error('Dịch vụ không biết');
      const n = Math.min(300, Math.max(10, Number(ctx.query.get('lines')) || 100));
      const r = await run('journalctl', ['-u', SERVICES[unit], '-n', String(n), '--no-pager', '-o', 'short-iso']);
      return { text: r.out.replace(/(token|secret|key|password)[=: ]+\S+/gi, '$1=***') };
    },
    async 'GET /api/backup'() {
      let files = []; try { files = fs.readdirSync(o.backupDir).filter((f) => /^agentos-.*\.tar\.gz$/.test(f)).sort().reverse().map((f) => ({ name: f, size: human(fs.statSync(path.join(o.backupDir, f)).size) })); } catch (e) { /* chưa có */ }
      return { dir: o.backupDir, files: files.slice(0, 14), timer: await isActive('agentos-sao-luu.timer') };
    },
    async 'POST /api/backup/run'() { if (busy()) throw new Error('Đang có công việc khác chạy.'); return { job: startJob('Sao lưu ngay', [['systemctl', ['start', 'agentos-sao-luu.service']]]) }; },
  };

  async function appJob(kind, b) {
    let pkgs;
    if (b.id) { const app = CATALOG.find((a) => a.id === b.id); if (!app) throw new Error('Ứng dụng không biết'); pkgs = app.pkgs; }
    else { const p = String(b.package || '').trim().toLowerCase(); if (!PKG_RE.test(p)) throw new Error('Tên gói không hợp lệ (chữ thường, số, - + .)'); pkgs = [p]; }
    if (busy()) throw new Error('Đang có một công việc khác chạy, đợi xong rồi thử lại.');
    const steps = kind === 'install' ? [['apt-get', ['update']], ['apt-get', ['install', '-y', '--no-install-recommends', ...pkgs]]] : [['apt-get', ['remove', '-y', ...pkgs]], ['apt-get', ['-y', 'autoremove']]];
    return { job: startJob((kind === 'install' ? 'Cài ' : 'Gỡ ') + pkgs.join(', '), steps) };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const host = String(req.headers.host || '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') return json(res, 403, { error: 'Chỉ truy cập từ máy này' });
      const uid = getPeerUid(req.socket);
      if (uid === null || !allowedUids().has(uid)) return json(res, 403, { error: 'Chỉ chủ máy (tài khoản quản trị) được mở Cài đặt.' });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { const b = fs.readFileSync(pageFile); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(b); }
      if (req.method === 'POST' && req.headers['x-agentos-settings'] !== '1') return json(res, 403, { error: 'Thiếu tiêu đề bảo vệ' });
      const jm = url.pathname.match(/^\/api\/jobs\/(\d+)$/);
      if (req.method === 'GET' && jm) {
        const j = jobs.get(jm[1]); if (!j) return json(res, 404, { error: 'Không có công việc này' });
        const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
        return json(res, 200, { id: j.id, title: j.title, status: j.status, code: j.code, lines: j.lines.slice(from), next: j.lines.length });
      }
      const handler = A[req.method + ' ' + url.pathname];
      if (!handler) return json(res, 404, { error: 'Không có' });
      let body = {};
      if (req.method === 'POST') {
        const chunks = []; let n = 0;
        for await (const c of req) { n += c.length; if (n > 64 * 1024) return json(res, 413, { error: 'Dữ liệu quá lớn' }); chunks.push(c); }
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch (e) { return json(res, 400, { error: 'JSON không hợp lệ' }); }
      }
      json(res, 200, await handler(body, { uid, query: url.searchParams }));
    } catch (e) { json(res, 400, { error: e.message || String(e) }); }
  });

  return {
    server, jobs,
    listen() { return new Promise((resolve) => server.listen(o.port, o.host, () => resolve(server.address().port))); },
    close() { odStop(); return new Promise((r) => server.close(r)); },
  };
}

module.exports = { createSettings, peerUid, sudoUids, CATALOG, SERVICES };

if (require.main === module) {
  const s = createSettings({});
  s.listen().then((p) => console.log('Cài đặt AgentOS nghe ở 127.0.0.1:' + p));
  const stop = () => s.close().then(() => process.exit(0)); process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
