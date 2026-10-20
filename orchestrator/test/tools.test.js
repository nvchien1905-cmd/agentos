'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadTools, subst } = require('../src/tools');
const { scan } = require('../src/outbox');
const { createTelegram } = require('../src/telegram');
const { startClaude } = require('../src/engines/claude');
const { startCodex } = require('../src/engines/codex');
const { openDb } = require('../src/db');
const { createWorker } = require('../src/worker');
const { createBot } = require('../src/bot');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-t-'));
const VARS = { DATA_DIR: '/d', OUT_DIR: '/o', DISPLAY: ':99', WORKDIR: '/w' };

function writeTools(obj) { const f = path.join(tmp(), 'tools.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; }

test('tools: thay biến ${...}, biến lạ giữ nguyên', () => {
  assert.deepEqual(subst({ a: ['${X}/y', 5], b: { c: '${Z}' } }, { X: 'ok' }), { a: ['ok/y', 5], b: { c: '${Z}' } });
});

test('tools: nạp tools.example.json và tools.linux.json không lỗi, profile web có trình duyệt', () => {
  for (const name of ['tools.example.json', 'tools.linux.json']) {
    const t = loadTools({ file: path.join(ROOT, name), vars: VARS });
    assert.deepEqual(t.errors, [], name);
    assert.equal(t.defaultName, 'chung');
    assert.deepEqual(t.selectable().map((p) => p.name), ['web', 'lam']);
    const web = t.profile('web');
    assert.deepEqual(web.mcp, ['browser']);
    // Có cổng duyệt: không cho phép sẵn công cụ nào, mọi thứ đi qua chính sách
    assert.deepEqual(t.allowFor(web), []);
    assert.deepEqual(t.allowFor(t.profile('chung')), []);
    assert.deepEqual(web.policy.allow, ['Read', 'Glob', 'Grep']);
    assert.deepEqual(web.engines, ['claude']);                          // có MCP -> mặc định chỉ Claude (Codex không qua cổng)
    assert.deepEqual(t.enginesFor('chung'), ['claude', 'codex', 'gemini', 'deepseekapi']);
    assert.deepEqual(t.enginesFor('da-xoa'), ['claude', 'codex', 'gemini', 'deepseekapi']);
    assert.equal(t.profile('lam').adminOnly, true);
    assert.deepEqual(t.profile('lam').engines, ['claude']);
    assert.deepEqual(t.profile('lam').policy.allowExec, ['^pwd$', '^ls( -[a-zA-Z]+)?$']);
    assert.deepEqual(Object.keys(t.mcpServersFor(web)), ['browser']);
    assert.match(JSON.stringify(t.servers.browser.args), /"\/d\/browser-profile"/);   // đã thay ${DATA_DIR}
    assert.equal(t.profile('da-xoa').name, 'chung');                                   // profile không còn -> mặc định
  }
});

test('tools: ghi cấu hình MCP cho mọi profile (rỗng cũng ghi) và tham số -c cho Codex', () => {
  const t = loadTools({ file: path.join(ROOT, 'tools.linux.json'), vars: VARS });
  const dir = tmp();
  t.writeMcpConfigs(dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(t.profile('chung').mcpConfig, 'utf8')), { mcpServers: {} });
  const w = JSON.parse(fs.readFileSync(t.profile('web').mcpConfig, 'utf8'));
  assert.equal(w.mcpServers.browser.command, '/opt/agentos/tools/node_modules/.bin/playwright-mcp');
  assert.deepEqual(w.mcpServers.browser.env, { DISPLAY: ':99' });
  const a = t.codexArgs(t.profile('web'));
  assert.equal(a[0], '-c'); assert.equal(a[1], 'mcp_servers.browser.command="/opt/agentos/tools/node_modules/.bin/playwright-mcp"');
  assert.match(a[3], /^mcp_servers\.browser\.args=\["--browser","chromium"/);
  assert.equal(a[5], 'mcp_servers.browser.env={DISPLAY=":99"}');
  assert.deepEqual(t.codexArgs(t.profile('chung')), []);
});

test('tools: bắt lỗi cấu hình', () => {
  const bad = loadTools({ file: writeTools({
    servers: { 'Sai Ten': { command: 'x' }, ok: {} },
    profiles: { codex: { mcp: [] }, Hoa: {}, dung: { mcp: ['khong_co'] } },
    default: 'khong-ton-tai',
  }) });
  const e = bad.errors.join('\n');
  assert.match(e, /Tên máy chủ MCP không hợp lệ.*Sai Ten/);
  assert.match(e, /"ok" thiếu command/);
  assert.match(e, /trùng lệnh có sẵn: codex/);
  assert.match(e, /Tên profile không hợp lệ.*Hoa/);
  assert.match(e, /máy chủ MCP không có: khong_co/);
  assert.match(e, /Thiếu "default"/);
});

test('tools: không có file -> một profile mặc định chỉ đọc theo .env', () => {
  const t = loadTools({ file: '', fallbackAllow: 'Read,Grep' });
  assert.deepEqual(t.errors, []);
  assert.deepEqual(t.profile().policy.allow, ['Read', 'Grep']);
  assert.deepEqual(t.selectable(), []);
});

test('tools: bộ không qua cổng (gate:false) cho phép sẵn công cụ; Codex không được ghi file; engine lạ bị báo', () => {
  const t = loadTools({ file: writeTools({
    servers: { s: { command: 'x' } },
    profiles: { cu: { allow: ['Read'], mcp: ['s'], gate: false }, bay: { engines: ['codex', 'gpt5'], codexSandbox: 'workspace-write' } },
    default: 'cu',
  }) });
  assert.deepEqual(t.allowFor(t.profile('cu')), ['Read', 'mcp__s']);
  const e = t.errors.join('\n');
  assert.match(e, /engine không biết: gpt5/);
  assert.match(e, /cho Codex ghi file \(workspace-write\) nhưng Codex không qua cổng duyệt/);
});

test('outbox: chỉ file mới, đúng loại, không ẩn/liên kết tượng trưng, giới hạn số file và dung lượng', () => {
  const d = tmp();
  const put = (rel, size, mtimeSec) => {
    const p = path.join(d, rel); fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(size, 1)); if (mtimeSec) fs.utimesSync(p, mtimeSec, mtimeSec); return p;
  };
  const since = Date.now() - 60000;
  put('cu.png', 10, 1000);                 // quá cũ
  put('a.png', 10); put('sub/b.pdf', 10); put('.an.png', 10); put('lenh.exe', 10); put('rong.png', 0);
  put('sau/1/2/3/4/qua-sau.png', 10);      // sâu quá giới hạn
  const base = scan(d, since).map((f) => f.name).sort();
  assert.deepEqual(base, ['a.png', 'b.pdf']);
  assert.equal(scan(d, since).find((f) => f.name === 'a.png').kind, 'photo');
  assert.equal(scan(d, since, { maxPhotoBytes: 5 }).find((f) => f.name === 'a.png').kind, 'document'); // ảnh quá lớn -> tài liệu
  assert.equal(scan(d, since, { maxDocBytes: 5 }).length, 0);
  put('c.png', 10, Date.now() / 1000 + 5); put('d.png', 10, Date.now() / 1000 + 10);
  assert.deepEqual(scan(d, since, { maxFiles: 2 }).map((f) => f.name), ['c.png', 'd.png']);           // 2 file mới nhất, cũ -> mới
  try { fs.symlinkSync(path.join(d, 'a.png'), path.join(d, 'lk.png')); assert.ok(!scan(d, since).some((f) => f.name === 'lk.png')); } catch (e) { /* Windows không cho tạo symlink */ }
});

test('telegram.sendFile: ảnh gửi sendPhoto, bị từ chối thì gửi lại sendDocument', async () => {
  const d = tmp(); const p = path.join(d, 'a.png'); fs.writeFileSync(p, Buffer.from([1, 2, 3]));
  const calls = [];
  const res = (ok, extra) => ({ status: ok ? 200 : 400, json: async () => Object.assign({ ok, result: {} }, extra || {}) });
  const fetchImpl = async (url, init) => {
    calls.push({ url, form: init.body });
    return url.endsWith('/sendPhoto') ? res(false, { description: 'PHOTO_INVALID_DIMENSIONS', error_code: 400 }) : res(true);
  };
  const tg = createTelegram('TOK', fetchImpl);
  await tg.sendFile(5, { path: p, name: 'a.png', kind: 'photo' });
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['sendPhoto', 'sendDocument']);
  assert.equal(calls[0].form.get('chat_id'), '5');
  assert.equal(calls[1].form.get('document').name, 'a.png');
  calls.length = 0;
  await tg.sendFile(5, { path: p, name: 'b.pdf', kind: 'document' });
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['sendDocument']);
});

test('engine: truyền --mcp-config/--strict-mcp-config/--append-system-prompt cho Claude, -c cho Codex', async () => {
  const fake = (f) => ({ bin: process.execPath, binArgs: [path.join(__dirname, f)], cwd: __dirname, prompt: 'x', timeoutMs: 8000 });
  const c = await startClaude(Object.assign(fake('fake-claude.js'), { mcpConfig: '/m/web.json', appendSystemPrompt: 'gợi ý nhỏ' })).done;
  assert.match(c.text, /--mcp-config \/m\/web\.json --strict-mcp-config --append-system-prompt gợi ý nhỏ/);
  const n = await startClaude(fake('fake-claude.js')).done;
  assert.doesNotMatch(n.text, /mcp-config|append-system-prompt/);
  const x = await startCodex(Object.assign(fake('fake-codex.js'), { sandbox: 'read-only', extraArgs: ['-c', 'a=1'] })).done;
  assert.match(x.text, /--json --skip-git-repo-check -c a=1 --sandbox read-only -$/);
});

const okRes = (text) => ({ ok: true, text, sessionId: null, limit: false });
const mk = (opts) => {
  const db = openDb(':memory:');
  const sent = [], files = [];
  const worker = createWorker(Object.assign({
    db, order: ['claude'], engines: { claude: { start: () => ({ done: Promise.resolve(okRes('xong')), kill() {} }) } },
    notify: async (c, t) => { sent.push(t); },
    sendFile: async (c, f) => { files.push([String(c), f.name]); },
  }, opts || {}));
  return { db, sent, files, worker };
};

test('worker: gửi file AI tạo ra sau tin kết quả; file lỗi không làm hỏng việc; việc lỗi không gửi file', async () => {
  const seen = [];
  const R = mk({ outbox: (since) => { seen.push(since); return [{ name: 'a.png', kind: 'photo' }, { name: 'boom.pdf', kind: 'document' }, { name: 'c.png', kind: 'photo' }]; } });
  R.worker = createWorker({
    db: R.db, order: ['claude'], engines: { claude: { start: () => ({ done: Promise.resolve(okRes('xong')), kill() {} }) } },
    notify: async (c, t) => { R.sent.push(t); },
    outbox: (since) => { seen.push(since); return [{ name: 'a.png', kind: 'photo' }, { name: 'boom.pdf', kind: 'document' }, { name: 'c.png', kind: 'photo' }]; },
    sendFile: async (c, f) => { if (f.name === 'boom.pdf') throw new Error('lỗi mạng'); R.files.push([String(c), f.name]); },
  });
  const id = R.db.addJob(7, 'chụp trang chủ');
  await R.worker.wake();
  assert.equal(R.db.getJob(id).status, 'done');
  assert.deepEqual(R.files, [['7', 'a.png'], ['7', 'c.png']]);
  assert.equal(seen[0], R.db.getJob(id).started_at);             // chỉ file tạo từ lúc việc bắt đầu

  const E = mk({ engines: { claude: { start: () => ({ done: Promise.resolve({ ok: false, limit: false, error: 'hỏng' }), kill() {} }) } }, outbox: () => [{ name: 'x.png', kind: 'photo' }] });
  E.db.addJob(7, 'lỗi'); await E.worker.wake();
  assert.deepEqual(E.files, []);
});

test('bot: lệnh /web gán profile, thiếu nội dung báo cách dùng, /help và /viec có profile', async () => {
  const R = mk();
  const bot = createBot({ db: R.db, worker: R.worker, allowed: new Set(['7']), profiles: [{ name: 'web', description: 'Duyệt web' }] });
  const msg = (text) => ({ from: { id: 7 }, chat: { id: 7, type: 'private' }, text });
  assert.equal(bot.handle(msg('/web')), 'Cách dùng: /web <việc cần làm>');
  assert.match(bot.handle(msg('/web mở trang chủ')), /Đã nhận việc #1/);
  assert.equal(R.db.getJob(1).profile, 'web'); assert.equal(R.db.getJob(1).prompt, 'mở trang chủ');
  assert.match(bot.handle(msg('/help')), /\/web <việc> - Duyệt web/);
  await R.worker.wake();
  assert.match(bot.handle(msg('/viec')), /#1 \[xong, claude, \/web\]/);
  assert.equal(bot.handle(msg('/khac gi do')), 'Lệnh không có. Gõ /help để xem danh sách.');
  await R.worker.stop();
});
