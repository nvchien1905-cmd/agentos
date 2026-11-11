'use strict';
// VIỆC CỦA ROOT: tạo / xóa / dừng / đổi giới hạn các AGENT (bot Telegram phụ).
// Mỗi agent = 1 tài khoản hệ thống riêng (agentos-aN) + 1 dịch vụ systemd riêng (agentos-agent-aN) + 1 thư mục riêng
// + giới hạn RAM/CPU riêng. Agent không đọc được /etc/agentos, /var/lib/agentos hay thư mục của agent khác;
// sập một agent không kéo theo agent khác hay bot quản lý.
//
// Bộ điều phối (người dùng `agentos`, KHÔNG phải root) chỉ thả TỆP YÊU CẦU vào req/; agentos-agentctl.path đánh thức tiến trình này (root).
// Vì người gửi yêu cầu kém quyền hơn root, mọi giá trị đều được kiểm lại ở đây, không tin yêu cầu.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ID_RE = /^a\d{1,3}$/;
const RID_RE = /^[a-f0-9]{16}$/;
const TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
const NUM_RE = /^\d{1,15}$/;
const LIMITS = { ramMb: [256, 16384, 1536], cpuPct: [25, 1600, 100] };
// QUYỀN HẠN / CHẾ ĐỘ từng agent (chỉnh ở Cài đặt → Bot Telegram hoặc /daily che-do). Mỗi mục ghi thẳng vào tệp cấu hình của agent; chỉ các khóa dưới đây được nhận.
const SETTINGS = {
  full:        { env: 'FULL_ACCESS', kind: 'bool', def: false, label: 'Toàn quyền trong tài khoản riêng (AI chạy không hỏi duyệt, không hộp cô lập; vẫn KHÔNG có sudo, chỉ ghi được thư mục riêng)' },
  sandbox:     { env: 'SANDBOX', kind: 'enum', values: ['auto', 'off', 'bwrap'], def: 'auto', label: 'Hộp cô lập AI (bubblewrap): auto / off / bwrap' },
  tools:       { env: 'CLAUDE_ALLOWED_TOOLS', kind: 'text', re: /^[A-Za-z0-9_,*():. /-]{0,300}$/, def: 'Read,Glob,Grep', label: 'Công cụ AI được dùng không cần hỏi',
    options: [['Read,Glob,Grep', 'Chỉ xem (đọc tệp, tìm kiếm) — an toàn nhất'], ['Read,Glob,Grep,WebFetch,WebSearch', 'Xem + lên mạng tra cứu'], ['Read,Glob,Grep,Edit,Write', 'Xem + sửa/tạo tệp'], ['Read,Glob,Grep,Edit,Write,Bash', 'Xem + sửa tệp + chạy lệnh'], ['Read,Glob,Grep,Edit,Write,Bash,WebFetch,WebSearch', 'Tất cả công cụ thường dùng']] },
  jobTimeoutMin:      { env: 'JOB_TIMEOUT_SEC', kind: 'int', lo: 1, hi: 480, def: 15, mul: 60, label: 'Thời gian tối đa một việc (phút)' },
  approvalTimeoutMin: { env: 'APPROVAL_TIMEOUT_SEC', kind: 'int', lo: 1, hi: 120, def: 5, mul: 60, label: 'Thời gian chờ chủ duyệt (phút)' },
  parallel:    { env: 'PARALLEL_CHATS', kind: 'int', lo: 1, hi: 6, def: 2, label: 'Số người làm việc cùng lúc' },
  subagents:   { env: 'SUBAGENTS', kind: 'bool', def: false, label: 'Cho AI giao việc cho trợ lý phụ' },
  checkpoints: { env: 'CHECKPOINTS', kind: 'bool', def: true, label: 'Chụp mốc khôi phục trước mỗi việc (/hoantac)' },
  memory:      { env: 'MEMORY_ENABLED', kind: 'bool', def: true, label: 'Bộ nhớ dài hạn' },
  netGuard:    { env: 'NET_GUARD', kind: 'bool', def: true, label: 'Giới hạn mạng của AI (chỉ cổng web)' },
  aiAutoFix:   { env: 'AI_AUTOFIX', kind: 'bool', def: true, label: 'AI tự điều tra và sửa lỗi máy khi tự chẩn đoán thấy lỗi (thay vì chỉ báo)' },
  netExtraPorts: { env: 'NET_EXTRA_PORTS', kind: 'text', re: /^[0-9,]{0,60}$/, def: '', label: 'Cổng mạng mở thêm cho AI (ngoài cổng web)',
    options: [['', 'Không mở thêm'], ['22', 'SSH (22)'], ['3306', 'MySQL (3306)'], ['5432', 'PostgreSQL (5432)'], ['6379', 'Redis (6379)'], ['22,3306,5432', 'SSH + MySQL + PostgreSQL']] },
  subPerJob:   { env: 'SUB_PER_JOB', kind: 'int', lo: 1, hi: 8, def: 4, label: 'Số trợ lý phụ tối đa cho MỘT việc' },
  subTotal:    { env: 'SUB_TOTAL', kind: 'int', lo: 1, hi: 20, def: 8, label: 'Số trợ lý phụ tối đa chạy cùng lúc trên bot' },
  checkpointKeep: { env: 'CHECKPOINT_KEEP', kind: 'int', lo: 3, hi: 100, def: 20, label: 'Giữ bao nhiêu mốc khôi phục gần nhất' },
  jobIdleMin:  { env: 'JOB_IDLE_SEC', kind: 'int', lo: 1, hi: 240, def: 15, mul: 60, label: 'AI im lặng quá bao nhiêu phút thì coi là kẹt và chạy lại (phút)' },
  jobBgHours:  { env: 'JOB_TIMEOUT_BG_SEC', kind: 'int', lo: 1, hi: 48, def: 4, mul: 3600, label: 'Thời gian tối đa một việc chạy nền /nen (giờ)' },
  limitCooldownMin: { env: 'LIMIT_COOLDOWN_MIN', kind: 'int', lo: 1, hi: 720, def: 60, label: 'Hết hạn mức AI thì nghỉ bao lâu rồi thử lại (phút)' },
  routeByDifficulty: { env: 'ROUTE_BY_DIFFICULTY', kind: 'bool', def: true, tf: true, label: 'Tự chọn cách làm theo độ khó của câu hỏi' },
  bootNotice:  { env: 'BOOT_NOTICE', kind: 'bool', def: true, tf: true, label: 'Báo vào Telegram mỗi lần bot khởi động' },
  minFreeMb:   { env: 'MIN_FREE_MB', kind: 'int', lo: 0, hi: 100000, def: 300, label: 'Ổ đĩa còn dưới bao nhiêu MB thì cảnh báo và không nhận việc nặng (MB)' },
  jobRetentionDays:   { env: 'JOB_RETENTION_DAYS', kind: 'int', lo: 1, hi: 3650, def: 90, label: 'Giữ lịch sử việc đã làm bao nhiêu ngày' },
  auditRetentionDays: { env: 'AUDIT_RETENTION_DAYS', kind: 'int', lo: 1, hi: 3650, def: 180, label: 'Giữ nhật ký kiểm tra bao nhiêu ngày' },
  outRetentionDays:   { env: 'OUT_RETENTION_DAYS', kind: 'int', lo: 1, hi: 3650, def: 14, label: 'Giữ tệp kết quả AI tạo ra bao nhiêu ngày' },
  backupKeep:  { env: 'BACKUP_KEEP', kind: 'int', lo: 1, hi: 60, def: 7, label: 'Giữ bao nhiêu bản sao lưu dữ liệu bot' },
};

// Làm sạch cấu hình quyền hạn: chỉ khóa biết, đúng kiểu. Giá trị null = đưa về mặc định.
function validateSettings(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('Cấu hình quyền hạn không hợp lệ');
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    const d = SETTINGS[k]; if (!d) throw new Error('Mục cấu hình lạ: ' + String(k).slice(0, 30));
    if (v === null) { out[k] = null; continue; }
    if (d.kind === 'bool') { if (typeof v !== 'boolean') throw new Error(k + ' phải là bật/tắt'); out[k] = v; }
    else if (d.kind === 'enum') { if (!d.values.includes(v)) throw new Error(k + ' phải là một trong: ' + d.values.join(', ')); out[k] = v; }
    else if (d.kind === 'int') { const n = Number(v); if (!Number.isInteger(n) || n < d.lo || n > d.hi) throw new Error(k + ' phải là số nguyên từ ' + d.lo + ' đến ' + d.hi); out[k] = n; }
    else if (d.kind === 'text') { const x = String(v).trim(); if (!d.re.test(x)) throw new Error(k + ' có ký tự không được phép'); out[k] = x; }
  }
  return out;
}
const settingEnv = (k, v) => { const d = SETTINGS[k]; const val = d.kind === 'bool' ? (d.env === 'MEMORY_ENABLED' || d.tf ? String(!!v) : (v ? '1' : '0')) : d.kind === 'int' ? String(v * (d.mul || 1)) : String(v); return d.env + '=' + val; };

const ACTIONS = ['init', 'create', 'remove', 'start', 'stop', 'restart', 'update', 'logs', 'pool', 'balance'];

const PATHS = {
  ctl: '/var/lib/agentos-agentctl',            // gốc do root sở hữu; req/ và res/ nằm trong (agentos không đổi được thư mục cha)
  homes: '/var/lib/agentos-agents',
  mail: '/var/lib/agentos-agents/.mail',        // hộp thư giao việc bot quản lý <-> bot thường (xem mail.js)
  bin: '/var/lib/agentos-agents/.bin',            // bản Claude dùng chung cho agent (KHÔNG để trong thư mục agentctl: dịch vụ agent bị cấm vào đó)
  etc: '/etc/agentos',
  units: '/etc/systemd/system',
  poolFile: '/etc/agentos/pool.json',            // {enabled, reserveMb}: tài nguyên chung cho mọi bot (reserveMb 0 = tự động)
  mainUnit: 'agentos-orchestrator',
  meminfo: '/proc/meminfo',
  sudoers: '/etc/sudoers.d',                     // tệp sudo riêng cho từng bot được chủ máy cấp quyền (91-agentos-agent-<mã>)
  mainEnv: '/etc/agentos/orchestrator.env',
  mainHome: '/var/lib/agentos',
  appDir: '/opt/agentos/orchestrator',
  node: '/usr/bin/node',
};
const unitName = (id) => 'agentos-agent-' + id;
const userName = (id) => 'agentos-' + id;

function clamp(key, v) {
  const [lo, hi, def] = LIMITS[key];
  const n = Number(v);
  if (v === undefined || v === null || v === '') return def;
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(key + ' phải từ ' + lo + ' đến ' + hi);
  return Math.round(n);
}

// Kiểm yêu cầu; trả về bản đã làm sạch (chỉ các trường được biết).
function validate(req) {
  if (!req || typeof req !== 'object') throw new Error('Yêu cầu không phải đối tượng');
  if (!RID_RE.test(String(req.rid || ''))) throw new Error('Mã yêu cầu sai');
  if (!ACTIONS.includes(req.action)) throw new Error('Việc không hợp lệ: ' + req.action);
  const out = { rid: req.rid, action: req.action };
  if (req.action === 'init' || req.action === 'balance') return out;
  if (req.action === 'pool') {                                        // tài nguyên chung: bật/tắt + phần RAM để lại cho hệ thống (0 = tự động)
    if (req.enabled !== undefined) { if (typeof req.enabled !== 'boolean') throw new Error('enabled phải là true/false'); out.enabled = req.enabled; }
    if (req.reserveMb !== undefined) { const n = Number(req.reserveMb); if (!Number.isInteger(n) || n < 0 || n > 65536) throw new Error('reserveMb phải từ 0 đến 65536'); out.reserveMb = n; }
    return out;
  }
  if (!ID_RE.test(String(req.id || ''))) throw new Error('Mã agent sai');
  out.id = req.id;
  if (req.action === 'create') {
    if (!TOKEN_RE.test(String(req.token || ''))) throw new Error('Token bot sai dạng');
    out.token = req.token;
  }
  if (req.action === 'create' || req.action === 'update') {
    if (req.owners !== undefined || req.action === 'create') {
      const o = Array.isArray(req.owners) ? req.owners.map(String) : [];
      if (!o.length || o.length > 20 || !o.every((x) => NUM_RE.test(x))) throw new Error('Danh sách ID chủ không hợp lệ');
      out.owners = [...new Set(o)];
    }
    if (req.name !== undefined || req.action === 'create') {
      const name = String(req.name || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 40);
      if (!name) throw new Error('Thiếu tên agent');
      out.name = name;
    }
    if (req.ramMb !== undefined || req.action === 'create') out.ramMb = clamp('ramMb', req.ramMb);
    if (req.cpuPct !== undefined || req.action === 'create') out.cpuPct = clamp('cpuPct', req.cpuPct);
  }
  if (req.action === 'update' && req.sudo !== undefined) { if (typeof req.sudo !== 'boolean') throw new Error('sudo phải là true/false'); out.sudo = req.sudo; }
  if ((req.action === 'create' || req.action === 'update') && req.settings !== undefined) out.settings = validateSettings(req.settings);
  if (req.action === 'remove') out.purge = req.purge === true;
  if (req.action === 'logs') out.lines = Math.max(5, Math.min(300, Number(req.lines) || 60));
  return out;
}

function unitText(id, meta, pool) {
  const home = PATHS.homes + '/' + id;
  return [
    '# Tạo bởi agentos-agentctl. Sửa tay sẽ bị ghi đè khi đổi giới hạn.',
    '[Unit]',
    'Description=AgentOS - agent ' + id + ' (' + String(meta.name).replace(/[\r\n]/g, ' ') + ')',
    'After=network-online.target',
    'Wants=network-online.target',
    'OnFailure=agentos-alert@%n.service',
    'StartLimitIntervalSec=600',
    'StartLimitBurst=15',
    '',
    '[Service]',
    'Type=notify',
    'NotifyAccess=all',
    'WatchdogSec=90',
    'User=' + userName(id),
    'Group=' + userName(id),
    'WorkingDirectory=' + PATHS.appDir,
    'EnvironmentFile=' + PATHS.etc + '/agents/' + id + '.env',
    'Environment=HOME=' + home,
    'ExecStart=' + PATHS.node + ' src/index.js',
    'Restart=always',
    'RestartSec=5',
    'TimeoutStopSec=30',
    'KillMode=control-group',
  ].concat(pool && pool.enabled ? [
    // TÀI NGUYÊN CHUNG: mọi bot nằm trong một nhóm (agentos-bots.slice) có trần RAM chung; không đặt trần riêng nên bot chạy một mình dùng được cả nhóm.
    // Khi nhiều bot cùng chạy, agentctl 'balance' đặt MemoryLow = phần chia đều cho mỗi bot đang chạy (hết RAM thì phần vượt mức bị thu hồi trước); CPU chia theo trọng số bằng nhau.
    'Slice=agentos-bots.slice',
    'CPUWeight=100',
  ] : [
    // Giới hạn tài nguyên RIÊNG của agent: chạy lỗi/ngốn máy chỉ làm chính nó chậm hoặc bị khởi động lại
    'MemoryHigh=' + Math.round(meta.ramMb * 0.85) + 'M',
    'MemoryMax=' + meta.ramMb + 'M',
    'CPUQuota=' + meta.cpuPct + '%',
  ]).concat([
    'TasksMax=1024',
    'LimitNOFILE=16384',
  ]).concat(meta.sudo ? [
    // Bot được chủ máy cấp SUDO: gỡ cô lập để sudo chạy được (NoNewPrivileges chặn sudo, ProtectSystem chặn ghi hệ thống, InaccessiblePaths che dữ liệu bot khác). Vẫn giữ giới hạn RAM/CPU ở trên.
    '# SUDO: bot này có quyền quản trị cả máy (chủ máy cấp ở Cài đặt → Bot Telegram)',
  ] : [
    // Gia cố + cô lập khỏi bot quản lý và agent khác. KHÔNG đặt RestrictNamespaces/PrivateDevices/ProtectKernelTunables/RestrictSUIDSGID (bubblewrap cần, xem agentos-orchestrator.service).
    'NoNewPrivileges=true',
    'ProtectSystem=strict',
    'ReadWritePaths=' + home,
    'ReadWritePaths=-' + PATHS.mail + '/' + id,
    'ProtectHome=true',
    'InaccessiblePaths=' + PATHS.etc + ' ' + PATHS.mainHome + ' ' + PATHS.ctl + ' /srv/onedrive /root',
    'PrivateTmp=true',
    'ProtectControlGroups=true',
    'LockPersonality=true',
  ]).concat([
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ]).join('\n');
}

// Các dòng được chép từ cấu hình của bot quản lý sang agent: CHỈ khóa đăng nhập Claude. Không chép token bot quản lý, khóa KiotViet, Google...
const SHARED_KEYS = /^(CLAUDE_CODE_OAUTH_TOKEN|AGENTOS_KEY_CLAUDE)=/;

function envText(id, meta, token, mainEnvText) {
  const home = PATHS.homes + '/' + id;
  const owners = meta.owners.join(',');
  const lines = [
    '# Tạo bởi agentos-agentctl cho agent ' + id + '. KHÔNG sửa tay: dùng /daily trên bot quản lý.',
    'TELEGRAM_TOKEN=' + token,
    'ALLOWED_USER_IDS=' + owners,
    'ADMIN_USER_IDS=' + owners,
    'AGENT_ID=' + id,
    'AGENT_NAME=' + String(meta.name).replace(/[\r\n]/g, ' '),
    'MAIL_ROOT=' + PATHS.mail,
    'ENGINE_ORDER=claude',
    'WORKDIR=' + home + '/work',
    'DB_PATH=' + home + '/data/agentos.db',
    'TOOLS_FILE=' + PATHS.appDir + '/tools.json',
    'CLAUDE_BIN=' + PATHS.bin + '/claude',
    'DISABLE_AUTOUPDATER=1',
    'SANDBOX=auto',
    'FULL_ACCESS=0',
    'MIN_FREE_MB=300',
    'ONEDRIVE_DIR=' + home + '/onedrive',
    'JOB_TIMEOUT_SEC=900',
    'PARALLEL_CHATS=2',
    'SUBAGENTS=0',
  ];
  for (const [k, v] of Object.entries(meta.settings || {})) {
    if (!SETTINGS[k] || v === null || v === undefined) continue;
    const line = settingEnv(k, v), key = line.slice(0, line.indexOf('=') + 1);
    const i = lines.findIndex((l) => l.startsWith(key)); if (i >= 0) lines.splice(i, 1);
    lines.push(line);
  }
  let shared = 0;
  for (const l of String(mainEnvText || '').split(/\r?\n/)) {
    if (SHARED_KEYS.test(l) && !/[\0]/.test(l)) { lines.push(l.trim()); shared++; }
  }
  return { text: lines.join('\n') + '\n', shared };
}

function parseEnv(text) {
  const m = {};
  for (const l of String(text || '').split(/\r?\n/)) { const x = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (x) m[x[1]] = x[2]; }
  return m;
}

const maskTokens = (s) => String(s || '').replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, '[token]').replace(/sk-ant-[A-Za-z0-9_-]+/g, '[khóa]');

// deps: { run(bin,args)->Promise<{code,out}>, fs, now, paths }  (tests thay thế)
function createAgentCtl(deps) {
  deps = deps || {};
  const P = Object.assign({}, PATHS, deps.paths || {});
  const run = deps.run || realRun;
  const F = deps.fs || fs;
  const now = deps.now || Date.now;
  // Giữ các hàm dựng nội dung dùng đường dẫn của P
  const savedPaths = Object.assign({}, PATHS);
  const withPaths = (fn) => { Object.assign(PATHS, P); try { return fn(); } finally { Object.assign(PATHS, savedPaths); } };
  const ok = (msg, extra) => Object.assign({ ok: true, msg }, extra || {});
  const fail = (msg) => ({ ok: false, msg });
  const sh = async (bin, args) => { const r = await run(bin, args); return r; };
  const sc = (...a) => sh('systemctl', a);

  function writeSecure(file, text, mode) {
    const tmp = file + '.tmp-' + process.pid;
    F.writeFileSync(tmp, text, { mode: mode || 0o600, flag: 'w' });
    F.renameSync(tmp, file);
    try { F.chmodSync(file, mode || 0o600); } catch (e) { /* bỏ qua */ }
  }
  const readMeta = (id) => { try { return JSON.parse(F.readFileSync(P.etc + '/agents/' + id + '.meta.json', 'utf8')); } catch (e) { return null; } };
  const writeMeta = (id, m) => writeSecure(P.etc + '/agents/' + id + '.meta.json', JSON.stringify(m, null, 1), 0o600);

  // Chép bản Claude dùng chung (agent không đọc được thư mục của bot quản lý nên cần bản riêng, chủ là root).
  async function ensureClaudeBin() {
    const main = parseEnv(F.existsSync(P.mainEnv) ? F.readFileSync(P.mainEnv, 'utf8') : '');
    const src = main.CLAUDE_BIN || P.mainHome + '/.local/bin/claude';
    let real; try { real = F.realpathSync(src); } catch (e) { return { ok: false, msg: 'Không thấy chương trình Claude (' + src + ') để chia sẻ cho agent.' }; }
    const dst = P.bin + '/claude';
    F.mkdirSync(P.bin, { recursive: true, mode: 0o755 }); try { F.chmodSync(P.bin, 0o755); } catch (e) { /* bỏ qua */ }
    let same = false;
    try { const a = F.statSync(real), b = F.statSync(dst); same = a.size === b.size && b.mtimeMs >= a.mtimeMs; } catch (e) { /* chưa có */ }
    if (!same) { F.copyFileSync(real, dst + '.new'); F.chmodSync(dst + '.new', 0o755); F.renameSync(dst + '.new', dst); }
    // Chủ phải là root: bot quản lý (agentos) mà thay được tệp này thì chạy được mã tùy ý trong mọi bot thường
    await sh('chown', ['root:root', dst]);
    return { ok: true };
  }

  // Hộp thư giao việc của agent: in = agentos ghi / agent đọc+xóa; out = agent ghi / agentos đọc+xóa; agent khác không vào được (mục 711 chỉ cho đi qua)
  async function ensureMail(id) {
    const user = userName(id), d = P.mail + '/' + id;
    for (const [p, mode] of [[P.mail, 0o711], [d, 0o711], [d + '/in', 0o2770], [d + '/out', 0o2770]]) { F.mkdirSync(p, { recursive: true }); try { F.chmodSync(p, mode); } catch (e) { /* bỏ qua */ } }
    await sh('chown', ['agentos:' + user, d + '/in']);
    await sh('chown', [user + ':agentos', d + '/out']);
  }

  // Tệp sudo riêng cho một bot: kiểm bằng `visudo -cf` TRƯỚC khi vào chỗ (tệp hỏng làm hỏng sudo cả máy). on=false: xóa.
  async function applySudo(id, on) {
    const f = P.sudoers + '/91-agentos-agent-' + id;
    if (!on) { F.rmSync(f, { force: true }); return; }
    const tmp = f + '.tmp';                                      // tên có dấu chấm: sudo bỏ qua khi chưa kiểm
    F.mkdirSync(P.sudoers, { recursive: true });
    F.writeFileSync(tmp, '# AgentOS: chủ máy cấp quyền quản trị (sudo) cho bot ' + id + '. Gỡ: tắt ở Cài đặt → Bot Telegram.\n' + userName(id) + ' ALL=(ALL:ALL) NOPASSWD: ALL\n', { mode: 0o440 });
    const v = await sh('visudo', ['-cf', tmp]);
    if (v.code !== 0) { F.rmSync(tmp, { force: true }); throw new Error('tệp sudo không hợp lệ'); }
    F.renameSync(tmp, f);
    try { F.chmodSync(f, 0o440); } catch (e) { /* bỏ qua */ }
  }

  // ===== TÀI NGUYÊN CHUNG (RAM/CPU): mọi bot, kể cả bot quản lý, nằm trong agentos-bots.slice =====
  // Trần RAM = tổng RAM trừ phần để lại cho hệ thống. Bot chạy MỘT mình dùng được cả trần; N bot cùng chạy thì mỗi bot được bảo đảm trần/N
  // (MemoryLow đặt lại mỗi khi bot chạy/dừng và 5 phút/lần; chỉ có tác dụng khi hết RAM, lúc đó phần vượt mức bị thu hồi trước). CPU: trọng số bằng nhau.
  function readPool() {
    let j = {}; try { j = JSON.parse(F.readFileSync(P.poolFile, 'utf8')); } catch (e) { /* chưa có: mặc định BẬT */ }
    return { enabled: j.enabled !== false, reserveMb: Number.isInteger(j.reserveMb) && j.reserveMb >= 0 ? j.reserveMb : 0 };
  }
  function memTotalMb() {
    if (deps.memTotalMb) return deps.memTotalMb;
    try { const m = F.readFileSync(P.meminfo, 'utf8').match(/^MemTotal:\s+(\d+) kB/m); if (m) return Math.floor(Number(m[1]) / 1024); } catch (e) { /* bỏ qua */ }
    return 4096;
  }
  function poolSizes(pool) {
    const total = memTotalMb(), reserve = pool.reserveMb || Math.max(1024, Math.round(total * 0.15));
    return { totalMb: total, reserveMb: reserve, maxMb: Math.max(512, total - reserve) };
  }
  const botUnits = () => {
    const out = [{ unit: P.mainUnit, name: 'Bot quản lý' }];
    let files = []; try { files = F.readdirSync(P.etc + '/agents'); } catch (e) { /* chưa có agent */ }
    for (const f of files.sort()) { const m = f.match(/^(a\d{1,3})\.meta\.json$/); if (m) { const mt = readMeta(m[1]); out.push({ unit: unitName(m[1]), name: mt ? mt.name : m[1] }); } }
    return out;
  };
  // Đặt MemoryLow cho từng bot ĐANG CHẠY = trần / số bot đang chạy
  async function balance() {
    const pool = readPool();
    if (!pool.enabled) return ok('Tài nguyên chung đang tắt.');
    const sz = poolSizes(pool), active = [];
    for (const b of botUnits()) { const a = await sc('is-active', b.unit); if (a.code === 0) active.push(b); }
    const per = Math.floor(sz.maxMb / Math.max(1, active.length));
    for (const b of active) await sc('set-property', '--runtime', b.unit, 'MemoryLow=' + per + 'M');
    return ok('Đã chia ' + sz.maxMb + ' MB cho ' + active.length + ' bot đang chạy (mỗi bot được bảo đảm ' + per + ' MB).', { maxMb: sz.maxMb, active: active.length, perMb: per });
  }
  // Ghi nhóm tài nguyên + cấu hình bot quản lý, viết lại tệp dịch vụ mọi bot, khởi động lại bot nào có tệp đổi (bot quản lý: khởi động lại không chặn)
  async function applyPool(opts) {
    opts = opts || {};
    const pool = readPool(), sliceF = P.units + '/agentos-bots.slice', dropDir = P.units + '/' + P.mainUnit + '.service.d', dropF = dropDir + '/20-pool.conf';
    let mainChanged = false;
    if (pool.enabled) {
      const sz = poolSizes(pool);
      F.writeFileSync(sliceF, ['# Tạo bởi agentos-agentctl: tài nguyên chung cho mọi bot (Cài đặt → Bot Telegram → Tài nguyên chung)', '[Unit]', 'Description=AgentOS - tài nguyên chung cho mọi bot', '[Slice]',
        'MemoryHigh=' + sz.maxMb + 'M', 'MemoryMax=' + sz.maxMb + 'M', 'MemoryLow=' + sz.maxMb + 'M', 'CPUWeight=100', ''].join('\n'), { mode: 0o644 });
      const want = ['# Tạo bởi agentos-agentctl: bot quản lý dùng chung nhóm tài nguyên với các bot khác', '[Service]', 'Slice=agentos-bots.slice', 'MemoryHigh=infinity', 'MemoryMax=infinity', 'CPUWeight=100', ''].join('\n');
      let cur = ''; try { cur = F.readFileSync(dropF, 'utf8'); } catch (e) { /* chưa có */ }
      if (cur !== want) { F.mkdirSync(dropDir, { recursive: true }); F.writeFileSync(dropF, want, { mode: 0o644 }); mainChanged = true; }
    } else {
      try { F.rmSync(sliceF, { force: true }); } catch (e) { /* bỏ qua */ }
      if (F.existsSync(dropF)) { F.rmSync(dropF, { force: true }); mainChanged = true; }
    }
    await sc('daemon-reload');
    let moved = 0;
    for (const b of botUnits().slice(1)) {
      const id = b.unit.replace(/^agentos-agent-/, ''), meta = readMeta(id); if (!meta) continue;
      const uf = P.units + '/' + b.unit + '.service', text = withPaths(() => unitText(id, meta, pool));
      let old = ''; try { old = F.readFileSync(uf, 'utf8'); } catch (e) { /* chưa có */ }
      if (old !== text) { F.writeFileSync(uf, text, { mode: 0o644 }); moved++; }
    }
    if (moved) await sc('daemon-reload');
    for (const b of botUnits().slice(1)) { const a = await sc('is-active', b.unit); if (moved && a.code === 0) await sc('restart', b.unit); }
    if (mainChanged && opts.restartMain !== false) await sc('restart', '--no-block', P.mainUnit);
    await balance();
    return ok(pool.enabled ? 'Đã bật tài nguyên chung.' : 'Đã tắt tài nguyên chung (mỗi bot dùng giới hạn riêng).', { moved, mainChanged });
  }
  async function poolStatus() {
    const pool = readPool(), sz = poolSizes(pool), active = [];
    for (const b of botUnits()) { const a = await sc('is-active', b.unit); if (a.code === 0) active.push(b.name); }
    let usedMb = null;
    if (pool.enabled) { const r = await sc('show', 'agentos-bots.slice', '-p', 'MemoryCurrent'); const m = String(r.out || '').match(/MemoryCurrent=(\d+)/); if (m && Number(m[1]) < 1e15) usedMb = Math.round(Number(m[1]) / 1048576); }
    return Object.assign({ enabled: pool.enabled, autoReserve: !pool.reserveMb, active, perMb: Math.floor(sz.maxMb / Math.max(1, active.length)), usedMb }, sz);
  }

  async function init() {
    for (const [d, mode] of [[P.ctl, 0o755], [P.ctl + '/req', 0o730], [P.ctl + '/res', 0o750], [P.homes, 0o755], [P.etc + '/agents', 0o700]]) {
      F.mkdirSync(d, { recursive: true });
      try { F.chmodSync(d, mode); } catch (e) { /* bỏ qua */ }
    }
    // req/: agentos được tạo tệp; res/: agentos chỉ đọc
    await sh('chgrp', ['agentos', P.ctl + '/req', P.ctl + '/res']);
    // Agent đã có từ bản cũ: thêm hộp thư + cập nhật tệp cấu hình/dịch vụ; chỉ khởi động lại agent nào có tệp dịch vụ đổi (không làm gián đoạn agent khác)
    let moved = 0;
    try { await ensureClaudeBin(); } catch (e) { /* chưa có Claude để chia sẻ: bỏ qua */ }
    let files = []; try { files = F.readdirSync(P.etc + '/agents'); } catch (e) { /* chưa có agent nào */ }
    for (const f of files) {
      const m = f.match(/^(a\d{1,3})\.meta\.json$/); if (!m) continue;
      const id = m[1], meta = readMeta(id); if (!meta) continue;
      const envFile = P.etc + '/agents/' + id + '.env';
      let envOld = ''; try { envOld = F.readFileSync(envFile, 'utf8'); } catch (e) { continue; }
      await ensureMail(id);
      let envNew = envOld;
      if (!/^MAIL_ROOT=/m.test(envNew)) envNew = envNew.replace(/\n*$/, '\n') + 'MAIL_ROOT=' + P.mail + '\n';
      // Bản cũ để Claude trong thư mục agentctl mà dịch vụ agent bị cấm vào → agent không chạy được AI ("Permission denied"): chuyển sang thư mục dùng chung
      if (/^CLAUDE_BIN=/m.test(envNew) && !envNew.includes('CLAUDE_BIN=' + P.bin + '/claude\n')) envNew = envNew.replace(/^CLAUDE_BIN=.*$/m, 'CLAUDE_BIN=' + P.bin + '/claude');
      const envChanged = envNew !== envOld;
      if (envChanged) F.writeFileSync(envFile, envNew, { mode: 0o600 });
      const uf = P.units + '/' + unitName(id) + '.service', text = withPaths(() => unitText(id, meta, readPool()));
      let old = ''; try { old = F.readFileSync(uf, 'utf8'); } catch (e) { /* chưa có */ }
      if (old !== text || envChanged) { F.writeFileSync(uf, text, { mode: 0o644 }); moved++; await sc('daemon-reload'); await sc('restart', unitName(id)); }
    }
    await applyPool({ restartMain: false });
    return ok('Đã chuẩn bị thư mục cho agent.' + (moved ? ' Đã nâng cấp ' + moved + ' agent (thêm hộp thư giao việc).' : ''));
  }

  async function create(r) {
    const id = r.id;
    if (readMeta(id) || F.existsSync(P.units + '/' + unitName(id) + '.service')) return fail('Agent ' + id + ' đã có.');
    const meta = { id, name: r.name, owners: r.owners, ramMb: r.ramMb, cpuPct: r.cpuPct, settings: r.settings || {}, createdAt: now() };
    const claude = await ensureClaudeBin(); if (!claude.ok) return fail(claude.msg);
    F.mkdirSync(P.etc + '/agents', { recursive: true, mode: 0o700 }); F.mkdirSync(P.homes, { recursive: true, mode: 0o755 }); F.chmodSync(P.homes, 0o755);   // 755 (không phải 711): bubblewrap trong agent cần ĐỌC thư mục cha mới gắn được thư mục riêng
    const home = P.homes + '/' + id;
    const user = userName(id);
    const has = await sh('id', ['-u', user]);
    if (has.code !== 0) {
      const u = await sh('useradd', ['--system', '--user-group', '--home-dir', home, '--no-create-home', '--shell', '/usr/sbin/nologin', user]);
      if (u.code !== 0) return fail('Không tạo được tài khoản hệ thống: ' + maskTokens(u.out).slice(0, 200));
    }
    for (const d of [home, home + '/data', home + '/work', home + '/onedrive']) F.mkdirSync(d, { recursive: true });
    const mainText = F.existsSync(P.mainEnv) ? F.readFileSync(P.mainEnv, 'utf8') : '';
    const env = withPaths(() => envText(id, meta, r.token, mainText));
    let warn = '';
    if (!env.shared) {
      // Chưa có token/khóa Claude dùng chung: chép tệp đăng nhập hiện có (bản riêng của agent)
      const cred = P.mainHome + '/.claude/.credentials.json', cj = P.mainHome + '/.claude.json';
      if (F.existsSync(cred)) {
        F.mkdirSync(home + '/.claude', { recursive: true });
        F.copyFileSync(cred, home + '/.claude/.credentials.json');
        if (F.existsSync(cj)) F.copyFileSync(cj, home + '/.claude.json');
        warn = 'Agent dùng BẢN SAO phiên đăng nhập Claude của máy. Nếu agent báo hết phiên, đăng nhập riêng cho agent hoặc đặt token dài hạn (claude setup-token) trong Cài đặt.';
      } else warn = 'Chưa tìm thấy đăng nhập Claude để chia sẻ: agent sẽ chưa trả lời được cho tới khi có token/khóa Claude.';
    }
    await sh('chown', ['-R', user + ':' + user, home]);
    F.chmodSync(home, 0o700);
    await ensureMail(id);
    writeSecure(P.etc + '/agents/' + id + '.env', env.text, 0o600);
    writeMeta(id, meta);
    F.writeFileSync(P.units + '/' + unitName(id) + '.service', withPaths(() => unitText(id, meta, readPool())), { mode: 0o644 });
    if (readPool().enabled && !F.existsSync(P.units + '/agentos-bots.slice')) await applyPool({ restartMain: false });   // máy chưa có nhóm tài nguyên chung: tạo trước khi bật bot
    await sc('daemon-reload');
    const en = await sc('enable', '--now', unitName(id));
    if (en.code !== 0) return fail('Đã tạo nhưng không bật được dịch vụ: ' + maskTokens(en.out).slice(0, 300));
    await balance().catch(() => {});
    return ok('Đã tạo agent ' + id + ' và bật dịch vụ.', { warn });
  }

  async function remove(r) {
    const id = r.id, meta = readMeta(id);
    if (!meta && !F.existsSync(P.units + '/' + unitName(id) + '.service')) return fail('Không có agent ' + id + '.');
    await sc('disable', '--now', unitName(id));
    try { F.rmSync(P.units + '/' + unitName(id) + '.service', { force: true }); } catch (e) { /* bỏ qua */ }
    await sc('daemon-reload'); await sc('reset-failed', unitName(id) + '.service');
    for (const f of [id + '.env', id + '.meta.json']) { try { F.rmSync(P.etc + '/agents/' + f, { force: true }); } catch (e) { /* bỏ qua */ } }
    try { F.rmSync(P.sudoers + '/91-agentos-agent-' + id, { force: true }); } catch (e) { /* bỏ qua */ }
    await sh('userdel', [userName(id)]);
    try { F.rmSync(P.mail + '/' + id, { recursive: true, force: true }); } catch (e) { /* bỏ qua */ }
    const home = P.homes + '/' + id;
    let kept = '';
    if (r.purge) { try { F.rmSync(home, { recursive: true, force: true }); } catch (e) { /* bỏ qua */ } }
    else if (F.existsSync(home)) {
      kept = P.homes + '/.da-xoa-' + id + '-' + now();
      F.renameSync(home, kept); try { F.chmodSync(kept, 0o700); } catch (e) { /* bỏ qua */ }
      await sh('chown', ['-R', 'root:root', kept]);
    }
    await balance().catch(() => {});
    return ok('Đã xóa agent ' + id + '.', { kept });
  }

  async function update(r) {
    const id = r.id, meta = readMeta(id);
    if (!meta) return fail('Không có agent ' + id + '.');
    const envFile = P.etc + '/agents/' + id + '.env';
    const oldEnv = F.readFileSync(envFile, 'utf8');
    const token = parseEnv(oldEnv).TELEGRAM_TOKEN;
    for (const k of ['name', 'owners', 'ramMb', 'cpuPct']) if (r[k] !== undefined) meta[k] = r[k];
    if (r.settings) { meta.settings = Object.assign({}, meta.settings); for (const [k, v] of Object.entries(r.settings)) { if (v === null) delete meta.settings[k]; else meta.settings[k] = v; } }
    // SUDO: chỉ có nghĩa khi bot ở chế độ Toàn quyền (AI không hộp cô lập). Cấp sudo → tự bật Toàn quyền; tắt Toàn quyền → thu sudo.
    if (r.sudo === true) { meta.settings = Object.assign({}, meta.settings, { full: true }); meta.sudo = true; }
    else if (r.sudo === false) meta.sudo = false;
    if (!(meta.settings && meta.settings.full === true)) meta.sudo = false;
    try { await applySudo(id, meta.sudo === true); } catch (e) { return fail('Không cấp được sudo: ' + maskTokens(e && e.message).slice(0, 200)); }
    const mainText = F.existsSync(P.mainEnv) ? F.readFileSync(P.mainEnv, 'utf8') : '';
    const env = withPaths(() => envText(id, meta, token, mainText));
    // Giữ nguyên khóa Claude đã có trong env cũ nếu cấu hình chung không còn
    const keep = env.shared ? '' : oldEnv.split(/\r?\n/).filter((l) => SHARED_KEYS.test(l)).join('\n');
    writeSecure(envFile, env.text + (keep ? keep + '\n' : ''), 0o600);
    writeMeta(id, meta);
    F.writeFileSync(P.units + '/' + unitName(id) + '.service', withPaths(() => unitText(id, meta, readPool())), { mode: 0o644 });
    await sc('daemon-reload');
    const rs = await sc('restart', unitName(id));
    if (rs.code !== 0) return fail('Đã lưu nhưng không khởi động lại được: ' + maskTokens(rs.out).slice(0, 300));
    await balance().catch(() => {});
    return ok('Đã cập nhật agent ' + id + ' và khởi động lại.');
  }

  async function ctl(verb, r) {
    if (!readMeta(r.id)) return fail('Không có agent ' + r.id + '.');
    const x = await sc(verb, unitName(r.id));
    if (x.code === 0) await balance().catch(() => {});
    return x.code === 0 ? ok('Đã ' + ({ start: 'chạy', stop: 'dừng', restart: 'khởi động lại' }[verb]) + ' agent ' + r.id + '.') : fail('Lỗi: ' + maskTokens(x.out).slice(0, 300));
  }

  async function logs(r) {
    if (!readMeta(r.id)) return fail('Không có agent ' + r.id + '.');
    const x = await sh('journalctl', ['-u', unitName(r.id) + '.service', '-n', String(r.lines), '--no-pager', '-q', '-o', 'short-iso']);
    return ok('Nhật ký agent ' + r.id, { text: maskTokens(x.out).slice(-6000) });
  }

  async function handle(raw) {
    let r;
    try { r = validate(raw); } catch (e) { return fail(e.message); }
    try {
      switch (r.action) {
        case 'init': return await init();
        case 'create': return await create(r);
        case 'remove': return await remove(r);
        case 'update': return await update(r);
        case 'start': case 'stop': case 'restart': return await ctl(r.action, r);
        case 'logs': return await logs(r);
        case 'balance': return await balance();
        case 'pool': {
          const cur = readPool(), next = { enabled: r.enabled === undefined ? cur.enabled : r.enabled, reserveMb: r.reserveMb === undefined ? cur.reserveMb : r.reserveMb };
          F.mkdirSync(P.etc, { recursive: true }); writeSecure(P.poolFile, JSON.stringify(next), 0o644);
          return await applyPool();
        }
        default: return fail('Việc không hợp lệ');
      }
    } catch (e) { return fail('Lỗi: ' + maskTokens(e && e.message)); }
  }

  // Xử lý mọi tệp trong req/: không đi theo liên kết tượng trưng, ghi kết quả bằng tệp mới (không ghi xuyên liên kết).
  async function drain() {
    const dir = P.ctl + '/req', res = P.ctl + '/res';
    let names = [];
    try { names = F.readdirSync(dir).filter((n) => /^[a-f0-9]{16}\.json$/.test(n)).sort(); } catch (e) { return 0; }
    let n = 0;
    for (const name of names) {
      const f = dir + '/' + name, rid = name.slice(0, 16);
      let result;
      try {
        const st = F.lstatSync(f);
        if (!st.isFile() || st.nlink > 1 || st.size > 4096) throw new Error('Tệp yêu cầu không hợp lệ');
        const fd = F.openSync(f, F.constants.O_RDONLY | (F.constants.O_NOFOLLOW || 0));
        let text; try { text = F.readFileSync(fd, 'utf8'); } finally { F.closeSync(fd); }
        const req = JSON.parse(text); req.rid = rid;
        result = await handle(req);
      } catch (e) { result = fail('Yêu cầu hỏng: ' + maskTokens(e && e.message)); }
      try { F.rmSync(f, { force: true }); } catch (e) { /* bỏ qua */ }
      try {
        const out = res + '/' + rid + '.json', tmp = out + '.tmp';
        F.rmSync(tmp, { force: true });
        const fd = F.openSync(tmp, 'wx', 0o640); try { F.writeSync(fd, JSON.stringify(Object.assign({ at: now() }, result))); } finally { F.closeSync(fd); }
        try { F.chmodSync(tmp, 0o640); } catch (e) { /* bỏ qua */ }
        F.renameSync(tmp, out);
        try { await sh('chgrp', ['agentos', out]); } catch (e) { /* bỏ qua */ }
      } catch (e) { /* không ghi được kết quả: bên gửi sẽ hết hạn chờ */ }
      n++;
    }
    // Dọn kết quả cũ > 10 phút
    try { for (const f of F.readdirSync(res)) { const p = res + '/' + f; if (Date.now() - F.lstatSync(p).mtimeMs > 600000) F.rmSync(p, { force: true }); } } catch (e) { /* bỏ qua */ }
    return n;
  }

  return { handle, drain, init, validate, unitText: (id, meta, pool) => withPaths(() => unitText(id, meta, pool)), poolStatus, balance, applyPool, readPool };
}

function realRun(bin, args) {
  return new Promise((res) => execFile(bin, args, { timeout: 120000, maxBuffer: 4 << 20 }, (e, so, se) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(so || '') + String(se || '') })));
}

module.exports = { createAgentCtl, validate, validateSettings, settingEnv, SETTINGS, unitText, envText, parseEnv, unitName, userName, maskTokens, PATHS, LIMITS, ID_RE, TOKEN_RE };
