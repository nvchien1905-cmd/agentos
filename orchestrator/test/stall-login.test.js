'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runProcess, abnormal } = require('../src/engines/proc');

// Lỗi gốc (03/11/2026): Codex tải yêu cầu 11MB lên chatgpt.com qua đường IPv6 mất 40% gói, 30KB/s → việc kẹt cả giờ, chặn hàng đợi dù CPU gần 0.
test('canh giữ: tiến trình im lặng quá idleMs bị cắt với killedBy=stalled; vẫn in đều thì không bị cắt', { skip: process.platform === 'win32' }, async () => {
  const quiet = runProcess({ bin: 'bash', args: ['-c', 'echo bat-dau; sleep 30'], cwd: process.cwd(), input: '', idleMs: 700 });
  const r = await quiet.done;
  assert.equal(r.killedBy, 'stalled');
  const ab = abnormal(r, 'bash');
  assert.equal(ab.stalled, true); assert.equal(ab.ok, false); assert.match(ab.error, /im lặng/);

  const busy = runProcess({ bin: 'bash', args: ['-c', 'for i in 1 2 3 4 5 6; do echo $i; sleep 0.3; done'], cwd: process.cwd(), input: '', idleMs: 700 });
  const b = await busy.done;
  assert.equal(b.killedBy, null, 'in đều (mỗi 0,3s) thì không bị coi là kẹt dù tổng thời gian dài hơn idleMs');
});

test('worker: AI kẹt (stalled) → bỏ phiên cũ, chạy lại KHÔNG kèm phiên đúng một lần; kẹt tiếp thì báo lỗi rõ, không treo', async () => {
  const { openDb } = require('../src/db'); const { createWorker } = require('../src/worker');
  const db = openDb(':memory:'); const resumes = []; const msgs = []; let mode = 'stall-once';
  const engines = { codex: { start: ({ resumeId }) => {
    resumes.push(resumeId || null);
    const stall = mode === 'stall-always' || (mode === 'stall-once' && resumes.length === 1);
    return { kill() {}, done: Promise.resolve(stall ? { ok: false, limit: false, stalled: true, error: 'x' } : { ok: true, text: 'xong rồi', sessionId: 'S-moi' }) };
  } } };
  const worker = createWorker({ db, engines, order: ['codex'], notify: async (c, t) => { msgs.push(t); }, now: () => 1000000, retryDelaysMs: [1], log: () => {} });
  const key = (id) => 'session:' + db.getJob(id).chat_id + ':codex';
  let id = db.addJob('7', 'đầu', null, null, 'main', null); db.kvSet(key(id), 'S-cu');
  await worker.wake();
  assert.deepEqual(resumes, ['S-cu', null], 'lần 1 kèm phiên cũ bị kẹt, lần 2 chạy mới không kèm phiên');
  assert.equal(db.getJob(id).status, 'done');
  assert.equal(db.kvGet(key(id)), 'S-moi');
  assert.ok(msgs.some((m) => /im lặng quá lâu/.test(m)), 'báo chủ máy là đang chạy lại');

  resumes.length = 0; msgs.length = 0; mode = 'stall-always';
  id = db.addJob('7', 'hai', null, null, 'main', null); db.kvSet(key(id), 'S-cu2');
  await worker.wake();
  assert.equal(resumes.length, 2, 'chỉ thử lại đúng một lần');
  assert.equal(db.getJob(id).status, 'error');
  assert.ok(msgs.some((m) => /im lặng quá lâu, chạy lại vẫn vậy/.test(m)));
});

test('đăng nhập: AI in "CẦN ĐĂNG NHẬP" → câu trả lời kèm cách đăng nhập (/mo webbot)', async () => {
  const { openDb } = require('../src/db'); const { createWorker } = require('../src/worker');
  const db = openDb(':memory:'); const msgs = [];
  const engines = { claude: { start: () => ({ kill() {}, done: Promise.resolve({ ok: true, text: 'CẦN ĐĂNG NHẬP: KiotViet https://tongkhohuyenanh01.kiotviet.vn\nChưa làm được gì.', sessionId: 'S' }) }) } };
  const worker = createWorker({ db, engines, order: ['claude'], notify: async (c, t) => { msgs.push(t); }, now: () => 1000000, retryDelaysMs: [1], log: () => {} });
  db.addJob('7', 'thống kê hàng hóa', null, null, 'main', null); await worker.wake();
  const all = msgs.join('\n');
  assert.match(all, /CẦN ĐĂNG NHẬP: KiotViet/);
  assert.match(all, /\/mo webbot/); assert.match(all, /\/dong webbot/); assert.match(all, /\/hanghoa|\/doanhso/);
});

test('trình duyệt: chỉ dùng Google Chrome đã cài (không Chromium), bỏ ảnh khỏi phiên AI; thứ tự IPv4 do gai.conf', () => {
  const root = path.join(__dirname, '..', '..');
  const t = JSON.parse(fs.readFileSync(path.join(root, 'orchestrator', 'tools.linux.json'), 'utf8'));
  const args = t.servers.browser.args;
  assert.ok(args[0].endsWith('browser-mcp.js'), 'AI dùng browser-mcp.js: mỗi AI một tab trong MỘT Chrome dùng chung');
  assert.equal(args[args.indexOf('--cdp') + 1], '__CDP__', 'địa chỉ Chrome dùng chung được thế theo từng việc');
  assert.ok(!args.includes('--user-data-dir') && !args.includes('--images'), 'hồ sơ do Chrome dùng chung giữ; mặc định không nhét ảnh chụp màn hình vào phiên (phình hàng chục MB)');
  assert.match(fs.readFileSync(path.join(root, 'orchestrator', 'src', 'browserHost.js'), 'utf8'), /google-chrome-stable/);
  assert.ok(!JSON.stringify(t).includes('chromium'));
  assert.match(t.profiles.web.hint, /CẦN ĐĂNG NHẬP/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'iso', 'config', 'package-lists', 'agentos.list.chroot'), 'utf8'), /^chromium$/m);
  assert.match(fs.readFileSync(path.join(root, 'orchestrator', 'src', 'fbprobe.js'), 'utf8'), /google-chrome-stable/);
  assert.match(fs.readFileSync(path.join(root, 'update', 'apply.sh'), 'utf8'), /precedence ::ffff:0:0\/96\s+100/);
  assert.match(fs.readFileSync(path.join(root, 'iso', 'config', 'includes.chroot', 'etc', 'gai.conf'), 'utf8'), /precedence ::ffff:0:0\/96\s+100/);
  assert.match(fs.readFileSync(path.join(root, 'orchestrator', 'src', 'index.js'), 'utf8'), /setDefaultResultOrder\('verbatim'\)/);
});

test('KiotViet: không biểu tượng/khóa trên giao diện; số liệu lấy bằng API (/doanhso /ton), vào web bằng Chrome (lưu mật khẩu, giữ phiên)', () => {
  const root = path.join(__dirname, '..', '..');
  assert.ok(!fs.existsSync(path.join(root, 'iso', 'config', 'includes.chroot', 'usr', 'share', 'applications', 'agentos-kiotviet.desktop')));
  assert.ok(!fs.existsSync(path.join(root, 'scripts', 'dat-khoa-kiotviet.sh')));
  const quick = fs.readFileSync(path.join(root, 'orchestrator', 'src', 'quick.js'), 'utf8');
  assert.match(quick, /case 'doanhso'/);   // số liệu bán hàng qua API chính thức, không qua web
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'desk', 'server.js'), 'utf8'), /kiotviet:\s*\{/);
  assert.match(fs.readFileSync(path.join(root, 'update', 'apply.sh'), 'utf8'), /agentos-kiotviet/);
  const pol = JSON.parse(fs.readFileSync(path.join(root, 'iso', 'config', 'includes.chroot', 'etc', 'opt', 'chrome', 'policies', 'managed', 'agentos.json'), 'utf8'));
  assert.equal(pol.PasswordManagerEnabled, true); assert.equal(pol.RestoreOnStartup, 1); assert.equal(pol.DefaultCookiesSetting, 1);
  assert.match(fs.readFileSync(path.join(root, 'update', 'apply.sh'), 'utf8'), /policies\/managed\/agentos\.json/);
});
