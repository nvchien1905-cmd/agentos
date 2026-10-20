'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const apikeys = require('../lib/apikeys');
const envfile = require('../lib/envfile');
const { createWizard } = require('../server');

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const K = {
  claude: 'sk-ant-api03-' + 'a'.repeat(40), codex: 'sk-proj-' + 'b'.repeat(40),
  gemini: 'AIza' + 'c'.repeat(35), deepseekapi: 'sk-' + 'd'.repeat(32),
};

test('apikeys: kiểm dạng khóa theo từng hãng', () => {
  for (const e of apikeys.ENGINES) assert.equal(apikeys.validFormat(e, K[e]), true, e);
  assert.equal(apikeys.validFormat('claude', K.codex), false);
  assert.equal(apikeys.validFormat('gemini', K.deepseekapi), false);
  assert.equal(apikeys.validFormat('deepseekapi', 'sk-ngan'), false);
  assert.equal(apikeys.validFormat('gpt5', K.codex), false);
  assert.equal(apikeys.mask(K.claude), 'sk-ant-…aaaa');
});

test('apikeys.check: gọi đúng địa chỉ + tiêu đề của từng hãng, hiểu 200/401/429/402/lỗi mạng và KHÔNG gửi khóa sai dạng', async () => {
  const seen = [];
  const mk = (status) => async (url, init) => { seen.push([url, init.headers]); return { status }; };
  assert.deepEqual((await apikeys.check('claude', K.claude, mk(200))).ok, true);
  assert.equal(seen[0][0].startsWith('https://api.anthropic.com/v1/models'), true); assert.equal(seen[0][1]['x-api-key'], K.claude);
  await apikeys.check('codex', K.codex, mk(200)); assert.equal(seen[1][0], 'https://api.openai.com/v1/models'); assert.equal(seen[1][1].Authorization, 'Bearer ' + K.codex);
  await apikeys.check('gemini', K.gemini, mk(200)); assert.match(seen[2][0], /^https:\/\/generativelanguage\.googleapis\.com\//); assert.equal(seen[2][1]['x-goog-api-key'], K.gemini);
  await apikeys.check('deepseekapi', K.deepseekapi, mk(200)); assert.equal(seen[3][0], 'https://api.deepseek.com/models');
  assert.equal((await apikeys.check('claude', K.claude, mk(401))).ok, false);
  assert.match((await apikeys.check('claude', K.claude, mk(401))).detail, /không đúng hoặc đã bị thu hồi/);
  const lim = await apikeys.check('codex', K.codex, mk(429)); assert.deepEqual([lim.ok, lim.limited], [true, true]);
  const bal = await apikeys.check('deepseekapi', K.deepseekapi, mk(402)); assert.deepEqual([bal.ok, bal.limited], [true, true]);
  const net = await apikeys.check('gemini', K.gemini, async () => { throw new Error('ENOTFOUND'); }); assert.deepEqual([net.ok, net.network], [false, true]);
  const before = seen.length;
  assert.equal((await apikeys.check('claude', 'sk-sai', mk(200))).ok, false); assert.equal(seen.length, before);
});

test('apikeys.applyToEnv: thêm khóa + bật AI trong ENGINE_ORDER, đổi khóa tại chỗ, xóa khóa', () => {
  let t = 'TELEGRAM_TOKEN=1:x\nENGINE_ORDER=claude\nFULL_ACCESS=0\n';
  t = apikeys.applyToEnv(t, 'deepseekapi', K.deepseekapi);
  assert.match(t, /^AGENTOS_KEY_DEEPSEEK=sk-d+$/m); assert.match(t, /^ENGINE_ORDER=claude,deepseekapi$/m); assert.match(t, /^FULL_ACCESS=0$/m);
  t = apikeys.applyToEnv(t, 'deepseekapi', 'sk-' + 'e'.repeat(30));
  assert.equal((t.match(/AGENTOS_KEY_DEEPSEEK=/g) || []).length, 1); assert.match(t, /=sk-e+$/m); assert.match(t, /^ENGINE_ORDER=claude,deepseekapi$/m);
  t = apikeys.applyToEnv(t, 'deepseekapi', null);
  assert.doesNotMatch(t, /AGENTOS_KEY_DEEPSEEK/);
  assert.throws(() => apikeys.applyToEnv(t, 'claude', 'sk-ant-x\nPWNED=1'), /không hợp lệ/);
  assert.throws(() => apikeys.applyToEnv(t, 'gpt5', K.codex), /không biết/);
  assert.equal(apikeys.applyToEnv('', 'gemini', K.gemini).includes('ENGINE_ORDER=gemini'), true);
});

test('envfile.build: ghi AGENTOS_KEY_* cho AI sẵn sàng, bỏ khóa của AI không có trong danh sách, từ chối khóa sai dạng', () => {
  const base = { token: TOKEN, ownerIds: ['7'], engines: ['claude', 'deepseekapi'] };
  const out = envfile.build(Object.assign({ apiKeys: { claude: K.claude, deepseekapi: K.deepseekapi, codex: K.codex } }, base));
  assert.match(out, /^ENGINE_ORDER=claude,deepseekapi$/m);
  assert.match(out, /^AGENTOS_KEY_CLAUDE=sk-ant-/m); assert.match(out, /^AGENTOS_KEY_DEEPSEEK=sk-/m); assert.doesNotMatch(out, /AGENTOS_KEY_CODEX/);
  assert.throws(() => envfile.build(Object.assign({ apiKeys: { claude: 'sk-ant-ngan' } }, base)), /không đúng dạng/);
  assert.doesNotMatch(envfile.build(base), /AGENTOS_KEY_/);
});

test('apikeys.childEnv: mỗi AI chỉ nhận khóa của mình, khóa khác bị xóa trắng; DeepSeek trỏ sang điểm cuối tương thích Anthropic', () => {
  const keys = { claude: K.claude, deepseekapi: K.deepseekapi };
  const c = apikeys.childEnv('claude', keys); assert.equal(c.ANTHROPIC_API_KEY, K.claude); assert.equal(c.AGENTOS_KEY_DEEPSEEK, ''); assert.equal(c.AGENTOS_KEY_CLAUDE, '');
  const d = apikeys.childEnv('deepseekapi', keys);
  assert.equal(d.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic'); assert.equal(d.ANTHROPIC_AUTH_TOKEN, K.deepseekapi); assert.equal(d.ANTHROPIC_API_KEY, ''); assert.equal(d.ANTHROPIC_MODEL, 'deepseek-flash');
  const x = apikeys.childEnv('codex', keys); assert.equal(x.OPENAI_API_KEY, undefined); assert.equal(x.AGENTOS_KEY_CLAUDE, '');
  const g = apikeys.childEnv('gemini', { gemini: K.gemini }); assert.equal(g.GEMINI_API_KEY, K.gemini); assert.equal(g.GOOGLE_GENAI_USE_GEMINI, 'true');
});

test('server: /api/apikey kiểm với hãng rồi lưu, state chỉ trả khóa đã che; xóa được; khóa sai bị từ chối; check CLI dùng khóa qua biến môi trường', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-k-'));
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    const a = args.join(' ');
    if (cmd === 'nmcli' && a === '-t -f CONNECTIVITY general') return { code: 0, out: 'full', err: '' };
    if (cmd === 'nmcli') return { code: 0, out: 'eth0:ethernet:connected', err: '' };
    if (args.includes('--version')) return { code: 0, out: '2.0.0', err: '' };
    if (args.includes('-p')) return { code: 0, out: '{"result":"OK"}', err: '' };
    return { code: 0, out: '', err: '' };
  };
  const apiFetch = async (url, init) => ({ status: (init.headers['x-api-key'] || init.headers.Authorization || '').includes('bad') ? 401 : 200 });
  const w = createWizard({ port: 0, host: '127.0.0.1', envFile: path.join(dir, 'o.env'), run, apiFetch, code: '123456', stateFile: path.join(dir, 's.json'), hotspotFile: path.join(dir, 'h.json'), hotspotDelayMs: 0, captivePort: 0, finishDelayMs: 60000 });
  const port = await w.listen();
  const call = async (m, p, b) => { const r = await fetch('http://127.0.0.1:' + port + p, { method: m, headers: { 'content-type': 'application/json', 'x-agentos-wizard': '1' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    const bad = await call('POST', '/api/apikey', { engine: 'deepseekapi', key: 'sk-' + 'bad'.repeat(10) });
    assert.equal(bad.status, 400); assert.match(bad.body.error, /không đúng hoặc đã bị thu hồi/);
    assert.equal((await call('POST', '/api/apikey', { engine: 'gpt5', key: K.codex })).status, 400);
    const ok = await call('POST', '/api/apikey', { engine: 'deepseekapi', key: K.deepseekapi });
    assert.equal(ok.status, 200); assert.equal(ok.body.saved, true); assert.equal(ok.body.masked, 'sk-dddd…dddd');
    const st = await call('GET', '/api/state');
    assert.equal(st.body.apiKeys.deepseekapi, 'sk-dddd…dddd'); assert.doesNotMatch(JSON.stringify(st.body), new RegExp(K.deepseekapi));
    assert.ok(fs.readFileSync(path.join(dir, 's.json'), 'utf8').includes(K.deepseekapi));              // lưu để mất điện vẫn nối tiếp (file quyền 600)
    const ck = await call('POST', '/api/engine/check', { engine: 'deepseekapi' });
    assert.equal(ck.body.loggedIn, true);
    const claudeCall = calls.find((c) => c[1].includes('-p') && c[2] && c[2].env);
    assert.equal(claudeCall[2].env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic'); assert.equal(claudeCall[2].env.ANTHROPIC_AUTH_TOKEN, K.deepseekapi);
    assert.ok(!claudeCall[1].join(' ').includes(K.deepseekapi));                                       // khóa KHÔNG nằm trong tham số dòng lệnh
    assert.equal((await call('POST', '/api/apikey/clear', { engine: 'deepseekapi' })).body.cleared, true);
    assert.deepEqual((await call('GET', '/api/state')).body.apiKeys, {});
  } finally { await w.close(); }
});
