'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ctlLib = require('../src/agentctl');
const { createAgentCtl, validate } = ctlLib;
const { createAgents } = require('../src/agents');
const { createAgentsUi } = require('../src/agentsUi');
const { createBot } = require('../src/bot');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-'));
const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN2 = '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MAIN_TOKEN = '555555555:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const RID = 'a1b2c3d4e5f60718';

function world() {
  const d = tmp();
  const paths = { ctl: path.join(d, 'ctl'), homes: path.join(d, 'homes'), etc: path.join(d, 'etc'), units: path.join(d, 'units'), mainEnv: path.join(d, 'etc', 'orchestrator.env'), mainHome: path.join(d, 'mainhome'), appDir: '/opt/agentos/orchestrator', node: '/usr/bin/node' };
  fs.mkdirSync(paths.etc, { recursive: true }); fs.mkdirSync(paths.units, { recursive: true });
  fs.mkdirSync(paths.mainHome + '/.local/bin', { recursive: true });
  fs.writeFileSync(paths.mainHome + '/.local/bin/claude', 'ELF-claude');
  fs.writeFileSync(paths.mainEnv, ['TELEGRAM_TOKEN=' + MAIN_TOKEN, 'ALLOWED_USER_IDS=1', 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abcdefghijklmnopqrstu', 'KIOTVIET_CLIENT_SECRET=kv-secret', 'CLAUDE_BIN=' + paths.mainHome + '/.local/bin/claude', ''].join('\n'));
  const cmds = [];
  const run = async (bin, args) => { cmds.push([bin].concat(args).join(' ')); if (bin === 'id') return { code: 1, out: '' }; return { code: 0, out: bin === 'journalctl' ? 'dòng 1 token ' + TOKEN + ' dòng 2' : '' }; };
  const ctl = createAgentCtl({ run, paths, now: () => 1800000000000 });
  return { d, paths, cmds, ctl };
}
const create = (w, over) => w.ctl.handle(Object.assign({ rid: RID, action: 'create', id: 'a1', token: TOKEN, name: 'Kế toán', owners: ['1'], ramMb: 1024, cpuPct: 100 }, over || {}));

test('validate: từ chối mã agent / token / số / việc sai, giới hạn ngoài khoảng, tên rỗng', () => {
  const base = { rid: RID, action: 'create', id: 'a1', token: TOKEN, name: 'x', owners: ['1'] };
  assert.doesNotThrow(() => validate(base));
  assert.throws(() => validate({ ...base, id: '../etc' }), /Mã agent/);
  assert.throws(() => validate({ ...base, id: 'a1; rm -rf /' }), /Mã agent/);
  assert.throws(() => validate({ ...base, token: 'abc' }), /Token/);
  assert.throws(() => validate({ ...base, owners: ['1', 'x'] }), /ID chủ/);
  assert.throws(() => validate({ ...base, owners: [] }), /ID chủ/);
  assert.throws(() => validate({ ...base, ramMb: 50 }), /ramMb/);
  assert.throws(() => validate({ ...base, cpuPct: 99999 }), /cpuPct/);
  assert.throws(() => validate({ ...base, name: '  ' }), /tên/);
  assert.throws(() => validate({ ...base, rid: '../../x' }), /Mã yêu cầu/);
  assert.throws(() => validate({ ...base, action: 'rm' }), /không hợp lệ/);
  assert.equal(validate({ ...base, name: 'a\nb' + 'x'.repeat(100) }).name.length, 40);
  assert.deepEqual(validate({ rid: RID, action: 'init' }), { rid: RID, action: 'init' });
});

test('tạo agent: tài khoản riêng, thư mục 700, env 600 chỉ chứa khóa Claude (không token bot chính/khóa KiotViet), dịch vụ có giới hạn + cô lập', async () => {
  const w = world();
  const r = await create(w);
  assert.equal(r.ok, true, r.msg);
  const useradd = w.cmds.find((c) => c.startsWith('useradd'));
  assert.match(useradd, /--system .*--home-dir .*homes[\\/]a1 --no-create-home --shell \/usr\/sbin\/nologin agentos-a1$/);
  const env = fs.readFileSync(path.join(w.paths.etc, 'agents/a1.env'), 'utf8');
  assert.match(env, new RegExp('^TELEGRAM_TOKEN=' + TOKEN + '$', 'm'));
  assert.match(env, /^AGENT_ID=a1$/m);
  assert.match(env, /^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-/m);
  assert.ok(!env.includes(MAIN_TOKEN), 'không chép token của bot quản lý');
  assert.ok(!env.includes('kv-secret'), 'không chép khóa KiotViet');
  assert.match(env, /^ALLOWED_USER_IDS=1$/m);
  assert.match(env, /^FULL_ACCESS=0$/m);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(w.paths.etc, 'agents/a1.env')).mode & 0o777, 0o600);
  const unit = fs.readFileSync(path.join(w.paths.units, 'agentos-agent-a1.service'), 'utf8');
  assert.match(unit, /^User=agentos-a1$/m);
  assert.match(unit, /^MemoryMax=1024M$/m);
  assert.match(unit, /^MemoryHigh=870M$/m);
  assert.match(unit, /^CPUQuota=100%$/m);
  assert.match(unit, /^InaccessiblePaths=.*\/etc\/agentos|^InaccessiblePaths=/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^OnFailure=agentos-alert@%n\.service$/m);
  assert.ok(!/RestrictSUIDSGID|ProtectKernelTunables|PrivateDevices/.test(unit.replace(/#.*$/gm, '')), 'không đặt các khóa làm hỏng bubblewrap');
  const order = w.cmds.map((c) => c.split(' ').slice(0, 2).join(' '));
  assert.ok(order.indexOf('systemctl daemon-reload') < order.indexOf('systemctl enable'), 'nạp lại rồi mới bật');
  assert.ok(w.cmds.includes('systemctl enable --now agentos-agent-a1'));
  assert.ok(fs.existsSync(path.join(w.paths.ctl, 'bin/claude')), 'có bản Claude dùng chung');
  assert.equal(fs.readFileSync(path.join(w.paths.ctl, 'bin/claude'), 'utf8'), 'ELF-claude');
});

test('tạo trùng bị từ chối; thiếu khóa Claude chung thì chép đăng nhập hiện có và cảnh báo', async () => {
  const w = world();
  assert.equal((await create(w)).ok, true);
  const again = await create(w);
  assert.equal(again.ok, false); assert.match(again.msg, /đã có/);
  const w2 = world();
  fs.writeFileSync(w2.paths.mainEnv, 'TELEGRAM_TOKEN=' + MAIN_TOKEN + '\nCLAUDE_BIN=' + w2.paths.mainHome + '/.local/bin/claude\n');
  fs.mkdirSync(w2.paths.mainHome + '/.claude', { recursive: true }); fs.writeFileSync(w2.paths.mainHome + '/.claude/.credentials.json', '{"x":1}');
  const r = await create(w2);
  assert.equal(r.ok, true); assert.match(r.warn, /BẢN SAO/);
  assert.ok(fs.existsSync(path.join(w2.paths.homes, 'a1/.claude/.credentials.json')));
  const w3 = world();
  fs.writeFileSync(w3.paths.mainEnv, 'CLAUDE_BIN=' + w3.paths.mainHome + '/.local/bin/claude\n');
  assert.match((await create(w3)).warn, /Chưa tìm thấy đăng nhập Claude/);
});

test('đổi giới hạn / chủ / tên: giữ token, ghi lại dịch vụ, khởi động lại; dừng - chạy - nhật ký (che token)', async () => {
  const w = world();
  await create(w);
  const u = await w.ctl.handle({ rid: RID, action: 'update', id: 'a1', ramMb: 2048, cpuPct: 150, owners: ['1', '2'], name: 'Bán hàng' });
  assert.equal(u.ok, true, u.msg);
  const env = fs.readFileSync(path.join(w.paths.etc, 'agents/a1.env'), 'utf8');
  assert.match(env, new RegExp('TELEGRAM_TOKEN=' + TOKEN)); assert.match(env, /ALLOWED_USER_IDS=1,2/); assert.match(env, /AGENT_NAME=Bán hàng/);
  assert.equal((env.match(/CLAUDE_CODE_OAUTH_TOKEN/g) || []).length, 1, 'không nhân đôi khóa');
  const unit = fs.readFileSync(path.join(w.paths.units, 'agentos-agent-a1.service'), 'utf8');
  assert.match(unit, /MemoryMax=2048M/); assert.match(unit, /CPUQuota=150%/);
  assert.ok(w.cmds.includes('systemctl restart agentos-agent-a1'));
  assert.equal((await w.ctl.handle({ rid: RID, action: 'stop', id: 'a1' })).ok, true);
  assert.ok(w.cmds.includes('systemctl stop agentos-agent-a1'));
  assert.equal((await w.ctl.handle({ rid: RID, action: 'stop', id: 'a9' })).ok, false);
  const lg = await w.ctl.handle({ rid: RID, action: 'logs', id: 'a1', lines: 20 });
  assert.ok(!lg.text.includes(TOKEN) && lg.text.includes('[token]'), 'nhật ký không lộ token');
});

test('xóa agent: dừng dịch vụ, xóa tài khoản + env + dịch vụ, GIỮ dữ liệu vào thư mục lưu trữ (purge thì xóa hẳn)', async () => {
  const w = world();
  await create(w);
  fs.writeFileSync(path.join(w.paths.homes, 'a1/data/x.txt'), 'dữ liệu');
  const r = await w.ctl.handle({ rid: RID, action: 'remove', id: 'a1' });
  assert.equal(r.ok, true); assert.match(r.kept, /\.da-xoa-a1-/);
  assert.ok(w.cmds.includes('systemctl disable --now agentos-agent-a1')); assert.ok(w.cmds.includes('userdel agentos-a1'));
  assert.ok(!fs.existsSync(path.join(w.paths.units, 'agentos-agent-a1.service')));
  assert.ok(!fs.existsSync(path.join(w.paths.etc, 'agents/a1.env')));
  assert.equal(fs.readFileSync(path.join(r.kept, 'data/x.txt'), 'utf8'), 'dữ liệu');
  const w2 = world(); await create(w2);
  const r2 = await w2.ctl.handle({ rid: RID, action: 'remove', id: 'a1', purge: true });
  assert.equal(r2.kept, ''); assert.ok(!fs.existsSync(path.join(w2.paths.homes, 'a1')));
});

test('drain: xử lý tệp yêu cầu, xóa tệp, ghi kết quả; từ chối tệp hỏng / liên kết tượng trưng / tên lạ', async () => {
  const w = world();
  await w.ctl.init();
  const req = path.join(w.paths.ctl, 'req'), res = path.join(w.paths.ctl, 'res');
  fs.writeFileSync(path.join(req, RID + '.json'), JSON.stringify({ action: 'create', id: 'a2', token: TOKEN, name: 'T', owners: ['1'] }));
  fs.writeFileSync(path.join(req, 'b1b2c3d4e5f60718.json'), '{hỏng');
  fs.writeFileSync(path.join(req, 'ten-la.json'), '{}');
  if (process.platform !== 'win32') {
    const secret = path.join(w.d, 'secret.json'); fs.writeFileSync(secret, JSON.stringify({ action: 'init' }));
    fs.symlinkSync(secret, path.join(req, 'c1b2c3d4e5f60718.json'));
  }
  const n = await w.ctl.drain();
  assert.ok(n >= 2);
  const ok = JSON.parse(fs.readFileSync(path.join(res, RID + '.json'), 'utf8'));
  assert.equal(ok.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(res, 'b1b2c3d4e5f60718.json'), 'utf8')).ok, false);
  assert.ok(!fs.existsSync(path.join(req, RID + '.json')));
  assert.ok(fs.existsSync(path.join(req, 'ten-la.json')), 'tên lạ bị bỏ qua, không xử lý');
  if (process.platform !== 'win32') {
    assert.equal(JSON.parse(fs.readFileSync(path.join(res, 'c1b2c3d4e5f60718.json'), 'utf8')).ok, false, 'liên kết tượng trưng bị từ chối');
    assert.ok(fs.existsSync(path.join(w.d, 'secret.json')));
  }
});

// ---------- phía bot quản lý ----------
function manager(over) {
  const w = world();
  const getMe = async (t) => { if (t === TOKEN) return { id: 111, username: 'ketoan_bot', first_name: 'Kế toán' }; if (t === TOKEN2) return { id: 222, username: 'banhang_bot', first_name: 'Bán hàng' }; throw new Error('Unauthorized'); };
  const mgr = createAgents(Object.assign({
    file: path.join(w.d, 'data/agents.json'), reqDir: path.join(w.paths.ctl, 'req'), resDir: path.join(w.paths.ctl, 'res'),
    mainToken: MAIN_TOKEN, owners: () => ['1'], getMe, pollMs: 5, waitMs: 3000,
    show: async (id) => ({ ActiveState: 'active', SubState: 'running', MemoryCurrent: String(100 * 1048576), NRestarts: '0', LoadState: 'loaded' }),
  }, over || {}));
  const timer = setInterval(() => { w.ctl.drain().catch(() => {}); }, 10);
  return { w, mgr, stop: () => clearInterval(timer) };
}

test('quản lý: thêm agent (kiểm token qua Telegram), lưu sổ KHÔNG chứa token, liệt kê trạng thái', async () => {
  const m = manager(); await m.w.ctl.init();
  try {
    const r = await m.mgr.add({ token: TOKEN, name: 'Kế toán' });
    assert.equal(r.agent.id, 'a1'); assert.equal(r.agent.bot.username, 'ketoan_bot'); assert.deepEqual(r.agent.owners, ['1']);
    const book = fs.readFileSync(path.join(m.w.d, 'data/agents.json'), 'utf8');
    assert.ok(!book.includes(TOKEN) && !book.includes('AAAAAAAA'), 'sổ agent không giữ token');
    assert.ok(fs.existsSync(path.join(m.w.paths.units, 'agentos-agent-a1.service')));
    const r2 = await m.mgr.add({ token: TOKEN2 }); assert.equal(r2.agent.id, 'a2'); assert.equal(r2.agent.name, 'Bán hàng');
    const list = await m.mgr.list();
    assert.equal(list.length, 2); assert.equal(list[0].status.active, true); assert.equal(list[0].status.memMb, 100);
    await assert.rejects(() => m.mgr.add({ token: TOKEN }), /đã là agent a1/);
    await assert.rejects(() => m.mgr.add({ token: MAIN_TOKEN }), /bot quản lý/);
    await assert.rejects(() => m.mgr.add({ token: 'rác' }), /không đúng dạng/);
    await assert.rejects(() => m.mgr.add({ token: '777777777:' + 'Z'.repeat(35) }), /Telegram không nhận token/);
  } finally { m.stop(); }
});

test('quản lý: dừng / chạy / giới hạn / chủ / xóa theo mã, số hoặc tên; xóa rồi mã được dùng lại', async () => {
  const m = manager(); await m.w.ctl.init();
  try {
    await m.mgr.add({ token: TOKEN, name: 'Kế toán' });
    assert.equal((await m.mgr.control('a1', 'stop')).agent.id, 'a1');
    assert.equal((await m.mgr.control('1', 'start')).agent.id, 'a1');
    assert.equal((await m.mgr.control('kế toán', 'restart')).agent.id, 'a1');
    assert.equal((await m.mgr.control('@ketoan_bot', 'stop')).agent.id, 'a1');
    const u = await m.mgr.update('a1', { ramMb: 3000, cpuPct: 200, owners: ['1', '5'] });
    assert.equal(u.agent.ramMb, 3000); assert.deepEqual(m.mgr.get('a1').owners, ['1', '5']);
    await assert.rejects(() => m.mgr.update('a1', { ramMb: 10 }), /ramMb/);
    await assert.rejects(() => m.mgr.control('zzz', 'stop'), /Không có agent/);
    const r = await m.mgr.remove('a1'); assert.match(r.kept, /da-xoa/);
    assert.equal(m.mgr.get('a1'), null);
    assert.equal((await m.mgr.add({ token: TOKEN })).agent.id, 'a1');
  } finally { m.stop(); }
});

test('quản lý: hệ thống không trả lời thì báo rõ, không treo', async () => {
  const m = manager({ waitMs: 150 }); m.stop();
  await m.w.ctl.init();
  await assert.rejects(() => m.mgr.add({ token: TOKEN }), /không trả lời/);
  assert.equal(fs.readdirSync(path.join(m.w.paths.ctl, 'req')).length, 0, 'tệp yêu cầu quá hạn được dọn');
  const bad = createAgents({ file: path.join(m.w.d, 'x.json'), reqDir: path.join(m.w.d, 'khong-co'), resDir: m.w.d, getMe: async () => ({ id: 9, username: 'u' }), owners: () => ['1'] });
  await assert.rejects(() => bad.add({ token: TOKEN }), /Chưa gửi được yêu cầu/);
});

test('/daily: danh sách + nút, thêm bằng token (xóa tin chứa token), xóa phải xác nhận, người thường bị từ chối, nút ≤ 64 byte', async () => {
  const m = manager(); await m.w.ctl.init();
  const sent = [], deleted = [];
  const ui = createAgentsUi({ agents: m.mgr, isAdmin: (u) => String(u) === '1', send: async (c, t) => { sent.push(t); }, deleteMessage: async (c, id) => { deleted.push(id); } });
  try {
    assert.match((await ui.command('1', '2', '')), /chỉ chủ máy/i);
    const empty = await ui.command('1', '1', ''); assert.match(empty.text, /@BotFather/);
    assert.match(await ui.command('1', '1', 'them abc', { message_id: 5 }), /Chưa thấy token/);
    const r = await ui.command('1', '1', 'them ' + TOKEN + ' Kế toán', { message_id: 7 });
    assert.match(r, /Đã tạo agent a1 "Kế toán" — bot @ketoan_bot/);
    assert.deepEqual(deleted, [5, 7], 'luôn xóa tin có (hoặc nghi có) token');
    const card = await ui.command('1', '1', '');
    assert.match(card.text, /a1 · Kế toán · @ketoan_bot/); assert.match(card.text, /đang chạy/);
    for (const b of card.buttons.flat()) { assert.match(b.data, /^ag:(stop|start|restart|logs|del):a1$/); assert.ok(Buffer.byteLength(b.data) <= 64); }
    assert.match(await ui.command('1', '1', 'dung a1'), /đã dừng/);
    assert.match(await ui.command('1', '1', 'gioihan a1 2048 150'), /RAM 2048 MB, CPU 150%/);
    assert.match(await ui.command('1', '1', 'gioihan a1 5'), /⚠️.*ramMb/);
    assert.match(await ui.command('1', '1', 'chu a1 1,5'), /1, 5/);
    assert.match(await ui.command('1', '1', 'chu a1 abc'), /Cách dùng/);
    assert.match(await ui.command('1', '1', 'nhatky a1'), /Nhật ký agent a1/);
    const ask = await ui.command('1', '1', 'xoa a1'); assert.match(ask.text, /Xóa agent a1/);
    assert.equal(m.mgr.get('a1') != null, true, 'chưa xóa khi chưa bấm xác nhận');
    const cq = (d, u) => ({ data: d, from: { id: u || 1 }, message: { chat: { id: 1 } } });
    assert.match(await ui.callback(cq('ag:stop:a1', 2)), /Chỉ chủ máy/);
    await ui.callback(cq('ag:xoa:a1'));
    assert.equal(m.mgr.get('a1'), null);
    assert.ok(sent.some((t) => /Đã xóa agent a1/.test(typeof t === 'string' ? t : t.text || '')));
  } finally { m.stop(); }
});

function botWith(over) {
  const subs = [];
  const db = { addJob: (...a) => { subs.push(a); return 1; }, aheadOf: () => 0, kvGet: () => null, kvSet() {}, runningInChat: () => 0, addAudit() {} };
  const worker = { engineNames: () => ['claude'], wake() {}, engineStatus: () => [] };
  const bot = createBot(Object.assign({ db, worker, allowed: new Set(['1']), isAdmin: () => true, quietAck: true }, over || {}));
  const msg = (text) => ({ from: { id: 1 }, chat: { id: 1, type: 'private' }, text, message_id: 3 });
  return { bot, msg, subs };
}

test('bot: AGENT chặn lệnh quản trị máy (cập nhật, toàn quyền, /daily, /menu) nhưng vẫn nhận việc và /help, /claude', async () => {
  const { bot, msg, subs } = botWith({ agentMode: true });
  for (const c of ['/capnhat co', '/toanquyen bat', '/daily', '/menu', '/google', '/ketnoi', '/manhinh', '/may']) assert.match(await bot.handle(msg(c)), /chỉ có ở bot quản lý/, c);
  assert.match(await bot.handle(msg('/help')), /AgentOS/);
  assert.match(await bot.handle(msg('/id')), /ID Telegram/);
  await bot.handle(msg('/claude viết thư'));
  assert.equal(subs.length, 1);
});

test('bot quản lý: /daily và /agent chuyển cho giao diện agent; không có giao diện thì báo chưa hỗ trợ', async () => {
  const calls = [];
  const { bot, msg } = botWith({ agentsUi: { command: (c, u, a, m) => { calls.push([c, u, a, m.message_id]); return 'ok'; }, isCallback: (d) => /^ag:/.test(d), callback: async () => 'cb' } });
  assert.equal(await bot.handle(msg('/daily them xyz')), 'ok');
  assert.equal(await bot.handle(msg('/agent')), 'ok');
  assert.deepEqual(calls[0], ['1', '1', 'them xyz', 3]);
  assert.equal(await bot.handleCallback({ data: 'ag:stop:a1', from: { id: 1 }, message: { chat: { id: 1 } } }), 'cb');
  assert.match(await botWith().bot.handle(msg('/daily')), /chưa hỗ trợ agent/);
});

test('quyền hạn từng agent: chỉ khóa biết, đúng kiểu; ghi vào env; cập nhật gộp và null = về mặc định; không chèn được dòng lạ', async () => {
  const w = world();
  assert.equal((await create(w, { settings: { full: true, jobTimeoutMin: 30, memory: false, sandbox: 'off', tools: 'Read,Bash(git:*)' } })).ok, true);
  let env = fs.readFileSync(path.join(w.paths.etc, 'agents/a1.env'), 'utf8');
  assert.match(env, /^FULL_ACCESS=1$/m); assert.match(env, /^JOB_TIMEOUT_SEC=1800$/m); assert.match(env, /^MEMORY_ENABLED=false$/m);
  assert.match(env, /^SANDBOX=off$/m); assert.match(env, /^CLAUDE_ALLOWED_TOOLS=Read,Bash\(git:\*\)$/m);
  assert.equal((env.match(/^FULL_ACCESS=/gm) || []).length, 1, 'đè mặc định, không lặp dòng');
  assert.equal((await w.ctl.handle({ rid: RID, action: 'update', id: 'a1', settings: { full: null, parallel: 4 } })).ok, true);
  env = fs.readFileSync(path.join(w.paths.etc, 'agents/a1.env'), 'utf8');
  assert.match(env, /^FULL_ACCESS=0$/m); assert.match(env, /^PARALLEL_CHATS=4$/m); assert.match(env, /^JOB_TIMEOUT_SEC=1800$/m, 'giữ mục không đổi');
  const bad = (s) => w.ctl.handle({ rid: RID, action: 'update', id: 'a1', settings: s });
  assert.match((await bad({ evil: 1 })).msg, /lạ/);
  assert.match((await bad({ sandbox: 'x' })).msg, /một trong/);
  assert.match((await bad({ parallel: 99 })).msg, /từ 1 đến 6/);
  assert.match((await bad({ full: 'yes' })).msg, /bật\/tắt/);
  assert.match((await bad({ tools: 'Read\nTELEGRAM_TOKEN=1' })).msg, /không được phép/);
  assert.match((await bad({ tools: 'a;b' })).msg, /không được phép/);
});

test('/daily quyen: xem danh sách, đổi bật/tắt, số, chữ, về mặc định; khóa lạ bị báo', async () => {
  const m = manager(); await m.w.ctl.init();
  const ui = createAgentsUi({ agents: m.mgr, isAdmin: (u) => String(u) === '1', send: async () => {}, deleteMessage: async () => {} });
  try {
    await ui.command('1', '1', 'them ' + TOKEN + ' Kế toán', { message_id: 1 });
    const list = await ui.command('1', '1', 'quyen a1'); assert.match(list, /Quyền hạn agent a1/); assert.match(list, /full/); assert.match(list, /jobTimeoutMin/);
    assert.match(await ui.command('1', '1', 'quyen a1 full bat'), /full = true/);
    assert.match(await ui.command('1', '1', 'quyen a1 jobTimeoutMin 45'), /jobTimeoutMin = 45/);
    assert.match(await ui.command('1', '1', 'quyen a1 tools Read,Glob'), /tools = Read,Glob/);
    assert.deepEqual(m.mgr.get('a1').settings, { full: true, jobTimeoutMin: 45, tools: 'Read,Glob' });
    assert.match(await ui.command('1', '1', 'quyen a1 full macdinh'), /full = mặc định/);
    assert.equal(m.mgr.get('a1').settings.full, undefined);
    assert.match(await ui.command('1', '1', 'quyen a1 khonghop 1'), /Không có mục/);
    assert.match(await ui.command('1', '1', 'quyen a1 full ???'), /bật hoặc tắt/);
    assert.match(await ui.command('1', '2', 'quyen a1 full bat'), /chỉ chủ máy/i);
  } finally { m.stop(); }
});
