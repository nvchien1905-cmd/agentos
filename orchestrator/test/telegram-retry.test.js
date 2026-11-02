'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegram } = require('../src/telegram');

const ok = () => ({ json: async () => ({ ok: true, result: { message_id: 1 } }), status: 200 });

test('Telegram: mạng chập chờn (fetch failed) thì thử lại rồi gửi được, câu trả lời không mất định dạng đẹp', async () => {
  let n = 0; const waits = [];
  const f = async () => { n++; if (n <= 2) throw new TypeError('fetch failed'); return ok(); };
  const tg = createTelegram('T', f, { sleep: async (ms) => { waits.push(ms); }, retryMs: [1, 2, 3, 4] });
  await tg.sendRich(5, '**đậm**');
  assert.equal(n, 3); assert.deepEqual(waits, [1, 2]);
});

test('Telegram: lỗi thật của Telegram (có mã lỗi) không thử lại; mất mạng quá số lần thì báo lỗi; getUpdates không thử lại ở đây', async () => {
  let n = 0;
  const bad = async () => { n++; return { json: async () => ({ ok: false, error_code: 400, description: 'Bad Request' }), status: 400 }; };
  await assert.rejects(createTelegram('T', bad, { sleep: async () => {}, retryMs: [1, 1] }).call('sendMessage', {}), /Bad Request/); assert.equal(n, 1);
  n = 0; const down = async () => { n++; throw new TypeError('fetch failed'); };
  await assert.rejects(createTelegram('T', down, { sleep: async () => {}, retryMs: [1, 1] }).call('sendMessage', {}), /fetch failed/); assert.equal(n, 3);
  n = 0; await assert.rejects(createTelegram('T', down, { sleep: async () => {}, retryMs: [1, 1] }).getUpdates(0, 1), /fetch failed/); assert.equal(n, 1);
});
