'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSummarizer } = require('../src/summarizer');

test('nén ngữ cảnh: không có khóa API thì dùng Codex (tài khoản đã đăng nhập); có khóa thì khóa đi trước; provider=codex ép dùng Codex', async () => {
  const calls = [];
  const codex = async (sys, user) => { calls.push([sys, user]); return '{"summary":"ok"}'; };
  const s = createSummarizer({ keys: {}, provider: 'auto', codex });
  assert.equal(s.available(), true); assert.equal(s.provider(), 'codex');
  const r = await s.run('SYS', 'nội dung'); assert.equal(r.via, 'codex'); assert.equal(r.text, '{"summary":"ok"}'); assert.equal(calls.length, 1);
  assert.equal(createSummarizer({ keys: { deepseekapi: 'k' }, provider: 'auto', codex }).provider(), 'deepseek');
  assert.equal(createSummarizer({ keys: { deepseekapi: 'k' }, provider: 'codex', codex }).provider(), 'codex');
  assert.equal(createSummarizer({ keys: {}, provider: 'none', codex }).provider(), null);
  assert.equal(createSummarizer({ keys: {}, provider: 'auto' }).available(), false, 'không có Codex lẫn khóa thì cắt gọn');
  const bad = createSummarizer({ keys: {}, provider: 'auto', codex: async () => { throw new Error('hỏng'); } });
  assert.equal(await bad.run('S', 'u'), null, 'Codex lỗi → null (bộ nhớ tự cắt gọn), không ném lỗi');
});

test('worker: việc quá thời gian / bị hủy / chạy quá 10 phút thì chỉ việc bị HỦY mới bỏ phiên; việc xong, quá hạn hay chạy lâu vẫn giữ phiên', async () => {
  const { openDb } = require('../src/db'); const { createWorker } = require('../src/worker');
  const db = openDb(':memory:'); let t = 1000000, mode = 'ok';
  const engines = { claude: { start: () => { if (mode === 'slow') t += 11 * 60 * 1000; return { done: Promise.resolve(mode === 'timeout' ? { ok: false, limit: false, timedOut: true, error: 'x' } : mode === 'cancel' ? { ok: false, limit: false, cancelled: true, error: 'Đã hủy' } : { ok: true, text: 't', sessionId: 'S-' + mode }), kill() {} }; } } };
  const worker = createWorker({ db, engines, order: ['claude'], notify: async () => {}, now: () => t, retryDelaysMs: [1], log: () => {} });
  const key = (id) => 'session:' + db.getJob(id).chat_id + ':claude';
  let id = db.addJob('7', 'a', null, null, 'main', null); await worker.wake(); assert.equal(db.kvGet(key(id)), 'S-ok', 'việc thường giữ phiên');
  mode = 'timeout'; id = db.addJob('7', 'b', null, null, 'main', null); await worker.wake(); assert.equal(db.kvGet(key(id)), 'S-ok', 'quá thời gian → vẫn giữ phiên (gõ tiếp tục là làm tiếp)');
  mode = 'ok'; id = db.addJob('7', 'c', null, null, 'main', null); await worker.wake(); assert.equal(db.kvGet(key(id)), 'S-ok');
  mode = 'cancel'; id = db.addJob('7', 'x', null, null, 'main', null); await worker.wake(); assert.equal(db.kvGet(key(id)), null, 'bị hủy → bỏ phiên');
  mode = 'slow'; id = db.addJob('7', 'd', null, null, 'main', null); await worker.wake(); assert.equal(db.kvGet(key(id)), 'S-slow', 'việc chạy lâu nhưng xong thì GIỮ phiên (việc dài nhiều giờ không mất mạch)');
});
