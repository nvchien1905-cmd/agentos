'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createWorker } = require('../src/worker');
const { createBot } = require('../src/bot');

// Giống index.js: engineCtl sắp lại CHÍNH mảng order mà bộ xếp việc đang dùng
function setup() {
  const db = openDb(':memory:'), sent = [], calls = [];
  const order = ['claude', 'codex'], orig = order.slice();
  const engines = {};
  for (const n of orig) engines[n] = { start: (a) => { calls.push(n); return { done: Promise.resolve({ ok: true, text: 'xong bằng ' + n, sessionId: 's' }), kill() {} }; } };
  const worker = createWorker({ db, engines, order, notify: async (c, t) => { sent.push(t); }, retryDelaysMs: [1] });
  const engineCtl = {
    order: () => order.slice(), original: () => orig.slice(),
    setPrimary(e) { if (!orig.includes(e)) return false; order.splice(0, order.length, e, ...orig.filter((x) => x !== e)); db.kvSet('engine_primary', e); return true; },
    reset() { order.splice(0, order.length, ...orig); db.kvDel('engine_primary'); },
  };
  const bot = createBot({ db, worker, allowed: new Set(['1', '2']), profiles: [], isAdmin: (u) => u === '1', engineCtl });
  const say = (uid, text) => bot.handle({ from: { id: uid }, chat: { id: uid, type: 'private' }, text });
  return { db, worker, order, say, calls, sent };
}

test('/ai: xem, đổi sang Codex có hiệu lực NGAY cho việc mới, Claude làm dự phòng; /ai tudong về mặc định', async () => {
  const S = setup();
  assert.match(await S.say(1, '/ai'), /Claude.*→.*Codex|claude.*→.*codex/i);
  assert.match(await S.say(1, '/ai codex'), /Từ giờ dùng .*odex trước/);
  assert.deepEqual(S.order, ['codex', 'claude']);
  assert.equal(S.db.kvGet('engine_primary'), 'codex', 'nhớ qua lần khởi động sau');
  const id = S.db.addJob('1', 'làm việc A', null, null, 'main', null); await S.worker.wake();
  assert.equal(S.db.getJob(id).status, 'done'); assert.deepEqual(S.calls, ['codex'], 'việc mới chạy bằng Codex');
  assert.match(await S.say(1, '/ai tudong'), /Về thứ tự mặc định/);
  assert.deepEqual(S.order, ['claude', 'codex']); assert.equal(S.db.kvGet('engine_primary'), null);
  assert.match(await S.say(1, '/ai abc'), /Không biết AI/);
  assert.match(await S.say(1, '/ai gemini'), /chưa được bật/);
});

test('"chuyển sang dùng codex" (câu nói tự nhiên) đổi AI ngay, không giao cho AI; câu dài hay việc thật không bị bắt nhầm; chỉ chủ máy', async () => {
  const S = setup();
  for (const t of ['Em chuyển sang dùng codeX cho anh nhé', 'chuyển sang codex', 'dùng codex đi', 'Đổi sang Codex', 'em chuyển hẳn sang dùng codex nha']) {
    S.order.splice(0, 2, 'claude', 'codex');
    assert.match(await S.say(1, t), /Từ giờ dùng .*odex trước/, t); assert.deepEqual(S.order, ['codex', 'claude'], t);
  }
  assert.match(await S.say(1, 'chuyển sang dùng claude nhé'), /Từ giờ dùng .*laude trước/); assert.deepEqual(S.order, ['claude', 'codex']);
  assert.equal(S.db.getJob(1), undefined, 'không tạo việc cho AI');
  // không bắt nhầm: việc thật nhắc tới Codex, hoặc câu dài
  S.order.splice(0, 2, 'claude', 'codex');
  for (const t of ['dùng codex để viết hàm sắp xếp mảng cho anh và giải thích từng bước thật kỹ nhé em', 'so sánh codex với claude', 'codex là gì']) {
    const r = await S.say(1, t); assert.ok(!/Từ giờ dùng/.test(String(r || '')), t);
  }
  assert.deepEqual(S.order, ['claude', 'codex'], 'thứ tự không đổi');
  // người khác không đổi được
  assert.match(await S.say(2, '/ai codex'), /Chỉ chủ máy/); assert.deepEqual(S.order, ['claude', 'codex']);
  const r2 = await S.say(2, 'chuyển sang dùng codex'); assert.ok(!/Từ giờ dùng/.test(String(r2 || ''))); assert.deepEqual(S.order, ['claude', 'codex']);
});

test('/ai codex: Codex hết hạn mức thì việc vẫn tự chuyển sang Claude và vẫn xong', async () => {
  const db = openDb(':memory:'), calls = [], order = ['claude', 'codex'], orig = order.slice();
  const engines = {
    claude: { start: () => { calls.push('claude'); return { done: Promise.resolve({ ok: true, text: 'Claude làm xong', sessionId: 's' }), kill() {} }; } },
    codex: { start: () => { calls.push('codex'); return { done: Promise.resolve({ ok: false, limit: true, resetAt: Date.now() + 3600000, error: 'hết hạn mức' }), kill() {} }; } },
  };
  const worker = createWorker({ db, engines, order, notify: async () => {}, retryDelaysMs: [1] });
  const engineCtl = { order: () => order.slice(), original: () => orig.slice(), setPrimary(e) { order.splice(0, order.length, e, ...orig.filter((x) => x !== e)); return true; }, reset() {} };
  const bot = createBot({ db, worker, allowed: new Set(['1']), profiles: [], isAdmin: () => true, engineCtl });
  await bot.handle({ from: { id: 1 }, chat: { id: 1, type: 'private' }, text: 'chuyển sang dùng codex' });
  const id = db.addJob('1', 'việc cần làm', null, null, 'main', null); await worker.wake();
  assert.equal(db.getJob(id).status, 'done'); assert.match(db.getJob(id).result, /Claude làm xong/);
  assert.deepEqual(calls, ['codex', 'claude'], 'Codex thử trước, hết hạn mức thì Claude làm tiếp');
});
