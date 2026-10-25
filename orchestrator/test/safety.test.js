'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decideGuard } = require('../src/policy');
const { createGate } = require('../src/gate');
const { createApprovals } = require('../src/approvals');
const { createRoles } = require('../src/roles');
const { createBot } = require('../src/bot');
const { createQuick } = require('../src/quick');
const { openDb } = require('../src/db');

const bash = (command) => decideGuard({ tool: 'Bash', input: { command } });

test('hàng rào: lệnh bình thường của toàn quyền vẫn tự chạy (sudo, apt, ghi file, mạng đọc)', () => {
  for (const c of ['sudo apt-get install -y htop', 'ls -la /etc', 'systemctl restart nginx', 'curl -s https://example.com/api', 'wget https://example.com/a.zip', 'git commit -am x', 'python3 tinh.py', 'cp a b', 'rm -rf /tmp/x']) assert.equal(bash(c).action, 'allow', c);
  assert.equal(decideGuard({ tool: 'Write', input: { file_path: '/srv/onedrive/a.txt' } }).action, 'allow');
  assert.equal(decideGuard({ tool: 'WebFetch', input: { url: 'https://example.com' } }).action, 'allow');
});

test('hàng rào: CẤM đọc khóa, biến môi trường, cấu hình bí mật (cả khi ở chế độ toàn quyền)', () => {
  for (const c of ['printenv', 'env', 'env | grep KEY', 'cat /proc/self/environ', 'cat /etc/agentos/orchestrator.env', 'cat ~/.ssh/id_ed25519', 'cat .env', 'echo $X; export -p', 'sudo cat /etc/agentos/update-pubkey.pem']) assert.equal(bash(c).action, 'deny', c);
  assert.equal(decideGuard({ tool: 'Read', input: { file_path: '/home/agentos/.claude/.credentials.json' } }).action, 'deny');
  assert.equal(decideGuard({ tool: 'Read', input: { file_path: '/etc/shadow' } }).action, 'deny');
  assert.equal(bash('env FOO=1 ls').action, 'allow', 'env dùng để chạy lệnh thì được');
});

test('hàng rào: HỎI chủ máy khi gửi ra ngoài hoặc dính tiền', () => {
  const ask = ['sendmail a@b.com < f', 'curl -X POST https://x.com/a -d "k=v"', 'curl --data @file https://x.com', 'curl -F file=@a.pdf https://x.com', 'curl https://api.telegram.org/bot1/sendMessage?chat_id=1',
    'scp a user@h:/tmp', 'rsync -a . h:/b', 'git push origin main', 'curl https://openapi.zalo.me/v2.0/oa/message', 'xdg-open https://vietcombank.com.vn', 'echo chuyển khoản 5 triệu', 'npm publish'];
  for (const c of ask) { const d = bash(c); assert.equal(d.action, 'ask', c); assert.ok(d.warn, c); }
  assert.equal(decideGuard({ tool: 'mcp__browser__browser_navigate', input: { url: 'https://ebanking.techcombank.com.vn' } }).action, 'ask');
});

test('gate ở chế độ guard: deny chặn, ask hỏi chủ máy, allow chạy luôn và KHÔNG ghi nhật ký từng thao tác', async () => {
  const db = openDb(':memory:'); const asked = [];
  const approvals = createApprovals({ db, ask: async (chat, text, btn) => { asked.push([chat, text]); return 5; }, edit: async () => {}, timeoutMs: 200, askChat: () => 'ADMIN' });
  const gate = createGate({ db, approvals, workdir: '/w' });
  gate.begin({ id: 7, chat_id: '42' }, { policy: {} }, { guard: true });
  assert.equal((await gate.evaluate({ jobId: 7, tool: 'Bash', input: { command: 'ls' } })).behavior, 'allow');
  assert.equal((await gate.evaluate({ jobId: 7, tool: 'Bash', input: { command: 'printenv' } })).behavior, 'deny');
  const r = await gate.evaluate({ jobId: 7, tool: 'Bash', input: { command: 'git push origin main' } });      // không ai bấm -> hết giờ -> từ chối
  assert.equal(r.behavior, 'deny'); assert.match(r.message, /không trả lời kịp/);
  assert.equal(asked.length, 1); assert.equal(asked[0][0], 'ADMIN'); assert.match(asked[0][1], /gửi|đẩy/i);
  const audit = db.recentAudit(10);
  assert.ok(audit.every((a) => a.decision !== 'allow' || a.source !== 'auto'), 'không ghi allow tự động trong chế độ guard');
  gate.end(7);
});

test('vai trò: thêm/gỡ người dùng, quyền lệnh theo vai, nhân viên không dùng được lệnh của chủ máy', async () => {
  const db = openDb(':memory:'); const allowed = new Set(['1']); const admins = new Set(['1']);
  const roles = createRoles({ db, allowed, adminIds: admins });
  assert.equal(roles.set('1', 'ketoan').ok, false);                       // chủ máy không đổi vai
  assert.equal(roles.set('abc', 'ketoan').ok, false); assert.equal(roles.set('222222', 'thantien').ok, false);
  assert.equal(roles.set('222222', 'ketoan').ok, true); assert.ok(allowed.has('222222'));
  assert.equal(roles.set('333333', 'xem').ok, true);
  assert.deepEqual([roles.canQuick('222222', 'thay'), roles.canQuick('222222', 'lenh'), roles.canQuick('333333', 'doanhso'), roles.canQuick('333333', 'doc'), roles.canQuick('1', 'lenh')], [true, false, true, false, true]);
  assert.equal(roles.canAsk('333333'), false); assert.equal(roles.canAsk('222222'), true);
  // khởi động lại: người đã thêm vẫn được phép
  const allowed2 = new Set(['1']); createRoles({ db, allowed: allowed2, adminIds: admins }); assert.ok(allowed2.has('222222') && allowed2.has('333333'));

  const q = createQuick({ desk: { call: async () => ({ ok: true }) }, shotWaitMs: 0, remote: { runShell: async () => ({ text: 'đã chạy' }), getFile: async () => ({ text: 'x' }), sysinfo: async () => ({ text: 'x' }) }, office: { read: async () => 'nội dung', convert: async () => 'ok', replace: async () => 'ok' } });
  const submitted = [];
  const worker = { wake() {}, currentJobId: () => null, engineNames: () => ['claude'], cancelRunning: () => false };
  const bot = createBot({ db, worker, allowed, isAdmin: (u) => admins.has(String(u)), quick: q, roles });
  const m = (text, uid) => ({ from: { id: uid }, chat: { id: uid, type: 'private' }, text });
  assert.match(String(await bot.handle(m('/lenh ls', 222222))), /chỉ dành cho quản trị viên.*Kế toán/);
  assert.match(String(await bot.handle(m('/tuxa', 222222))), /chỉ dành cho quản trị viên/);
  assert.equal(await bot.handle(m('/doc', 222222)), 'nội dung');
  assert.match(String(await bot.handle(m('/doc', 333333))), /chỉ dành cho quản trị viên.*Chỉ xem/);
  assert.match(String(await bot.handle(m('xin chào AI', 333333))), /chỉ xem được báo cáo/);
  assert.match(String(await bot.handle(m('/claude làm gì đó', 333333))), /chỉ xem được báo cáo/);
  assert.doesNotMatch(String(await bot.handle(m('xin chào AI', 222222)) || ''), /chỉ xem được báo cáo/);
  assert.match(String(await bot.handle(m('/vaitro dat 444444 nhanvien', 222222))), /Chỉ chủ máy/);
  assert.match(String(await bot.handle(m('/vaitro dat 444444 nhanvien', 1))), /Đã đặt 444444 = Nhân viên/); assert.ok(allowed.has('444444'));
  const ls = String(await bot.handle(m('/vaitro', 1))); assert.match(ls, /444444 — Nhân viên/); assert.match(ls, /222222 — Kế toán/);
  assert.match(String(await bot.handle(m('/vaitro xoa 444444', 1))), /Đã gỡ/); assert.ok(!allowed.has('444444'));
  assert.equal(db.queuedCount() >= 1, true);
});
