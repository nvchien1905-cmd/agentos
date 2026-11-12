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
const kvLib = require('../lib/kiotviet');
const { createVault } = require('../../orchestrator/src/vault');
const envfile = require('../lib/envfile');
const fullaccess = require('../lib/fullaccess');
const odauth = require('../lib/odauth');
const synclist = require('../lib/synclist');
const { createProjects } = require('../../orchestrator/src/projects');
const { mergeProjects } = require('../../orchestrator/src/projectMerge');
const { createMachineAccess } = require('../../orchestrator/src/machineAccess');
const { createBackup } = require('../../orchestrator/src/backup');
const { createUsage } = require('../../orchestrator/src/usage');
const { createAuditLog } = require('../../orchestrator/src/auditlog');
const { ACTIONS: CONTROL_ACTIONS } = require('../../orchestrator/src/control');
const { createFleet } = require('../../orchestrator/src/fleet');
const { createLogin } = require('../lib/login');
const qrLib = require('../lib/qr');
const { createDevices } = require('../../orchestrator/src/devices');
const mask = require('../lib/mask');
const { createTailscale } = require('../../orchestrator/src/tailscale');
const { createUpdater } = require('../../update/updater');
const { createSummarizer } = require('../../orchestrator/src/summarizer');
const { createBook } = require('../../orchestrator/src/book');
const { createSessions } = require('../../orchestrator/src/sessions');
const { createWatch } = require('../lib/watch');
const { createConnectors } = require('../../orchestrator/src/connectors');
const { createPlugins } = require('../../orchestrator/src/plugins');
const { createGoogleAuth } = require('../../orchestrator/src/googleAuth');
const { createSkillLayers } = require('../../orchestrator/src/skillLayers');
const { collect: hwCollect, evaluate: hwEvaluate } = require('../../orchestrator/src/hwcheck');
let hwCache = null;

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
  const cloudBin = o.cloudBin || '/usr/local/sbin/agentos-cloud';
  const backupBin = o.backupBin || '/usr/local/sbin/agentos-backup';
  const diskBackup = createBackup(o.backupFiles || {});
  let phoneLoginInst = null; const phoneLogin = () => phoneLoginInst || (phoneLoginInst = o.login || createLogin());
  // QR của link đăng nhập (nếu máy có qrencode); không có thì thôi, vẫn có link + nút gửi Telegram
  const loginView = async (v) => { v = await v; if (v && v.url && v.status === 'running') { try { v.qr = await (o.qrSvg ? o.qrSvg(v.url) : qrLib.svg(run, v.url)); } catch (e) { v.qr = null; } } return v; };
  let devicesInst = null; const devicesFile = o.devicesFile || '/var/lib/agentos/data/devices.json';
  const devicesLib = () => devicesInst || (devicesInst = createDevices({ file: devicesFile, outDir: o.devicesOut || require('os').tmpdir(), fetch: o.devicesFetch, run: o.devicesRun }));
  const fixDevicesOwner = () => { try { chownAgentos(devicesFile); } catch (e) { /* bỏ qua */ } };
  let botsInst = null;
  const botsLib = () => botsInst || (botsInst = require('../lib/bots').createBots({
    ctl: o.agentCtl, file: o.agentsFile || '/var/lib/agentos/data/agents.json', show: o.agentShow,
    mainToken: () => envVal(readEnv() || '', 'TELEGRAM_TOKEN'),
    owners: () => envVal(readEnv() || '', 'ALLOWED_USER_IDS').split(',').filter(Boolean),
    getMe: (token) => tgLib.getMe(token, { fetch: fetchImpl }),
    afterSave: (p) => chownAgentos(p),
  }));
  // Danh sách bot để tích quyền dùng khóa KiotViet (bot quản lý + các bot phụ) và đồng bộ khóa xuống cấu hình của bot phụ (agentctl update viết lại tệp cấu hình riêng rồi khởi động lại bot đó)
  const kvBotList = async () => { const l = await botsLib().list().catch(() => ({ agents: [] })); return [{ key: 'main', name: 'Bot quản lý' }].concat((l.agents || []).map((a) => ({ key: a.id, name: a.name, username: (a.bot && a.bot.username) || '' }))); };
  const kvSyncAgents = async (ids) => { const warn = []; for (const id of [...new Set(ids)]) { if (id === 'main') continue; try { await botsLib().update({ id }); } catch (e) { warn.push(id + ': ' + String(e.message || e).slice(0, 160)); } } return warn; };
  // Bot quản lý cũng có đủ chế độ/quyền hạn riêng như mọi bot: giá trị nằm trong tệp cấu hình của bộ điều phối (cùng khóa với agent, xem agentctl.SETTINGS)
  const AC = () => require('../../orchestrator/src/agentctl');
  const mainSettings = (t) => {
    const out = {};
    for (const [k, d] of Object.entries(AC().SETTINGS)) {
      if (k === 'full') continue;                                         // toàn quyền của bot quản lý có nút riêng (cấp sudo)
      const raw = envVal(t, d.env); if (raw === '') continue;
      if (d.kind === 'bool') out[k] = /^(1|true|yes|on)$/i.test(raw);
      else if (d.kind === 'int') { const n = Number(raw) / (d.mul || 1); if (Number.isFinite(n)) out[k] = n; }
      else if (d.kind === 'enum') { if (d.values.includes(raw)) out[k] = raw; }
      else out[k] = raw;
    }
    return out;
  };
  let fleetInst = null; const fleetLib = () => fleetInst || (fleetInst = createFleet({ file: o.fleetFile || '/var/lib/agentos/data/fleet.json', fetch: o.fleetFetch }));
  // Mở cơ sở dữ liệu của bộ điều phối ở chế độ CHỈ ĐỌC, chạy fn({raw, kvGet}), rồi đóng
  const withRoDb = (fn) => {
    let Database; try { Database = require('../../orchestrator/node_modules/better-sqlite3'); } catch (e) { try { Database = require('better-sqlite3'); } catch (e2) { throw new Error('Chưa đọc được cơ sở dữ liệu (thiếu thư viện).'); } }
    let raw; try { raw = new Database(o.dbFile || '/var/lib/agentos/data/agentos.db', { readonly: true, fileMustExist: true }); } catch (e) { throw new Error('Không mở được cơ sở dữ liệu: ' + e.message); }
    try { return fn({ raw, kvGet: (k) => { const r = raw.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; } }); } finally { raw.close(); }
  };
  let projectsInst = null;
  const projectsLib = () => projectsInst || (projectsInst = o.projects || createProjects({ baseDir: o.onedriveDir, extraSkillDirs: () => plugLib().skillDirs(), extraAgentDirs: () => plugLib().agentDirs() }));
  // Kết nối dịch vụ + chợ kỹ năng (cùng tệp dữ liệu với bot; bot tự nạp lại khi tệp đổi). "Thử" chạy máy chủ MCP bằng tài khoản agentos, không bao giờ bằng root.
  const connFile = o.connectorsFile || '/var/lib/agentos/data/connectors.json', plugFile = o.pluginsFile || '/var/lib/agentos/data/plugins.json';
  const asAgentosSpawn = (cmd, args, opts) => { const env = Object.assign({}, (opts && opts.env) || {}, { HOME: '/var/lib/agentos' }); return cp.spawn('runuser', ['-u', 'agentos', '--', 'env'].concat(Object.keys(env).map((k) => k + '=' + env[k]), [cmd], args || []), { stdio: (opts && opts.stdio) || ['pipe', 'pipe', 'pipe'] }); };
  let connInst = null, plugInst = null;
  const connLib = () => connInst || (connInst = createConnectors({ file: connFile, extraCatalog: () => (plugInst ? plugInst.extraCatalog() : []), spawn: o.connSpawn || asAgentosSpawn }));
  const plugLib = () => { if (!plugInst) { const c = connLib(); plugInst = createPlugins({ dir: o.pluginsDir || path.join(__dirname, '..', 'plugins'), stateFile: plugFile, userDir: o.pluginsUserDir || '/var/lib/agentos/plugins-user', fetch: o.pluginsFetch, connectors: c }); } return plugInst; };
  // Hai lớp kỹ năng: gốc (plugin, chỉ đọc) / của chủ máy (ghi chú riêng + kỹ năng dự án đè bản gốc) — skillLayers.js
  const skillNotesDir = o.skillNotesDir || '/var/lib/agentos/skill-notes';
  let layersInst = null;
  const layersLib = () => layersInst || (layersInst = createSkillLayers({ plugins: plugLib(), projects: projectsLib(), notesDir: skillNotesDir, stateFile: o.skillLayersFile || path.join(path.dirname(plugFile), 'skill-layers.json') }));
  const fixSkillNotes = () => { try { chownTree(skillNotesDir); } catch (e) { /* máy thử */ } try { chownAgentos(o.skillLayersFile || path.join(path.dirname(plugFile), 'skill-layers.json')); } catch (e) { /* máy thử */ } };
  const fixUserPlugins = () => { try { chownTree(o.pluginsUserDir || '/var/lib/agentos/plugins-user'); } catch (e) { /* máy thử */ } };
  const fixConnOwner = () => { for (const f of [connFile, plugFile]) { try { chownAgentos(f); } catch (e) { /* máy thử */ } } };
  const connOut = () => ({ connectors: connLib().list(), catalog: connLib().catalog(), plugins: plugLib().list() });
  // Đăng nhập Google (googleAuth.js + google-mcp.js): khóa client + token ở data/google (0600, chủ agentos); mặc định chỉ đọc
  const googleDir = o.googleDir || '/var/lib/agentos/data/google';
  const googleAuth = o.googleAuth || createGoogleAuth({ dir: googleDir, fetch: o.googleFetch, origins: o.googleOrigins });
  const googleBase = () => o.googleRedirectBase || 'http://127.0.0.1:' + PORT;
  const fixGoogleOwner = () => { try { chownTree(googleDir); } catch (e) { /* máy thử */ } };
  const googleOut = () => Object.assign(googleAuth.status(), { connector: (() => { try { const c = connLib().get('google'); return c ? { enabled: c.enabled } : null; } catch (e) { return null; } })() });
  const SKILL_DIR = 'KY-NANG';
  const skillSlug = (name) => String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  // Bảng điều khiển từng bot (wizard/lib/botboard.js): đọc dữ liệu mọi bot, điều khiển bằng tệp yêu cầu trong thư mục điều khiển của đúng bot
  let boardInst = null;
  const boardLib = () => boardInst || (boardInst = require('../lib/botboard').createBotBoard({
    mainDataDir: o.boardMainDir, agentsHome: o.boardAgentsHome, onedriveDir: o.onedriveDir, mainWorkdir: () => envVal(readEnv() || '', 'WORKDIR') || '/var/lib/agentos/work',
    chown: (p, user) => { try { cp.execFileSync('chown', [user + ':' + (user === 'agentos' ? 'agentos' : user), p]); } catch (e) { /* bỏ qua */ } },
  }));
  const botKey = (ctx) => String(ctx.query.get('bot') || 'main');
  // Xưởng sáng tạo: tạo ảnh bằng AI + soạn Word/Excel/PDF/PowerPoint chỉnh bằng giao diện (wizard/lib/studio.js). Khóa API lấy từ tệp cấu hình ở mỗi lần gọi.
  let studioInst = null;
  const studioLib = () => studioInst || (studioInst = require('../lib/studio').createStudio({
    dir: o.studioDir || path.join(o.boardMainDir || '/var/lib/agentos/data', 'studio'),
    keys: () => { const text = readEnv() || ''; return apikeys.keysFrom(Object.fromEntries(Object.values(apikeys.VAR).map((v) => [v, envVal(text, v)]))); },
    fetch: (...a) => fetchImpl(...a), officeBin: o.officeBin, exec: o.officeExec, chown: (p) => chownAgentos(p),
  }));
  let watchInst = null;
  const watchLib = () => watchInst || (watchInst = createWatch({ traceDir: o.traceDir || '/var/lib/agentos/data/trace', journalDir: o.journalDir || '/var/lib/agentos/data/journal', projects: projectsLib() }));
  // Trang Cài đặt chạy bằng root: dự án vừa tạo/sửa phải thuộc người dùng agentos để bộ điều phối ghi được
  const fixProjectOwner = (p) => { try { chownTree(projectsLib().root()); } catch (e) { /* bỏ qua */ } };
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

  // Nhận ra AI đã ĐĂNG NHẬP bằng tài khoản nào (đọc tệp đăng nhập của từng CLI trong thư mục của người dùng agentos; chỉ lấy email, KHÔNG đọc/hiện token).
  // Trả { loggedIn, how, who } với who = email đã che. Có token dài hạn (CLAUDE_CODE_OAUTH_TOKEN trong cấu hình) cũng tính là đã đăng nhập.
  function engineLogin(e, envText) {
    const home = o.homeDir || engines.HOME;
    const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (x) { return null; } };
    const jwtEmail = (t) => { try { const p = JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); return p.email || ''; } catch (x) { return ''; } };
    const em = (v) => (v ? mask.email(v) : '');
    if (e === 'claude') {
      const c = readJson(home + '/.claude.json'), cred = fs.existsSync(home + '/.claude/.credentials.json');
      const long = envVal(envText || '', 'CLAUDE_CODE_OAUTH_TOKEN');
      const acct = c && c.oauthAccount ? c.oauthAccount : null;
      if (cred || acct) return { loggedIn: true, how: 'tài khoản Claude', who: em(acct && acct.emailAddress) };
      if (long) return { loggedIn: true, how: 'token đăng nhập dài hạn ' + mask.secret(long), who: '' };
    } else if (e === 'codex') {
      const a = readJson(home + '/.codex/auth.json');
      if (a && (a.tokens || a.OPENAI_API_KEY)) return a.tokens ? { loggedIn: true, how: 'tài khoản ChatGPT/OpenAI', who: em(jwtEmail(a.tokens.id_token)) } : { loggedIn: true, how: 'khóa API lưu trong Codex ' + mask.secret(a.OPENAI_API_KEY), who: '' };
    } else if (e === 'gemini') {
      if (fs.existsSync(engines.GEMINI_CREDS.replace(engines.HOME, home))) { const g = readJson(home + '/.gemini/google_accounts.json'); return { loggedIn: true, how: 'tài khoản Google', who: em(g && g.active) }; }
    }
    return { loggedIn: false, how: '', who: '' };
  }
  const isActive = async (unit) => (await run('systemctl', ['is-active', unit])).out.trim() || 'unknown';

  // ---------- OneDrive (chạy bằng người dùng agentos) ----------
  let odChild = null;
  const odUrlFile = () => path.join(o.onedriveConf, 'auth-url.txt'), odRespFile = () => path.join(o.onedriveConf, 'auth-response.txt'), odToken = () => path.join(o.onedriveConf, 'refresh_token');
  const bookOf = () => createBook({ dir: o.onedriveDir, fallbackDir: o.memFallback || '/var/lib/agentos/data/so-tay' });
  const chownTree = (p) => { chownAgentos(p); try { if (fs.statSync(p).isDirectory()) for (const n of fs.readdirSync(p)) chownTree(path.join(p, n)); } catch (e) { /* bỏ qua */ } };
  const asAgentos = (cmd, args) => ['runuser', ['-u', 'agentos', '--', cmd, ...args]];
  let odAuth = null, odListener = null;                     // đăng nhập tự động: { state, status: waiting|exchanging|done|error, error, clientId, scope, redirect }
  const odAccountFile = () => path.join(o.onedriveConf, 'account.json');
  function odCloseListener() { if (odListener) { const l = odListener; odListener = null; try { l.close(); if (l.closeAllConnections) l.closeAllConnections(); } catch (e) { /* đã đóng */ } } }
  function odStop() { odCloseListener(); if (odChild) { try { odChild.kill('SIGTERM'); } catch (e) { /* đã thoát */ } odChild = null; } fs.rmSync(odUrlFile(), { force: true }); fs.rmSync(odRespFile(), { force: true }); }
  const writeToken = (t) => { fs.mkdirSync(o.onedriveConf, { recursive: true }); fs.writeFileSync(odToken(), String(t).trim(), { mode: 0o600 }); chownAgentos(odToken()); };
  const saveAccount = (who) => { try { fs.writeFileSync(odAccountFile(), JSON.stringify({ name: who.name || '', email: who.email || '', driveType: who.driveType || '', at: Date.now() }), { mode: 0o600 }); chownAgentos(odAccountFile()); } catch (e) { /* bỏ qua */ } };
  const readAccount = () => { try { return JSON.parse(fs.readFileSync(odAccountFile(), 'utf8')); } catch (e) { return null; } };

  // Cổng nhận mã đăng nhập ở máy này (127.0.0.1): trang đăng nhập Microsoft chuyển trình duyệt về đây kèm mã
  async function odFinishAuto(a, code) {
    const ex = await odauth.exchange({ fetch: fetchImpl, clientId: a.clientId, scope: a.scope, code, redirect: a.redirect });
    writeToken(ex.refreshToken);
    const who = ex.accessToken ? await odauth.whoami(fetchImpl, ex.accessToken) : null;
    if (who) saveAccount(who);
    odStop();                                                  // tắt tiến trình xin mã của client (đã có khóa)
    await run('systemctl', ['start', 'onedrive-agentos.service']);
    a.status = 'done';
  }
  function odOnRedirect(req, res) {
    const a = odAuth;
    let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { res.writeHead(400); return res.end(); }
    if (u.pathname !== '/') { res.writeHead(404); return res.end(); }
    const page = (ok, msg) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentOS</title><body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px"><h2>' + (ok ? '✅ ' : '⚠️ ') + msg + '</h2><p>Quay lại cửa sổ <b>Cài đặt AgentOS</b> (OneDrive sẽ tự báo đã kết nối). Có thể đóng trang này.</p></body>'); };
    if (!a || a.status !== 'waiting' || u.searchParams.get('state') !== a.state) return page(false, 'Yêu cầu không hợp lệ hoặc đã hết hạn.');
    const err = u.searchParams.get('error_description') || u.searchParams.get('error');
    if (err) { a.status = 'error'; a.error = String(err).replace(/\s+/g, ' ').slice(0, 300); res.on('finish', odCloseListener); return page(false, 'Microsoft báo lỗi: ' + a.error.slice(0, 120)); }
    const code = u.searchParams.get('code');
    if (!code) return page(false, 'Thiếu mã đăng nhập.');
    a.status = 'exchanging'; res.on('finish', odCloseListener);          // đóng cổng SAU khi đã trả trang cho trình duyệt
    page(true, 'Đã nhận mã đăng nhập, đang hoàn tất...');
    odFinishAuto(a, code).catch((e) => { a.status = 'error'; a.error = e.message; odStop(); });
  }
  function odListen() {
    return new Promise((resolve) => {
      const l = http.createServer(odOnRedirect);
      l.once('error', () => resolve(null));                    // cổng bận: chỉ còn cách dán địa chỉ bằng tay
      l.listen(o.odPort === undefined ? 53100 : o.odPort, '127.0.0.1', () => { odListener = l; const t = setTimeout(odCloseListener, 15 * 60 * 1000); if (t.unref) t.unref(); resolve(l.address().port); });
    });
  }
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const vaultLib = () => createVault({ file: o.vaultFile || '/var/lib/agentos/data/vault.enc', keyFile: o.vaultKey || '/var/lib/agentos/vault.key', chown: (f) => chownAgentos(f) });
  let accessInst = null;
  const accessLib = () => accessInst || (accessInst = createMachineAccess({ file: path.join(path.dirname(o.vaultFile || '/var/lib/agentos/data/vault.enc'), 'machine-acl.json'), isAdmin: () => false, chown: (f) => chownAgentos(f) }));
  const chownAgentos = (p) => { try { const l = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((x) => x.startsWith('agentos:')).split(':'); fs.chownSync(p, Number(l[2]), Number(l[3])); } catch (e) { /* máy thử */ } };

  // ---------- xử lý yêu cầu ----------
  const A = {
    // Kiểm tra phần cứng (hwcheck.js, chỉ đọc); nhớ 60 giây để mở trang không chạy lspci liên tục
    async 'GET /api/hardware'(b, ctx) {
      if (hwCache && Date.now() - hwCache.at < 60000 && !(ctx && ctx.query && ctx.query.get('force'))) return hwCache.rep;
      const rep = hwEvaluate(await hwCollect(o.hwOptions || {})); hwCache = { at: Date.now(), rep }; return rep;
    },
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

    // ----- KiotViet: nhiều gian hàng (mỗi gian một cửa hàng KiotViet với khóa API riêng) -----
    // Bot nào được dùng gian hàng: 'main' = bot quản lý, còn lại là bot phụ (agent). Gian được tích cho bot phụ nào thì khóa được ghi vào cấu hình riêng của bot đó (chỉ root đọc) và bot đó khởi động lại để nhận khóa.
    async 'GET /api/kiotviet'() { return { shops: kvLib.view(readEnv() || ''), configured: readEnv() != null, bots: await kvBotList() }; },
    async 'POST /api/kiotviet/bots'(b) {
      const text = needEnv(), retailer = String(b.retailer || '').trim();
      const known = new Set((await kvBotList()).map((x) => x.key));
      const bots = (Array.isArray(b.bots) ? b.bots : []).map(String);
      for (const x of bots) if (!known.has(x)) throw new Error('Không có bot "' + x + '".');
      const r = kvLib.setBots(text, retailer, bots);
      saveEnv(r.text);
      const changed = [...new Set([...r.before.filter((x) => !r.after.includes(x)), ...r.after.filter((x) => !r.before.includes(x))])];
      if (changed.includes('main')) await restart('agentos-orchestrator');
      const warn = await kvSyncAgents(changed);
      return { saved: true, bots: r.after, changed, warn };
    },
    async 'POST /api/kiotviet/save'(b) {
      const text = needEnv();
      let u;
      // sửa gian đã có mà để trống khóa thì giữ khóa cũ: kiểm bằng khóa đã lưu
      const cur = kvLib.shopsFromEnv(text).find((x) => x.retailer.toLowerCase() === String(b.retailer || '').trim().toLowerCase());
      const probe = { retailer: String(b.retailer || '').trim(), clientId: String(b.clientId || '').trim() || (cur && cur.clientId) || '', clientSecret: String(b.clientSecret || '').trim() || (cur && cur.clientSecret) || '' };
      const r = await kvLib.check(probe, fetchImpl);
      if (!r.ok) throw new Error(r.detail);
      u = kvLib.upsert(text, b);
      saveEnv(u.text); await restart('agentos-orchestrator');
      const warn = await kvSyncAgents(cur ? (cur.bots || []).filter((x) => x !== 'main').concat((u.shop.bots || []).filter((x) => x !== 'main')) : (u.shop.bots || []));       // khóa đổi → bot phụ đang dùng gian này nhận khóa mới
      return { saved: true, detail: r.detail, warn, shop: { name: u.shop.name || u.shop.retailer, retailer: u.shop.retailer } };
    },
    async 'POST /api/kiotviet/test'(b) {
      const cur = kvLib.shopsFromEnv(readEnv() || '').find((x) => x.retailer.toLowerCase() === String(b.retailer || '').trim().toLowerCase());
      if (!cur) throw new Error('Không có gian hàng này.');
      return kvLib.check(cur, fetchImpl);
    },
    async 'POST /api/kiotviet/delete'(b) {
      const text = needEnv(), had = kvLib.shopsFromEnv(text).find((x) => x.retailer.toLowerCase() === String(b.retailer || '').trim().toLowerCase());
      saveEnv(kvLib.remove(text, b.retailer)); await restart('agentos-orchestrator');
      const warn = await kvSyncAgents(had && Array.isArray(had.bots) ? had.bots : []);        // bot phụ đang dùng gian này mất khóa
      return { deleted: true, warn };
    },

    // ----- Máy từ xa: kho mật khẩu RustDesk (mã hóa). Mật khẩu chỉ đi MỘT chiều vào kho, không bao giờ trả ra màn hình/chat -----
    // Quyền dùng máy theo từng ID Telegram (machineAccess.js): tệp machine-acl.json cạnh kho mật khẩu, bộ điều phối đọc cùng tệp
    async 'GET /api/vault'() { const A = accessLib(); return { machines: vaultLib().list().map((m) => Object.assign({}, m, { users: A.usersOf(m.name) })), local: A.usersOf(A.LOCAL) }; },
    async 'POST /api/machine-access/set'(b) { const r = accessLib().setUsers(String(b.name || ''), Array.isArray(b.users) ? b.users : String(b.users || '')); return { saved: true, name: r.name, users: r.users }; },
    async 'POST /api/vault/save'(b) { const r = vaultLib().put(b.name, { id: b.id, password: b.password, note: b.note }); return { saved: true, name: r.name, id: r.id }; },
    async 'POST /api/vault/delete'(b) { if (!vaultLib().remove(b.name)) throw new Error('Không có máy này trong kho.'); try { accessLib().forget(b.name); } catch (e) { /* bỏ qua */ } return { deleted: true }; },

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
      // CLAUDE_ONLY=1 mới ẩn Codex/Gemini/DeepSeek; mặc định hiện đủ
      const claudeOnly = !/^(0|false|no|off|tat)$/i.test(String(envVal(text, 'CLAUDE_ONLY') || '0').trim());
      for (const e of (claudeOnly ? apikeys.ENGINES.filter((x) => x === 'claude') : apikeys.ENGINES)) {
        const ver = await engines.installed(run, e).catch(() => null);
        const lg = engineLogin(e, text);
        out.push({ id: e, name: apikeys.NAMES[e], where: apikeys.WHERE[e], key: keys[e] ? apikeys.mask(keys[e]) : null, installed: ver, enabled: order.includes(e), login: lg, using: keys[e] ? 'key' : (lg.loggedIn ? 'account' : 'none') });
      }
      return { engines: out, order: claudeOnly ? ['claude'] : order, claudeOnly, configured: readEnv() != null };
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
    // ĐĂNG NHẬP AI QUA ĐIỆN THOẠI (không mở cửa sổ dòng lệnh): chạy lệnh đăng nhập chính thức trong nền, trang này hiện link + mã (Codex: mã thiết bị; Claude/Gemini: dán mã lại);
    // nút "Gửi vào Telegram" đưa link + mã sang điện thoại, người dùng bấm link trên điện thoại (đã đăng nhập sẵn, dùng được khóa bảo mật/ứng dụng xác thực của họ).
    async 'POST /api/ai/login/start'(b) {
      const eng = String(b.engine); if (!['claude', 'codex', 'gemini'].includes(eng)) throw new Error('AI này dùng khóa API, không đăng nhập tài khoản');
      if (!(await engines.installed(run, eng))) throw new Error('Chưa cài phần mềm ' + eng + ': bấm "Cài phần mềm" trước.');
      return loginView(phoneLogin().start(eng));
    },
    async 'GET /api/ai/login/state'() { return loginView(phoneLogin().get()); },
    async 'POST /api/ai/login/input'(b) { return loginView(phoneLogin().input(String(b.text || ''))); },
    async 'POST /api/ai/login/cancel'() { return loginView(phoneLogin().cancel()); },
    async 'POST /api/ai/login/phone'() {
      const v = phoneLogin().get(); if (v.status !== 'running' || !v.url) throw new Error('Chưa có đường dẫn đăng nhập để gửi (bấm đăng nhập trước).');
      const text = readEnv() || '', token = envVal(text, 'TELEGRAM_TOKEN'), owner = envVal(text, 'ADMIN_USER_IDS').split(',')[0].trim();
      if (!token || !owner) throw new Error('Chưa cấu hình bot Telegram.');
      const msg = '🔐 Đăng nhập ' + v.engine + ' cho máy AgentOS\n1) Bấm đường dẫn: ' + v.url + '\n' + (v.code ? '2) Nhập mã: ' + v.code : v.needsInput ? '2) Đăng nhập xong, trang hiện một MÃ: sao chép rồi dán vào trang Cài đặt trên máy (ô "Dán mã").' : '') + '\n(Mở bằng điện thoại hoặc máy nào cũng được.)';
      await (o.tgSend || tgLib.send)(token, owner, msg);
      return { ok: true };
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

    // Bật/tắt "chỉ dùng Claude": tắt thì hiện lại Codex, Gemini, DeepSeek (khóa API, đăng nhập, thứ tự ưu tiên)
    async 'POST /api/ai/claude-only'(b) {
      const on = !!(b && b.on);
      saveEnv(setEnvLine(needEnv(), 'CLAUDE_ONLY', on ? '1' : '0'));
      await restart('agentos-orchestrator');
      return { claudeOnly: on };
    },

    // ----- Bot Telegram -----
    // Tổng hợp MỌI tài khoản/khóa/thông tin đã lưu trên máy để khách biết cái gì đã có; bí mật được che bớt (mask.js), không bao giờ trả giá trị đầy đủ
    async 'GET /api/accounts'() {
      const text = readEnv() || '';
      const val = (k) => envVal(text, k);
      const home = o.homeDir || engines.HOME;
      const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
      const jwtEmail = (t) => { try { const p = JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); return p.email || ''; } catch (e) { return ''; } };
      const keys = apikeys.keysFrom(Object.fromEntries(Object.values(apikeys.VAR).map((v) => [v, val(v)])));
      const order = val('ENGINE_ORDER').split(',').map((x) => x.trim()).filter(Boolean);
      const groups = [];

      // Telegram
      const token = val('TELEGRAM_TOKEN');
      let bot = null; if (token) { try { bot = await tgLib.getMe(token, { fetch: fetchImpl }); } catch (e) { bot = null; } }
      const owners = val('ALLOWED_USER_IDS').split(',').filter(Boolean), admins = val('ADMIN_USER_IDS').split(',').filter(Boolean);
      groups.push({ id: 'telegram', icon: '💬', title: 'Bot Telegram', status: !token ? 'none' : (bot ? 'ok' : 'warn'),
        rows: [['Token bot', token ? mask.telegramToken(token) : 'chưa có'], ['Tên bot', bot ? '@' + bot.username : (token ? 'không hỏi được Telegram (kiểm tra mạng hoặc token)' : '—')], ['Người được phép (ID Telegram)', owners.length ? owners.join(', ') : 'chưa đặt'], ['Quản trị viên', admins.length ? admins.join(', ') : 'như người được phép']],
        hint: token ? '' : 'Vào "Bot Telegram" để dán token bot.' });

      // AI
      for (const e of apikeys.ENGINES) {
        const ver = await engines.installed(run, e).catch(() => null);
        const lg = engineLogin(e, text); const login = lg.loggedIn ? 'Đã đăng nhập: ' + lg.how : null, who = lg.who;
        const rows = [['Phần mềm', ver || 'chưa cài'], ['Khóa API', keys[e] ? mask.secret(keys[e]) : 'chưa có'], ['Đăng nhập tài khoản', login ? login + (who ? ' (' + who + ')' : '') : 'chưa']];
        const have = !!(keys[e] || login);
        groups.push({ id: 'ai-' + e, icon: '🤖', title: apikeys.NAMES[e], status: have ? (ver ? 'ok' : 'warn') : 'none', rows: rows.concat([['Đang bật dùng', order.includes(e) ? 'có (theo thứ tự ưu tiên ' + (order.indexOf(e) + 1) + ')' : 'không']]), hint: have ? (ver ? '' : 'Có tài khoản/khóa nhưng chưa cài phần mềm: vào "AI và khóa API" để cài.') : 'Chưa có khóa hoặc đăng nhập: vào "AI và khóa API".' });
      }

      // OneDrive
      const odConnected = fs.existsSync(odToken()), acc = odConnected ? readAccount() : null;
      let odFiles = null; try { odFiles = fs.readdirSync(o.onedriveDir).filter((n) => !n.startsWith('.')).length; } catch (e) { /* chưa có */ }
      groups.push({ id: 'onedrive', icon: '☁️', title: 'OneDrive (Microsoft)', status: odConnected ? ((await isActive('onedrive-agentos')) === 'active' ? 'ok' : 'warn') : 'none',
        rows: [['Kết nối', odConnected ? 'đã kết nối (khóa đăng nhập đã lưu, không hiện)' : 'chưa'], ['Tài khoản', acc ? ((acc.email ? mask.email(acc.email) : mask.name(acc.name)) + (acc.driveType ? ' · ' + (acc.driveType === 'personal' ? 'cá nhân' : acc.driveType) : '')) : (odConnected ? 'đã kết nối (chưa ghi nhận tên — kết nối lại để hiện)' : '—')], ['Đồng bộ', odConnected ? (await isActive('onedrive-agentos')) === 'active' ? 'đang chạy' : 'KHÔNG chạy' : '—'], ['Thư mục', o.onedriveDir + (odFiles == null ? '' : ' (' + odFiles + ' mục)')]],
        hint: odConnected ? '' : 'Vào "Kết nối" để đăng nhập OneDrive.' });

      // Tailscale
      const t = await ts.info().catch(() => ({ state: 'unknown' }));
      groups.push({ id: 'tailscale', icon: '🔐', title: 'Tailscale (đường vào dự phòng)', status: t.state === 'Running' ? 'ok' : t.state === 'missing' ? 'none' : 'warn',
        rows: [['Trạng thái', t.state === 'Running' ? 'đã đăng nhập' : t.state === 'missing' ? 'chưa cài' : 'chưa đăng nhập (' + t.state + ')'], ['Địa chỉ', t.state === 'Running' ? ((t.ips || [])[0] || '') + (t.dns ? ' · ' + t.dns : '') : '—']], hint: t.state === 'Running' ? '' : 'Vào "Kết nối" để đăng nhập Tailscale.' });

      // Hệ thống
      let fp = ''; try { fp = require('crypto').createHash('sha256').update(fs.readFileSync(o.updatePubkey || '/etc/agentos/update-pubkey.pem')).digest('hex').slice(0, 16); } catch (e) { /* không có */ }
      groups.push({ id: 'system', icon: '🛡️', title: 'Bảo mật hệ thống', status: 'ok',
        rows: [['Chế độ AI toàn quyền (sudo)', fullaccess.isEnabled(o.fullAccessPaths) ? 'ĐANG BẬT' : 'tắt'], ['Khóa kiểm chữ ký bản cập nhật', fp ? 'đã cài (dấu vân ' + fp + ')' : 'chưa có'], ['Tệp cấu hình bí mật', readEnv() == null ? 'chưa có' : o.envFile + ' (chỉ chủ máy đọc được, không hiện ở đây)']], hint: '' });

      return { groups, note: 'Khóa, token và mật khẩu chỉ hiện vài ký tự đầu/cuối để nhận ra; giá trị đầy đủ không bao giờ hiện ở đây.' };
    },
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

    // ----- Các bot Telegram phụ (agent): xem, thêm, dừng/chạy, chỉnh quyền hạn và chế độ từng bot -----
    async 'GET /api/bots'() {
      const l = await botsLib().list();
      const t = readEnv();
      if (t == null) { l.main = { configured: false }; return l; }
      const token = envVal(t, 'TELEGRAM_TOKEN');
      let bot = null; try { bot = token ? await tgLib.getMe(token, { fetch: fetchImpl }) : null; } catch (e) { bot = null; }
      l.main = { configured: true, token: token ? apikeys.mask(token) : null, bot: bot ? { username: bot.username, name: bot.first_name } : null, owners: envVal(t, 'ALLOWED_USER_IDS').split(',').filter(Boolean),
        fullAccessEnabled: fullaccess.isEnabled(o.fullAccessPaths), service: await isActive('agentos-orchestrator'), settings: mainSettings(t) };
      return l;
    },
    // Quyền hạn / chế độ của bot quản lý (cùng các mục với bot thường, trừ Toàn quyền: có nút riêng)
    async 'POST /api/bot/settings'(b) {
      const s = AC().validateSettings(b.settings || {});
      let t = needEnv();
      for (const [k, v] of Object.entries(s)) {
        if (k === 'full') throw new Error('Toàn quyền của bot quản lý đổi bằng nút "Chuyển sang Toàn quyền" (cần cấp quyền quản trị).');
        const d = AC().SETTINGS[k];
        t = setEnvLine(t, d.env, v === null ? null : AC().settingEnv(k, v).slice(d.env.length + 1));
      }
      saveEnv(t); await restart('agentos-orchestrator');
      return { settings: mainSettings(t) };
    },
    async 'GET /api/pool'() { return botsLib().pool(); },
    async 'POST /api/pool'(b) { return botsLib().setPool(b || {}); },
    async 'POST /api/bots/agent/add'(b) { return botsLib().add(b || {}); },
    async 'POST /api/bots/agent/control'(b) { return botsLib().control(b || {}); },
    async 'POST /api/bots/agent/update'(b) { return botsLib().update(b || {}); },
    async 'POST /api/bots/agent/logs'(b) { return botsLib().logs(b || {}); },
    async 'POST /api/bots/agent/remove'(b) { return botsLib().remove(b || {}); },

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
      const acc = connected ? readAccount() : null;
      const sl = synclist.read(o.onedriveConf);
      return { connected, service: await isActive('onedrive-agentos'), dir: o.onedriveDir, entries: files, authPending: !!odChild, syncAll: sl.all, folders: sl.folders, account: acc ? { name: acc.name ? mask.name(acc.name) : '', email: acc.email ? mask.email(acc.email) : '', driveType: acc.driveType } : null };
    },
    async 'POST /api/onedrive/start'() {
      odStop();
      // Kết nối MỚI (chưa có khóa đăng nhập, chưa có danh sách): mặc định chỉ đồng bộ thư mục AgentOS, không kéo cả OneDrive về máy
      if (!fs.existsSync(odToken()) && !fs.existsSync(synclist.file(o.onedriveConf))) { try { fs.mkdirSync(o.onedriveConf, { recursive: true }); synclist.write(o.onedriveConf, synclist.DEFAULT); chownAgentos(synclist.file(o.onedriveConf)); } catch (e) { /* bỏ qua */ } }
      fs.mkdirSync(o.onedriveConf, { recursive: true }); chownAgentos(o.onedriveConf);
      const [cmd, args] = asAgentos('onedrive', ['--confdir', o.onedriveConf, '--auth-files', odUrlFile() + ':' + odRespFile()]);
      odChild = spawn(cmd, args, { stdio: 'ignore' });
      odChild.on('error', () => {}); odChild.on('exit', () => { odChild = null; });
      for (let i = 0; i < 50; i++) {
        if (fs.existsSync(odUrlFile()) && fs.statSync(odUrlFile()).size > 20) {
          const url = fs.readFileSync(odUrlFile(), 'utf8').trim();
          const p = odauth.parseAuthUrl(url);
          odAuth = null;
          let auto = null;
          if (p) {
            const port = await odListen();
            if (port) { const redirect = 'http://127.0.0.1:' + port + '/'; odAuth = { state: odauth.newState(), status: 'waiting', error: '', clientId: p.clientId, scope: p.scope, redirect }; auto = odauth.autoUrl(url, redirect, odAuth.state); }
          }
          return { url, autoUrl: auto, auto: !!auto };
        }
        await sleep(o.odPollMs || 500);
      }
      odStop(); throw new Error('Không lấy được đường dẫn đăng nhập (kiểm tra mạng).');
    },
    // Đổi các thư mục OneDrive được đồng bộ: ghi sync_list rồi đồng bộ lại từ đầu (phần mềm bắt buộc --resync khi danh sách đổi) bằng công việc nền có nhật ký
    async 'POST /api/onedrive/folders'(b) {
      if (!fs.existsSync(odToken())) throw new Error('Chưa kết nối OneDrive.');
      if (busy()) throw new Error('Đang có một công việc khác chạy, đợi xong rồi thử lại.');
      let folders = null;
      if (b.all === true) { if (b.confirmAll !== true) throw new Error('Đồng bộ TOÀN BỘ OneDrive có thể kéo hàng chục đến hàng trăm GB về máy. Cần xác nhận.'); }
      else folders = synclist.clean(b.folders);
      const [cmd, args] = asAgentos('onedrive', ['--confdir', o.onedriveConf, '--sync', '--resync', '--resync-auth']);
      // Phải dừng CẢ onedrive-agentos.path: nó tự bật lại dịch vụ ngay khi dịch vụ dừng (đo thật: "already running" làm việc đồng bộ lại hỏng). Bật lại cả hai ở bước cuối, kể cả khi bước giữa lỗi.
      const steps = [['systemctl', ['stop', 'onedrive-agentos.path', 'onedrive-agentos.service']], [cmd, args], ['systemctl', ['start', 'onedrive-agentos.path', 'onedrive-agentos.service']]];
      if (folders) { synclist.write(o.onedriveConf, folders); chownAgentos(synclist.file(o.onedriveConf)); } else synclist.removeAll(o.onedriveConf);
      return { job: startJob('Đồng bộ lại OneDrive (' + (folders ? folders.join(', ') : 'toàn bộ') + ')', steps, { keepGoing: true }), folders: folders || [], all: !folders };
    },
    async 'GET /api/onedrive/auth-status'() { return odAuth ? { status: odAuth.status, error: odAuth.error } : { status: 'none', error: '' }; },
    async 'POST /api/onedrive/finish'(b) {
      const u = String(b.response || '').trim();
      if (!/^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/nativeclient\?/.test(u) || !/[?&]code=/.test(u)) throw new Error('Đó không phải địa chỉ đăng nhập OneDrive. Sau khi đăng nhập Microsoft, trình duyệt hiện trang trắng: copy TOÀN BỘ địa chỉ trên thanh địa chỉ và dán vào đây.');
      if (!odChild) throw new Error('Chưa bắt đầu kết nối (hoặc đã quá lâu). Bấm "Kết nối OneDrive" để lấy đường dẫn mới.');
      fs.writeFileSync(odRespFile(), u + '\n', { mode: 0o644 }); chownAgentos(odRespFile());
      for (let i = 0; i < 180; i++) { if (fs.existsSync(odToken())) break; await sleep(o.odPollMs || 500); }
      const ok = fs.existsSync(odToken()); await sleep(o.odSettleMs === undefined ? 3000 : o.odSettleMs); odStop(); if (odAuth) odAuth.status = ok ? 'done' : 'error';
      if (!ok) throw new Error('Microsoft không chấp nhận mã (chỉ dùng được một lần, hết hạn sau vài phút). Bấm kết nối lại.');
      await run('systemctl', ['start', 'onedrive-agentos.service']);
      return { connected: true };
    },
    async 'POST /api/onedrive/sync'() { const r = await run('pkill', ['-USR1', '-x', 'onedrive']); if (r.code !== 0) throw new Error('Dịch vụ đồng bộ không chạy'); return { ok: true }; },
    async 'POST /api/onedrive/disconnect'(b) {
      if (b.confirm !== true) throw new Error('Cần xác nhận');
      odStop(); odAuth = null; await run('pkill', ['-TERM', '-x', 'onedrive']); fs.rmSync(odToken(), { force: true }); fs.rmSync(odAccountFile(), { force: true }); return { connected: false };
    },

    // ----- Tailscale -----
    // ---- Thiết bị (camera, ổ cắm/đèn thông minh): devices.js; tệp cấu hình quyền 600 của người dùng agentos
    async 'GET /api/devices'() { return devicesLib().list(); },
    async 'POST /api/devices/camera'(b) { const r = devicesLib().addCamera(b); fixDevicesOwner(); return r; },
    async 'POST /api/devices/plug'(b) { const r = devicesLib().addPlug(b); fixDevicesOwner(); return r; },
    async 'POST /api/devices/remove'(b) { if (b.confirm !== true) throw new Error('Cần xác nhận'); return { ok: devicesLib().remove(b.kind === 'camera' ? 'camera' : 'plug', String(b.name || '')) }; },
    async 'POST /api/devices/snapshot'(b) { const s = await devicesLib().snapshot(String(b.name || '')); const buf = fs.readFileSync(s.file); try { fs.rmSync(s.file, { force: true }); } catch (e) { /* bỏ qua */ } if (buf.length > 3e6) throw new Error('Ảnh quá lớn để xem thử.'); return { image: 'data:image/' + (buf[0] === 0x89 ? 'png' : 'jpeg') + ';base64,' + buf.toString('base64') }; },
    async 'POST /api/devices/plug-test'(b) { return devicesLib().plug(String(b.name || ''), String(b.action || 'status')); },
    // ---- Đội máy (fleet.js; cấu hình ở tệp JSON dùng chung với bộ điều phối)
    async 'GET /api/fleet'() {
      const f = fleetLib(), c = f.load(), tsi = await ts.info().catch(() => ({}));
      return { agent: { enabled: c.agent.enabled, name: c.agent.name, port: c.agent.port, host: c.agent.host, hasKey: !!c.agent.key, allowFrom: c.agent.allowFrom || [] }, isHead: c.machines.length > 0, tailscaleIp: (tsi.ips || [])[0] || '', machines: await f.statusAll() };
    },
    async 'POST /api/fleet/agent'(b) {
      const f = fleetLib();
      if (b.resetAllowFrom === true) { f.resetAllowFrom(); } else if (b.enabled === false) { f.disableAgent(); } else {
        const tsi = await ts.info().catch(() => ({})), ip = (tsi.ips || [])[0] || '';
        f.enableAgent({ name: b.name, port: b.port === undefined || b.port === '' ? undefined : Number(b.port), host: ip, regenerate: b.regenerate === true });
      }
      try { chownAgentos(o.fleetFile || '/var/lib/agentos/data/fleet.json'); } catch (e) { /* bỏ qua */ }
      if (!o.fleetFile) await run('systemctl', ['restart', 'agentos-orchestrator']);                 // nạp cấu hình cổng nhận lệnh
      return { ok: true };
    },
    async 'POST /api/fleet/key'() { const c = fleetLib().load(); if (!c.agent.key) throw new Error('Chưa bật.'); return { key: c.agent.key, url: 'http://' + (c.agent.host || '<địa chỉ Tailscale>') + ':' + c.agent.port }; },
    async 'POST /api/fleet/add'(b) { const m = fleetLib().addMachine(b); try { chownAgentos(o.fleetFile || '/var/lib/agentos/data/fleet.json'); } catch (e) { /* bỏ qua */ } return m; },
    async 'POST /api/fleet/remove'(b) { if (b.confirm !== true) throw new Error('Cần xác nhận'); return { ok: fleetLib().removeMachine(String(b.name || '')) }; },
    async 'POST /api/fleet/update'(b) { return fleetLib().updateMachine(String(b.name || '')); },
    // ---- Nhật ký kiểm toán (chỉ đọc): danh sách việc, chi tiết 1 việc (công cụ AI đã xin), báo cáo tuần, xuất CSV
    async 'GET /api/audit'(b, ctx) { return withRoDb((db) => { const g = (k) => ctx.query.get(k) || ''; const a = createAuditLog({ db, projects: projectsLib() }); let sched = []; try { sched = (JSON.parse(db.kvGet('sched') || 'null') || {}).jobs || []; } catch (e) { /* hỏng: bỏ */ }
      const schedules = sched.map((j) => ({ scope: '', projectName: '', id: j.id, time: j.time, days: [], text: String(j.text || '').slice(0, 400), paused: !!j.paused, last: j.last || '' }));
      for (const p of projectsLib().list({ all: true })) for (const j of p.schedule || []) schedules.push({ scope: p.id, projectName: p.name, id: j.id, time: j.time, days: j.days || [], text: String(j.text || '').slice(0, 400), paused: !!j.paused, last: j.last || '' });
      return { active: a.list({ active: true, limit: 60 }), list: a.list({ days: g('days'), q: g('q'), status: g('status'), project: g('project'), denied: g('denied') === '1', limit: g('limit') }), week: a.week(7), schedules, projects: projectsLib().list().map((p) => ({ id: p.id, name: p.name })) }; }); },
    // Điều khiển từng việc / việc định kỳ: thả tệp yêu cầu cho bộ điều phối (control.js) — trang này chỉ đọc cơ sở dữ liệu nên không sửa trực tiếp
    async 'POST /api/control'(b) {
      const action = String((b && b.action) || ''); if (!CONTROL_ACTIONS.includes(action)) throw new Error('Hành động không hợp lệ.');
      const req = { action };
      if (b.id != null) { req.id = Number(b.id); if (!Number.isInteger(req.id)) throw new Error('Mã việc không hợp lệ.'); }
      if (b.approval != null) req.approval = String(b.approval).slice(0, 40);
      if (b.decision != null) req.decision = String(b.decision).slice(0, 1);
      if (b.scope != null) req.scope = String(b.scope).slice(0, 80);
      if (b.project != null) req.project = String(b.project).slice(0, 80);
      if (b.text != null) req.text = String(b.text).slice(0, action === 'job.submit' ? 4000 : 400);
      const dir = o.controlDir || '/var/lib/agentos/data/control'; fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json');
      fs.writeFileSync(f, JSON.stringify(req), { mode: 0o600 }); try { chownAgentos(f); } catch (e) { /* bỏ qua */ }
      return { ok: true };
    },
    async 'GET /api/audit/job'(b, ctx) { return withRoDb((db) => { const d = createAuditLog({ db, projects: projectsLib() }).detail(ctx.query.get('id')); if (!d) throw new Error('Không có việc này.'); return d; }); },
    // ---- Kết nối dịch vụ (MCP), chợ kỹ năng/plugin, kỹ năng dự án — cùng tính năng với /dichvu, /cho, /kynang trên Telegram
    async 'GET /api/conn'() { plugLib(); return connOut(); },
    async 'POST /api/conn/add'(b) { plugLib(); const r = connLib().addFromCatalog(String(b.key || '')); fixConnOwner(); if (!r.ok) throw new Error(r.error); return connOut(); },
    async 'POST /api/conn/add-custom'(b) { plugLib(); const args = Array.isArray(b.args) ? b.args : String(b.args || '').split(/\s+/).filter(Boolean); const r = connLib().addCustom({ label: b.label, command: String(b.command || '').trim(), args }); fixConnOwner(); if (!r.ok) throw new Error(r.error); return connOut(); },
    async 'POST /api/conn/secret'(b) { plugLib(); const r = connLib().setSecret(String(b.id || ''), String(b.name || ''), b.value); fixConnOwner(); if (!r.ok) throw new Error(r.error); return connOut(); },
    async 'POST /api/conn/enable'(b) { plugLib(); const r = connLib().setEnabled(String(b.id || ''), !!b.on); fixConnOwner(); if (!r.ok) throw new Error(r.error); return connOut(); },
    async 'POST /api/conn/remove'(b) { plugLib(); if (b.confirm !== true) throw new Error('Cần xác nhận'); const r = connLib().remove(String(b.id || '')); fixConnOwner(); if (!r.ok) throw new Error(r.error); return connOut(); },
    async 'POST /api/conn/test'(b) { plugLib(); const r = await connLib().test(String(b.id || '')); fixConnOwner(); return Object.assign({ result: r }, connOut()); },
    async 'POST /api/plugins/install'(b) { const r = plugLib().install(String(b.id || '')); fixConnOwner(); if (!r.ok) throw new Error(r.error); return connOut(); },
    async 'POST /api/plugins/uninstall'(b) { if (b.confirm !== true) throw new Error('Cần xác nhận'); const r = plugLib().uninstall(String(b.id || '')); fixConnOwner(); if (!r.ok) throw new Error(r.error); return connOut(); },
    // Thêm plugin từ liên kết .tar.gz (nguồn ngoài): lần 1 chỉ XEM TRƯỚC (confirm=false), lần 2 confirm=true mới lưu; kết nối dịch vụ của nguồn ngoài luôn bị bỏ
    async 'POST /api/plugins/add-url'(b) { const r = await plugLib().addFromUrl(String(b.url || ''), { confirm: b.confirm === true, allowConnectors: false }); fixUserPlugins(); fixConnOwner(); if (r.needConfirm) return { needConfirm: true, preview: r.preview }; if (!r.ok) throw new Error(r.error); return Object.assign({ added: r }, connOut()); },
    async 'POST /api/plugins/remove-user'(b) { if (b.confirm !== true) throw new Error('Cần xác nhận'); const r = plugLib().removeUser(String(b.id || '')); fixConnOwner(); if (!r.ok) throw new Error(r.error); return connOut(); },
    async 'POST /api/plugins/enable'(b) { const r = plugLib().setEnabled(String(b.id || ''), !!b.on); fixConnOwner(); if (!r.ok) throw new Error(r.error); return connOut(); },
    async 'GET /api/plugins/skill'(b, ctx) { const t = plugLib().skillText(ctx.query.get('id'), ctx.query.get('slug')); if (t == null) throw new Error('Không có kỹ năng này.'); return { text: t }; },
    async 'GET /api/skills'(b, ctx) {
      const P = projectsLib(), id = String(ctx.query.get('project') || ''), p = P.get(id); if (!p) throw new Error('Không có dự án này.');
      plugLib();
      const mine = path.join(p.dir, SKILL_DIR) + path.sep;
      const an = layersLib().analyze(id), byKey = new Map(an.skills.map((x) => [x.name.toLowerCase(), x]));
      return { project: { id: p.id, name: p.name }, officialChanged: an.officialChanged, hidden: an.hidden, skills: P.skillsOf(id).map((s) => { const x = byKey.get(String(s.name).toLowerCase()) || {}; return { name: s.name, description: s.description, slug: path.basename(s.file).replace(/\.md$/i, ''), kind: s.file.startsWith(mine) ? 'mine' : 'other', layer: x.layer || (s.file.startsWith(mine) ? 'custom' : 'official'), plugin: x.plugin || null, pluginName: x.pluginName || null, hasNote: !!x.hasNote, overrides: x.overrides || null }; }) };
    },
    async 'GET /api/skills/text'(b, ctx) {
      const P = projectsLib(), id = String(ctx.query.get('project') || ''), p = P.get(id); if (!p) throw new Error('Không có dự án này.');
      plugLib(); const s = P.skillsOf(id).find((x) => path.basename(x.file).replace(/\.md$/i, '') === String(ctx.query.get('slug') || '')); if (!s) throw new Error('Không có kỹ năng này.');
      return { text: fs.readFileSync(s.file, 'utf8').slice(0, 30000) };
    },
    async 'GET /api/skills/note'(b, ctx) { return layersLib().getNote(String(ctx.query.get('plugin') || ''), String(ctx.query.get('slug') || '')); },
    async 'POST /api/skills/note'(b) { const r = layersLib().setNote(String(b.plugin || ''), String(b.slug || ''), b.text); fixSkillNotes(); if (!r.ok) throw new Error(r.error); return r; },
    async 'POST /api/skills/use-official'(b) { if (b.confirm !== true) throw new Error('Cần xác nhận'); const r = layersLib().useOfficial(String(b.project || ''), String(b.name || '')); fixSkillNotes(); if (!r.ok) throw new Error(r.error); return { ok: true, plugin: r.plugin }; },
    async 'POST /api/skills/save'(b) {
      const P = projectsLib(), p = P.get(String(b.project || '')); if (!p) throw new Error('Không có dự án này.');
      const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60), description = String(b.description || '').replace(/\s+/g, ' ').trim().slice(0, 160), body = String(b.body || '').trim();
      const slug = skillSlug(b.slug || name); if (!name || !slug) throw new Error('Tên kỹ năng cần có chữ hoặc số.'); if (!description) throw new Error('Cần mô tả ngắn: khi nào AI nên dùng kỹ năng này.'); if (!body) throw new Error('Cần nội dung (các bước làm).'); if (body.length > 20000) throw new Error('Nội dung quá dài (tối đa 20.000 ký tự).');
      const dir = path.join(p.dir, SKILL_DIR), f = path.join(dir, slug + '.md');
      if (!b.overwrite && fs.existsSync(f)) throw new Error('Đã có kỹ năng "' + slug + '". Sửa kỹ năng đó hoặc đặt tên khác.');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f, '---\nname: ' + name + '\ndescription: ' + description + '\n---\n' + body + '\n');
      fixProjectOwner(p); return { ok: true, slug };
    },
    async 'POST /api/skills/delete'(b) {
      if (b.confirm !== true) throw new Error('Cần xác nhận');
      const P = projectsLib(), p = P.get(String(b.project || '')); if (!p) throw new Error('Không có dự án này.');
      const slug = skillSlug(b.slug), f = path.join(p.dir, SKILL_DIR, slug + '.md');
      if (!slug || !fs.existsSync(f)) throw new Error('Không có kỹ năng này trong KY-NANG (kỹ năng ở nơi khác chỉ xem được).');
      fs.rmSync(f, { force: true }); return { ok: true };
    },
    // ---- Google (Lịch + Gmail) — máy chủ MCP riêng, chỉ đọc mặc định
    async 'GET /api/google'() { return googleOut(); },
    async 'POST /api/google/client'(b) { const r = googleAuth.saveClient(b.json !== undefined ? b.json : { client_id: b.client_id, client_secret: b.client_secret }); fixGoogleOwner(); if (!r.ok) throw new Error(r.error); return googleOut(); },
    async 'POST /api/google/start'(b) { const r = googleAuth.start({ write: !!b.write, redirectUri: googleBase() + '/google/callback' }); if (!r.ok) throw new Error(r.error); return { url: r.url }; },
    async 'POST /api/google/disconnect'(b) { if (b.confirm !== true) throw new Error('Cần xác nhận'); await googleAuth.revoke(); if (b.removeClient === true) googleAuth.removeClient(); plugLib(); try { connLib().remove('google'); } catch (e) { /* chưa thêm */ } fixConnOwner(); return googleOut(); },
    // ---- Bảng điều khiển bot: lệnh đã nhận, kết quả, thành quả, đánh giá AI, dạy bot, tài liệu lưu trữ ----
    async 'GET /api/board/bots'() { const l = await botsLib().list().catch(() => ({ agents: [] })); return { bots: boardLib().bots(l.agents) }; },
    async 'GET /api/board/jobs'(b, ctx) { return boardLib().list(botKey(ctx), { status: ctx.query.get('status'), before: ctx.query.get('before'), limit: ctx.query.get('limit') }); },
    async 'GET /api/board/job'(b, ctx) { return boardLib().detail(botKey(ctx), ctx.query.get('id')); },
    async 'POST /api/board/control'(b) {
      const map = { pause: 'job.pause', resume: 'job.resume', cancel: 'job.cancel', rerun: 'job.rerun' }, action = map[String(b.what)];
      if (!action) throw new Error('Việc không hợp lệ.'); const id = Number(b.id); if (!Number.isInteger(id) || id < 1) throw new Error('Mã lệnh sai.');
      return boardLib().control(String(b.bot || 'main'), { action, id });
    },
    async 'POST /api/board/review'(b) { return boardLib().requestReview(String(b.bot || 'main'), b.id); },
    async 'POST /api/board/teach'(b) { return boardLib().teach(String(b.bot || 'main'), b.text, b.job); },
    async 'POST /api/board/forget'(b) { return boardLib().forget(String(b.bot || 'main'), b.id); },
    async 'GET /api/board/trace'(b, ctx) { return boardLib().trace(botKey(ctx), ctx.query.get('id'), ctx.query.get('from')); },
    async 'GET /api/board/changes'(b, ctx) { return boardLib().changes(botKey(ctx), ctx.query.get('id')); },
    async 'GET /api/board/memory'(b, ctx) { return boardLib().memory(botKey(ctx)); },
    // Ô tìm chung trong mọi hội thoại cũ: bot=all tìm ở tất cả bot, hoặc một bot. Tham số: q, status, days (chỉ trong N ngày gần đây), limit, offset
    async 'GET /api/board/search'(b, ctx) {
      const q = String(ctx.query.get('q') || '').trim(); if (!q) throw new Error('Gõ từ khóa cần tìm.'); if (q.length > 120) throw new Error('Từ khóa dài quá.');
      const days = Number(ctx.query.get('days')) || 0; const opt = { status: ctx.query.get('status') || undefined, from: days > 0 ? Date.now() - days * 86400000 : 0, limit: ctx.query.get('limit'), offset: ctx.query.get('offset') };
      const key = String(ctx.query.get('bot') || 'all');
      if (key === 'all') { const l = await botsLib().list().catch(() => ({ agents: [] })); return boardLib().searchAll(q, opt, l.agents); }
      return boardLib().search(key, q, opt);
    },
    async 'GET /api/studio'() { return studioLib().list(); },
    async 'POST /api/studio/image'(b) { return studioLib().image(b || {}); },
    async 'GET /api/studio/file'(b, ctx) { return studioLib().fileData(ctx.query.get('name') || '', ctx.query.get('download') === '1'); },
    async 'POST /api/studio/delete'(b) { return studioLib().remove(String((b || {}).name || '')); },
    async 'GET /api/studio/template'(b, ctx) { return { doc: studioLib().template(ctx.query.get('id') || '') }; },
    async 'GET /api/studio/draft'(b, ctx) { return { doc: studioLib().getDraft(ctx.query.get('name') || '') }; },
    async 'POST /api/studio/draft'(b) { return studioLib().saveDraft((b || {}).name, (b || {}).doc); },
    async 'POST /api/studio/preview'(b) { return { html: studioLib().preview((b || {}).doc) }; },
    async 'POST /api/studio/build'(b) { return studioLib().build((b || {}).doc, (b || {}).draft); },
    async 'POST /api/studio/from-md'(b) { return { doc: studioLib().fromMarkdown((b || {}).md, (b || {}).type) }; },
    async 'GET /api/board/archive'(b, ctx) { return boardLib().archive(botKey(ctx), ctx.query.get('path') || ''); },
    async 'GET /api/board/file'(b, ctx) { return boardLib().fileView(botKey(ctx), ctx.query.get('path') || '', ctx.query.get('download') === '1'); },
    // ---- Màn hình "Việc AI" (xem như màn hình Claude Code): từng bước đang chạy, tệp đã đổi + khác biệt từng dòng, duyệt tệp dự án (chỉ đọc) — wizard/lib/watch.js
    async 'GET /api/watch/trace'(b, ctx) { return watchLib().trace(ctx.query.get('id'), ctx.query.get('from')); },
    // Các yêu cầu xin quyền đang chờ (bot ghi ảnh chụp ra tệp mỗi khi có thay đổi) — duyệt bằng POST /api/control {action:'approval.answer', approval, decision}
    async 'GET /api/watch/approvals'() { try { const l = JSON.parse(fs.readFileSync(o.approvalsFile || '/var/lib/agentos/data/approvals-pending.json', 'utf8')); return { list: Array.isArray(l) ? l : [] }; } catch (e) { return { list: [] }; } },
    async 'GET /api/watch/changes'(b, ctx) { return watchLib().changes(ctx.query.get('id')); },
    async 'GET /api/watch/tree'(b, ctx) { return watchLib().tree(ctx.query.get('project'), ctx.query.get('path') || ''); },
    async 'GET /api/watch/file'(b, ctx) { return watchLib().file(ctx.query.get('project'), ctx.query.get('path') || ''); },
    async 'GET /api/audit/csv'(b, ctx) { return withRoDb((db) => ({ csv: createAuditLog({ db, projects: projectsLib() }).csv(Number(ctx.query.get('days')) || 30) })); },
    // ---- Thống kê sử dụng AI (đọc cơ sở dữ liệu của bộ điều phối ở chế độ CHỈ ĐỌC; đặt trần tháng bằng /chiphi trên Telegram)
    async 'GET /api/usage'(b, ctx) {
      let Database; try { Database = require('../../orchestrator/node_modules/better-sqlite3'); } catch (e) { try { Database = require('better-sqlite3'); } catch (e2) { throw new Error('Chưa đọc được cơ sở dữ liệu (thiếu thư viện).'); } }
      const dbFile = o.dbFile || '/var/lib/agentos/data/agentos.db';
      let raw; try { raw = new Database(dbFile, { readonly: true, fileMustExist: true }); } catch (e) { throw new Error('Không mở được cơ sở dữ liệu: ' + e.message); }
      try {
        const kv = (k) => { const r = raw.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; };
        const days = Math.min(366, Math.max(1, Number(ctx.query.get('days')) || 30));
        return createUsage({ db: { raw, kvGet: kv }, projects: projectsLib() }).summary(days);
      } finally { raw.close(); }
    },
    // ---- Sao lưu dữ liệu ra ổ ngoài (tập lệnh root agentos-backup)
    async 'GET /api/diskbackup'() {
      const r = await run(backupBin, ['devices']);
      const devices = String(r.out || '').split(/\r?\n/).filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      return { status: diskBackup.status(), devices, timer: await isActive('agentos-backup.timer') };
    },
    async 'POST /api/diskbackup/set'(b) {
      if (busy()) throw new Error('Đang có một công việc khác chạy, đợi xong rồi thử lại.');
      const target = String(b.target || '').trim(), days = b.keepDays == null || b.keepDays === '' ? 30 : Math.round(Number(b.keepDays));
      if (!/^[A-Za-z0-9-]{8,40}$/.test(target) && !/^\/[\w./ -]{1,200}$/.test(target)) throw new Error('Ổ không hợp lệ.');
      if (!(days >= 1 && days <= 3650)) throw new Error('Số ngày giữ bản cũ từ 1 đến 3650.');
      return { job: startJob('Chọn ổ sao lưu ngoài', [[backupBin, ['set', target, String(days)]]]) };
    },
    async 'POST /api/diskbackup/run'() { if (busy()) throw new Error('Đang có một công việc khác chạy.'); return { job: startJob('Sao lưu ra ổ ngoài', [[backupBin, ['run']]], { keepGoing: false }) }; },
    async 'POST /api/diskbackup/verify'() { if (busy()) throw new Error('Đang có một công việc khác chạy.'); return { job: startJob('Kiểm tra khôi phục từ ổ ngoài', [[backupBin, ['verify']]]) }; },
    async 'POST /api/diskbackup/off'(b) { if (b.confirm !== true) throw new Error('Cần xác nhận'); const r = await run(backupBin, ['off']); if (r.code !== 0) throw new Error(String(r.err || r.out).slice(-200)); return { ok: true }; },
    // ---- Bảng phiên: mọi cuộc trò chuyện (chat + dự án) với trạng thái suy ra từ bảng việc (chỉ đọc)
    async 'GET /api/sessions'() {
      return withRoDb((db) => {
        const P = projectsLib(), S = createSessions({ db: null, projects: P });
        const rows = S.rowsFor(db.raw, null, 120).map((r) => {
          const p = r.project ? P.get(r.project) : null, st = S.stateOf(r);
          return { chat: r.chat, project: r.project, name: r.project ? (p ? (p.home ? 'Chung (dự án tổng)' : p.name) : r.project + ' (đã xóa)') : 'Chế độ chung', mode: (p && p.mode) || 'chay', state: st.key, icon: st.icon, label: st.label, running: r.running, queued: r.queued, total: r.total, lastId: r.last_id, prompt: r.last ? String(r.last.prompt || '').slice(0, 160) : '', at: r.last ? (r.last.finished_at || r.last.started_at || r.last.created_at) : 0 };
        });
        return { sessions: rows };
      });
    },
    // ---- Dự án (projects.js dùng chung với bộ điều phối; danh sách nằm ở tệp .du-an.json trong thư mục dự án)
    async 'GET /api/projects'() {
      const text = readEnv() || '';
      const engines = envVal(text, 'ENGINE_ORDER').split(',').map((s) => s.trim()).filter(Boolean);
      const P = projectsLib();
      const bookOf = (p) => { try { const ch = createBook({ rootDir: P.bookDir(p.id) }).list(); return { chapters: ch.length, entries: ch.reduce((s, c) => s + c.entries.length, 0) }; } catch (e) { return { chapters: 0, entries: 0 }; } };
      const all = P.list({ all: true });
      const nameOf = (id) => { const t = all.find((x) => x.id === id); return t ? t.name : id; };
      const list = all.map((p) => Object.assign({}, p, { usage: P.usage(p.id), instructions: P.rawInstructions(p.id), book: bookOf(p), mergedIntoName: p.mergedInto ? nameOf(p.mergedInto) : '' }));
      return { list, engines, root: P.root() };
    },
    // GỘP DỰ ÁN: đổ sổ tay/chỉ dẫn/tệp/lịch của các dự án đã chọn vào một dự án đích (có sẵn hoặc tạo mới); sau đó bộ điều phối nhờ AI sắp xếp lại sổ tay (xem memory.organizePending).
    async 'POST /api/projects/merge'(b) {
      if (b.confirm !== true) throw new Error('Cần xác nhận');
      const P = projectsLib();
      const r = mergeProjects({ projects: P, ids: Array.isArray(b.ids) ? b.ids : [], into: b.into ? String(b.into) : '', name: b.name, by: 'settings' });
      try { chownTree(P.root()); } catch (e) { /* bỏ qua */ }
      return Object.assign({ ok: true }, r);
    },
    async 'POST /api/projects/create'(b) { const p = projectsLib().create(b.name, 'settings'); fixProjectOwner(p); return { project: p }; },
    async 'POST /api/projects/update'(b) {
      const P = projectsLib(), id = String(b.id || '');
      if (!P.get(id)) throw new Error('Không có dự án này.');
      if (b.name != null) P.rename(id, b.name);
      if (b.engine !== undefined) P.setEngine(id, b.engine || null);
      if (b.users !== undefined) P.setUsers(id, Array.isArray(b.users) ? b.users : String(b.users || '').split(/[\s,;]+/));
      if (b.archived !== undefined) P.archive(id, !!b.archived);
      if (b.mode !== undefined) P.setMode(id, b.mode);
      if (b.rules !== undefined) P.setRules(id, b.rules);
      if (b.hoidap !== undefined) P.setHoiDap(id, !!b.hoidap);
      if (b.chungtu !== undefined) { P.setChungTu(id, !!b.chungtu); if (b.chungtu) { try { fs.mkdirSync(path.join(P.dirOf(id), 'CHUNG-TU-MOI'), { recursive: true }); } catch (e) { /* bỏ qua */ } } }
      fixProjectOwner(P.get(id)); return { project: P.get(id) };
    },
    async 'POST /api/projects/instructions'(b) { const P = projectsLib(); P.setInstructions(String(b.id || ''), b.text); fixProjectOwner(P.get(String(b.id))); return { ok: true }; },
    async 'POST /api/projects/schedule/add'(b) { const P = projectsLib(); const j = P.addSchedule(String(b.id || ''), { time: b.time, days: Array.isArray(b.days) ? b.days : [], text: b.text }); fixProjectOwner(P.get(String(b.id))); return { schedule: j }; },
    async 'POST /api/projects/schedule/delete'(b) { return { ok: projectsLib().removeSchedule(String(b.id || ''), Number(b.sid)) }; },
    async 'POST /api/projects/files'(b) { const P = projectsLib(), id = String(b.id || ''); if (!P.get(id)) throw new Error('Không có dự án này.'); return { docs: P.files(id, 'TAI-LIEU'), results: P.files(id, 'KET-QUA'), dir: P.dirOf(id) }; },
    async 'POST /api/projects/delete'(b) {
      if (b.confirm !== true) throw new Error('Cần xác nhận');
      const r = projectsLib().remove(String(b.id || '')); try { chownTree(projectsLib().root()); } catch (e) { /* bỏ qua */ } return r;
    },
    // ---- Kho tệp riêng (Nextcloud trong Docker, do tập lệnh agentos-cloud quản lý)
    async 'GET /api/cloud'() {
      const r = await run(cloudBin, ['status']);
      const kv = {}; const urls = [];
      for (const l of String(r.out || '').split(/\r?\n/)) { const m = l.match(/^(\w+)=(.*)$/); if (!m) continue; if (m[1] === 'url') urls.push(m[2].trim()); else kv[m[1]] = m[2].trim(); }
      return { installed: kv.installed === 'yes', running: kv.running === 'yes', user: kv.user || '', version: kv.version || '', urls, share: kv.share || o.onedriveDir };
    },
    async 'POST /api/cloud/install'() {
      if (busy()) throw new Error('Đang có một công việc khác chạy, đợi xong rồi thử lại.');
      return { job: startJob('Cài kho tệp riêng (Nextcloud)', [[cloudBin, ['install']]]) };
    },
    async 'POST /api/cloud/password'() {
      const r = await run(cloudBin, ['password']); if (r.code !== 0) throw new Error('Chưa cài kho tệp riêng.');
      const m = String(r.out).match(/^password=(.*)$/m), u = String(r.out).match(/^user=(.*)$/m);
      return { user: u ? u[1].trim() : '', password: m ? m[1].trim() : '' };
    },
    async 'POST /api/cloud/reset-password'(b) {
      if (b.confirm !== true) throw new Error('Cần xác nhận');
      const r = await run(cloudBin, ['reset-password']); if (r.code !== 0) throw new Error('Không đổi được mật khẩu: ' + String(r.err || r.out).slice(-200));
      const m = String(r.out).match(/^password=(.*)$/m); return { password: m ? m[1].trim() : '' };
    },
    async 'POST /api/cloud/remove'(b) {
      if (b.confirm !== true) throw new Error('Cần xác nhận');
      if (busy()) throw new Error('Đang có một công việc khác chạy, đợi xong rồi thử lại.');
      return { job: startJob('Gỡ kho tệp riêng', [[cloudBin, ['remove']]]) };
    },
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
      // Google chuyển trình duyệt về đây sau khi chủ máy bấm Cho phép (chỉ loopback + đúng uid chủ máy, mã "state" khớp phiên đã mở)
      if (req.method === 'GET' && url.pathname === '/google/callback') {
        const page = (ok, msg) => { res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end('<!doctype html><meta charset=utf-8><title>Google</title><body style="font:16px system-ui;max-width:520px;margin:12vh auto;padding:0 16px"><h2>' + (ok ? '✅ Đã kết nối Google' : '⚠️ Chưa kết nối được') + '</h2><p>' + String(msg).replace(/[&<>]/g, '') + '</p><p>Đóng tab này và quay lại Cài đặt.</p>'); };
        if (url.searchParams.get('error')) return page(false, 'Google báo: ' + url.searchParams.get('error'));
        const r = await googleAuth.finish({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
        if (!r.ok) return page(false, r.error);
        fixGoogleOwner();
        try { plugLib(); const C = connLib(); if (!C.get('google')) C.addFromCatalog('google'); C.setEnabled('google', true); fixConnOwner(); } catch (e) { /* kết nối thêm tay được */ }
        return page(true, googleAuth.hasWrite() ? 'Đã cho phép ĐỌC và GHI (mọi việc ghi vẫn hỏi anh trước).' : 'Chỉ ĐỌC lịch và thư — an toàn.');
      }
      if (req.method === 'POST' && req.headers['x-agentos-settings'] !== '1') return json(res, 403, { error: 'Thiếu tiêu đề bảo vệ' });
      // LUỒNG TRỰC TIẾP (Server-Sent Events) cho màn hình Việc AI: đẩy từng chữ AI gõ + từng bước ngay khi có, không cần hỏi lại liên tục
      if (req.method === 'GET' && url.pathname === '/api/watch/stream') {
        const id = url.searchParams.get('id'); let from = Math.max(0, Number(url.searchParams.get('from')) || 0), lastSig = -2, closed = false, idle = 0;
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        req.on('close', () => { closed = true; });
        const bk = url.searchParams.get('bot'), bl = bk ? boardLib() : null;
        const w = bl ? { traceSig: (i2) => bl.traceSig(bk, i2), trace: (i2, f2) => bl.trace(bk, i2, f2) } : watchLib();
        for (let i = 0; i < (o.streamMaxTicks || 7200) && !closed; i++) {                       // tối đa ~30 phút một luồng
          const sig = w.traceSig(id);
          if (sig !== lastSig) {
            lastSig = sig; idle = 0;
            const r = await w.trace(id, from); from = r.next;
            res.write('data: ' + JSON.stringify({ events: r.events, next: r.next, done: r.done, todos: r.todos, exists: r.exists }) + '\n\n');
            if (r.done) break;
          } else if (++idle % 40 === 0) res.write(': ping\n\n');
          await new Promise((r2) => setTimeout(r2, o.streamTickMs || 250));
        }
        return res.end();
      }
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
        const lim = /^\/api\/studio\//.test(url.pathname) ? 2 * 1024 * 1024 : 64 * 1024;       // tài liệu soạn trong Xưởng sáng tạo có thể dài
        for await (const c of req) { n += c.length; if (n > lim) return json(res, 413, { error: 'Dữ liệu quá lớn' }); chunks.push(c); }
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
