'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTgWatch } = require('../src/tgwatch');
const { createTelegram } = require('../src/telegram');
const { openDb } = require('../src/db');

const err = (code, msg) => Object.assign(new Error(msg || 'Telegram getUpdates: x'), { code });

test('409 liên tiếp: nhắn chủ máy MỘT lần (nêu rõ nguyên nhân), không spam; hết xung đột thì báo ổn lại', async () => {
  const db = openDb(':memory:'); const sent = []; let t = Date.now();
  const tg = { call: async () => ({ url: '' }), sendMessage: async (c, m) => { sent.push([c, m]); } };
  const w = createTgWatch({ tg, db, admins: ['7'], now: () => t });
  await w.onError(err(409)); await w.onError(err(409));
  assert.equal(w.state().kind, 'ok'); assert.equal(sent.length, 0);          // 1–2 lần: có thể chỉ do khởi động lại
  await w.onError(err(409));
  assert.equal(w.state().kind, 'conflict'); assert.equal(sent.length, 1);
  assert.match(sent[0][1], /KHÁC đang cùng nhận tin/); assert.match(sent[0][1], /@BotFather/);
  for (let i = 0; i < 20; i++) await w.onError(err(409));
  assert.equal(sent.length, 1, 'không báo lặp');
  t += 60000; await w.onOk();
  assert.equal(w.state().kind, 'ok'); assert.equal(sent.length, 2); assert.match(sent[1][1], /bình thường lại/);
});

test('409 do webhook: nói rõ là webhook; 401: ghi trạng thái token hỏng, lỗi mạng thường không đổi trạng thái', async () => {
  const db = openDb(':memory:'); const sent = [];
  const tg = { call: async (m) => (m === 'getWebhookInfo' ? { url: 'https://example.com/hook/abc' } : null), sendMessage: async (c, m) => { sent.push(m); } };
  const w = createTgWatch({ tg, db, admins: ['7'] });
  for (let i = 0; i < 3; i++) await w.onError(err(409));
  assert.match(sent[0], /WEBHOOK \(https:\/\/example\.com\)/); assert.doesNotMatch(sent[0], /hook\/abc/);   // không lộ đường dẫn bí mật
  const w2 = createTgWatch({ tg, db: openDb(':memory:'), admins: ['7'] });
  await w2.onError(new Error('fetch failed')); assert.equal(w2.state().kind, 'ok');
  await w2.onError(err(401, 'Unauthorized')); assert.equal(w2.state().kind, 'badtoken');
  await w2.onOk(); assert.equal(w2.state().kind, 'ok');
});

test('telegram: lệnh gọi thường có giới hạn thời gian (không treo vô hạn khi mạng chập chờn)', async () => {
  let sig = null;
  const tg = createTelegram('T', async (url, opts) => { sig = opts.signal; return { status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }; });
  await tg.sendMessage('1', 'xin chào');
  assert.ok(sig && typeof sig.aborted === 'boolean', 'phải có AbortSignal');
});
