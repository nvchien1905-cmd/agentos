'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { startGemini, parseOutput } = require('../src/engines/gemini');
const { startClaude } = require('../src/engines/claude');
const { classifyFailure, parseResetTime } = require('../src/limits');
const config = require('../src/config');
const { loadTools } = require('../src/tools');
const { openDb } = require('../src/db');
const { createWorker } = require('../src/worker');

const FAKE = path.join(__dirname, 'fake-gemini.js');
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const run = (prompt, extra) => startGemini(Object.assign({ bin: process.execPath, binArgs: [FAKE], cwd: __dirname, prompt, timeoutMs: 8000 }, extra || {}));

test('gemini: thành công (prompt qua stdin, chỉ đọc theo mặc định, mô hình và phiên nối tiếp)', async () => {
  const r = await run('xin chào').done;
  assert.equal(r.ok, true); assert.equal(r.sessionId, 'g-1'); assert.equal(r.limit, false);
  assert.match(r.text, /^gemini:xin chào\|args=/);
  assert.match(r.text, /-p  --output-format json --skip-trust --approval-mode plan/);       // -p "" + chỉ đọc (plan)
  assert.doesNotMatch(r.text, /yolo/);
  const y = await run('làm đi', { mode: 'yolo', model: 'gemini-2.5-pro', resumeId: 'sess-9' }).done;
  assert.match(y.text, /--approval-mode yolo/); assert.match(y.text, /-m gemini-2.5-pro/); assert.match(y.text, /\|resume=sess-9\|/);
});

test('gemini: dòng cảnh báo trước JSON vẫn đọc được; không phải JSON thì coi là lỗi', async () => {
  const w = await run('WARN hỏi').done;
  assert.equal(w.ok, true); assert.match(w.text, /^gemini:WARN hỏi/);
  assert.deepEqual(parseOutput('(!) cảnh báo\n{ "response": "ok" }'), { response: 'ok' });
  assert.equal(parseOutput(''), null); assert.equal(parseOutput('không phải json'), null); assert.equal(parseOutput('[1,2]'), null);
  const f = await run('FAIL').done;
  assert.equal(f.ok, false); assert.equal(f.limit, false); assert.match(f.error, /Thoát với mã 2|gemini boom/);
});

test('gemini: chưa đăng nhập (mã 41) nhận ra được, KHÔNG bị coi là hết hạn mức hay lỗi tạm', async () => {
  const r = await run('NOAUTH').done;
  assert.equal(r.ok, false); assert.equal(r.notLoggedIn, true); assert.equal(r.limit, false); assert.equal(r.transient, false);
  assert.match(r.error, /Auth method/);
});

test('gemini: hết hạn mức (429 RESOURCE_EXHAUSTED) kèm giờ hồi; quá tải 503 là lỗi tạm', async () => {
  const l = await run('LIMIT').done;
  assert.equal(l.ok, false); assert.equal(l.limit, true); assert.equal(l.transient, false);
  assert.ok(l.resetAt > Date.now() + 2 * 3600 * 1000 && l.resetAt < Date.now() + 3 * 3600 * 1000, 'giờ hồi ≈ 2h30m nữa');
  const b = await run('BUSY').done;
  assert.equal(b.ok, false); assert.equal(b.transient, true); assert.equal(b.limit, false);
  const none = await startGemini({ bin: 'khong-co-lenh-gemini-xyz', cwd: __dirname, prompt: 'x' }).done;
  assert.equal(none.ok, false);
});

test('limits: nhận ra câu chữ hết hạn mức của Gemini và giờ hồi viết liền (2h30m)', () => {
  assert.equal(classifyFailure('You have exhausted your capacity on this model. (429 RESOURCE_EXHAUSTED)').limit, true);
  assert.equal(classifyFailure('Quota exceeded for quota metric').limit, true);
  assert.equal(classifyFailure('The model is overloaded. Please try again later (503)').transient, true);
  const now = Date.UTC(2026, 9, 20, 0, 0);
  assert.equal(parseResetTime('Your quota will reset after 2h30m', now), now + 2.5 * 3600 * 1000);
  assert.equal(parseResetTime('try again in 2 hours 30 minutes', now), now + 2.5 * 3600 * 1000);          // dạng cũ vẫn đúng
  assert.equal(parseResetTime('resets in 45 minutes', now), now + 45 * 60 * 1000);
});

test('config + công cụ: ENGINE_ORDER nhận gemini; bộ công cụ không có MCP dùng được cả ba AI, bộ có trình duyệt chỉ Claude', () => {
  const ok = { TELEGRAM_TOKEN: 't', ALLOWED_USER_IDS: '1', ENGINE_ORDER: 'claude, codex, gemini' };
  assert.deepEqual(config.load(ok).engineOrder, ['claude', 'codex', 'gemini']);
  assert.equal(config.validate(config.load(ok)).length, 0);
  assert.equal(config.load(ok).geminiBin, 'gemini');
  assert.equal(config.load(Object.assign({ GEMINI_BIN: '/x/gemini', GEMINI_MODEL: 'm1' }, ok)).geminiModel, 'm1');
  assert.equal(config.validate(config.load(Object.assign({}, ok, { ENGINE_ORDER: 'claude,gemini,gemini' }))).length, 1);
  const t = loadTools({ file: path.join(__dirname, '..', 'tools.linux.json'), vars: {} });
  assert.deepEqual(t.errors, []);
  assert.deepEqual(t.enginesFor('chung'), ['claude', 'codex', 'gemini', 'deepseekapi']);
  assert.deepEqual(t.enginesFor('web'), ['claude']);
  assert.deepEqual(t.enginesFor('lam'), ['claude']);
});

test('định tuyến: Claude hết hạn mức -> chuyển sang Gemini và trả lời; việc sau đi thẳng Gemini; /gemini ép dùng; resume hỏng thì làm lại không kèm phiên', async () => {
  const db = openDb(':memory:');
  const sent = [];
  const engines = {
    claude: { start: ({ prompt }) => startClaude({ bin: process.execPath, binArgs: [FAKE_CLAUDE], cwd: __dirname, prompt: 'LIMIT ' + prompt, allowedTools: 'Read', timeoutMs: 8000 }) },
    gemini: { start: ({ prompt, resumeId }) => startGemini({ bin: process.execPath, binArgs: [FAKE], cwd: __dirname, prompt, resumeId, timeoutMs: 8000 }) },
  };
  const worker = createWorker({ db, engines, order: ['claude', 'gemini'], notify: async (c, t) => { sent.push(String(t)); } });
  const idle = async () => { for (let i = 0; i < 200; i++) { if (!worker.currentJobId() && db.queuedCount() === 0) { await new Promise((r) => setTimeout(r, 30)); if (!worker.currentJobId() && db.queuedCount() === 0) return; } await new Promise((r) => setTimeout(r, 50)); } };
  db.addJob('7', 'việc một', null, null); worker.wake(); await idle();
  assert.ok(sent.some((t) => /gemini:/.test(t) && /việc một/.test(t)), sent.join(' | '));       // Gemini trả lời thay
  assert.ok(sent.some((t) => /chuyển|hết hạn mức/i.test(t)), 'báo đã chuyển AI: ' + sent.join(' | '));
  assert.equal(db.getJob(1).status, 'done');
  db.addJob('7', 'việc hai', 'gemini', null); worker.wake(); await idle();
  assert.match(db.getJob(2).result, /resume=g-1/);                                               // nối tiếp phiên của Gemini
  db.addJob('7', 'NOSESSION ba', 'gemini', null); worker.wake(); await idle();
  assert.equal(db.getJob(3).status, 'done'); assert.doesNotMatch(db.getJob(3).result.split('|args=').pop(), /--resume/);  // phiên cũ mất -> chạy lại không kèm phiên
  await worker.stop();
});
