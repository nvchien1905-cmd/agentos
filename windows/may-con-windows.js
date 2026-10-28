'use strict';
// MÁY CON WINDOWS cho Đội máy AgentOS: máy Windows này hiện trong /may của máy đầu não như một máy con.
//  - Dùng CHUNG giao thức và mã bảo mật với máy con Linux (fleet.js: ký HMAC-SHA256, chống phát lại, lệch giờ > 60 giây bị từ chối).
//  - Việc nhận được chạy bằng AI dòng lệnh đã cài trên máy này (Claude Code `claude -p` hoặc Codex `codex exec`) ở chế độ CHỈ ĐỌC:
//    chỉ đọc/tìm tệp trong thư mục làm việc, không ghi tệp, không chạy lệnh. (Cho phép ghi/chạy lệnh là quyết định riêng của chủ máy, mặc định TẮT.)
//  - Chỉ nghe trên địa chỉ Tailscale (nếu có) hoặc mạng nội bộ; không bao giờ mở ra Internet.
// Cấu hình: %ProgramData%\AgentOS\fleet.json (khóa, cổng, tên — do cai-dat.ps1 tạo) và windows-agent.json cạnh nó: { "ai": "claude"|"codex"|"none", "workdir": "...", "timeoutSec": 600 }.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
// fleet.js nằm cạnh tệp này sau khi cài (cai-dat-may-con.ps1 chép vào); chạy từ kho mã thì lấy ở orchestrator/src
let createFleet; try { ({ createFleet } = require('./fleet')); } catch (e) { ({ createFleet } = require('../orchestrator/src/fleet')); }
let createTsOwner; try { ({ createTsOwner } = require('./tsowner')); } catch (e) { ({ createTsOwner } = require('../orchestrator/src/tsowner')); }

const VERSION = '2026.10.28.3-win';
const baseDir = process.env.AGENTOS_WIN_DIR || path.join(process.env.ProgramData || os.tmpdir(), 'AgentOS');
const fleetFile = process.env.AGENTOS_FLEET_FILE || path.join(baseDir, 'fleet.json');
const confFile = process.env.AGENTOS_WIN_CONF || path.join(baseDir, 'windows-agent.json');
const logFile = path.join(baseDir, 'may-con.log');
const log = (m) => { const line = new Date().toISOString() + ' ' + m; try { fs.mkdirSync(baseDir, { recursive: true }); fs.appendFileSync(logFile, line + '\n'); } catch (e) { /* bỏ qua */ } console.log(line); };

const conf = () => Object.assign({ ai: 'claude', workdir: path.join(os.homedir(), 'AgentOS-May-Con'), timeoutSec: 600 }, (() => { try { return JSON.parse(fs.readFileSync(process.env.AGENTOS_WIN_CONF || confFile, 'utf8')); } catch (e) { return {}; } })());

// Câu lệnh chạy AI ở chế độ chỉ đọc. (Việc của máy đầu não đã có tiền tố "[VIỆC TỪ MÁY ĐẦU NÃO]".)
function aiCommand(ai, prompt) {
  if (ai === 'claude') return { bin: 'claude', args: ['-p', prompt, '--allowedTools', 'Read,Glob,Grep', '--output-format', 'text'] };
  if (ai === 'codex') return { bin: 'codex', args: ['exec', '--skip-git-repo-check', '-s', 'read-only', prompt] };
  return null;
}

// Nhận KHÓA CÔNG KHAI SSH từ máy đầu não (lệnh /ketnoi). Mặc định TẮT: chủ máy Windows phải bật "allowSshKey" (cai-rustdesk-va-ssh.ps1, mục C).
// Chỉ nhận đúng 1 dòng khóa công khai, chỉ thêm vào authorized_keys của người dùng đang chạy máy con (không chạm tệp của quản trị viên).
const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]{20,800}={0,2}( [^\r\n]{0,80})?$/;
function installSshKey(key) {
  const c = conf();
  if (!c.allowSshKey) throw new Error('Chủ máy Windows chưa bật "cho phép nhận khóa SSH" (chạy cai-rustdesk-va-ssh.ps1 bằng Run as administrator, chọn mục C).');
  key = String(key || '').trim();
  if (!SSH_KEY_RE.test(key)) throw new Error('Khóa SSH không đúng dạng (cần 1 dòng khóa CÔNG KHAI, ví dụ ssh-ed25519 AAAA...).');
  const dir = c.sshDir || path.join(os.homedir(), '.ssh'), file = path.join(dir, 'authorized_keys');
  fs.mkdirSync(dir, { recursive: true });
  let cur = ''; try { cur = fs.readFileSync(file, 'utf8'); } catch (e) { /* chưa có tệp */ }
  const id = key.split(' ').slice(0, 2).join(' ');
  const has = cur.split(/\r?\n/).some((l) => l.trim().split(' ').slice(0, 2).join(' ') === id);
  if (!has) fs.appendFileSync(file, (cur && !/\n$/.test(cur) ? '\n' : '') + key + '\n');
  let warn = '';
  try { const cfg = fs.readFileSync(path.join(process.env.ProgramData || '', 'ssh', 'sshd_config'), 'utf8'); if (/^\s*Match\s+Group\s+administrators/im.test(cfg)) warn = 'Máy đang dùng tệp khóa riêng cho quản trị viên: nếu tài khoản này là quản trị viên, chạy lại cai-rustdesk-va-ssh.ps1 mục C để SSH đọc khóa vừa chép.'; } catch (e) { /* chưa cài sshd */ }
  log('đã ' + (has ? 'có sẵn' : 'chép thêm') + ' 1 khóa SSH của máy đầu não');
  return { ok: true, added: !has, user: os.userInfo().username, host: os.hostname(), file, warn };
}

const jobs = new Map(); let nextId = 1, running = null;
function runJob(id, prompt) {
  const j = jobs.get(id), c = conf();
  const cmd = o_runner ? o_runner(prompt, c) : aiCommand(c.ai, prompt);
  if (!cmd) { j.status = 'error'; j.error = 'Máy Windows này chưa chọn AI (windows-agent.json: "ai").'; return; }
  try { fs.mkdirSync(c.workdir, { recursive: true }); } catch (e) { /* bỏ qua */ }
  running = id; j.status = 'running';
  let out = '', err = '';
  const child = spawn(cmd.bin, cmd.args, { cwd: c.workdir, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* đã dừng */ } j.timedOut = true; }, (c.timeoutSec || 600) * 1000);
  child.stdout.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-200000); });
  child.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
  child.on('error', (e) => { clearTimeout(timer); j.status = 'error'; j.error = 'Không chạy được "' + cmd.bin + '": ' + e.message; running = null; });
  child.on('close', (code) => {
    clearTimeout(timer); running = null;
    if (j.timedOut) { j.status = 'error'; j.error = 'Quá thời gian ' + (c.timeoutSec || 600) + ' giây'; return; }
    if (code === 0) { j.status = 'done'; j.result = out.trim(); } else { j.status = 'error'; j.error = (err || out).trim().slice(-800) || 'AI kết thúc với mã ' + code; }
  });
}
let o_runner = null;          // chỗ để test thay bằng chương trình giả

const queue = [];
function startNext() { if (running) return; const id = queue.shift(); if (id) runJob(id, jobs.get(id).prompt); }

function diskFreeMb() { try { const s = fs.statfsSync(path.parse(process.cwd()).root || 'C:\\'); return Math.round(s.bavail * s.bsize / 1048576); } catch (e) { return null; } }

function create(opts) {
  opts = opts || {}; o_runner = opts.runner || null;
  const fleet = createFleet({ file: opts.fleetFile || fleetFile, log });
  const agent = fleet.createAgent({
    version: () => VERSION,
    submit: (prompt) => { const id = nextId++; jobs.set(id, { status: 'queued', prompt, result: '', error: '' }); queue.push(id); setImmediate(startNext); return id; },
    getJob: (id) => { const j = jobs.get(id); return j ? { status: j.status, result: j.result, error: j.error, engine: conf().ai } : null; },
    platform: 'windows',
    sameOwner: (opts.sameOwner || createTsOwner({}).sameOwner),       // ghép đôi tự động: chỉ máy cùng tài khoản Tailscale (tailscale whois)
    sshKey: async (k) => installSshKey(k),
    update: async () => 'Máy Windows: cập nhật thủ công (chạy lại cai-dat.ps1 với bản mới).',
    stats: () => ({ queued: queue.length, running, diskFreeMb: diskFreeMb(), uptimeSec: Math.round(process.uptime()), platform: 'windows', host: os.hostname() }),
  });
  // Việc xong để lâu thì dọn (giữ 100 việc gần nhất)
  setInterval(() => { for (const id of [...jobs.keys()].slice(0, Math.max(0, jobs.size - 100))) jobs.delete(id); }, 600000).unref();
  return { fleet, agent };
}

module.exports = { create, aiCommand, installSshKey, VERSION };

if (require.main === module) {
  const { fleet, agent } = create();
  const c = fleet.load().agent;
  if (!c.enabled || !c.key) { log('Chưa bật: chạy cai-dat.ps1 trước.'); process.exit(1); }
  (function listen(tries) {
    agent.listen().then((a) => log('Máy con Windows "' + c.name + '" nghe ở ' + a.address + ':' + a.port + ' (AI: ' + conf().ai + ', chỉ đọc)')).catch((e) => { log('Chưa mở được cổng (' + e.code + '), thử lại sau 30 giây'); setTimeout(() => listen(tries + 1), 30000); });
  })(0);
}
