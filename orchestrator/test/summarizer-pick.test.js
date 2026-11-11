'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSummarizer } = require('../src/summarizer');

test('nén ngữ cảnh: bot chỉ có Claude thì không bao giờ thử Codex; có cả hai thì theo thứ tự ưu tiên của bot', async () => {
  const calls = [];
  const claude = async () => { calls.push('claude'); return 'tóm tắt claude'; }, codex = async () => { calls.push('codex'); return 'tóm tắt codex'; };
  const onlyClaude = createSummarizer({ provider: 'auto', claude, codex: null, engineOrder: ['claude'], log() {} });
  assert.equal(onlyClaude.provider(), 'claude'); assert.equal((await onlyClaude.run('s', 'u')).via, 'claude');
  const onlyCodex = createSummarizer({ provider: 'auto', claude: null, codex, engineOrder: ['codex'], log() {} });
  assert.equal(onlyCodex.provider(), 'codex');
  const both = createSummarizer({ provider: 'auto', claude, codex, engineOrder: ['codex', 'claude'], log() {} });
  assert.equal(both.provider(), 'codex'); await both.run('s', 'u'); assert.deepEqual(calls, ['claude', 'codex']);
  const none = createSummarizer({ provider: 'auto', engineOrder: ['claude'], log() {} });
  assert.equal(none.available(), false); assert.equal(await none.run('s', 'u'), null);
});

test('nén ngữ cảnh: cách đầu lỗi (hết hạn mức, mất đăng nhập) thì thử cách kế tiếp thay vì bỏ nén', async () => {
  const logs = [];
  const s = createSummarizer({ provider: 'auto', claude: async () => { throw new Error('OAuth hết hạn'); }, codex: async () => 'đã nén bằng codex', engineOrder: ['claude', 'codex'], log: (m) => logs.push(m) });
  const r = await s.run('s', 'u');
  assert.deepEqual(r, { text: 'đã nén bằng codex', via: 'codex' }); assert.ok(logs.some((l) => /claude lỗi/.test(l)));
  const dead = createSummarizer({ provider: 'auto', claude: async () => { throw new Error('x'); }, engineOrder: ['claude'], log() {} });
  assert.equal(await dead.run('s', 'u'), null, 'hết cách thì null: bộ nhớ tự cắt gọn như trước');
  assert.equal(createSummarizer({ provider: 'none', claude: async () => 'x', engineOrder: ['claude'] }).available(), false);
});
