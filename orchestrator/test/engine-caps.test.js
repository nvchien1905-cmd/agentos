'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { capsText, CAPS } = require('../src/engineCaps');
const { mcpNamesFor, isConnector } = require('../src/connectors');
const { createBot } = require('../src/bot');
const openDb = (f) => require('../src/db').openDb(f);

test('bảng năng lực: Claude/DeepSeek có hàng rào + kết nối dịch vụ; Codex/Gemini KHÔNG (không qua cổng duyệt); chỉ liệt kê AI đang bật; không có AI nào thì rỗng', () => {
  const label = (e) => ({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini', deepseekapi: 'DeepSeek (API)' }[e]);
  const t = capsText(['claude', 'codex', 'gemini', 'deepseekapi'], label);
  const line = (n) => t.split('\n').find((l) => l.startsWith('• ' + n + ':'));
  assert.match(line('Claude'), /Hàng rào[^·]*✅[\s\S]*Trợ lý phụ ✅[\s\S]*Kết nối dịch vụ ✅/);
  assert.match(line('DeepSeek (API)'), /Kết nối dịch vụ ✅[\s\S]*mô hình DeepSeek/);
  assert.match(line('Codex'), /bảo vệ = chỉ đọc[\s\S]*Hàng rào[^·]*❌[\s\S]*Kết nối dịch vụ ❌[\s\S]*Xem tiến độ từng bước ✅/);
  assert.match(line('Gemini'), /Hàng rào[^·]*❌[\s\S]*Trình duyệt ❌[\s\S]*Kết nối dịch vụ ❌[\s\S]*Xem tiến độ từng bước ❌/);
  assert.match(t, /Mọi AI đều có: sổ tay[\s\S]*\/hoantac[\s\S]*\/claude <việc>/);
  assert.equal(capsText(['claude'], label).includes('Codex'), false); assert.equal(capsText([], label), ''); assert.equal(capsText(['khong-biet'], label), ''); assert.equal(capsText(null), '');
  assert.deepEqual(Object.keys(CAPS).sort(), ['claude', 'codex', 'deepseekapi', 'gemini']);
});

test('kết nối dịch vụ KHÔNG được cấp cho AI không qua hàng rào (Codex): mcpNamesFor loại các máy chủ "c_…", giữ nguyên thứ tự và máy chủ khác', () => {
  const servers = { browser: {}, c_gmail: {}, agentos_gate: {}, c_notion: {}, kho: {} };
  assert.deepEqual(mcpNamesFor(servers, true), ['browser', 'c_gmail', 'agentos_gate', 'c_notion', 'kho']);
  assert.deepEqual(mcpNamesFor(servers, false), ['browser', 'agentos_gate', 'kho']);
  assert.deepEqual(mcpNamesFor(undefined, false), []); assert.deepEqual(mcpNamesFor(null, true), []);
  assert.equal(isConnector('c_x'), true); assert.equal(isConnector('cx'), false); assert.equal(isConnector('browser'), false); assert.equal(isConnector(undefined), false);
});

test('/ai: thẻ AI đang ưu tiên kèm bảng năng lực của các AI đang bật', () => {
  const db = openDb(':memory:');
  const worker = { wake() {}, engineNames: () => ['claude', 'codex'], currentJobId: () => null, engineStatus: () => [{ name: 'claude', label: 'Claude' }, { name: 'codex', label: 'Codex' }], cancelRunning: () => true };
  const engineCtl = { order: () => ['claude', 'codex'], original: () => ['claude', 'codex'], reset() {}, setPrimary() {} };
  const bot = createBot({ db, worker, allowed: new Set(['1', '2']), isAdmin: (u) => String(u) === '1', engineCtl });
  const say = (uid, text) => bot.handle({ from: { id: uid }, chat: { id: uid, type: 'private' }, text });
  const r = say(1, '/ai');
  assert.match(r, /AI đang ưu tiên: Claude → Codex/); assert.match(r, /Năng lực từng AI:\n• Claude: [\s\S]*\n• Codex: [\s\S]*Kết nối dịch vụ ❌/);
  assert.doesNotMatch(r, /Gemini:/, 'chỉ AI đang bật');
  assert.equal(say(2, '/ai'), 'Chỉ chủ máy đổi được AI.');
});
