'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const engines = require('../lib/engines');
const envfile = require('../lib/envfile');
const { createLogin } = require('../lib/login');

const FAKE = path.join(__dirname, 'fake-login.js');
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const until = async (fn, ms) => { const end = Date.now() + (ms || 6000); while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('hết giờ chờ'); };

test('gemini: có trong danh sách gói/lệnh; kiểm tra đăng nhập chạy từ thư mục của agentos, chế độ chỉ đọc, prompt qua stdin', async () => {
  assert.equal(engines.PACKAGES.gemini, '@google/gemini-cli');
  assert.equal(engines.BIN.gemini, '/var/lib/agentos/.local/bin/gemini');
  const calls = [];
  const run = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { code: 0, out: '{ "session_id": "s", "response": "OK" }', err: '' }; };
  assert.deepEqual(await engines.verifyLogin(run, 'gemini'), { ok: true, detail: 'đăng nhập tốt' });
  const c = calls[0];
  assert.equal(c.cmd, 'runuser'); assert.deepEqual(c.args.slice(0, 3), ['-u', 'agentos', '--']);
  const tail = c.args.slice(c.args.indexOf('-C') - 1);
  assert.deepEqual(tail, ['env', '-C', '/var/lib/agentos', '/var/lib/agentos/.local/bin/gemini', '-p', '', '--output-format', 'json', '--skip-trust', '--approval-mode', 'plan']);
  assert.equal(c.opts.input, 'Trả lời đúng một từ: OK');
});

test('gemini: chưa đăng nhập (mã 41) báo rõ lý do; hết hạn mức (429) vẫn tính là ĐÃ đăng nhập', async () => {
  const noAuth = await engines.verifyLogin(async () => ({ code: 41, out: '{ "error": { "message": "Please set an Auth method in your /var/lib/agentos/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY", "code": 41 } }', err: '' }), 'gemini');
  assert.equal(noAuth.ok, false); assert.ok(noAuth.detail.startsWith('chưa đăng nhập'), noAuth.detail); assert.match(noAuth.detail, /Auth method/);
  const lim = await engines.verifyLogin(async () => ({ code: 1, out: '{ "error": { "message": "You have exhausted your capacity on this model. Your quota will reset after 2h30m. (429 RESOURCE_EXHAUSTED)", "code": 429 } }', err: '' }), 'gemini');
  assert.equal(lim.ok, true); assert.equal(lim.limited, true);
});

test('gemini: chuẩn bị đăng nhập đặt sẵn kiểu Google trong settings.json (giữ cài đặt cũ), trả quyền cho agentos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gem-'));
  const writes = {}, owns = [];
  const fsx = {
    mkdirSync: () => {}, readFileSync: () => JSON.stringify({ ui: { theme: 'x' }, security: { auth: { enforcedType: 'a' } } }),
    writeFileSync: (f, c, o) => { writes[f] = { c, o }; }, chownSync: (f, u, g) => owns.push([f, u, g]),
  };
  const f = engines.prepareGemini({ fs: fsx, execFileSync: (cmd, args) => Buffer.from(args[0] === '-u' ? '1001\n' : '1002\n') });
  assert.equal(f, '/var/lib/agentos/.gemini/settings.json');
  const j = JSON.parse(writes[f].c);
  assert.equal(j.security.auth.selectedType, 'oauth-personal'); assert.equal(j.security.auth.enforcedType, 'a'); assert.equal(j.ui.theme, 'x');
  assert.equal(writes[f].o.mode, 0o600);
  assert.deepEqual(owns.map((x) => x.slice(1)), [[1001, 1002], [1001, 1002]]);
  // tệp hỏng hoặc không phải đối tượng: ghi đè bằng cấu hình tối thiểu, không ném lỗi
  const bad = engines.prepareGemini({ fs: Object.assign({}, fsx, { readFileSync: () => '{hỏng', writeFileSync: (ff, c) => { writes.bad = c; } }), execFileSync: () => { throw new Error('không có agentos'); } });
  assert.ok(bad); assert.equal(JSON.parse(writes.bad).security.auth.selectedType, 'oauth-personal');
});

test('gemini: đăng nhập qua điện thoại - lấy đường dẫn Google (không nhầm đường dẫn điều khoản), nhận mã, xong khi có tệp đăng nhập rồi dừng tiến trình', async () => {
  const cred = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemlogin-')), 'oauth_creds.json');
  let wrapped = null;
  const L = createLogin({
    skipPrepare: true, doneFile: { gemini: cred }, stopDelayMs: 20, pollMs: 20,
    wrap: (argv, env) => { wrapped = { argv, env }; return { cmd: process.execPath, args: [FAKE, 'gemini-login', cred] }; },
  });
  const v0 = L.start('gemini');
  assert.equal(v0.status, 'running');
  assert.deepEqual(wrapped.argv, ['/var/lib/agentos/.local/bin/gemini', '--skip-trust']);
  assert.deepEqual(wrapped.env, { NO_BROWSER: 'true' });
  const v = await until(() => { const x = L.get(); return x.url ? x : null; });
  assert.match(v.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?client_id=abc/);     // không phải geminicli.com/docs/...
  assert.equal(v.needsInput, true); assert.equal(v.hasToken, false); assert.equal(v.code, null);
  L.input('MA-SAI');                                                                              // mã sai: vẫn chờ, không báo xong
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(L.get().status, 'running'); assert.match(L.get().tail, /Failed to authenticate/);
  L.input('MA-DUNG');
  const done = await until(() => { const x = L.get(); return x.status === 'done' ? x : null; });
  assert.equal(done.status, 'done');
  assert.ok(fs.existsSync(cred));
  const child = L._current().child;
  await until(() => child.exitCode !== null || child.signalCode !== null);                       // tiến trình đã bị dừng (Gemini không tự thoát)
});

test('gemini: tệp đăng nhập CŨ (có từ trước lúc bắt đầu) không làm đăng nhập báo xong sớm; hủy giữa chừng dừng tiến trình', async () => {
  const cred = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemold-')), 'oauth_creds.json');
  fs.writeFileSync(cred, 'cu'); const old = new Date(Date.now() - 3600 * 1000); fs.utimesSync(cred, old, old);
  const L = createLogin({ skipPrepare: true, doneFile: { gemini: cred }, stopDelayMs: 20, pollMs: 20, wrap: () => ({ cmd: process.execPath, args: [FAKE, 'gemini-login', cred] }) });
  L.start('gemini'); await until(() => L.get().url);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(L.get().status, 'running');
  L.cancel();
  const s = await until(() => { const x = L.get(); return x.status === 'error' ? x : null; });
  assert.match(s.error, /Đã hủy/);
});

test('gemini: ghi vào orchestrator.env (ENGINE_ORDER có gemini, GEMINI_BIN)', () => {
  const env = envfile.build({ token: TOKEN, ownerIds: ['7'], engines: ['claude', 'gemini'] });
  assert.match(env, /^ENGINE_ORDER=claude,gemini$/m); assert.match(env, /^GEMINI_BIN=\/var\/lib\/agentos\/\.local\/bin\/gemini$/m);
  assert.match(envfile.build({ token: TOKEN, ownerIds: ['7'], engines: ['gemini'] }), /^ENGINE_ORDER=gemini$/m);
  assert.throws(() => envfile.build({ token: TOKEN, ownerIds: ['7'], engines: ['gpt'] }), /Chưa có AI nào/);
});
