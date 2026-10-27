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

const VERSION = '2026.10.26.15-win';
const baseDir = process.env.AGENTOS_WIN_DIR || path.join(process.env.ProgramData || os.tmpdir(), 'AgentOS');
const fleetFile = process.env.AGENTOS_FLEET_FILE || path.join(baseDir, 'fleet.json');
const confFile = process.env.AGENTOS_WIN_CONF || path.join(baseDir, 'windows-agent.json');
const logFile = path.join(baseDir, 'may-con.log');
const log = (m) => { const line = new Date().toISOString() + ' ' + m; try { fs.mkdirSync(baseDir, { recursive: true }); fs.appendFileSync(logFile, line + '\n'); } catch (e) { /* bỏ qua */ } console.log(line); };

const conf = () => Object.assign({ ai: 'claude', workdir: path.join(os.homedir(), 'AgentOS-May-Con'), timeoutSec: 600 }, (() => { try { return JSON.parse(fs.readFileSync(confFile, 'utf8')); } catch (e) { return {}; } })());

// Câu lệnh chạy AI ở chế độ chỉ đọc. (Việc của máy đầu não đã có tiền tố "[VIỆC TỪ MÁY ĐẦU NÃO]".)
function aiCommand(ai, prompt) {
  if (ai === 'claude') return { bin: 'claude', args: ['-p', prompt, '--allowedTools', 'Read,Glob,Grep', '--output-format', 'text'] };
  if (ai === 'codex') return { bin: 'codex', args: ['exec', '--skip-git-repo-check', '-s', 'read-only', prompt] };
  return null;
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
    update: async () => 'Máy Windows: cập nhật thủ công (chạy lại cai-dat.ps1 với bản mới).',
    stats: () => ({ queued: queue.length, running, diskFreeMb: diskFreeMb(), uptimeSec: Math.round(process.uptime()), platform: 'windows', host: os.hostname() }),
  });
  // Việc xong để lâu thì dọn (giữ 100 việc gần nhất)
  setInterval(() => { for (const id of [...jobs.keys()].slice(0, Math.max(0, jobs.size - 100))) jobs.delete(id); }, 600000).unref();
  return { fleet, agent };
}

module.exports = { create, aiCommand, VERSION };

if (require.main === module) {
  const { fleet, agent } = create();
  const c = fleet.load().agent;
  if (!c.enabled || !c.key) { log('Chưa bật: chạy cai-dat.ps1 trước.'); process.exit(1); }
  (function listen(tries) {
    agent.listen().then((a) => log('Máy con Windows "' + c.name + '" nghe ở ' + a.address + ':' + a.port + ' (AI: ' + conf().ai + ', chỉ đọc)')).catch((e) => { log('Chưa mở được cổng (' + e.code + '), thử lại sau 30 giây'); setTimeout(() => listen(tries + 1), 30000); });
  })(0);
}
