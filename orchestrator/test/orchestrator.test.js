'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { openDb } = require('../src/db');
const { startClaude, parseOutput } = require('../src/engines/claude');
const { startCodex, parseEvents } = require('../src/engines/codex');
const { createWorker } = require('../src/worker');
const { createBot } = require('../src/bot');
const { splitMessage } = require('../src/telegram');
const { parseResetTime } = require('../src/limits');
const config = require('../src/config');

const FAKE = path.join(__dirname, 'fake-claude.js');
const FAKE_CODEX = path.join(__dirname, 'fake-codex.js');
const run = (prompt, extra) => startClaude(Object.assign({
  bin: process.execPath, binArgs: [FAKE], cwd: __dirname, prompt, allowedTools: 'Read', timeoutMs: 8000,
}, extra || {}));
const runCodex = (prompt, extra) => startCodex(Object.assign({
  bin: process.execPath, binArgs: [FAKE_CODEX], cwd: __dirname, prompt, sandbox: 'read-only', timeoutMs: 8000,
}, extra || {}));

// ---------- tiện ích thuần ----------

test('splitMessage: cắt theo xuống dòng và không vượt giới hạn', () => {
  const text = Array.from({ length: 50 }, (_, i) => 'dòng ' + i + ' ' + 'x'.repeat(50)).join('\n');
  const parts = splitMessage(text, 500);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 500));
  assert.equal(parts.join('\n').replace(/\n/g, ''), text.replace(/\n/g, ''));
  assert.deepEqual(splitMessage('ngắn'), ['ngắn']);
});

test('parseOutput: đọc JSON, JSON nhiều dòng, mảng sự kiện', () => {
  assert.equal(parseOutput('{"type":"result","result":"ok"}').result, 'ok');
  assert.equal(parseOutput('log\n{"type":"result","result":"b"}\n').result, 'b');
  assert.equal(parseOutput('[{"type":"system"},{"type":"result","result":"c"}]').result, 'c');
  assert.equal(parseOutput('không phải json'), null);
});

test('config: bắt buộc token/ID, kiểm tra ENGINE_ORDER', () => {
  assert.equal(config.validate(config.load({})).length, 2);
  const ok = { TELEGRAM_TOKEN: 't', ALLOWED_USER_IDS: '1, 2' };
  assert.equal(config.validate(config.load(ok)).length, 0);
  assert.deepEqual(config.load(ok).engineOrder, ['claude']);
  assert.deepEqual(config.load(Object.assign({ ENGINE_ORDER: 'Claude, codex' }, ok)).engineOrder, ['claude', 'codex']);
  assert.equal(config.validate(config.load(Object.assign({ ENGINE_ORDER: 'claude,gemini' }, ok))).length, 1);
  assert.equal(config.validate(config.load(Object.assign({ ENGINE_ORDER: 'codex,codex' }, ok))).length, 1);
  assert.equal(config.validate(config.load(Object.assign({ ALLOWED_USER_IDS: 'abc' }, { TELEGRAM_TOKEN: 't' }))).length, 1);
});

test('parseResetTime: các kiểu câu chữ của CLI', () => {
  const now = new Date(2026, 9, 19, 10, 0, 0).getTime();
  const H = 3600000;
  assert.equal(parseResetTime('Claude AI usage limit reached|' + Math.floor((now + 2 * H) / 1000), now), Math.floor((now + 2 * H) / 1000) * 1000);
  assert.equal(parseResetTime('Try again in 2 hours 30 minutes.', now), now + 2.5 * H);
  assert.equal(parseResetTime('Limit resets in 45 minutes', now), now + 45 * 60000);
  assert.equal(parseResetTime('Your limit will reset at 5pm (Asia/Saigon)', now), new Date(2026, 9, 19, 17, 0).getTime());
  assert.equal(parseResetTime('Your limit will reset at 9am', now), new Date(2026, 9, 20, 9, 0).getTime());
  assert.equal(parseResetTime('Your limit will reset at 17:30', now), new Date(2026, 9, 19, 17, 30).getTime());
  assert.equal(parseResetTime("You've hit your usage limit. Try again at Oct 22nd, 2026 3:15 PM.", now), new Date(2026, 9, 22, 15, 15).getTime());
  assert.equal(parseResetTime('try again at Oct 20, 3:15 PM', now), new Date(2026, 9, 20, 15, 15).getTime());
  assert.equal(parseResetTime('không có giờ nào cả', now), null);
  assert.equal(parseResetTime('Try again in 30 days', now), null); // xa quá -> bỏ
});

// ---------- cơ sở dữ liệu ----------

test('db: vòng đời việc, hàng đợi theo thứ tự, chờ hạn mức, khôi phục sau sự cố', () => {
  const db = openDb(':memory:');
  const a = db.addJob(1, 'a'), b = db.addJob(1, 'b', 'codex');
  assert.equal(db.getJob(b).engine_pref, 'codex');
  assert.equal(db.aheadOf(b), 1);
  const j = db.claimNext();
  assert.equal(j.id, a); assert.equal(j.status, 'running');
  db.setWaiting(a, 5000);
  assert.equal(db.getJob(a).status, 'waiting');
  assert.equal(db.queuedCount(), 2); assert.equal(db.waitingCount(), 1);
  assert.equal(db.claimNext(1000).id, b);            // a còn phải chờ -> b chạy trước
  assert.equal(db.claimNext(1000), null);
  const again = db.claimNext(6000);                    // tới giờ -> a chạy lại, nhớ là từng chờ
  assert.equal(again.id, a); assert.equal(again.run_after, 5000);
  db.finishJob(a, 'done', { result: 'ok' });
  assert.equal(db.getJob(a).run_after, null);
  assert.deepEqual(db.markInterrupted().map((x) => x.id), [b]);
  assert.equal(db.getJob(b).status, 'interrupted');
  db.kvSet('x', 5); assert.equal(db.kvGet('x'), '5'); db.kvDel('x'); assert.equal(db.kvGet('x'), null);
  db.kvSet('session:1:claude', 'a'); db.kvSet('session:1:codex', 'b'); db.kvSet('session:2:claude', 'c');
  db.kvDelPrefix('session:1:');
  assert.equal(db.kvGet('session:1:codex'), null); assert.equal(db.kvGet('session:2:claude'), 'c');
});

test('db: nâng cấp cơ sở dữ liệu GĐ 1 (thiếu cột mới)', () => {
  const fs = require('fs'), os = require('os');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-')), 'old.db');
  const Database = require('better-sqlite3');
  const old = new Database(file);
  old.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', engine TEXT, result TEXT, error TEXT, session_id TEXT, cost_usd REAL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER); INSERT INTO jobs (chat_id, prompt, created_at) VALUES ('1','cũ',1);");
  old.close();
  const db = openDb(file);
  assert.equal(db.claimNext().prompt, 'cũ');
  assert.equal(db.addJob(1, 'mới', 'codex') > 1, true);
  db.close();
});

// ---------- engine thật (tiến trình giả) ----------

test('claude: thành công, prompt qua stdin, có allowedTools và resume', async () => {
  const r = await run('xin chào', { resumeId: 'abc' }).done;
  assert.equal(r.ok, true);
  assert.equal(r.sessionId, 'sess-1');
  assert.equal(r.costUsd, 0.01);
  assert.match(r.text, /^echo:xin chào\|resume=abc\|args=/);
  assert.match(r.text, /--allowedTools Read/);
});

test('claude: nhận diện chạm giới hạn kèm giờ hồi, lỗi thường, hết giờ, hủy, không có lệnh', async () => {
  const lim = await run('LIMIT').done;
  assert.equal(lim.ok, false); assert.equal(lim.limit, true);
  assert.ok(lim.resetAt > Date.now());
  const bad = await run('FAIL').done;
  assert.equal(bad.ok, false); assert.equal(bad.limit, false); assert.match(bad.error, /boom/);
  const slow = await run('SLOW', { timeoutMs: 300 }).done;
  assert.equal(slow.timedOut, true);
  const h = run('SLOW'); setTimeout(() => h.kill('cancelled'), 200);
  assert.equal((await h.done).cancelled, true);
  const none = await startClaude({ bin: 'khong-co-lenh-nay-xyz', cwd: __dirname, prompt: 'x' }).done;
  assert.equal(none.ok, false); assert.match(none.error, /Không chạy được/);
});

test('codex: parseEvents đọc thread, tin nhắn cuối, lỗi', () => {
  const ev = parseEvents([
    '{"type":"thread.started","thread_id":"t9"}', 'dòng rác', '{"type":"item.completed","item":{"type":"agent_message","text":"a"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"b"}}', '{"type":"turn.failed","error":{"message":"hỏng"}}',
  ].join('\n'));
  assert.deepEqual(ev, { threadId: 't9', text: 'b', error: 'hỏng', failed: true });
});

test('codex: thành công (stdin, sandbox, resume), chạm giới hạn, lỗi', async () => {
  const r = await runCodex('chào').done;
  assert.equal(r.ok, true); assert.equal(r.sessionId, 'thr-1');
  assert.match(r.text, /^codex:chào\|args=.*exec --json --skip-git-repo-check --sandbox read-only -$/);
  const rs = await runCodex('tiếp', { resumeId: 'thr-0' }).done;
  assert.match(rs.text, /\|resume=thr-0\|args=.*exec resume thr-0 --json --skip-git-repo-check -$/);
  assert.doesNotMatch(rs.text, /--sandbox/);
  const lim = await runCodex('LIMIT').done;
  assert.equal(lim.ok, false); assert.equal(lim.limit, true);
  assert.ok(Math.abs(lim.resetAt - (Date.now() + 2 * 3600000)) < 60000);
  const bad = await runCodex('FAIL').done;
  assert.equal(bad.ok, false); assert.equal(bad.limit, false); assert.match(bad.error, /codex boom/);
});

// ---------- worker: định tuyến, chuyển engine, chờ hạn mức (engine giả bằng hàm) ----------

const H = 3600000;
function stub(fn) {
  const calls = [];
  return { calls, start: ({ prompt, resumeId }) => { calls.push({ prompt, resumeId }); return { done: Promise.resolve(fn(prompt, resumeId, calls.length)), kill() {} }; } };
}
const okRes = (text, sid) => ({ ok: true, text, sessionId: sid || null, limit: false });

function routing(claudeFn, codexFn) {
  const db = openDb(':memory:');
  const clock = { t: new Date(2026, 9, 19, 10, 0, 0).getTime() };
  const claude = stub(claudeFn), codex = stub(codexFn);
  const sent = [];
  const worker = createWorker({
    db, engines: { claude, codex }, order: ['claude', 'codex'], now: () => clock.t,
    notify: async (c, t) => { sent.push(t); },
  });
  const go = async (prompt, pref) => { const id = db.addJob(7, prompt, pref); await worker.wake(); return id; };
  return { db, clock, claude, codex, sent, worker, go };
}

test('định tuyến: Claude hết hạn mức -> chuyển Codex, việc sau đi thẳng Codex, hồi rồi quay lại Claude', async () => {
  let claudeLimited = true;
  const R = routing(
    () => (claudeLimited ? { ok: false, limit: true, resetAt: new Date(2026, 9, 19, 13, 0).getTime(), error: 'limit' } : okRes('claude ok', 's-c')),
    () => okRes('codex ok', 's-x'),
  );
  const j1 = await R.go('một');
  assert.equal(R.db.getJob(j1).status, 'done'); assert.equal(R.db.getJob(j1).engine, 'codex');
  assert.ok(R.sent.some((s) => /Claude đã hết hạn mức.*Chuyển việc #1 sang Codex/.test(s)));
  assert.ok(R.sent.some((s) => /^Việc #1 \(Codex\) xong:\ncodex ok/.test(s)));
  assert.equal(R.claude.calls.length, 1);

  await R.go('hai');                                   // Claude còn nghỉ -> không gọi nữa
  assert.equal(R.claude.calls.length, 1); assert.equal(R.codex.calls.length, 2);

  claudeLimited = false; R.clock.t += 4 * H;           // qua giờ hồi
  const j3 = await R.go('ba');
  assert.equal(R.db.getJob(j3).engine, 'claude');
  assert.ok(R.sent.some((s) => /^Việc #3 xong:\nclaude ok/.test(s)));
});

test('định tuyến: hết cả hai -> chờ, báo một lần, tự chạy lại khi tới giờ', async () => {
  let claudeUp = false;
  const R = routing(
    () => (claudeUp ? okRes('claude ok') : { ok: false, limit: true, resetAt: R.clock.t + 3 * H, error: 'l' }),
    () => ({ ok: false, limit: true, resetAt: R.clock.t + 5 * H, error: 'l' }),
  );
  const j = await R.go('việc dài');
  const job = R.db.getJob(j);
  assert.equal(job.status, 'waiting');
  assert.equal(job.run_after, R.clock.t + 3 * H);               // chờ engine hồi sớm nhất
  assert.equal(R.sent.filter((s) => /đang chờ vì Claude và Codex đều hết hạn mức/.test(s)).length, 1);

  R.clock.t += 1 * H; await R.worker.wake();                     // chưa tới giờ
  assert.equal(R.db.getJob(j).status, 'waiting');
  assert.equal(R.claude.calls.length, 1);                        // không gọi lại engine đang nghỉ

  claudeUp = true; R.clock.t += 2.5 * H; await R.worker.wake();  // qua giờ
  assert.equal(R.db.getJob(j).status, 'done'); assert.equal(R.db.getJob(j).engine, 'claude');
  assert.equal(R.sent.filter((s) => /đang chờ vì/.test(s)).length, 1); // không báo trùng
});

test('định tuyến: không biết giờ hồi -> nghỉ theo mặc định; ép engine thì không tự chuyển', async () => {
  const R = routing(() => ({ ok: false, limit: true, resetAt: null, error: 'l' }), () => okRes('codex ok'));
  await R.go('a');
  assert.equal(R.db.kvGet('cool:claude'), String(R.clock.t + H));   // mặc định 1 giờ

  const R2 = routing(() => okRes('claude ok'), () => ({ ok: false, limit: true, resetAt: new Date(2026, 9, 19, 12, 0).getTime(), error: 'l' }));
  const id = await R2.go('ép codex', 'codex');                       // Codex hết, Claude rảnh nhưng người dùng ép Codex
  assert.equal(R2.db.getJob(id).status, 'waiting');
  assert.equal(R2.claude.calls.length, 0);
});

test('định tuyến: lỗi thường không chuyển engine; chuyển engine thì mang theo ngữ cảnh; /moi cắt ngữ cảnh', async () => {
  let claudeMode = 'ok';
  const R = routing(
    (p) => (claudeMode === 'limit' ? { ok: false, limit: true, resetAt: R.clock.t + 9 * H, error: 'l' } : claudeMode === 'err' ? { ok: false, limit: false, error: 'hỏng thật' } : okRes('trả lời: ' + p.slice(0, 20), 's-c')),
    (p) => okRes('codex nhận: ' + p, 's-x'),
  );
  await R.go('viết thư cho khách');                       // Claude làm, có phiên
  claudeMode = 'err';
  const e = await R.go('việc lỗi');
  assert.equal(R.db.getJob(e).status, 'error'); assert.equal(R.codex.calls.length, 0);

  claudeMode = 'limit';
  await R.go('tiếp tục thư đó');                         // Claude hết -> Codex chưa có phiên -> kèm ngữ cảnh
  const p = R.codex.calls[0].prompt;
  assert.equal(R.codex.calls[0].resumeId, null);
  assert.match(p, /Ngữ cảnh các việc trước/); assert.match(p, /viết thư cho khách/); assert.match(p, /Yêu cầu mới:\ntiếp tục thư đó$/);

  await R.go('việc nữa');                                // Codex đã có phiên -> dùng phiên, không nhồi ngữ cảnh
  assert.equal(R.codex.calls[1].resumeId, 's-x'); assert.equal(R.codex.calls[1].prompt, 'việc nữa');

  const bot = createBot({ db: R.db, worker: R.worker, allowed: new Set(['7']) });
  bot.handle({ from: { id: 7 }, chat: { id: 7, type: 'private' }, text: '/moi' });
  await R.go('chủ đề khác');
  assert.equal(R.codex.calls[2].resumeId, null); assert.equal(R.codex.calls[2].prompt, 'chủ đề khác');
});

// ---------- bot ----------

function botSetup(engineFns) {
  const db = openDb(':memory:');
  const sent = [];
  const engines = {};
  for (const k of Object.keys(engineFns)) engines[k] = { start: ({ prompt, resumeId }) => engineFns[k](prompt, resumeId) };
  const worker = createWorker({ db, engines, order: Object.keys(engineFns), notify: async (c, t) => { sent.push([String(c), t]); } });
  const bot = createBot({ db, worker, allowed: new Set(['42']) });
  const msg = (text, uid) => ({ from: { id: uid || 42 }, chat: { id: uid || 42, type: 'private' }, text });
  const idle = async () => { for (let i = 0; i < 200; i++) { if (!worker.currentJobId() && db.queuedCount() === 0) { await new Promise((r) => setTimeout(r, 30)); if (!worker.currentJobId() && db.queuedCount() === 0) return; } await new Promise((r) => setTimeout(r, 50)); } };
  return { db, sent, worker, bot, msg, idle };
}
const procEngine = (fake, runner) => (prompt, resumeId) => runner(prompt, { resumeId });

test('bot: người lạ bị bỏ qua, chỉ /id được trả lời; chat nhóm bị bỏ qua', () => {
  const { bot, msg, db } = botSetup({ claude: procEngine(null, run) });
  assert.equal(bot.handle(msg('làm việc gì đó', 99)), null);
  assert.equal(db.queuedCount(), 0);
  assert.equal(bot.handle(msg('/id', 99)), 'ID Telegram của bạn: 99');
  assert.equal(bot.handle({ from: { id: 42 }, chat: { id: -5, type: 'group' }, text: 'hi' }), null);
});

test('bot + worker: nhận việc, chạy tiến trình thật, giữ phiên, /moi xóa phiên, báo lỗi', async () => {
  const { bot, msg, sent, idle, db, worker } = botSetup({ claude: procEngine(null, run) });
  assert.match(bot.handle(msg('việc một')), /Đã nhận việc #1/);
  await idle();
  assert.match(sent[0][1], /Việc #1 xong:\necho:việc một/);
  bot.handle(msg('việc hai')); await idle();
  assert.match(sent[1][1], /resume=sess-1/);
  assert.equal(bot.handle(msg('/moi')), 'Đã bắt đầu cuộc trò chuyện mới.');
  bot.handle(msg('việc ba')); await idle();
  assert.doesNotMatch(sent[2][1], /resume=/);
  bot.handle(msg('FAIL')); await idle();
  assert.equal(db.getJob(4).status, 'error');
  db.kvSet('session:42:claude', 'cu');
  bot.handle(msg('NOSESSION')); await idle();           // phiên cũ mất -> làm lại không kèm phiên
  assert.equal(db.getJob(5).status, 'done');
  await worker.stop();
});

test('bot: /codex ép engine, thiếu nội dung, engine chưa bật, /trangthai hiện hạn mức', async () => {
  const { bot, msg, idle, db, worker } = botSetup({ claude: procEngine(null, run), codex: procEngine(null, runCodex) });
  assert.equal(bot.handle(msg('/codex')), 'Cách dùng: /codex <việc cần làm>');
  assert.match(bot.handle(msg('/codex tóm tắt giúp')), /Đã nhận việc #1/);
  await idle();
  assert.equal(db.getJob(1).engine, 'codex'); assert.match(db.getJob(1).result, /^codex:tóm tắt giúp/);
  assert.match(bot.handle(msg('/viec')), /#1 \[xong, codex\]/);

  const solo = botSetup({ claude: procEngine(null, run) });
  assert.equal(solo.bot.handle(solo.msg('/codex làm đi')), 'Engine codex chưa được bật trên máy này.');

  db.kvSet('cool:claude', Date.now() + H);
  const st = bot.handle(msg('/trangthai'));
  assert.match(st, /Claude: hết hạn mức, hồi khoảng/); assert.match(st, /Codex: sẵn sàng/);
  await worker.stop();
});

test('bot: /huy hủy việc đang chạy, việc chờ và việc đang chờ hạn mức', async () => {
  const { bot, msg, idle, db, worker } = botSetup({ claude: procEngine(null, run) });
  bot.handle(msg('SLOW'));
  bot.handle(msg('việc chờ'));
  await new Promise((r) => setTimeout(r, 400));
  assert.match(bot.handle(msg('/huy')), /Đã hủy việc đang chạy và 1 việc đang chờ/);
  await idle();
  assert.equal(db.getJob(1).status, 'cancelled'); assert.equal(db.getJob(2).status, 'cancelled');
  assert.equal(bot.handle(msg('/huy')), 'Không có việc nào để hủy.');

  const w = db.addJob(42, 'đang chờ hạn mức'); db.claimNext(); db.setWaiting(w, Date.now() + H);
  assert.match(bot.handle(msg('/huy')), /Đã hủy 1 việc đang chờ/);
  assert.equal(db.getJob(w).status, 'cancelled');
  await worker.stop();
});

// ---------- chế độ TOÀN QUYỀN ----------

test('toàn quyền: config đọc FULL_ACCESS; Claude chạy với --dangerously-skip-permissions và không còn allowedTools/cổng duyệt', async () => {
  const ok = { TELEGRAM_TOKEN: 't', ALLOWED_USER_IDS: '1' };
  assert.equal(config.load(ok).fullAccess, false);
  for (const v of ['1', 'true', 'ON', 'yes']) assert.equal(config.load(Object.assign({ FULL_ACCESS: v }, ok)).fullAccess, true, v);
  assert.equal(config.load(Object.assign({ FULL_ACCESS: '0' }, ok)).fullAccess, false);

  const full = await run('làm đi', { allowedTools: undefined, skipPermissions: true }).done;
  assert.match(full.text, /--dangerously-skip-permissions/);
  assert.doesNotMatch(full.text, /--allowedTools|--permission-prompt-tool|--settings/);
  const prot = await run('làm đi').done;
  assert.doesNotMatch(prot.text, /--dangerously-skip-permissions/);     // chế độ bảo vệ không bao giờ có cờ này
});

test('toàn quyền: /toanquyen và /baove chỉ quản trị viên, đổi chế độ, /trangthai hiện chế độ', () => {
  const db = openDb(':memory:');
  const worker = createWorker({ db, engines: { claude: { start: () => { throw new Error('không chạy'); } } }, order: ['claude'], notify: async () => {} });
  let on = false;
  const fullAccess = { get: () => on, set: (v) => { on = v; } };
  const admins = new Set(['1']);
  const bot = createBot({ db, worker, allowed: new Set(['1', '2']), isAdmin: (u) => admins.has(String(u)), fullAccess });
  const m = (text, uid) => ({ from: { id: uid || 1 }, chat: { id: uid || 1, type: 'private' }, text });
  assert.match(bot.handle(m('/trangthai')), /Chế độ: 🛡️ bảo vệ/);
  assert.match(bot.handle(m('/toanquyen', 2)), /Chỉ quản trị viên/);
  assert.equal(on, false);                                   // người được phép nhưng không phải admin: không đổi được
  assert.match(bot.handle(m('/toanquyen')), /ĐÃ BẬT chế độ TOÀN QUYỀN/);
  assert.equal(on, true);
  assert.match(bot.handle(m('/trangthai')), /Chế độ: ⚡ TOÀN QUYỀN/);
  assert.match(bot.handle(m('/baove')), /chế độ bảo vệ/);
  assert.equal(on, false);
  assert.match(bot.handle(m('/baove', 99)) || 'null', /null/);   // người lạ: im lặng
  assert.match(createBot({ db, worker, allowed: new Set(['1']) }).handle(m('/toanquyen')), /chưa hỗ trợ/);   // không có bộ nhớ chế độ
});
