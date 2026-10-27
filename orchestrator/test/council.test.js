'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createWorker } = require('../src/worker');
const { createBot } = require('../src/bot');

function setup(spec, extra) {
  const db = openDb(':memory:'), sent = [], calls = [];
  const engines = {};
  for (const [name, f] of Object.entries(spec)) engines[name] = { start: (a) => { calls.push({ eng: name, prompt: a.prompt, resumeId: a.resumeId }); return { done: Promise.resolve(f(a, calls.filter((c) => c.eng === name).length)), kill() {} }; } };
  const worker = createWorker(Object.assign({ db, engines, order: Object.keys(spec), notify: async (c, t) => { sent.push(t); }, retryDelaysMs: [1] }, extra || {}));
  return { db, sent, calls, worker };
}
const ok = (text) => ({ ok: true, text, sessionId: 's' });

test('hội đồng AI: hai AI làm ĐỘC LẬP (không thấy bài nhau), AI thứ ba đối chiếu; không lưu phiên', async () => {
  const W = setup({ claude: () => ok('Đáp án A: 120 triệu'), codex: () => ok('Đáp án B: 125 triệu'), gemini: (a) => ok('Hai bên khác nhau ở 5 triệu. Đúng là 120 triệu. KẾT LUẬN: 120 triệu') });
  const id = W.db.addJob('1', 'Tính doanh thu quý', null, null, 'main', null, true); await W.worker.wake();
  const j = W.db.getJob(id); assert.equal(j.status, 'done');
  assert.deepEqual(W.calls.map((c) => c.eng), ['claude', 'codex', 'gemini']);
  assert.match(W.calls[0].prompt, /Tính doanh thu quý/); assert.doesNotMatch(W.calls[0].prompt, /Đáp án/); assert.doesNotMatch(W.calls[1].prompt, /Đáp án A/, 'AI thứ hai không thấy bài AI thứ nhất');
  assert.match(W.calls[2].prompt, /TRỌNG TÀI/); assert.match(W.calls[2].prompt, /Đáp án A: 120 triệu/); assert.match(W.calls[2].prompt, /Đáp án B: 125 triệu/);
  assert.match(j.result, /HỘI ĐỒNG AI — Claude và Codex làm độc lập, Gemini đối chiếu/); assert.match(j.result, /KẾT LUẬN: 120 triệu/); assert.match(j.result, /Ý kiến Claude:[\s\S]*Đáp án A/); assert.match(j.result, /Ý kiến Codex:[\s\S]*Đáp án B/);
  for (const c of W.calls) assert.equal(c.resumeId, null, 'mỗi bước độc lập, không dùng phiên cũ');
  assert.equal(W.db.kvGet('session:1:claude'), null, 'không lưu phiên của bước hội đồng');
});

test('hội đồng AI: chỉ có hai AI thì một trong hai làm trọng tài; AI hết hạn mức bị bỏ qua; thiếu AI thì làm bình thường', async () => {
  const W = setup({ claude: () => ok('A'), codex: () => ok('B') });
  W.db.addJob('1', 'việc', null, null, 'main', null, true); await W.worker.wake();
  assert.deepEqual(W.calls.map((c) => c.eng), ['claude', 'codex', 'claude']); assert.match(W.calls[2].prompt, /TRỌNG TÀI/);
  // claude hết hạn mức -> bỏ qua claude, dùng codex + gemini
  const W2 = setup({ claude: () => ({ ok: false, limit: true, resetAt: Date.now() + 3600000, error: 'limit' }), codex: () => ok('B'), gemini: () => ok('C') });
  const id2 = W2.db.addJob('1', 'việc', null, null, 'main', null, true); await W2.worker.wake();
  assert.equal(W2.db.getJob(id2).status, 'done'); assert.match(W2.db.getJob(id2).result, /Codex và Gemini làm độc lập/);
  // chỉ còn một AI dùng được -> làm bình thường + báo
  const W3 = setup({ claude: () => ({ ok: false, limit: true, resetAt: Date.now() + 3600000, error: 'limit' }), codex: () => ok('đáp án duy nhất') });
  const id3 = W3.db.addJob('1', 'việc', null, null, 'main', null, true); await W3.worker.wake();
  assert.equal(W3.db.getJob(id3).status, 'done'); assert.equal(W3.db.getJob(id3).result, 'đáp án duy nhất'); assert.ok(W3.sent.some((s) => /ít nhất 2 AI/.test(s)));
});

test('hội đồng AI: trọng tài lỗi thì vẫn giao hai ý kiến để chủ máy tự đối chiếu', async () => {
  const W = setup({ claude: () => ok('A'), codex: () => ok('B'), gemini: () => ({ ok: false, error: 'hỏng' }) });
  const id = W.db.addJob('1', 'việc', null, null, 'main', null, true); await W.worker.wake();
  const r = W.db.getJob(id).result; assert.match(r, /Trọng tài Gemini không trả lời được/); assert.match(r, /Ý kiến Claude:[\s\S]*A/); assert.match(r, /Ý kiến Codex:[\s\S]*B/);
});

test('Telegram /hoidong: giao việc hội đồng; cần ít nhất 2 AI; người chỉ xem báo cáo không dùng được', async () => {
  const db = openDb(':memory:'); const worker = { wake() {}, engineNames: () => ['claude', 'codex'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const mkbot = (w, roles) => createBot({ db, worker: w, allowed: new Set(['111']), profiles: [], isAdmin: () => true, quietAck: true, roles });
  const say = (b, t) => b.handle({ from: { id: 111 }, chat: { id: 111, type: 'private' }, text: t });
  const bot = mkbot(worker);
  assert.match(await say(bot, '/hoidong'), /Cách dùng/);
  await say(bot, '/hoidong soạn hợp đồng thuê kho'); const j = db.recentJobs('111', 1)[0]; assert.equal(j.council, 1); assert.equal(j.prompt, 'soạn hợp đồng thuê kho');
  assert.match(await say(mkbot(Object.assign({}, worker, { engineNames: () => ['claude'] })), '/hoidong x'), /ít nhất 2 AI/);
  assert.match(await say(mkbot(worker, { canAsk: () => false, label: () => 'Xem' }), '/hoidong x'), /chỉ xem/);
});
