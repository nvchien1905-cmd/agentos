'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { scopeContext } = require('../src/browser-mcp');
const { createBrowserHost } = require('../src/browserHost');
const { createProbe } = require('../src/fbprobe');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-'));
const PA = path.join(os.tmpdir(), 'bh-prof', 'admin'), P2 = path.join(os.tmpdir(), 'bh-prof', '222');   // hồ sơ giả của các bài thử (thư mục có thật, ghi được)

// ---------- scopeContext: mỗi AI chỉ thấy tab của mình ----------
class FakePage extends EventEmitter {
  constructor(ctx, opener) { super(); this.ctx = ctx; this._opener = opener || null; this.closed = false; }
  opener() { return Promise.resolve(this._opener); }
  isClosed() { return this.closed; }
  async close() { this.closed = true; this.ctx._pages.delete(this); this.emit('close'); }
}
class FakeContext extends EventEmitter {
  constructor() { super(); this._pages = new Set(); }
  pages() { return [...this._pages]; }
  async newPage() { const p = new FakePage(this); this._pages.add(p); this.emit('page', p); return p; }          // sự kiện 'page' phát TRƯỚC khi newPage trả về (như Playwright thật)
  popup(from) { const p = new FakePage(this, from); this._pages.add(p); this.emit('page', p); from.emit('popup', p); return p; }
}
const tick = () => new Promise((r) => setImmediate(r));

test('scopeContext: hai AI cùng một Chrome, mỗi AI chỉ thấy và nhận sự kiện của TAB mình mở; tab có sẵn của người dùng không bị đụng', async () => {
  const base = new FakeContext();
  const userTab = await base.newPage();                                          // tab của chủ máy đang xem
  const A = scopeContext(base), B = scopeContext(base);
  const seenA = [], seenB = [];
  A.on('page', (p) => seenA.push(p)); B.on('page', (p) => seenB.push(p));
  assert.deepEqual(A.pages(), []); assert.deepEqual(B.pages(), []);             // không thấy tab có sẵn
  const [pa, pb] = await Promise.all([A.newPage(), B.newPage()]);
  await tick();
  assert.deepEqual(A.pages(), [pa]); assert.deepEqual(B.pages(), [pb]);
  assert.deepEqual(seenA, [pa]); assert.deepEqual(seenB, [pb], 'mỗi bên chỉ được báo tab của mình đúng một lần');
  assert.equal(base.pages().length, 3);
  // cửa sổ bật lên từ tab của A là của A, không phải của B; popup từ tab của người dùng không thuộc ai
  const pop = base.popup(pa); await tick();
  assert.ok(A.pages().includes(pop) && !B.pages().includes(pop)); assert.deepEqual(seenA, [pa, pop]); assert.deepEqual(seenB, [pb]);
  base.popup(userTab); await tick(); assert.equal(A.pages().length, 2); assert.equal(B.pages().length, 1);
  // tab tự đóng thì biến khỏi danh sách; close() chỉ đóng tab của mình, Chrome và tab của AI khác còn nguyên
  await pop.close(); assert.deepEqual(A.pages(), [pa]);
  await A.close(); assert.equal(pa.closed, true); assert.equal(pb.closed, false); assert.equal(userTab.closed, false); assert.deepEqual(B.pages(), [pb]);
});

test('scopeContext: gỡ listener, once chỉ một lần, listener thường không nhận tab của AI khác', async () => {
  const base = new FakeContext(); const A = scopeContext(base), B = scopeContext(base);
  const calls = []; const f = (p) => calls.push('f'); const g = () => calls.push('g');
  A.on('page', f); A.once('page', g);
  await A.newPage(); await A.newPage(); await B.newPage();
  assert.deepEqual(calls, ['f', 'g', 'f']);
  A.off('page', f); await A.newPage(); assert.deepEqual(calls, ['f', 'g', 'f']);
});

// ---------- browserHost (lệnh giả) ----------
function hostEnv(extra) {
  const alive = new Set(), spawned = [], killed = []; let pid = 1000;
  const spawn1 = (cmd, args, opts) => { const port = Number((args.find((a) => /^--remote-debugging-port=/.test(a)) || '').split('=')[1]); spawned.push({ cmd, args, env: opts.env, port }); if (!(extra && extra.failFirst && spawned.length === 1)) alive.add(port); return { pid: ++pid }; };
  let nextPort = 30000;
  const dir = tmp();
  const host = createBrowserHost(Object.assign({ spawn: spawn1, probe: async (p) => alive.has(p), listPages: async () => [], freePort: async () => ++nextPort, kill: (pid2) => killed.push(pid2), sleep: async () => {}, waitMs: 500, display: ':99', stateFile: path.join(dir, 'hosts.json'), log() {} }, extra || {}));
  return { host, alive, spawned, killed, dir };
}

test('browserHost: một Chrome cho mỗi danh tính; hai việc cùng lúc dùng chung một lần khởi động; sống thì dùng lại; chết thì mở lại', async () => {
  const E = hostEnv();
  const [a, b] = await Promise.all([E.host.ensure('admin', PA), E.host.ensure('admin', PA)]);
  assert.equal(a, b); assert.equal(E.spawned.length, 1);
  const s0 = E.spawned[0]; assert.ok(s0.args.includes('--user-data-dir=' + PA) && s0.args.includes('--remote-debugging-address=127.0.0.1') && s0.args.includes('--password-store=basic')); assert.equal(s0.env.DISPLAY, ':99');
  assert.equal(a, 'http://127.0.0.1:' + s0.port);
  assert.equal(await E.host.ensure('admin', PA), a); assert.equal(E.spawned.length, 1);
  const c = await E.host.ensure('id-222', P2); assert.notEqual(c, a); assert.equal(E.spawned.length, 2);   // ID thường: Chrome riêng, hồ sơ riêng
  E.alive.delete(s0.port);                                                                     // Chrome của chủ máy bị tắt
  const a2 = await E.host.ensure('admin', PA); assert.notEqual(a2, a); assert.equal(E.spawned.length, 3);
  const st = JSON.parse(fs.readFileSync(path.join(E.dir, 'hosts.json'), 'utf8')); assert.equal(st.admin.port, E.spawned[2].port); assert.equal(st['id-222'].profile, P2);
});

test('browserHost: bot khởi động lại nhận lại Chrome đang chạy (không mở thêm); lỗi sandbox thì thử --no-sandbox; mở không được thì báo rõ', async () => {
  const E = hostEnv();
  const a = await E.host.ensure('admin', PA);
  const host2 = createBrowserHost({ spawn: () => { throw new Error('không được mở thêm'); }, probe: async (p) => E.alive.has(p), stateFile: path.join(E.dir, 'hosts.json'), log() {} });
  assert.equal(await host2.ensure('admin', PA), a);
  const F = hostEnv({ failFirst: true });
  await F.host.ensure('admin', PA); assert.equal(F.spawned.length, 2); assert.ok(!F.spawned[0].args.includes('--no-sandbox') && F.spawned[1].args.includes('--no-sandbox')); assert.equal(F.killed.length, 1);
  const G = createBrowserHost({ spawn: () => ({ pid: 5 }), probe: async () => false, freePort: async () => 31000, kill() {}, sleep: async () => {}, waitMs: 300, log() {} });
  await assert.rejects(() => G.ensure('admin', PA), /Không mở được Chrome dùng chung.*\/dong webbot/);
});

test('browserHost: stop dừng đúng Chrome đó (rồi ensure mở lại); reap chỉ tắt Chrome của ID thường nhàn rỗi và không còn trang nào, không bao giờ tắt của chủ máy', async () => {
  let t = 1000; let pages = [];
  const E = hostEnv({ now: () => t, listPages: async () => pages });
  const a = await E.host.ensure('admin', PA); const c = await E.host.ensure('id-222', P2);
  await E.host.stop('admin'); assert.ok(E.killed.length >= 1);
  E.alive.delete(Number(a.split(':').pop()));
  assert.notEqual(await E.host.ensure('admin', PA), a);
  t += 40 * 60000; pages = [{ type: 'page', url: 'https://example.com/' }];
  assert.equal(await E.host.reap(30 * 60000), 0, 'còn trang đang mở thì giữ');
  t += 40 * 60000; pages = [{ type: 'page', url: 'about:blank' }, { type: 'browser_ui', url: 'x' }];
  E.alive.add(Number(c.split(':').pop()));
  assert.equal(await E.host.reap(30 * 60000), 1, 'ID thường nhàn rỗi: tắt');
  assert.deepEqual(E.host.status().map((x) => x.key), ['admin']);
});

// ---------- fbprobe nối vào Chrome dùng chung ----------
test('fbprobe: có endpoint thì nối CDP và mở TAB riêng (không giành hồ sơ), đóng thì chỉ đóng tab của mình', async () => {
  const log = []; const base = new FakeContext();
  const fake = { chromium: { launchPersistentContext: async () => { throw new Error('không được giành hồ sơ'); }, connectOverCDP: async (url) => { log.push('cdp ' + url); const ee = new EventEmitter(); return Object.assign(ee, { contexts: () => [base], close: async () => log.push('ngắt kết nối'), newContext: async () => base }); } } };
  const pg = (title) => { const p = new FakePage(base); Object.assign(p, { goto: async () => {}, waitForTimeout: async () => {}, title: async () => title, url: () => 'https://www.messenger.com/', $: async () => null, reload: async () => {} }); return p; };
  base.newPage = async function () { const p = pg('(3) Messenger'); this._pages.add(p); return p; };
  const probe = createProbe({ load: () => fake, endpoint: async () => 'http://127.0.0.1:9', settleMs: 0 });
  const r = await probe(); assert.equal(r.unread, 3); assert.deepEqual(log, ['cdp http://127.0.0.1:9']);
  assert.equal(probe.isOpen(), true);
  await probe.release(); assert.equal(probe.isOpen(), false); assert.ok(log.includes('ngắt kết nối')); assert.equal(base._pages.size, 0, 'tab của fbprobe đã đóng');
});

// ---------- THẬT: Chrome thật + 2 browser-mcp.js (mỗi AI một tab trong MỘT Chrome) ----------
const TOOLS = process.env.AGENTOS_TOOLS_DIR || '/opt/agentos/tools';
const chromeBin = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
let pwOk = false; try { require.resolve('playwright-core/lib/coreBundle', { paths: [TOOLS] }); pwOk = true; } catch (e) { /* không có */ }
const realSkip = process.platform === 'linux' && chromeBin && pwOk ? false : 'cần Linux + Google Chrome + playwright-core (/opt/agentos/tools)';

function mcpClient(cdp) {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'browser-mcp.js'), '--cdp', cdp], { stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { AGENTOS_TOOLS_DIR: TOOLS }) });
  let buf = '', id = 0; const waiters = new Map();
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } catch (e) { /* bỏ */ } } });
  p.stderr.on('data', () => {});
  const call = (method, params) => new Promise((res) => { const i = ++id; waiters.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); setTimeout(() => { if (waiters.has(i)) { waiters.delete(i); res({ error: 'quá thời gian' }); } }, 40000).unref(); });
  const text = (r) => ((r.result && r.result.content) || []).map((c) => c.text || '').join(' ');
  return { p, text, kill: () => { try { p.kill('SIGKILL'); } catch (e) { /* */ } },
    async init() { await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); },
    tool: (n, a) => call('tools/call', { name: n, arguments: a || {} }) };
}

test('THẬT: 2 AI cùng MỘT Chrome — mỗi AI một tab riêng, điều hướng cùng lúc không đè nhau, đóng thì chỉ đóng tab của mình', { skip: realSkip }, async () => {
  const dir = tmp();
  const host = createBrowserHost({ chromeBin, headless: true, noSandbox: true, display: process.env.DISPLAY || ':99', stateFile: path.join(dir, 'hosts.json'), log() {} });
  const cdp = await host.ensure('admin', path.join(dir, 'profile'));
  const A = mcpClient(cdp), B = mcpClient(cdp);
  try {
    await Promise.all([A.init(), B.init()]);
    const page = (t) => 'data:text/html,<title>' + t + '</title><h1>' + t + '</h1>';
    const [ra, rb] = await Promise.all([A.tool('browser_navigate', { url: page('TRANG-A') }), B.tool('browser_navigate', { url: page('TRANG-B') })]);
    assert.match(A.text(ra), /Page Title: TRANG-A/); assert.match(B.text(rb), /Page Title: TRANG-B/); assert.doesNotMatch(A.text(ra) + B.text(rb), /interrupted by another navigation/);
    const [sa, sb] = await Promise.all([A.tool('browser_snapshot'), B.tool('browser_snapshot')]);
    assert.match(A.text(sa), /TRANG-A/); assert.doesNotMatch(A.text(sa), /TRANG-B/); assert.match(B.text(sb), /TRANG-B/); assert.doesNotMatch(B.text(sb), /TRANG-A/);
    const [ta, tb] = await Promise.all([A.tool('browser_tabs', { action: 'list' }), B.tool('browser_tabs', { action: 'list' })]);
    assert.equal((A.text(ta).match(/^- \d+:/gm) || []).length, 1, A.text(ta)); assert.equal((B.text(tb).match(/^- \d+:/gm) || []).length, 1, B.text(tb));
    const list = await new Promise((res) => require('http').get(cdp + '/json/list', (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res(JSON.parse(b))); }));
    const titles = list.filter((t) => t.type === 'page').map((t) => t.title);
    assert.ok(titles.includes('TRANG-A') && titles.includes('TRANG-B'), 'cả hai tab cùng nằm trong MỘT Chrome: ' + titles.join('|'));
  } finally { A.kill(); B.kill(); await host.stop('admin').catch(() => {}); spawnSync('pkill', ['-f', '[u]ser-data-dir=' + path.join(dir, 'profile')]); }
});
