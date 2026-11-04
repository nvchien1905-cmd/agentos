'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createProjects } = require('../src/projects');
const { createProjectCommands } = require('../src/projectCmd');
const { createWorker } = require('../src/worker');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));

test('dự án tổng: mỗi ID Telegram có dự án riêng (thư mục khác nhau); chọn dự án khác thì ưu tiên, thoát thì về dự án tổng', () => {
  const db = openDb(':memory:'), projects = createProjects({ db, baseDir: tmp() });
  const a = projects.active('1001'), b = projects.active('2002');
  assert.ok(a && b); assert.notEqual(a.id, b.id); assert.notEqual(a.dir, b.dir);
  assert.equal(a.home, '1001'); assert.deepEqual(a.users, ['1001']);
  assert.ok(fs.existsSync(path.join(a.dir, 'TAI-LIEU')) && fs.existsSync(path.join(b.dir, 'KET-QUA')));
  assert.equal(projects.active('1001').id, a.id, 'gọi lại không tạo thêm');
  assert.equal(projects.list().filter((p) => p.home).length, 2);
  const x = projects.create('Kế toán', '1001'); projects.setActive('1001', x.id);
  assert.equal(projects.active('1001').id, x.id); assert.equal(projects.active('2002').id, b.id, 'ID kia không bị ảnh hưởng');
  projects.setActive('1001', null); assert.equal(projects.active('1001').id, a.id);
  assert.equal(projects.homeOf('sys:abc'), null); assert.equal(projects.homeOf(''), null);
  projects.setHomeEnabled(false); assert.equal(projects.active('3003'), null, 'tắt thì về chế độ chung như cũ');
  assert.equal(projects.list().some((p) => p.home === '3003'), false);
  projects.setHomeEnabled(true); assert.ok(projects.active('3003'));
});

test('lệnh /duan: dự án tổng không lẫn vào danh sách chung, /duan tong, chỉ chủ máy bật/tắt', async () => {
  const db = openDb(':memory:'), projects = createProjects({ db, baseDir: tmp() });
  const adm = (u) => String(u) === '1001';
  const pc = createProjectCommands({ db, projects, isAdmin: adm, memory: null });
  projects.active('1001'); projects.active('2002');
  projects.create('Kế toán', '1001'); const k = projects.get('Kế toán'); projects.setUsers(k.id, ['2002']);
  const l1 = pc.listText('2002', '2002');
  assert.match(l1, /dự án tổng của bạn/); assert.match(l1, /Kế toán/); assert.doesNotMatch(l1, /Tổng · /);
  assert.equal(pc.current('2002', '2002').home, '2002');
  assert.match(await pc.run('2002', '2002', 'tong tat'), /chỉ dành cho chủ máy/); assert.equal(projects.homeEnabled(), true);
  assert.match(await pc.run('1001', '1001', 'tong tat'), /Đã tắt/); assert.equal(projects.homeEnabled(), false);
  assert.match(await pc.run('1001', '1001', 'tong bat'), /Đã bật/);
  await pc.run('2002', '2002', 'Kế toán'); assert.equal(pc.current('2002', '2002').id, k.id);
  assert.match(await pc.run('2002', '2002', 'thoat'), /dự án tổng/); assert.equal(pc.current('2002', '2002').home, '2002');
});

test('hàng đợi: mỗi chat tuần tự nhưng chat khác chạy song song; việc /web chỉ một lúc', () => {
  const db = openDb(':memory:');
  const o = { perChat: true, exclusiveProfiles: ['web'] };
  const a1 = db.addJob('1', 'a1'), a2 = db.addJob('1', 'a2'), b1 = db.addJob('2', 'b1');
  assert.equal(db.claimNext(Date.now(), ['main'], o).id, a1);
  assert.equal(db.claimNext(Date.now(), ['main'], o).id, b1, 'a2 phải chờ a1 (cùng ID), b1 của ID khác chạy ngay');
  assert.equal(db.claimNext(Date.now(), ['main'], o), null);
  db.finishJob(a1, 'done'); assert.equal(db.claimNext(Date.now(), ['main'], o).id, a2);
  db.finishJob(a2, 'done'); db.finishJob(b1, 'done');
  const w1 = db.addJob('1', 'web 1', null, 'web'), w2 = db.addJob('2', 'web 2', null, 'web'), c = db.addJob('3', 'thường');
  assert.equal(db.claimNext(Date.now(), ['main'], o).id, w1);
  assert.equal(db.claimNext(Date.now(), ['main'], o).id, c, 'việc /web thứ hai chờ; việc thường vẫn chạy');
  assert.equal(db.claimNext(Date.now(), ['main'], o), null);
  db.finishJob(w1, 'done'); assert.equal(db.claimNext(Date.now(), ['main'], o).id, w2);
  // không bật perChat (làn nền) thì giữ hành vi cũ: cùng chat vẫn chạy song song
  const n1 = db.addJob('9', 'n1', null, null, 'bg'), n2 = db.addJob('9', 'n2', null, null, 'bg');
  assert.equal(db.claimNext(Date.now(), ['bg']).id, n1); assert.equal(db.claimNext(Date.now(), ['bg']).id, n2);
});

test('hai worker: việc của ID thứ hai chạy ngay khi ID thứ nhất đang bận; cùng ID thì xếp hàng', async () => {
  const db = openDb(':memory:');
  const gates = {}, started = [];
  const engines = { codex: { start: ({ prompt }) => {
    started.push(prompt);
    let release; const p = new Promise((r) => { release = r; }); gates[prompt] = release;
    return { kill() { release(); }, done: p.then(() => ({ ok: true, text: 'xong ' + prompt, sessionId: 'S' })) };
  } } };
  const mk = () => createWorker({ db, engines, order: ['codex'], notify: async () => {}, now: Date.now, retryDelaysMs: [1], log: () => {}, perChat: true, exclusiveProfiles: [] });
  const w1 = mk(), w2 = mk();
  const wake = () => { w1.wake(); w2.wake(); };
  const a1 = db.addJob('1', 'A1'), a2 = db.addJob('1', 'A2'), b1 = db.addJob('2', 'B1');
  wake();
  const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };
  await until(() => started.length >= 2);
  assert.deepEqual(started.sort(), ['A1', 'B1'], 'A1 và B1 chạy cùng lúc, A2 chưa chạy');
  assert.equal(db.getJob(a2).status, 'queued');
  gates.B1(); await until(() => db.getJob(b1).status === 'done');
  assert.equal(db.getJob(a2).status, 'queued', 'B1 xong không làm A2 chạy chen khi A1 còn đang làm');
  gates.A1(); await until(() => started.includes('A2')); wake();
  await until(() => started.includes('A2'));
  assert.ok(started.includes('A2')); gates.A2(); await until(() => db.getJob(a2).status === 'done');
  assert.equal(db.getJob(a1).status, 'done');
  await w1.stop(); await w2.stop();
});

test('Telegram: việc mới của mỗi ID tự gắn vào dự án tổng của ID đó; /duan thoat quay về dự án tổng', async () => {
  const { createBot } = require('../src/bot');
  const db = openDb(':memory:'), projects = createProjects({ db, baseDir: tmp() });
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const bot = createBot({ db, worker, allowed: new Set(['111', '222']), profiles: [], isAdmin: (u) => String(u) === '111', projects, quietAck: true });
  const say = async (uid, text) => bot.handle({ from: { id: uid }, chat: { id: uid, type: 'private' }, text });
  await say(111, 'việc của chủ'); await say(222, 'việc của nhân viên');
  const j1 = db.recentJobs('111', 1)[0], j2 = db.recentJobs('222', 1)[0];
  assert.equal(j1.project, 'tong-111'); assert.equal(j2.project, 'tong-222');
  assert.notEqual(db.scopeOf(j1), db.scopeOf(j2), 'phiên và ngữ cảnh tách riêng theo ID');
  await say(111, '/duan moi Kế toán'); await say(111, 'trong dự án'); assert.equal(db.recentJobs('111', 1)[0].project, 'ke-toan');
  await say(111, '/duan thoat'); await say(111, 'về tổng'); assert.equal(db.recentJobs('111', 1)[0].project, 'tong-111');
  await say(222, 'vẫn của tôi'); assert.equal(db.recentJobs('222', 1)[0].project, 'tong-222');
});

test('hộp thư ra riêng từng ID: chỉ quét thư mục của chat của việc, không thấy tệp của ID khác hay tệp dùng chung', () => {
  const { createOutbox } = require('../src/outbox');
  const out = tmp(), dirFor = (c) => path.join(out, String(c));
  for (const c of ['1', '2']) { fs.mkdirSync(path.join(dirFor(c), 'browser'), { recursive: true }); fs.writeFileSync(path.join(dirFor(c), 'browser', 'anh-' + c + '.png'), 'x'); }
  fs.writeFileSync(path.join(out, 'chung.png'), 'x');
  const box = createOutbox(out, null, dirFor);
  assert.deepEqual(box(0, { chat_id: '1' }).map((f) => f.name), ['anh-1.png']);
  assert.deepEqual(box(0, { chat_id: '2' }).map((f) => f.name), ['anh-2.png']);
  assert.deepEqual(box(0, { chat_id: '3' }), []);
  assert.deepEqual(createOutbox(out)(0).map((f) => f.name).sort(), ['anh-1.png', 'anh-2.png', 'chung.png'], 'không có dirFor thì giữ cách cũ');
});

test('dự án tổng tự đặt tên theo tên Telegram; chủ máy đổi tên rồi thì không bị ghi đè', () => {
  const db = openDb(':memory:'), projects = createProjects({ db, baseDir: tmp() });
  projects.noteName('1001', 'Nguyễn Chiến');
  assert.equal(projects.active('1001').name, 'Nguyễn Chiến (1001)');
  projects.noteName('1001', 'Chiến Mới'); assert.equal(projects.active('1001').name, 'Chiến Mới (1001)', 'đổi tên Telegram thì tên theo');
  projects.rename(projects.active('1001').id, 'Phòng kế toán');
  projects.noteName('1001', 'Tên khác'); assert.equal(projects.active('1001').name, 'Phòng kế toán', 'đã tự đổi tên thì giữ');
  projects.noteName('2002', ''); assert.equal(projects.list().some((p) => p.home === '2002'), false, 'không có tên thì không tạo');
});

test('Nhật ký: danh sách lệnh đang chạy/chờ, nút Chạy lại tạo việc mới cùng nội dung (chỉ việc đã kết thúc)', () => {
  const { createAuditLog } = require('../src/auditlog');
  const { createControl } = require('../src/control');
  const db = openDb(':memory:'), projects = createProjects({ db, baseDir: tmp() });
  const woke = []; const ctl = createControl({ dir: tmp(), db, worker: { wake: () => woke.push(1) }, schedule: null, projects, log() {} });
  const a = db.addJob('1', 'đang chờ'), b = db.addJob('1', 'đã xong', 'codex', null, 'main', null);
  db.claimNext(Date.now(), ['main']); db.finishJob(a, 'done'); const run = db.claimNext(Date.now(), ['main']);
  const act = createAuditLog({ db: { raw: db.raw } }).list({ active: true });
  assert.deepEqual(act.map((x) => x.id), [run.id]); assert.equal(act[0].statusText, 'đang chạy');
  assert.equal(ctl.apply({ action: 'job.rerun', id: run.id }), false, 'việc đang chạy không chạy lại');
  assert.equal(ctl.apply({ action: 'job.rerun', id: a }), true);
  const copy = db.recentJobs('1', 1)[0]; assert.equal(copy.prompt, 'đang chờ'); assert.equal(copy.status, 'queued'); assert.notEqual(copy.id, a);
});
