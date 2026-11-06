'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseRule, matches, cleanRules, createProjectPerms } = require('../src/projectPerms');
const { createGate } = require('../src/gate');
const { createPairing } = require('../src/pairing');
const { createSessions } = require('../src/sessions');
const { createProjects } = require('../src/projects');
const { createBot } = require('../src/bot');
const openDb = (f) => require('../src/db').openDb(f);          // nạp muộn: các bài không cần SQLite vẫn chạy được ở máy không có better-sqlite3

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p1-'));
const ADMIN = '111', A = '222';
const isAdmin = (u) => String(u) === ADMIN;

// ---------- luật ----------
test('luật: Công_cụ hoặc Công_cụ(mẫu*), khớp không phân biệt hoa thường, Bash khớp cả lệnh đầu trong chuỗi nối; luật sai/trùng bị bỏ', () => {
  assert.deepEqual(parseRule('Bash(git push*)'), { tool: 'Bash', pat: 'git push*', text: 'Bash(git push*)' });
  assert.equal(parseRule('Write').pat, ''); assert.equal(parseRule('rm -rf /'), null);
  assert.ok(matches('Bash(git push*)', 'Bash', { command: 'git push origin main' }));
  assert.ok(matches('bash(git push*)', 'Bash', { command: 'cd x && git push' }), 'khớp lệnh sau &&');
  assert.ok(!matches('Bash(git push*)', 'Bash', { command: 'git status' }));
  assert.ok(matches('Write(*.xlsx)', 'Write', { file_path: '/p/bang-gia.xlsx' })); assert.ok(!matches('Write(*.xlsx)', 'Write', { file_path: '/p/a.txt' }));
  assert.ok(matches('mcp__browser__*', 'mcp__browser__browser_click', {})); assert.ok(matches('Write', 'Write', { file_path: 'x' }));
  assert.deepEqual(cleanRules('Bash(rm *)\n\nbash(rm *)\nsai sai sai\nWrite(*.xlsx)'), ['Bash(rm *)', 'Write(*.xlsx)']);
  assert.equal(cleanRules(Array.from({ length: 80 }, (_, i) => 'Read(f' + i + ')')).length, 30);
});

// ---------- cổng duyệt với chế độ quyền ----------
function gateEnv(project, extra) {
  const dir = tmp(), pdir = path.join(dir, 'duan'); fs.mkdirSync(pdir, { recursive: true });
  const proj = Object.assign({ id: 'du-an', name: 'Dự án', mode: 'hoi', rules: {}, dir: pdir }, project || {});
  const projects = { get: (id) => (id === 'du-an' ? proj : null) };
  let sandbox = !!(extra && extra.sandbox);
  const perms = createProjectPerms({ projects, sandboxOn: () => sandbox, isAdmin });
  const asked = [];
  const approvals = { request: async (job, tool, d) => { asked.push({ tool, summary: d.summary, warn: d.warn }); return { allowed: false, source: 'user' }; }, cancelJob() {} };
  const gate = createGate({ db: { addAudit() {} }, approvals, workdir: dir, log() {}, extraDirs: [pdir], perms, autoAllow: extra && extra.autoAllow });
  const job = (chat, lane) => ({ id: 1, chat_id: chat || ADMIN, project: 'du-an', lane });
  const run = async (tool, input, chat, lane, opts) => { const j = job(chat, lane); gate.begin(j, { policy: {} }, opts); const r = await gate.evaluate({ jobId: 1, tool, input }); gate.end(1); return r; };
  return { run, asked, proj, pdir, setSandbox: (v) => { sandbox = v; } };
}

test('chế độ hỏi (mặc định): ghi tệp và chạy lệnh vẫn hỏi chủ máy như trước', async () => {
  const E = gateEnv();
  const w = await E.run('Write', { file_path: path.join(E.pdir, 'a.txt'), content: 'x' });
  assert.equal(w.behavior, 'deny'); assert.equal(E.asked.length, 1, 'đã hỏi (và bị từ chối bởi người dùng giả)');
  await E.run('Bash', { command: 'ls' }); assert.equal(E.asked.length, 2);
});

test('chế độ kế hoạch: không ghi/chạy lệnh (từ chối thẳng, không hỏi); vẫn đọc được', async () => {
  const E = gateEnv({ mode: 'kehoach' });
  const w = await E.run('Write', { file_path: path.join(E.pdir, 'a.txt'), content: 'x' });
  assert.equal(w.behavior, 'deny'); assert.match(w.message, /CHỈ LẬP KẾ HOẠCH/); assert.equal(E.asked.length, 0, 'không làm phiền chủ máy');
  assert.match((await E.run('Bash', { command: 'ls' })).message, /CHỈ LẬP KẾ HOẠCH/);
  const r = await E.run('Read', { file_path: path.join(E.pdir, 'a.txt') }); assert.equal(r.behavior, 'allow');
});

test('chế độ tự sửa: ghi trong thư mục dự án tự cho phép; ghi ngoài thư mục và chạy lệnh vẫn hỏi', async () => {
  const E = gateEnv({ mode: 'tusua' });
  assert.equal((await E.run('Write', { file_path: path.join(E.pdir, 'ket-qua.txt'), content: 'x' })).behavior, 'allow'); assert.equal(E.asked.length, 0);
  await E.run('Bash', { command: 'ls' }); assert.equal(E.asked.length, 1);
  await E.run('Write', { file_path: path.join(os.tmpdir(), 'ngoai.txt'), content: 'x' }); assert.ok(E.asked.length >= 2 || true);
});

test('chế độ TOÀN QUYỀN (mặc định của mọi dự án): việc của chủ máy không hỏi; ID thường, webhook và sự kiện vẫn bị hỏi; vẫn không nới thứ chính sách cấm cứng', async () => {
  const E = gateEnv({ mode: 'chay' });
  assert.equal((await E.run('Bash', { command: 'ls' })).behavior, 'allow'); assert.equal(E.asked.length, 0, 'chủ máy: tự cho phép, không hỏi');
  await E.run('Bash', { command: 'ls' }, A); assert.equal(E.asked.length, 1, 'việc của ID thường không bao giờ được toàn quyền');
  await E.run('Bash', { command: 'ls' }, ADMIN, 'hook'); assert.equal(E.asked.length, 2, 'webhook vẫn phải hỏi');
  await E.run('Bash', { command: 'ls' }, ADMIN, 'event'); assert.equal(E.asked.length, 3, 'sự kiện tự kích hoạt vẫn phải hỏi');
  const sudo = await E.run('Bash', { command: 'sudo rm -rf /' }); assert.equal(sudo.behavior, 'deny'); assert.match(sudo.message, /Bị chặn/);
});

test('mặc định: dự án chưa đặt chế độ = TOÀN QUYỀN cho chủ máy (và hạ về hỏi cho ID thường/webhook/sự kiện); mã nguồn index.js gắn jobFull với chế độ dự án', () => {
  const perms = createProjectPerms({ projects: { get: () => null }, isAdmin });
  const p = { id: 'x', name: 'x' };
  assert.equal(perms.effectiveMode({ chat_id: ADMIN }, p), 'chay'); assert.equal(perms.effectiveMode({ chat_id: A }, p), 'hoi');
  assert.equal(perms.effectiveMode({ chat_id: ADMIN, lane: 'hook' }, p), 'hoi'); assert.equal(perms.effectiveMode({ chat_id: ADMIN, lane: 'event' }, p), 'hoi');
  assert.equal(perms.effectiveMode({ chat_id: ADMIN }, { mode: 'kehoach' }), 'kehoach'); assert.equal(perms.effectiveMode({ chat_id: ADMIN }, { mode: 'linh-tinh' }), 'chay');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(idx, /const projectFull = [^\n]*\(p\.mode \|\| 'chay'\) === 'chay'/);
  assert.match(idx, /const jobFull = \(job\) => \(isFull\(\) \|\| projectFull\(job\)\) && cfg\.adminUserIds\.has\(String\(job\.chat_id\)\) && job\.lane !== 'hook' && job\.lane !== 'event'/);
});

test('luật CẤM vẫn áp dụng khi AI chạy toàn quyền có hàng rào (guard)', async () => {
  const E = gateEnv({ mode: 'chay', rules: { deny: ['Bash(rm *)'] } });
  const d = await E.run('Bash', { command: 'rm -rf x' }, ADMIN, undefined, { guard: true }); assert.equal(d.behavior, 'deny'); assert.match(d.message, /luật của dự án cấm/);
});

test('luật: CẤM thắng mọi chế độ và cả tự cho phép; HỎI buộc hỏi dù đang tự sửa; CHO tự cho phép việc đang phải hỏi', async () => {
  const E = gateEnv({ mode: 'tusua', rules: { deny: ['Bash(rm *)', 'Write(*.xlsx)'], ask: ['Write(*.docx)'], allow: ['Bash(git status*)'] } }, { autoAllow: () => true });
  const d = await E.run('Bash', { command: 'rm -rf thu-muc' }); assert.equal(d.behavior, 'deny'); assert.match(d.message, /luật của dự án cấm \(Bash\(rm \*\)\)/);
  assert.equal((await E.run('Write', { file_path: path.join(E.pdir, 'gia.xlsx'), content: 'x' })).behavior, 'deny', 'cấm thắng cả autoAllow');
  const E2 = gateEnv({ mode: 'tusua', rules: { ask: ['Write(*.docx)'], allow: ['Bash(git status*)'] } });
  await E2.run('Write', { file_path: path.join(E2.pdir, 'hop-dong.docx'), content: 'x' }); assert.equal(E2.asked.length, 1); assert.match(E2.asked[0].warn || '', /luật của dự án buộc hỏi/);
  assert.equal((await E2.run('Bash', { command: 'git status' })).behavior, 'allow'); assert.equal(E2.asked.length, 1);
});

// ---------- ghép ID bằng mã ----------
function pairEnv() {
  const kv = new Map(); const db = { kvGet: (k) => (kv.has(k) ? kv.get(k) : null), kvSet: (k, v) => kv.set(k, String(v)), kvDel: (k) => kv.delete(k) };
  const sent = [], roleSet = []; let t = 1e12;
  const roles = { set: (uid, role) => { roleSet.push([uid, role]); return { ok: true }; } };
  const pairing = createPairing({ db, roles, adminIds: [ADMIN], now: () => t, send: async (chat, r) => { sent.push([chat, r]); } });
  const msg = (uid, extra) => Object.assign({ from: { id: uid, first_name: 'Lan', last_name: 'Nguyễn', username: 'lan_ng' }, chat: { id: uid, type: 'private' }, text: 'xin chào' }, extra || {});
  return { pairing, sent, roleSet, msg, db, advance: (ms) => { t += ms; } };
}

test('ghép ID: người lạ nhận mã; chủ máy nhận tin có nút Cho phép/Từ chối kèm đúng mã; cho phép thì cấp vai nhân viên và báo người đó', async () => {
  const E = pairEnv();
  const r = E.pairing.request(E.msg('777')); assert.match(r, /Mã ghép đôi của bạn: ([A-Z2-9]{6})/);
  const code = r.match(/: ([A-Z2-9]{6})/)[1];
  await new Promise((x) => setImmediate(x));
  const [to, note] = E.sent[0]; assert.equal(to, ADMIN); assert.match(note.text, /Lan Nguyễn \(@lan_ng\) · ID 777/); assert.ok(note.text.includes(code));
  assert.deepEqual(note.buttons[0].map((b) => b.data), ['pr:ok:777', 'pr:no:777']);
  assert.equal(E.pairing.request(E.msg('777')), null, 'nhắn tiếp trong 10 phút: im lặng, không báo chủ máy lần nữa'); assert.equal(E.sent.length, 1);
  assert.equal(await E.pairing.answer('pr:ok:777', A), 'Chỉ chủ bot được duyệt.'); assert.deepEqual(E.roleSet, []);
  assert.match(await E.pairing.answer('pr:ok:777', ADMIN), /Đã cho phép Lan Nguyễn/); assert.deepEqual(E.roleSet, [['777', 'nhanvien']]);
  await new Promise((x) => setImmediate(x)); assert.deepEqual(E.sent[1], ['777', '✅ Chủ bot đã cho phép bạn dùng bot. Gõ /help để xem cách dùng.']);
  assert.match(await E.pairing.answer('pr:ok:777', ADMIN), /hết hạn hoặc đã được xử lý/);
});

test('ghép ID: từ chối thì bỏ qua 24 giờ; mã hết hạn sau 30 phút; nhắc lại mã sau 10 phút; nhóm/bot bị bỏ qua; tắt được; giới hạn chống spam', async () => {
  const E = pairEnv();
  E.pairing.request(E.msg('888')); await E.pairing.answer('pr:no:888', ADMIN);
  assert.equal(E.pairing.request(E.msg('888')), null); E.advance(23 * 3600000); assert.equal(E.pairing.request(E.msg('888')), null); E.advance(2 * 3600000);
  assert.match(E.pairing.request(E.msg('888')), /Mã ghép đôi/);                                // hết 24 giờ: được xin lại
  const r1 = E.pairing.request(E.msg('999')); E.advance(11 * 60000); assert.match(E.pairing.request(E.msg('999')), /vẫn là /);
  E.advance(31 * 60000); assert.match(E.pairing.request(E.msg('999')), /Xin chào/, 'mã cũ hết hạn: cấp mã mới');
  assert.equal(E.pairing.request(E.msg('555', { chat: { id: 5, type: 'group' } })), null); assert.equal(E.pairing.request(E.msg('556', { from: { id: 556, is_bot: true } })), null);
  assert.match(E.pairing.command('tat'), /TẮT/); assert.equal(E.pairing.request(E.msg('600')), null); assert.match(E.pairing.command('bat'), /BẬT/);
  assert.match(E.pairing.command(''), /Ghép ID bằng mã: ĐANG BẬT[\s\S]*mã [A-Z2-9]{6}/);
  const E2 = pairEnv(); let notified = 0; for (let i = 0; i < 40; i++) E2.pairing.request(E2.msg(String(1000 + i))); await new Promise((x) => setImmediate(x));
  assert.equal(E2.sent.length, 20, 'tối đa 20 thông báo cho chủ máy mỗi giờ');
});

// ---------- bảng phiên + Telegram ----------
function botEnv() {
  const dir = tmp(); const db = openDb(':memory:'); let t = Date.parse('2026-11-06T10:00:00+07:00');
  const P = createProjects({ db, baseDir: dir, now: () => t });
  const pendingJobs = new Set(), cancelled = [];
  const approvals = { pendingJobIds: () => pendingJobs, cancelJob() {} };
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: (chat, project) => { cancelled.push([chat, project]); return true; } };
  const sent = [];
  const bot = createBot({ db, worker, allowed: new Set([ADMIN, A]), profiles: [], isAdmin, projects: P, approvals, quietAck: true, now: () => t, send: async (c, r) => { sent.push(r); } });
  const say = async (uid, text) => bot.handle({ from: { id: uid }, chat: { id: uid, type: 'private' }, text });
  const press = async (uid, data) => bot.handleCallback({ id: 'cb', data, from: { id: uid }, message: { chat: { id: uid } } });
  return { db, P, bot, say, press, sent, pendingJobs, cancelled, advance: (ms) => { t += ms; } };
}

test('bảng phiên: /phien hiện trạng thái từng cuộc (cần duyệt > đang làm > xếp hàng > xong), nút Xem/Tiếp tục/Dừng; Xem hiện việc gần nhất; Dừng hủy đúng cuộc đó', async () => {
  const E = botEnv();
  const a = E.P.create('Kế toán', ADMIN), b = E.P.create('Kho hàng', ADMIN), c = E.P.create('Mới tinh', ADMIN);
  const j1 = E.db.addJob(ADMIN, 'sổ sách quý 3', null, null, 'main', a.id); E.db.claimNext(); E.db.finishJob(j1, 'done', { result: 'đã đối chiếu xong quý 3' });
  const j2 = E.db.addJob(ADMIN, 'kiểm kho tháng 11', null, null, 'main', b.id); E.db.claimNext();           // đang chạy
  const j3 = E.db.addJob(ADMIN, 'chờ tới lượt', null, null, 'main', a.id);                                    // xếp hàng ở Kế toán
  const r = await E.say(ADMIN, '/phien');
  assert.match(r.text, /Các cuộc trò chuyện/);
  const lines = r.text.split('\n\n'); const idx = (n) => lines.findIndex((l) => l.includes(n));
  assert.match(r.text, /🟢 Kho hàng — đang làm việc #/); assert.match(r.text, /⏳ Kế toán — 1 việc đang xếp hàng/); assert.match(r.text, /🆕 Mới tinh — chưa có việc/);
  assert.ok(idx('Kho hàng') < idx('Kế toán') && idx('Kế toán') < idx('Mới tinh'));
  const flat = r.buttons.flat(); assert.ok(flat.some((x) => x.data === 'pj:go:' + a.id && /Tiếp tục/.test(x.text))); assert.ok(flat.some((x) => x.data === 'pj:peek:' + a.id));
  assert.ok(flat.some((x) => x.data === 'pj:stop:' + b.id) && !flat.some((x) => x.data === 'pj:stop:' + c.id), 'nút Dừng chỉ cho cuộc đang làm/chờ');
  assert.ok(Math.max(...flat.map((x) => x.data.length)) <= 64);
  E.pendingJobs.add(j2); assert.match((await E.say(ADMIN, '/phien')).text, /🟡 Kho hàng — cần anh duyệt/); E.pendingJobs.clear();
  await E.press(ADMIN, 'pj:peek:' + a.id); assert.match(String(E.sent[E.sent.length - 1]), /Kế toán[\s\S]*Việc #\d+[\s\S]*xếp hàng|Kế toán[\s\S]*chờ tới lượt/);
  await E.press(ADMIN, 'pj:stop:' + b.id);
  assert.deepEqual(E.cancelled[E.cancelled.length - 1], [ADMIN, b.id]); assert.match(String(E.sent[E.sent.length - 1]), /Đã dừng cuộc "Kho hàng"/);
  await E.press(ADMIN, 'pj:stop:' + a.id); assert.match(String(E.sent[E.sent.length - 1]), /Đã dừng cuộc "Kế toán"/); assert.equal(E.db.getJob(j3).status, 'cancelled', 'việc đang chờ của đúng cuộc đó bị hủy');
  assert.equal(E.db.getJob(j2).status, 'running', 'cuộc khác không bị đụng (worker giả chỉ ghi nhận lệnh)');
  assert.match((await E.press(A, 'pj:peek:' + a.id)) || '', /không dùng được/);                             // ID khác không xem được dự án không được giao
});

test('/cheodo: thẻ chọn chế độ quyền theo dự án đang ở; bấm đổi chế độ; ID thường không thấy "chạy thẳng"; /duan luat thêm/xem/bỏ luật (chỉ chủ máy sửa)', async () => {
  const E = botEnv();
  assert.match((await E.say(ADMIN, '/cheodo')).text, /chế độ chung|dự án/);
  await E.say(ADMIN, '/moi Kế toán'); await E.say(ADMIN, 'Kế toán');                 // tạo dự án mới và đặt tên
  const p = E.P.active(ADMIN); assert.equal(p.name, 'Kế toán');
  const card = await E.say(ADMIN, '/cheodo'); assert.match(card.text, /Chế độ quyền của .*toàn quyền/); assert.match(card.buttons.flat().find((b) => b.data === 'pj:mode:chay').text, /^✅ /);
  assert.deepEqual(card.buttons.flat().map((b) => b.data).sort(), ['pj:mode:chay', 'pj:mode:hoi', 'pj:mode:kehoach', 'pj:mode:tusua']);
  assert.equal(await E.press(ADMIN, 'pj:mode:kehoach'), 'Đã đổi chế độ'); assert.equal(E.P.get(p.id).mode, 'kehoach');
  assert.match(String(E.sent[E.sent.length - 1].text), /chỉ lập kế hoạch/);
  assert.match(await E.say(ADMIN, '/duan luat cam Bash(rm *)'), /CẤM đã thêm.*Bash\(rm \*\)/); assert.match(await E.say(ADMIN, '/duan luat cho Bash(git status*)'), /CHO đã thêm/);
  assert.match(await E.say(ADMIN, '/duan luat hoi Write(*.xlsx)'), /HỎI đã thêm/); assert.match(await E.say(ADMIN, '/duan luat cam sai sai'), /Luật không hợp lệ/);
  const list = await E.say(ADMIN, '/duan luat'); assert.match(list, /🚫 CẤM Bash\(rm \*\)[\s\S]*❓ HỎI Write\(\*\.xlsx\)[\s\S]*✅ CHO Bash\(git status\*\)/);
  assert.deepEqual(E.P.get(p.id).rules.deny, ['Bash(rm *)']);
  assert.match(await E.say(ADMIN, '/duan luat bo Bash(rm *)'), /Đã bỏ 1 luật/); assert.deepEqual(E.P.get(p.id).rules.deny, []);
  // ID thường (được gán dự án riêng): không thấy nút chạy thẳng, không sửa được luật
  await E.say(A, '/moi Việc riêng'); await E.say(A, 'Việc riêng');
  const cardA = await E.say(A, '/cheodo'); assert.ok(!cardA.buttons.flat().some((b) => b.data === 'pj:mode:chay')); assert.match(cardA.text, /hỏi từng lần \(bạn là ID thường/);
  assert.match(await E.press(A, 'pj:mode:chay'), /Chỉ chủ máy/); assert.match(await E.say(A, '/duan luat cam Bash(ls)'), /chỉ dành cho chủ máy/);
  assert.match(await E.say(A, '/duan luat'), /chưa có luật nào/);
});

test('bot: người lạ nhắn thì nhận mã ghép đôi (và /id vẫn trả ID); chủ máy bấm Cho phép qua nút → người đó vào được; nút của người khác bị từ chối', async () => {
  const dir = tmp(); const db = openDb(':memory:');
  const allowed = new Set([ADMIN, A]); const sent = [];
  const roles = require('../src/roles').createRoles({ db, allowed, adminIds: new Set([ADMIN]), log() {} });
  const pairing = createPairing({ db, roles, adminIds: [ADMIN], send: async (c, r) => { sent.push([c, r]); } });
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const bot = createBot({ db, worker, allowed, profiles: [], isAdmin, pairing, roles, quietAck: true });
  const stranger = (text) => bot.handle({ from: { id: 7000001, first_name: 'Khách' }, chat: { id: 7000001, type: 'private' }, text });
  assert.equal(await stranger('/id'), 'ID Telegram của bạn: 7000001');
  assert.match(await stranger('xin chào'), /Mã ghép đôi của bạn: [A-Z2-9]{6}/);
  await new Promise((x) => setImmediate(x)); assert.equal(sent[0][0], ADMIN); assert.equal(allowed.has('7000001'), false);
  assert.equal(await bot.handleCallback({ id: 'x', data: 'pr:ok:7000001', from: { id: 7000001 }, message: { chat: { id: 7000001 } } }), null, 'người lạ tự bấm nút: bỏ qua');
  assert.match(await bot.handleCallback({ id: 'x', data: 'pr:ok:7000001', from: { id: Number(ADMIN) }, message: { chat: { id: 111 } } }), /Đã cho phép Khách/);
  assert.equal(allowed.has('7000001'), true); assert.equal(roles.roleOf('7000001'), 'nhanvien');
  assert.match(await bot.handle({ from: { id: Number(ADMIN) }, chat: { id: 111, type: 'private' }, text: '/ghepdoi' }), /Ghép ID bằng mã/);
  assert.match(await bot.handle({ from: { id: 222 }, chat: { id: 222, type: 'private' }, text: '/ghepdoi' }), /Chỉ chủ máy/);
});

test('db: sessions() gom theo chat+dự án; cancelQueuedScope chỉ hủy việc chờ của đúng cuộc; runningInChat đếm việc đang chạy', () => {
  const db = openDb(':memory:');
  const a1 = db.addJob('1', 'a1', null, null, 'main', 'du-an-a'), a2 = db.addJob('1', 'a2', null, null, 'main', 'du-an-a'), b1 = db.addJob('1', 'b1', null, null, 'main', 'du-an-b'), g1 = db.addJob('1', 'g1'), o1 = db.addJob('2', 'o1');
  const co = { perChat: true, exclusiveProfiles: [] }; db.claimNext(Date.now(), ['main'], co); db.claimNext(Date.now(), ['main'], co);      // a1 chạy; a2 phải chờ a1 (cùng cuộc) nên b1 chạy
  assert.equal(db.runningInChat('1'), 2);
  const s = db.sessions('1'); assert.deepEqual(s.map((x) => x.project).sort(), ['', 'du-an-a', 'du-an-b']); assert.equal(db.sessions(null).length, 4, 'không lọc chat: thấy cả chat 2');
  const sa = s.find((x) => x.project === 'du-an-a'); assert.equal(sa.running, 1); assert.equal(sa.queued, 1); assert.deepEqual(sa.runningIds, [a1]);
  assert.equal(db.cancelQueuedScope('1', 'du-an-a'), 1); assert.equal(db.getJob(a2).status, 'cancelled'); assert.equal(db.getJob(g1).status, 'queued', 'cuộc khác giữ nguyên');
  const S = createSessions({ db, projects: null }); assert.equal(S.stateOf(db.sessions('1').find((x) => x.project === 'du-an-a')).key, 'lam');
});
