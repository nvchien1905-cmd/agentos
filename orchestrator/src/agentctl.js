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
const ACTIONS = ['init', 'create', 'remove', 'start', 'stop', 'restart', 'update', 'logs'];

const PATHS = {
  ctl: '/var/lib/agentos-agentctl',            // gốc do root sở hữu; req/ và res/ nằm trong (agentos không đổi được thư mục cha)
  homes: '/var/lib/agentos-agents',
  etc: '/etc/agentos',
  units: '/etc/systemd/system',
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
  if (req.action === 'init') return out;
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
  if (req.action === 'remove') out.purge = req.purge === true;
  if (req.action === 'logs') out.lines = Math.max(5, Math.min(300, Number(req.lines) || 60));
  return out;
}

function unitText(id, meta) {
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
    // Giới hạn tài nguyên RIÊNG của agent: chạy lỗi/ngốn máy chỉ làm chính nó chậm hoặc bị khởi động lại
    'MemoryHigh=' + Math.round(meta.ramMb * 0.85) + 'M',
    'MemoryMax=' + meta.ramMb + 'M',
    'CPUQuota=' + meta.cpuPct + '%',
    'TasksMax=1024',
    'LimitNOFILE=16384',
    // Gia cố + cô lập khỏi bot quản lý và agent khác. KHÔNG đặt RestrictNamespaces/PrivateDevices/ProtectKernelTunables/RestrictSUIDSGID (bubblewrap cần, xem agentos-orchestrator.service).
    'NoNewPrivileges=true',
    'ProtectSystem=strict',
    'ReadWritePaths=' + home,
    'ProtectHome=true',
    'InaccessiblePaths=' + PATHS.etc + ' ' + PATHS.mainHome + ' ' + PATHS.ctl + ' /srv/onedrive /root',
    'PrivateTmp=true',
    'ProtectControlGroups=true',
    'LockPersonality=true',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
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
    'ENGINE_ORDER=claude',
    'WORKDIR=' + home + '/work',
    'DB_PATH=' + home + '/data/agentos.db',
    'TOOLS_FILE=' + PATHS.appDir + '/tools.json',
    'CLAUDE_BIN=' + PATHS.ctl + '/bin/claude',
    'DISABLE_AUTOUPDATER=1',
    'SANDBOX=auto',
    'FULL_ACCESS=0',
    'MIN_FREE_MB=300',
    'ONEDRIVE_DIR=' + home + '/onedrive',
    'JOB_TIMEOUT_SEC=900',
    'PARALLEL_CHATS=2',
    'SUBAGENTS=0',
  ];
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
    const dst = P.ctl + '/bin/claude';
    F.mkdirSync(P.ctl + '/bin', { recursive: true, mode: 0o755 });
    let same = false;
    try { const a = F.statSync(real), b = F.statSync(dst); same = a.size === b.size && b.mtimeMs >= a.mtimeMs; } catch (e) { /* chưa có */ }
    if (!same) { F.copyFileSync(real, dst + '.new'); F.chmodSync(dst + '.new', 0o755); F.renameSync(dst + '.new', dst); }
    return { ok: true };
  }

  async function init() {
    for (const [d, mode] of [[P.ctl, 0o755], [P.ctl + '/req', 0o730], [P.ctl + '/res', 0o750], [P.homes, 0o755], [P.etc + '/agents', 0o700]]) {
      F.mkdirSync(d, { recursive: true });
      try { F.chmodSync(d, mode); } catch (e) { /* bỏ qua */ }
    }
    // req/: agentos được tạo tệp; res/: agentos chỉ đọc
    await sh('chgrp', ['agentos', P.ctl + '/req', P.ctl + '/res']);
    return ok('Đã chuẩn bị thư mục cho agent.');
  }

  async function create(r) {
    const id = r.id;
    if (readMeta(id) || F.existsSync(P.units + '/' + unitName(id) + '.service')) return fail('Agent ' + id + ' đã có.');
    const meta = { id, name: r.name, owners: r.owners, ramMb: r.ramMb, cpuPct: r.cpuPct, createdAt: now() };
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
    writeSecure(P.etc + '/agents/' + id + '.env', env.text, 0o600);
    writeMeta(id, meta);
    F.writeFileSync(P.units + '/' + unitName(id) + '.service', withPaths(() => unitText(id, meta)), { mode: 0o644 });
    await sc('daemon-reload');
    const en = await sc('enable', '--now', unitName(id));
    if (en.code !== 0) return fail('Đã tạo nhưng không bật được dịch vụ: ' + maskTokens(en.out).slice(0, 300));
    return ok('Đã tạo agent ' + id + ' và bật dịch vụ.', { warn });
  }

  async function remove(r) {
    const id = r.id, meta = readMeta(id);
    if (!meta && !F.existsSync(P.units + '/' + unitName(id) + '.service')) return fail('Không có agent ' + id + '.');
    await sc('disable', '--now', unitName(id));
    try { F.rmSync(P.units + '/' + unitName(id) + '.service', { force: true }); } catch (e) { /* bỏ qua */ }
    await sc('daemon-reload'); await sc('reset-failed', unitName(id) + '.service');
    for (const f of [id + '.env', id + '.meta.json']) { try { F.rmSync(P.etc + '/agents/' + f, { force: true }); } catch (e) { /* bỏ qua */ } }
    await sh('userdel', [userName(id)]);
    const home = P.homes + '/' + id;
    let kept = '';
    if (r.purge) { try { F.rmSync(home, { recursive: true, force: true }); } catch (e) { /* bỏ qua */ } }
    else if (F.existsSync(home)) {
      kept = P.homes + '/.da-xoa-' + id + '-' + now();
      F.renameSync(home, kept); try { F.chmodSync(kept, 0o700); } catch (e) { /* bỏ qua */ }
      await sh('chown', ['-R', 'root:root', kept]);
    }
    return ok('Đã xóa agent ' + id + '.', { kept });
  }

  async function update(r) {
    const id = r.id, meta = readMeta(id);
    if (!meta) return fail('Không có agent ' + id + '.');
    const envFile = P.etc + '/agents/' + id + '.env';
    const oldEnv = F.readFileSync(envFile, 'utf8');
    const token = parseEnv(oldEnv).TELEGRAM_TOKEN;
    for (const k of ['name', 'owners', 'ramMb', 'cpuPct']) if (r[k] !== undefined) meta[k] = r[k];
    const mainText = F.existsSync(P.mainEnv) ? F.readFileSync(P.mainEnv, 'utf8') : '';
    const env = withPaths(() => envText(id, meta, token, mainText));
    // Giữ nguyên khóa Claude đã có trong env cũ nếu cấu hình chung không còn
    const keep = env.shared ? '' : oldEnv.split(/\r?\n/).filter((l) => SHARED_KEYS.test(l)).join('\n');
    writeSecure(envFile, env.text + (keep ? keep + '\n' : ''), 0o600);
    writeMeta(id, meta);
    F.writeFileSync(P.units + '/' + unitName(id) + '.service', withPaths(() => unitText(id, meta)), { mode: 0o644 });
    await sc('daemon-reload');
    const rs = await sc('restart', unitName(id));
    if (rs.code !== 0) return fail('Đã lưu nhưng không khởi động lại được: ' + maskTokens(rs.out).slice(0, 300));
    return ok('Đã cập nhật agent ' + id + ' và khởi động lại.');
  }

  async function ctl(verb, r) {
    if (!readMeta(r.id)) return fail('Không có agent ' + r.id + '.');
    const x = await sc(verb, unitName(r.id));
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

  return { handle, drain, init, validate, unitText: (id, meta) => withPaths(() => unitText(id, meta)) };
}

function realRun(bin, args) {
  return new Promise((res) => execFile(bin, args, { timeout: 120000, maxBuffer: 4 << 20 }, (e, so, se) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(so || '') + String(se || '') })));
}

module.exports = { createAgentCtl, validate, unitText, envText, parseEnv, unitName, userName, maskTokens, PATHS, LIMITS, ID_RE, TOKEN_RE };
