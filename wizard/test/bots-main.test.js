'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSettings } = require('../settings/server');

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-main-'));
  const envFile = path.join(dir, 'orchestrator.env');
  fs.writeFileSync(envFile, 'TELEGRAM_TOKEN=' + TOKEN + '\nALLOWED_USER_IDS=5\nADMIN_USER_IDS=5\nFULL_ACCESS=0\nJOB_TIMEOUT_SEC=900\n');
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd].concat(args)); return { code: 0, out: args[0] === 'is-active' ? 'active\n' : '', err: '' }; };
  const apiFetch = async (url) => (/api\.telegram\.org/.test(url) ? { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 9, username: 'quan_ly_bot', first_name: 'Quản lý' } }) } : { status: 200 });
  const s = createSettings({
    port: 0, host: '127.0.0.1', envFile, versionFile: path.join(dir, 'VERSION'), backupDir: path.join(dir, 'bk'), onedriveConf: path.join(dir, 'od'), onedriveDir: path.join(dir, 'odir'),
    run, fetch: apiFetch, peerUid: () => 1000, allowedUids: () => new Set([1000, 0]), pageFile: path.join(__dirname, '..', 'settings', 'index.html'), exit: () => {}, sleep: () => new Promise((r) => setTimeout(r, 1)),
    fullAccessPaths: { sudoers: path.join(dir, 'sudoers.d', '90-x'), dropin: path.join(dir, 'dropin', '10-x.conf') },
    agentCtl: { handle: async () => ({ ok: true, msg: 'ok' }) }, agentsFile: path.join(dir, 'agents.json'), agentShow: async () => ({ ActiveState: 'active' }),
  });
  const port = await s.listen();
  const call = async (method, p, body) => {
    const r = await fetch('http://127.0.0.1:' + port + '/api/' + p, { method, headers: { 'content-type': 'application/json', 'x-agentos-settings': '1' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* html */ }
    return { status: r.status, body: j, text };
  };
  return { s, call, calls, env: () => fs.readFileSync(envFile, 'utf8') };
}

test('Cài đặt → Bot Telegram: bot quản lý cũng có thẻ riêng với token, ID, chế độ và quyền hạn như mọi bot', async () => {
  const S = await boot();
  try {
    let r = await S.call('GET', 'bots');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.main.configured, true); assert.equal(r.body.main.bot.username, 'quan_ly_bot'); assert.deepEqual(r.body.main.owners, ['5']);
    assert.ok(!JSON.stringify(r.body).includes(TOKEN), 'không lộ token đầy đủ');
    assert.deepEqual(r.body.main.settings, { jobTimeoutMin: 15 }); assert.deepEqual(r.body.agents, []); assert.ok(r.body.spec.full && r.body.spec.parallel);
    // sửa quyền hạn của bot quản lý: ghi đúng khóa cấu hình, đổi phút ra giây, bool đúng dạng
    r = await S.call('POST', 'bot/settings', { settings: { parallel: 3, memory: false, jobTimeoutMin: 20, tools: 'Read,Glob', sandbox: 'off' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const env = S.env();
    for (const l of ['PARALLEL_CHATS=3', 'MEMORY_ENABLED=false', 'JOB_TIMEOUT_SEC=1200', 'CLAUDE_ALLOWED_TOOLS=Read,Glob', 'SANDBOX=off']) assert.ok(env.split('\n').includes(l), l);
    assert.ok(S.calls.some((c) => c[0] === 'systemctl' && c.includes('restart') && c.includes('agentos-orchestrator.service')), 'khởi động lại bot quản lý');
    r = await S.call('GET', 'bots');
    assert.deepEqual(r.body.main.settings, { parallel: 3, memory: false, jobTimeoutMin: 20, tools: 'Read,Glob', sandbox: 'off' });
    // về mặc định = bỏ dòng khỏi cấu hình
    r = await S.call('POST', 'bot/settings', { settings: { parallel: null, tools: null } });
    assert.equal(r.status, 200); assert.ok(!/PARALLEL_CHATS=/.test(S.env())); assert.ok(!/CLAUDE_ALLOWED_TOOLS=/.test(S.env()));
    // từ chối: khóa lạ, sai kiểu, ký tự xuống dòng, Toàn quyền (có nút riêng cấp sudo)
    assert.equal((await S.call('POST', 'bot/settings', { settings: { rm: 1 } })).status, 400);
    assert.equal((await S.call('POST', 'bot/settings', { settings: { parallel: 99 } })).status, 400);
    assert.equal((await S.call('POST', 'bot/settings', { settings: { tools: 'a\nTELEGRAM_TOKEN=x' } })).status, 400);
    assert.equal((await S.call('POST', 'bot/settings', { settings: { full: true } })).status, 400);
    assert.ok(S.env().includes('TELEGRAM_TOKEN=' + TOKEN), 'token không bị đụng tới');
  } finally { S.s.close && S.s.close(); }
});

test('giao diện: mọi bot cùng một kiểu thẻ, bot quản lý có dấu ⭐ và hướng dẫn giao việc; không còn chữ "bot phụ"', () => {
  const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
  for (const k of ['function botCard', 'function mainBot', 'function agentBot', 'function bindBot', '⭐', 'giao cho bot', 'bot/settings', 'data-do="owners"', 'data-do="safe"', 'data-do="full"', 'data-do="perm"', 'sudoon', 'sudooff']) assert.ok(html.includes(k), k);
  assert.ok(!/bot phụ/i.test(html), 'bỏ cách gọi "bot phụ"');
  const js = html.split('<script>')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(js));
});
