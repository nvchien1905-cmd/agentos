'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOneDrive, AUTH_PREFIX } = require('../src/onedrive');
const { createQuick } = require('../src/quick');
const { decide } = require('../src/policy');
const { openDb } = require('../src/db');
const { createWorker } = require('../src/worker');
const { createBot } = require('../src/bot');

const GOOD = AUTH_PREFIX + 'code=M.C509_BAY.2.U.abcdef';
const SIGNIN = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&response_type=code';

function make(extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-'));
  const dir = path.join(root, 'OneDrive'), conf = path.join(root, 'conf');
  fs.mkdirSync(dir, { recursive: true });
  const spawns = [], runs = [];
  let killed = 0;
  const urlFile = path.join(conf, 'auth-url.txt'), respFile = path.join(conf, 'auth-response.txt'), token = path.join(conf, 'refresh_token');
  const opts = Object.assign({
    dir, confDir: conf, waitMs: 200, tokenWaitMs: 200, pollMs: 1, settleMs: 0,
    // Ứng dụng khách giả: ghi đường dẫn đăng nhập ngay; khi thấy tệp đáp án thì tạo token (như onedrive --auth-files)
    spawn: (bin, args) => {
      spawns.push([bin, args]);
      if (!(extra && extra.noUrl)) fs.writeFileSync(urlFile, SIGNIN + '\n');
      return { on() {}, kill() { killed++; } };
    },
    sleep: async () => { await new Promise((r) => setTimeout(r, 2)); if (fs.existsSync(respFile) && !(extra && extra.reject)) fs.writeFileSync(token, 'rt'); },
    run: async (cmd, args) => { runs.push([cmd, args]); return (extra && extra.run && extra.run(cmd, args)) || { code: 0, out: 'active\n', err: '' }; },
  }, extra && extra.opts);
  return { od: createOneDrive(opts), dir, conf, urlFile, respFile, token, spawns, runs, killed: () => killed };
}

test('onedrive: nhận diện địa chỉ đăng nhập dán lại (chỉ đúng đầu địa chỉ + có code=)', () => {
  const { od } = make();
  assert.equal(od.looksLikeAuthResponse(GOOD), true);
  assert.equal(od.looksLikeAuthResponse('  ' + GOOD + '\n'), true);
  for (const bad of ['', 'xin chào', SIGNIN, AUTH_PREFIX + 'error=access_denied', 'https://evil.example.com/common/oauth2/nativeclient?code=1', 'http://login.microsoftonline.com/common/oauth2/nativeclient?code=1']) assert.equal(od.looksLikeAuthResponse(bad), false, bad);
});

test('onedrive: kết nối 2 bước - lấy đường dẫn đăng nhập, rồi nhận địa chỉ trang trắng và hoàn tất khi có token', async () => {
  const t = make();
  assert.match(await t.od.status(), /CHƯA kết nối/);
  const a = await t.od.startAuth();
  assert.deepEqual([a.ok, a.url], [true, SIGNIN]);
  assert.deepEqual(t.spawns[0], ['onedrive', ['--confdir', t.conf, '--auth-files', t.urlFile + ':' + t.respFile]]);
  assert.equal((await t.od.finishAuth('xin chào')).ok, false);
  const f = await t.od.finishAuth(GOOD);
  assert.equal(f.ok, true);
  assert.ok(fs.existsSync(t.token), 'có token');
  assert.ok(!fs.existsSync(t.respFile) && !fs.existsSync(t.urlFile), 'đã dọn tệp tạm chứa mã đăng nhập');
  assert.equal(t.killed(), 1);                                       // dừng tiến trình đăng nhập để dịch vụ đồng bộ chạy
  assert.equal(fs.statSync(t.token).size > 0, true);
});

test('onedrive: chưa bắt đầu kết nối thì từ chối đáp án; Microsoft không chấp nhận mã thì báo và không giữ token', async () => {
  const t = make({ reject: true });
  const r0 = await t.od.finishAuth(GOOD);
  assert.equal(r0.ok, false); assert.match(r0.error, /\/onedrive ketnoi/);
  await t.od.startAuth();
  const r1 = await t.od.finishAuth(GOOD);
  assert.equal(r1.ok, false); assert.match(r1.error, /không chấp nhận mã/);
  assert.ok(!fs.existsSync(t.token));
  const noUrl = make({ noUrl: true });
  const r2 = await noUrl.od.startAuth(); assert.equal(r2.ok, false); assert.match(r2.error, /Không lấy được đường dẫn/);
});

test('onedrive: bắt đầu lại thì dừng tiến trình đăng nhập cũ (không để nhiều tiến trình)', async () => {
  const t = make();
  await t.od.startAuth(); await t.od.startAuth();
  assert.equal(t.spawns.length, 2); assert.ok(t.killed() >= 1);
});

test('onedrive: tình trạng (dịch vụ chạy, số tệp, tệp mới nhất), đồng bộ ngay bằng SIGUSR1, thư mục, ngắt kết nối giữ nguyên tệp', async () => {
  const t = make();
  assert.match((await t.od.sync()).error, /Chưa kết nối/);
  fs.mkdirSync(t.conf, { recursive: true }); fs.writeFileSync(t.token, 'rt');
  fs.mkdirSync(path.join(t.dir, 'AgentOS'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'AgentOS', 'GHI-NHO.md'), 'a'.repeat(2048));
  fs.writeFileSync(path.join(t.dir, 'bao-cao.xlsx'), 'b');
  const s = await t.od.status();
  assert.match(s, /đã kết nối · dịch vụ đồng bộ đang chạy/); assert.match(s, /2 tệp/); assert.match(s, /Tệp mới nhất: /);
  assert.deepEqual(t.runs[0], ['systemctl', ['is-active', 'onedrive-agentos.service']]);
  const off = make({ run: () => ({ code: 3, out: 'inactive\n', err: '' }) });
  fs.mkdirSync(off.conf, { recursive: true }); fs.writeFileSync(off.token, 'rt');
  assert.match(await off.od.status(), /KHÔNG chạy/);
  assert.equal((await t.od.sync()).ok, true);
  assert.deepEqual(t.runs.find((r) => r[0] === 'pkill')[1], ['-USR1', '-x', 'onedrive']);
  assert.deepEqual(t.od.folders(), ['📁 AgentOS', '📄 bao-cao.xlsx']);
  await t.od.disconnect();
  assert.ok(!fs.existsSync(t.token)); assert.ok(fs.existsSync(path.join(t.dir, 'bao-cao.xlsx')), 'tệp trên máy vẫn còn');
  assert.deepEqual(t.runs.filter((r) => r[0] === 'pkill').pop()[1], ['-TERM', '-x', 'onedrive']);
});

test('quick /onedrive: tình trạng, kết nối (gửi link + hướng dẫn), dán địa chỉ trang trắng, đồng bộ, ngắt phải có "co"', async () => {
  const calls = [];
  const od = { dir: '/srv/onedrive', looksLikeAuthResponse: (s) => String(s).startsWith(AUTH_PREFIX),
    status: async () => 'TRẠNG THÁI', startAuth: async () => ({ ok: true, url: SIGNIN }), finishAuth: async (u) => { calls.push(['finish', u]); return { ok: true }; },
    sync: async () => ({ ok: true }), disconnect: async () => { calls.push(['disconnect']); return { ok: true }; }, folders: () => ['📁 AgentOS'] };
  const q = createQuick({ desk: { call: async () => ({ ok: true }) }, onedrive: od });
  assert.equal(await q.run('onedrive', ''), 'TRẠNG THÁI');
  const k = await q.run('onedrive', 'ketnoi');
  assert.ok(k.includes(SIGNIN) && /TỰ CHUYỂN/.test(k) && /nativeclient\?code=/.test(k));
  assert.match(await q.run('onedrive', GOOD), /Đã kết nối OneDrive/); assert.deepEqual(calls[0], ['finish', GOOD]);
  assert.match(await q.run('onedrive', 'dongbo'), /đồng bộ ngay/);
  assert.match(await q.run('onedrive', 'thumuc'), /AgentOS/);
  assert.match(await q.run('onedrive', 'ngat'), /Gõ \/onedrive ngat co/); assert.equal(calls.length, 1);
  assert.match(await q.run('onedrive', 'ngat co'), /Đã ngắt kết nối/); assert.deepEqual(calls[1], ['disconnect']);
  assert.match(await q.run('onedrive', 'linh tinh'), /Cách dùng/);
  assert.deepEqual(q.match(GOOD), { name: 'onedrive', arg: GOOD }); assert.equal(q.match('xin chào'), null);
  assert.match(await createQuick({ desk: {} }).run('onedrive', ''), /chưa có OneDrive/);
});

test('bot: dán thẳng địa chỉ đăng nhập (không có dấu /) chuyển cho /onedrive; người không phải admin bị từ chối', async () => {
  const db = openDb(':memory:');
  const worker = createWorker({ db, engines: { claude: { start: () => { throw new Error('không chạy'); } } }, order: ['claude'], notify: async () => {} });
  let finished = null;
  const od = { dir: '/srv/onedrive', looksLikeAuthResponse: (s) => String(s).startsWith(AUTH_PREFIX), finishAuth: async (u) => { finished = u; return { ok: true }; } };
  const bot = createBot({ db, worker, allowed: new Set(['1', '2']), isAdmin: (u) => String(u) === '1', quick: createQuick({ desk: {}, onedrive: od }) });
  const m = (text, uid) => ({ from: { id: uid || 1 }, chat: { id: uid || 1, type: 'private' }, text });
  assert.match(await bot.handle(m(GOOD)), /Đã kết nối OneDrive/); assert.equal(finished, GOOD);
  finished = null;
  assert.match(bot.handle(m(GOOD, 2)), /chỉ dành cho quản trị viên/); assert.equal(finished, null);
  assert.ok(bot.handle(m('/help')).includes('/onedrive'));
});

test('chính sách: AI được đọc/ghi trong thư mục OneDrive (đường dẫn tuyệt đối) nhưng không ra ngoài, và không đụng token OneDrive', () => {
  const ctx = (tool, input) => ({ tool, input, workdir: '/var/lib/agentos/work', extraDirs: ['/srv/onedrive'], policy: { allow: ['Read'] }, state: { tainted: false, allowed: new Set() } });
  assert.equal(decide(ctx('Read', { file_path: '/srv/onedrive/AgentOS/GHI-NHO.md' })).action, 'allow');
  assert.equal(decide(ctx('Read', { file_path: '/var/lib/agentos/work/a.txt' })).action, 'allow');
  assert.equal(decide(ctx('Write', { file_path: '/srv/onedrive/AgentOS/bao-cao.md', content: 'x' })).action, 'ask');   // ghi vẫn hỏi chủ máy ở chế độ bảo vệ
  for (const p of ['/etc/passwd', '/srv/onedrive-khac/a.txt', '/srv/onedrive/../etc/hosts', '/home/chien/tailieu.txt']) assert.equal(decide(ctx('Read', { file_path: p })).action, 'deny', p);
  for (const p of ['/var/lib/agentos/.config/onedrive/refresh_token', '/srv/onedrive/x/refresh_token', '/var/lib/agentos/.config/onedrive/config']) {
    const d = decide(ctx('Read', { file_path: p })); assert.equal(d.action, 'deny', p);
  }
  assert.equal(decide(Object.assign(ctx('Read', { file_path: '/srv/onedrive/a.txt' }), { extraDirs: [] })).action, 'deny');   // không cấu hình thì như cũ
  assert.equal(decide(ctx('Bash', { command: 'cat /var/lib/agentos/.config/onedrive/refresh_token' })).action, 'deny');
});
