'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLive } = require('../../orchestrator/src/live');

test('tin "Đang làm…" vẫn đếm giây khi chưa có bước nào (không đứng ở "2 giây")', async () => {
  let t = 0; const timers = [], ints = [], edits = [];
  const tg = { sendChatAction: async () => {}, sendHtml: async (c, h) => { edits.push(h); return 1; }, editHtml: async (c, id, h) => { edits.push(h); }, deleteMessage: async () => {} };
  const live = createLive({ tg, now: () => t, setTimeout: (f, ms) => { timers.push({ f, at: t + ms }); return {}; }, clearTimeout: () => {}, setInterval: (f, ms) => { ints.push({ f, ms }); return {}; }, clearInterval: () => {} });
  live.begin({ id: 1, chat_id: 5 });
  t = 1800; timers.shift().f();                       // hiện tin sau 1,8 giây
  t = 2500; await timers.shift().f(); await new Promise((r) => setImmediate(r));
  const before = edits.length;
  t = 20000; ints.find((x) => x.ms === 4000).f();     // nhịp đồng hồ, không có bước nào
  const nxt = timers.shift(); assert.ok(nxt); t = 23000; await nxt.f(); await new Promise((r) => setImmediate(r));
  assert.ok(edits.length > before); assert.match(edits[edits.length - 1], /23 giây/);
});
