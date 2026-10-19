'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { runProcess } = require('../src/engines/proc');
const { startClaude } = require('../src/engines/claude');
const { classifyFailure } = require('../src/limits');
const { createWorker } = require('../src/worker');
const { createHealth, readHeartbeat } = require('../src/health');
const maint = require('../src/maintenance');
const { sendAlert, idsFromEnv } = require('../src/alert-lib');
const { createSandbox, buildArgs } = require('../src/sandbox');
const { openDb } = require('../src/db');
const config = require('../src/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-d-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Tiến trình "zombie" (đã chết nhưng chưa được cha dọn) coi là đã chết: trong container Docker không có init, tiến trình mồ côi
// bị giết vẫn nằm lại dạng zombie nên process.kill(pid, 0) vẫn thành công (phát hiện từ CI trong container Debian 19/10/2026).
const alive = (pid) => {
  try { process.kill(pid, 0); } catch (e) { return false; }
  if (process.platform === 'linux') {
    try { const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return s.charAt(s.lastIndexOf(')') + 2) !== 'Z'; } catch (e) { return false; }
  }
  return true;
};
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 6000)) { const v = fn(); if (v) return v; await sleep(50); } return null; }

// ---------- giết cả cây tiến trình ----------

test('proc: hủy là giết cả cây (tiến trình cháu cũng chết)', async () => {
  const pidFile = path.join(tmp(), 'child.pid');
  const h = runProcess({ bin: process.execPath, args: [path.join(__dirname, 'fake-tree.js'), pidFile], cwd: __dirname, input: '', timeoutMs: 30000 });
  const pid = Number(await waitFor(() => { try { return fs.readFileSync(pidFile, 'utf8'); } catch (e) { return null; } }));
  assert.ok(pid > 0 && alive(pid), 'tiến trình cháu phải đang chạy');
  h.kill('cancelled');
  const r = await h.done;
  assert.equal(r.killedBy, 'cancelled');
  assert.ok(await waitFor(() => !alive(pid)), 'tiến trình cháu phải chết theo');
});

test('proc: tiến trình chính thoát bình thường thì dọn tiến trình mồ côi (Linux)', { skip: process.platform === 'win32' }, async () => {
  const pidFile = path.join(tmp(), 'orphan.pid');
  const r = await runProcess({ bin: process.execPath, args: [path.join(__dirname, 'fake-tree.js'), pidFile, 'exit'], cwd: __dirname, input: '', timeoutMs: 30000 }).done;
  assert.equal(r.code, 0);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(await waitFor(() => !alive(pid)), 'tiến trình mồ côi phải bị dọn');
});

test('proc: wrap ném lỗi (ví dụ sandbox bắt buộc không dùng được) thì báo lỗi chứ không chạy', async () => {
  const r = await runProcess({ bin: 'x', args: [], cwd: __dirname, input: '', wrap: () => { throw new Error('không có bwrap'); } }).done;
  assert.match(r.spawnError.message, /không có bwrap/);
});

// ---------- lỗi tạm thời ----------

test('limits: lỗi quá tải/rớt mạng là TẠM THỜI, hết hạn mức là LIMIT, ưu tiên tạm thời', () => {
  assert.deepEqual(classifyFailure('API Error: 529 Overloaded. Please try again in a moment.'), { transient: true, limit: false });
  assert.deepEqual(classifyFailure('fetch failed ECONNRESET'), { transient: true, limit: false });
  assert.deepEqual(classifyFailure('502 Bad Gateway'), { transient: true, limit: false });
  assert.deepEqual(classifyFailure('Claude usage limit reached. Your limit will reset at 5pm.'), { transient: false, limit: true });
  assert.deepEqual(classifyFailure("You've hit your usage limit. Try again in 2 hours."), { transient: false, limit: true });
  assert.deepEqual(classifyFailure('429 Too Many Requests'), { transient: false, limit: true });
  assert.deepEqual(classifyFailure('lỗi cú pháp'), { transient: false, limit: false });
});

test('claude: quá tải (529) được đánh dấu transient, không phải limit', async () => {
  const r = await startClaude({ bin: process.execPath, binArgs: [path.join(__dirname, 'fake-claude.js')], cwd: __dirname, prompt: 'OVERLOAD', timeoutMs: 8000 }).done;
  assert.equal(r.ok, false); assert.equal(r.transient, true); assert.equal(r.limit, false);
});

const okRes = (text) => ({ ok: true, text, sessionId: null, limit: false });
const transientRes = { ok: false, limit: false, transient: true, error: '529 Overloaded' };

function wk(results, extra) {
  const db = openDb(':memory:'); const sent = []; let calls = 0;
  const worker = createWorker(Object.assign({
    db, order: ['claude'], notify: async (c, t) => { sent.push(t); }, retryDelaysMs: [1, 1, 1],
    engines: { claude: { start: () => ({ done: Promise.resolve(results[Math.min(calls++, results.length - 1)]), kill() {} }) } },
  }, extra || {}));
  return { db, sent, worker, calls: () => calls };
}

test('worker: lỗi tạm thời thì tự thử lại (báo một lần), không cho engine nghỉ; qua được thì xong', async () => {
  const W = wk([transientRes, transientRes, okRes('xong rồi')]);
  const id = W.db.addJob(1, 'việc'); await W.worker.wake();
  assert.equal(W.db.getJob(id).status, 'done'); assert.equal(W.calls(), 3);
  assert.equal(W.sent.filter((s) => /quá tải hoặc mất kết nối/.test(s)).length, 1);
  assert.equal(W.db.kvGet('cool:claude'), null);                                  // không bị coi là hết hạn mức
});

test('worker: thử lại hết số lần mà vẫn lỗi thì báo lỗi (không treo, không chờ hạn mức)', async () => {
  const W = wk([transientRes]);
  const id = W.db.addJob(1, 'việc'); await W.worker.wake();
  assert.equal(W.db.getJob(id).status, 'error'); assert.equal(W.calls(), 4);       // 1 lần đầu + 3 lần thử lại
  assert.ok(W.sent.some((s) => /lỗi: 529 Overloaded/.test(s)));
});

test('worker: /huy trong lúc chờ thử lại thì dừng ngay', async () => {
  const W = wk([transientRes], { retryDelaysMs: [60000] });
  const id = W.db.addJob(7, 'việc');
  const run = W.worker.wake();
  await waitFor(() => W.calls() === 1 && W.worker.currentJobId() === id);
  await sleep(100);
  assert.equal(W.worker.cancelRunning(7), true);
  await run;
  assert.equal(W.db.getJob(id).status, 'cancelled');
});

test('worker: ổ đĩa gần đầy (preflight) thì báo, không chạy việc', async () => {
  const W = wk([okRes('x')], { preflight: () => 'ổ đĩa gần đầy (còn 12 MB)' });
  const id = W.db.addJob(1, 'việc'); await W.worker.wake();
  assert.equal(W.db.getJob(id).status, 'error'); assert.equal(W.calls(), 0);
  assert.ok(W.sent.some((s) => /Việc #1 chưa chạy được: ổ đĩa gần đầy/.test(s)));
});

// ---------- nhịp tim / watchdog ----------

test('health: khỏe thì ghi heartbeat và báo WATCHDOG; READY một lần; vòng nhận tin đứng thì KHÔNG báo', () => {
  const db = openDb(':memory:'); const dir = tmp(); const file = path.join(dir, 'sub', 'heartbeat.json');
  const sent = []; const clock = { t: 1000000 };
  const h = createHealth({ db, file, notify: (a) => sent.push(a), now: () => clock.t, loopStaleMs: 180000, stats: () => ({ running: 4, queued: 2 }) });
  h.ready(); h.ready();
  assert.deepEqual(sent, [['READY=1']]);

  const b = h.check();
  assert.equal(b.ok, true);
  assert.deepEqual(sent[1], ['WATCHDOG=1', 'STATUS=đang chạy việc #4, chờ 2']);
  assert.deepEqual(readHeartbeat(file, 60000, clock.t + 5000).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).running, 4);

  clock.t += 200000;                                                              // vòng nhận tin không quay 200 giây
  const bad = h.check();
  assert.equal(bad.ok, false); assert.equal(bad.loopOk, false);
  assert.equal(sent.length, 2);                                                  // không báo thêm -> systemd sẽ khởi động lại
  h.tickLoop();
  assert.equal(h.check().ok, true);

  db.close();
  assert.equal(h.check().dbOk, false);                                            // cơ sở dữ liệu đóng/hỏng
});

test('health.readHeartbeat: thiếu file, cũ, không khỏe', () => {
  const file = path.join(tmp(), 'hb.json');
  assert.equal(readHeartbeat(file, 60000).ok, false);
  fs.writeFileSync(file, JSON.stringify({ ts: 1000, ok: true }));
  assert.match(readHeartbeat(file, 60000, 100000).reason, /heartbeat cũ 99 giây/);
  fs.writeFileSync(file, JSON.stringify({ ts: 1000, ok: false, dbOk: true, loopOk: false }));
  assert.match(readHeartbeat(file, 60000, 2000).reason, /không khỏe/);
});

test('scripts/healthcheck.js: exit 0 khi ổn, 1 khi heartbeat cũ', async () => {
  const file = path.join(tmp(), 'hb.json');
  const run = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'healthcheck.js'), file], { stdio: 'ignore' });
    c.on('close', resolve);
  });
  fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), ok: true }));
  assert.equal(await run(), 0);
  fs.writeFileSync(file, JSON.stringify({ ts: Date.now() - 3600000, ok: true }));
  assert.equal(await run(), 1);
});

// ---------- bảo trì: kiểm tra, khôi phục, sao lưu, dọn dẹp ----------

test('maintenance: phát hiện cơ sở dữ liệu hỏng, giữ lại file hỏng, khôi phục từ bản sao lưu tốt gần nhất', () => {
  const dir = tmp(); const file = path.join(dir, 'agentos.db'); const bdir = path.join(dir, 'backups');
  assert.deepEqual(maint.checkIntegrity(file), { ok: true, detail: 'chưa có' });

  let db = openDb(file); db.addJob(1, 'việc quan trọng');
  const made = maint.backup(db, bdir, { now: new Date(2026, 9, 17, 12).getTime(), keep: 7 });
  assert.equal(made, 'agentos-2026-10-17.db');
  db.close();
  assert.equal(maint.checkIntegrity(file).ok, true);

  fs.writeFileSync(path.join(bdir, 'agentos-2026-10-18.db'), 'bản sao lưu hỏng, không phải sqlite');
  fs.writeFileSync(file, Buffer.alloc(4096, 7));                                  // file chính hỏng
  const bad = maint.checkIntegrity(file);
  assert.equal(bad.ok, false);

  const moved = maint.quarantine(file, 123);
  assert.ok(fs.existsSync(moved) && !fs.existsSync(file));
  assert.equal(maint.restoreLatestBackup(file, bdir), 'agentos-2026-10-17.db');   // bỏ qua bản 18 hỏng, dùng bản 17
  db = openDb(file);
  assert.equal(db.getJob(1).prompt, 'việc quan trọng');
  db.close();
  assert.equal(maint.restoreLatestBackup(path.join(dir, 'x.db'), path.join(dir, 'khong-co')), null);
});

test('maintenance: mỗi ngày một bản sao lưu, giữ N bản mới nhất', () => {
  const dir = tmp(); const db = openDb(path.join(dir, 'a.db')); const bdir = path.join(dir, 'b');
  const day = (n) => new Date(2026, 9, n, 9).getTime();
  assert.equal(maint.backup(db, bdir, { now: day(1), keep: 3 }), 'agentos-2026-10-01.db');
  assert.equal(maint.backup(db, bdir, { now: day(1) + 3600000, keep: 3 }), null);   // hôm nay đã có
  for (const n of [2, 3, 4, 5]) maint.backup(db, bdir, { now: day(n), keep: 3 });
  assert.deepEqual(maint.listBackups(bdir), ['agentos-2026-10-05.db', 'agentos-2026-10-04.db', 'agentos-2026-10-03.db']);
  assert.equal(fs.readdirSync(bdir).some((f) => f.endsWith('.tmp')), false);
  db.close();
});

test('maintenance: dọn việc/nhật ký cũ (giữ việc đang chờ/chạy), dọn file cũ, đo ổ đĩa', () => {
  const db = openDb(':memory:'); const now = Date.now(); const D = maint.DAY;
  const old = db.addJob(1, 'cũ'); db.claimNext(); db.finishJob(old, 'done', { result: 'x' });
  db.raw.prepare('UPDATE jobs SET finished_at = ? WHERE id = ?').run(now - 100 * D, old);
  const recent = db.addJob(1, 'mới'); db.claimNext(); db.finishJob(recent, 'done', { result: 'y' });
  const waiting = db.addJob(1, 'đang chờ'); db.claimNext(); db.setWaiting(waiting, now + D);
  db.raw.prepare('UPDATE jobs SET created_at = ?, started_at = ? WHERE id = ?').run(now - 200 * D, now - 200 * D, waiting);
  db.addAudit({ jobId: 1, tool: 'Read', cls: 'read', decision: 'allow', source: 'auto', summary: 'a' });
  db.raw.prepare('UPDATE audit SET ts = ?').run(now - 300 * D);
  db.addAudit({ jobId: 2, tool: 'Read', cls: 'read', decision: 'allow', source: 'auto', summary: 'b' });
  assert.deepEqual(db.pruneOld(now - 90 * D, now - 180 * D), { jobs: 1, audit: 1 });
  assert.equal(db.getJob(old), undefined); assert.ok(db.getJob(recent)); assert.ok(db.getJob(waiting));

  const dir = tmp(); fs.mkdirSync(path.join(dir, 'sub'));
  const f1 = path.join(dir, 'moi.png'), f2 = path.join(dir, 'sub', 'cu.png');
  fs.writeFileSync(f1, 'a'); fs.writeFileSync(f2, 'b'); fs.utimesSync(f2, (now - 30 * D) / 1000, (now - 30 * D) / 1000);
  assert.equal(maint.pruneFiles(dir, 14 * D, now), 1);
  assert.ok(fs.existsSync(f1) && !fs.existsSync(f2));
  assert.ok(maint.diskFreeMb(dir) > 0);
  assert.equal(maint.diskFreeMb(path.join(dir, 'khong', 'co')), Infinity);
});

test('alert: gửi cho từng quản trị viên, lỗi một người không chặn người khác', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); calls.push([url.split('/').slice(-1)[0], body.chat_id, body.text]);
    if (body.chat_id === '2') throw new Error('mạng lỗi');
    return { json: async () => ({ ok: true }) };
  };
  assert.equal(await sendAlert({ token: 'T', chatIds: ['1', '2', '3'], text: 'cảnh báo', fetchImpl }), 2);
  assert.deepEqual(calls.map((c) => c[1]), ['1', '2', '3']);
  assert.deepEqual(idsFromEnv({ ADMIN_USER_IDS: '5, x, 7', ALLOWED_USER_IDS: '9' }), ['5', '7']);
  assert.deepEqual(idsFromEnv({ ALLOWED_USER_IDS: '9' }), ['9']);
  assert.deepEqual(idsFromEnv({ ADMIN_USER_IDS: '' , ALLOWED_USER_IDS: '9' }), []);
});

// ---------- sandbox ----------

const PATHS = { home: '/var/lib/agentos', workdir: '/var/lib/agentos/work', dataDir: '/var/lib/agentos/data', jobDir: '/var/lib/agentos/data/jobs', rw: ['/var/lib/agentos/data/browser-profile'], hide: ['/etc/agentos', '/opt/agentos/orchestrator/.env', '/khong/co'] };
const FILES = new Set(['/opt/agentos/orchestrator/.env']);
const statSync = (p) => {
  if (p === '/khong/co') throw new Error('ENOENT');
  return { isDirectory: () => !FILES.has(p) };
};

test('sandbox.buildArgs: gốc chỉ đọc, che dữ liệu bộ điều phối rồi mở lại đúng phần cần, che token', () => {
  const a = buildArgs(PATHS, statSync);
  const seq = a.join(' ');
  assert.ok(seq.startsWith('--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind /var/lib/agentos /var/lib/agentos'));
  const idx = (s) => seq.indexOf(s);
  assert.ok(idx('--tmpfs /var/lib/agentos/data') < idx('--bind /var/lib/agentos/work'));
  assert.ok(idx('--tmpfs /var/lib/agentos/data') < idx('--ro-bind /var/lib/agentos/data/jobs'));
  assert.ok(idx('--tmpfs /var/lib/agentos/data') < idx('--bind /var/lib/agentos/data/browser-profile'));
  assert.ok(seq.includes('--tmpfs /etc/agentos'));                                  // thư mục: che bằng tmpfs
  assert.ok(seq.includes('--ro-bind /dev/null /opt/agentos/orchestrator/.env'));    // file: che bằng /dev/null
  assert.ok(!seq.includes('/khong/co'));                                             // không tồn tại: bỏ qua
  for (const f of ['--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session']) assert.ok(a.includes(f), f);
  assert.ok(!a.includes('--unshare-net'));                                           // vẫn dùng chung mạng
});

test('sandbox: chế độ off / auto (tự kiểm) / bwrap (bắt buộc)', () => {
  const spec = { bin: 'claude', args: ['-p', 'x'], cwd: '/var/lib/agentos/work' };
  const off = createSandbox({ mode: 'off', paths: PATHS, statSync });
  assert.equal(off.enabled, false); assert.deepEqual(off.wrap(spec), spec);

  const ok = createSandbox({ mode: 'auto', paths: PATHS, platform: 'linux', statSync, run: () => ({ status: 0 }) });
  assert.equal(ok.enabled, true);
  const w = ok.wrap(spec);
  assert.equal(w.bin, 'bwrap');
  assert.deepEqual(w.args.slice(-6), ['--chdir', '/var/lib/agentos/work', '--', 'claude', '-p', 'x']);   // lệnh gốc nằm sau dấu --

  const logs = [];
  const fail = createSandbox({ mode: 'auto', paths: PATHS, platform: 'linux', statSync, log: (m) => logs.push(m), run: () => ({ status: 1, stderr: 'bwrap: No permissions to create new namespace' }) });
  assert.equal(fail.enabled, false); assert.match(fail.info.reason, /No permissions to create new namespace/);
  assert.deepEqual(fail.wrap(spec), spec);                                         // auto: chạy không cô lập (và đã báo)
  assert.equal(logs.length, 1);

  const req = createSandbox({ mode: 'bwrap', paths: PATHS, platform: 'linux', statSync, run: () => ({ status: 1, stderr: 'x' }) });
  assert.throws(() => req.wrap(spec), /SANDBOX=bwrap nhưng không dùng được/);       // bắt buộc: không chạy
  const win = createSandbox({ mode: 'auto', paths: PATHS, platform: 'win32', statSync });
  assert.equal(win.enabled, false); assert.match(win.info.reason, /chỉ hỗ trợ Linux/);
});

test('config: tùy chọn độ bền và giá trị mặc định', () => {
  const base = { TELEGRAM_TOKEN: 't', ALLOWED_USER_IDS: '1' };
  const c = config.load(base);
  assert.equal(c.sandboxMode, 'off'); assert.equal(c.minFreeMb, 300); assert.equal(c.bootNotice, true);
  assert.deepEqual(c.sandboxHide, ['/etc/agentos']); assert.deepEqual(c.retryDelaysMs, [15000, 60000, 180000]);
  assert.equal(c.jobRetentionDays, 90); assert.equal(c.backupKeep, 7);
  const d = config.load(Object.assign({ SANDBOX: 'BWRAP', MIN_FREE_MB: '1000', BOOT_NOTICE: 'false', TRANSIENT_RETRY_SEC: '1,2', SANDBOX_HIDE: '' }, base));
  assert.equal(d.sandboxMode, 'bwrap'); assert.equal(d.minFreeMb, 1000); assert.equal(d.bootNotice, false);
  assert.deepEqual(d.retryDelaysMs, [1000, 2000]); assert.deepEqual(d.sandboxHide, []);
  assert.equal(config.validate(config.load(Object.assign({ SANDBOX: 'chroot' }, base))).length, 1);
});
