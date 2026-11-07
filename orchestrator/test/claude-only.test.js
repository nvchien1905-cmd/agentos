'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSummarizer } = require('../src/summarizer');
const { createBot } = require('../src/bot');
const { startClaude } = require('../src/engines/claude');
const config = require('../src/config');
const openDb = (f) => require('../src/db').openDb(f);

test('nén ngữ cảnh bằng Claude: provider "claude" gọi hàm claude(system,user); không có hàm thì không dùng', async () => {
  let got = null;
  const s = createSummarizer({ provider: 'claude', claude: async (sys, user) => { got = [sys, user]; return ' bản tóm tắt '; } });
  assert.equal(s.provider(), 'claude'); assert.equal(s.available(), true);
  const r = await s.run('hệ thống', 'nội dung');
  assert.deepEqual(r, { text: 'bản tóm tắt', via: 'claude' }); assert.deepEqual(got, ['hệ thống', 'nội dung']);
  assert.equal(createSummarizer({ provider: 'claude' }).provider(), null);
  const bad = createSummarizer({ provider: 'claude', claude: async () => { throw new Error('hỏng'); }, log() {} });
  assert.equal(await bad.run('a', 'b'), null, 'lỗi thì trả null (bộ nhớ tự cắt gọn)');
});

test('mặc định CHỈ Claude: CLAUDE_ONLY=0 mới đọc lại ENGINE_ORDER / SUMMARY_PROVIDER / LIGHT_ENGINES', () => {
  const ok = { TELEGRAM_TOKEN: 't', ALLOWED_USER_IDS: '1', ENGINE_ORDER: 'codex,gemini', SUMMARY_PROVIDER: 'gemini', LIGHT_ENGINES: 'gemini' };
  const a = config.load(ok);
  assert.equal(a.claudeOnly, true); assert.deepEqual(a.engineOrder, ['claude']); assert.equal(a.summaryProvider, 'claude'); assert.deepEqual(a.lightEngines, []);
  assert.equal(config.validate(a).length, 0);
  const b = config.load(Object.assign({ CLAUDE_ONLY: '0' }, ok));
  assert.equal(b.claudeOnly, false); assert.deepEqual(b.engineOrder, ['codex', 'gemini']); assert.equal(b.summaryProvider, 'gemini'); assert.deepEqual(b.lightEngines, ['gemini']);
});

test('/ai khi chỉ có Claude: nói rõ "chỉ dùng Claude", không mời đổi sang AI khác', () => {
  const db = openDb(':memory:');
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [{ name: 'claude', label: 'Claude' }], cancelRunning: () => true };
  const engineCtl = { order: () => ['claude'], original: () => ['claude'], reset() { throw new Error('không được gọi'); }, setPrimary() { throw new Error('không được gọi'); } };
  const bot = createBot({ db, worker, allowed: new Set(['1']), isAdmin: () => true, engineCtl });
  const say = (text) => bot.handle({ from: { id: 1 }, chat: { id: 1, type: 'private' }, text });
  assert.match(say('/ai'), /Máy này chỉ dùng Claude/); assert.doesNotMatch(say('/ai'), /\/ai codex|→/);
  assert.match(say('/ai claude'), /chỉ dùng Claude/); assert.match(say('/ai tudong'), /chỉ dùng Claude/);
  assert.match(say('/ai codex'), /đã bỏ codex/); assert.match(say('/ai abc'), /Không biết AI/);
});

test('Claude chạy nén ngữ cảnh: chọn mô hình nhẹ, tắt mọi công cụ và máy chủ MCP', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-')); const bin = path.join(dir, 'fake.sh'), out = path.join(dir, 'args.txt');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > ' + out + '\ncat >/dev/null\necho \'{"type":"result","result":"ok","is_error":false}\'\n', { mode: 0o755 });
  const r = await startClaude({ bin, cwd: dir, prompt: 'x', model: 'haiku', noTools: true, timeoutMs: 20000 }).done;
  assert.equal(r.ok, true);
  const args = fs.readFileSync(out, 'utf8').split('\n');
  assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'haiku');
  assert.ok(args.includes('--tools') && args[args.indexOf('--tools') + 1] === '');
  assert.ok(args.includes('--strict-mcp-config') && args[args.indexOf('--mcp-config') + 1] === '{"mcpServers":{}}');
});
