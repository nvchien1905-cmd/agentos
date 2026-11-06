'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createMachineAccess } = require('../src/machineAccess');
const { createQuick } = require('../src/quick');
const { createVault } = require('../src/vault');
const { createSandbox, buildArgs } = require('../src/sandbox');
const { createOffice } = require('../src/office');
const { createBook } = require('../src/book');
const { createMemory } = require('../src/memory');
const { createProjects } = require('../src/projects');
const { createMedia } = require('../src/media');
const openDb = (f) => require('../src/db').openDb(f);          // nạp muộn: test không cần SQLite vẫn chạy được ở máy không có better-sqlite3

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cly-'));
const ADMIN = '111', A = '222', B = '333';
const isAdmin = (u) => String(u) === ADMIN;

test('quyền dùng máy theo ID: chủ máy dùng mọi máy; ID thường chỉ máy được giao; lưu ở tệp dùng chung (trang Cài đặt và bộ điều phối cùng đọc)', () => {
  const file = path.join(tmp(), 'machine-acl.json');
  const X = createMachineAccess({ file, isAdmin }), Y = createMachineAccess({ file, isAdmin });      // hai tiến trình cùng một tệp
  assert.equal(X.can(ADMIN, 'May van phong'), true); assert.equal(X.can(A, 'May van phong'), false); assert.equal(X.canRun(A, 'manhinh'), false);
  X.setUsers('May van phong', [A, 'abc', A]); X.setUsers('maytinh', B);                          // "maytinh" = màn hình máy này
  assert.deepEqual(Y.usersOf('may van phong'), [A]);                                              // tên không dấu/không phân biệt hoa thường; bản kia thấy ngay
  assert.deepEqual(Y.usersOf('@local'), [B]); assert.deepEqual(Y.grants(A), ['May van phong']); assert.deepEqual(Y.grants(B), ['@local']);
  assert.equal(Y.canRun(A, 'vao'), true); assert.equal(Y.canRun(A, 'manhinh'), false);          // A có máy từ xa nhưng không có màn hình máy chủ
  assert.equal(Y.canRun(B, 'manhinh'), true); assert.equal(Y.canRun(B, 'vao'), false);
  for (const danger of ['tatmay', 'khoamay', 'khoimay', 'mokhoa', 'tuxa', 'quyenmay']) assert.equal(Y.canRun(A, danger) || Y.canRun(B, danger), false, danger);
  assert.deepEqual(Y.visible(A, [{ name: 'May van phong' }, { name: 'May kho' }]).map((x) => x.name), ['May van phong']);
  assert.equal(Y.visible(ADMIN, [{ name: 'x' }, { name: 'y' }]).length, 2);
  Y.grant(B, 'May kho'); assert.deepEqual(X.grants(B).sort(), ['@local', 'May kho']); Y.grant(B, 'May kho', false); assert.deepEqual(X.grants(B), ['@local']);
  assert.equal(X.forget('May van phong'), true); assert.equal(Y.can(A, 'May van phong'), false);
  assert.throws(() => X.grant('abc', 'x'), /số/);
});

test('màn hình máy chủ chỉ MỘT người dùng một lúc: giữ lượt 10 phút, nhả bằng /nhaman, hết hạn thì người khác vào, chủ máy luôn giành lại', () => {
  let t = 1000000; const ac = createMachineAccess({ file: path.join(tmp(), 'a.json'), isAdmin, now: () => t });
  ac.setUsers('@local', [A, B]);
  assert.equal(ac.gate(A, 'manhinh'), null);
  assert.match(ac.gate(B, 'manhinh'), /đang được một người khác dùng.*thử lại sau khoảng 10 phút/);
  assert.equal(ac.gate(A, 'go'), null);                                                          // người đang giữ dùng tiếp (làm mới lượt)
  t += 9 * 60000; assert.match(ac.gate(B, 'manhinh'), /thử lại/);
  t += 2 * 60000; assert.equal(ac.gate(B, 'manhinh'), null);                                     // A im quá 10 phút: B vào
  assert.equal(ac.releaseScreen(B), true); assert.equal(ac.gate(A, 'manhinh'), null);            // B nhả: A vào ngay
  assert.equal(ac.gate(ADMIN, 'manhinh'), null); assert.match(ac.gate(A, 'manhinh'), /chủ máy/);   // chủ máy giành lại; người khác chờ
  assert.match(ac.gate('999', 'manhinh'), /chưa được giao/);
});

function fakeDesk() { const calls = []; return { calls, call: async (c) => { calls.push(c.cmd); return { ok: true, file: path.join(os.tmpdir(), 'x.png') }; } }; }
test('lệnh Telegram: ID thường chỉ chạy lệnh máy khi được giao; /vao chỉ thấy và chỉ vào máy của mình; /quyenmay chỉ chủ máy; nhả màn hình', async () => {
  const dir = tmp(), vault = createVault({ file: path.join(dir, 'vault.enc'), keyFile: path.join(dir, 'vault.key') });
  vault.put('May van phong', { id: '264372510', password: 'pw-1' }); vault.put('May kho', { id: '111222333', password: 'pw-2' });
  const access = createMachineAccess({ file: path.join(dir, 'acl.json'), isAdmin });
  const desk = fakeDesk(), q = createQuick({ desk, vault, access, isAdmin, shotWaitMs: 0, rdWaitMs: 0 });
  const as = (uid) => ({ chatId: uid, uid });
  // chưa được giao gì
  assert.match(await q.run('manhinh', '', as(A)), /chưa được giao/); assert.equal(desk.calls.length, 0);
  assert.match(await q.run('vao', '', as(A)), /chưa được giao/);
  // chủ máy giao
  assert.match(await q.run('quyenmay', '"May van phong" ' + A, as(ADMIN)), /May van phong: 222/);
  assert.match(await q.run('quyenmay', '@local ' + B, as(ADMIN)), /Màn hình máy này: 333/);
  assert.match(await q.run('quyenmay', '', as(ADMIN)), /May van phong: 222[\s\S]*Màn hình máy này \(@local\): 333/);
  assert.match(await q.run('quyenmay', '"May ma" 222', as(ADMIN)), /Không có máy "May ma"/);
  assert.match(await q.run('quyenmay', '@local ' + B, as(A)), /Chỉ chủ máy/);
  // A: chỉ máy văn phòng
  const list = await q.run('vao', '', as(A)); assert.match(list, /May van phong/); assert.doesNotMatch(list, /May kho|111222333/);
  assert.match(await q.run('vao', 'kho', as(A)), /May van phong/, 'gõ tên máy không được giao thì không khớp (không lộ máy khác)');
  assert.equal(desk.calls.includes('rdconnect'), false);
  assert.match(String((await q.run('vao', 'van phong', as(A))).text || ''), /Đã mở RustDesk nối tới "May van phong"/); assert.ok(desk.calls.includes('rdconnect'));
  // B: có màn hình máy chủ nhưng A đang giữ lượt (vừa /vao) → phải chờ; A nhả thì B dùng được
  assert.match(await q.run('manhinh', '', as(B)), /đang được một người khác dùng/);
  assert.match(await q.run('nhaman', '', as(A)), /Đã nhả/);
  assert.match(String((await q.run('manhinh', '', as(B))).text || ''), /Màn hình máy lúc/);
  assert.match(await q.run('vao', 'van phong', as(B)), /chưa được giao/);
  assert.equal((await q.run('quyenmay', '"May van phong" none', as(ADMIN))).includes('chỉ chủ máy'), true);
  assert.match(await q.run('vao', '', as(A)), /chưa được giao/);                  // thu quyền có hiệu lực ngay
});

test('sổ tay chung: /nho /quen /trinho của ID thường khi không ở dự án bị từ chối (chủ máy vẫn dùng)', async () => {
  const dir = tmp(); const book = createBook({ rootDir: path.join(dir, 'sotay') });
  const calls = []; const mem = { addFact: async (t) => { calls.push(t); return { ok: true, chapter: 'x' }; }, forgetFact: () => ({ removed: 0, lines: [] }), book, bookFor: () => book, info: () => ({ chapters: 0, entries: 0, toc: '', summary: '', cfg: { rotateAfter: 15 } }) };
  const noProj = { active: () => null, list: () => [] };
  const q = createQuick({ memory: mem, projects: noProj, isAdmin });
  for (const cmd of [['nho', 'điều gì đó'], ['quen', 'điều'], ['trinho', '']]) assert.match(await q.run(cmd[0], cmd[1], { chatId: A, uid: A }), /Sổ tay chung chỉ dành cho chủ máy/, cmd[0]);
  assert.equal(calls.length, 0);
  assert.match(await q.run('nho', 'Cửa hàng nghỉ chủ nhật', { chatId: ADMIN, uid: ADMIN }), /Đã ghi/); assert.equal(calls.length, 1);
  const withProj = { active: () => ({ id: 'du-an-a', name: 'A' }), list: () => [] };
  const q2 = createQuick({ memory: mem, projects: withProj, isAdmin });
  assert.match(await q2.run('nho', 'ghi vào dự án của mình', { chatId: A, uid: A }), /Đã ghi/);   // trong dự án riêng thì được (ghi vào sổ tay DỰ ÁN)
});

test('sổ tay chung chỉ nạp cho chủ máy: ID thường chỉ thấy sổ tay dự án của mình; ID thường không có dự án không ghi được vào sổ tay chung', async () => {
  const db = openDb(':memory:'), dir = tmp();
  const P = createProjects({ db, baseDir: dir });
  const m = createMemory({ db, dir, projects: P, isAdmin, now: () => 1, cfg: {} });
  m.book.put('Cửa hàng', 'Cửa hàng nghỉ chủ nhật, giá vốn nồi chiên là 900 nghìn');           // sổ tay chung (của chủ máy)
  const pa = P.create('Dự án A', A); P.setUsers(pa.id, [A]); m.bookFor(pa.id).put('Khách hàng', 'Khách Lan của dự án A thích màu xanh');
  const job = (chat, project, prompt) => ({ id: 1, chat_id: chat, project, prompt });
  const adm = m.pack(job(ADMIN, null, 'cửa hàng nghỉ chủ nhật không'), false, 'claude');
  assert.match(adm, /Sổ tay của chủ máy — MỤC LỤC/); assert.match(adm, /nghỉ chủ nhật/);
  const usr = m.pack(job(A, pa.id, 'cửa hàng nghỉ chủ nhật và khách Lan thích màu gì'), false, 'claude');
  assert.doesNotMatch(usr, /Sổ tay của chủ máy|giá vốn nồi chiên|900 nghìn/, 'không lộ sổ tay chung'); assert.match(usr, /Khách Lan của dự án A/);
  // tự ghi "nhớ…" khi không có dự án: chủ máy ghi được, ID thường thì không
  await m.afterJob(job(A, null, 'Nhớ giúp anh mã hàng xyzabc là nồi chiên 1 triệu'), 'claude', { ok: true });
  await m.afterJob(job(ADMIN, null, 'Nhớ giúp anh là cửa hàng đóng cửa 22 giờ'), 'claude', { ok: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(m.book.search('xyzabc mã hàng', 5).length, 0); assert.equal(m.book.search('đóng cửa 22 giờ', 5).length, 1);
});

test('cách ly trong hộp cô lập: che trước rồi mở lại đúng thư mục của mình (đúng thứ tự tham số bwrap)', () => {
  const stat = (p) => ({ isDirectory: () => true });
  const a = buildArgs({ home: '/h', workdir: '/w', rw: ['/od'], hide: [] }, stat, { hide: ['/od/AgentOS', '/w/out'], bind: ['/od/AgentOS/DU-AN/mine', '/w/out/222'] });
  const s = a.join(' ');
  assert.ok(s.indexOf('--tmpfs /od/AgentOS') > s.indexOf('--bind /od /od'), 'che sau khi gắn OneDrive');
  assert.ok(s.indexOf('--bind /od/AgentOS/DU-AN/mine') > s.indexOf('--tmpfs /od/AgentOS'), 'mở lại sau khi che');
  assert.ok(s.indexOf('--bind /w/out/222') > s.indexOf('--tmpfs /w/out'));
  assert.ok(!buildArgs({ home: '/h', workdir: '/w' }, stat).join(' ').includes('/od/AgentOS'), 'không truyền isolate thì không che thêm');
});

const bwrapOk = (() => { if (process.platform !== 'linux') return false; const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--', '/bin/true'], { timeout: 10000 }); return r && r.status === 0; })();
test('hộp cô lập THẬT (bwrap): ID thường không đọc được dự án/sổ tay/tệp của ID khác, đọc được phần của mình; chủ máy không bị che', { skip: bwrapOk ? false : 'máy này không có bwrap' }, () => {
  const root = tmp(), od = path.join(root, 'od'), work = path.join(root, 'work'), data = path.join(root, 'data'), jobs = path.join(root, 'jobs'), home = path.join(root, 'home');
  const mk = (p, f, c) => { fs.mkdirSync(p, { recursive: true }); if (f) fs.writeFileSync(path.join(p, f), c); };
  mk(path.join(od, 'AgentOS', 'DU-AN', 'mine'), 'a.txt', 'cua toi'); mk(path.join(od, 'AgentOS', 'DU-AN', 'other'), 'b.txt', 'bi mat nguoi khac');
  mk(path.join(od, 'AgentOS', 'SO-TAY'), 'chuong-chung.md', 'so tay chung'); mk(path.join(od, 'Chung'), 'tai-lieu.txt', 'tai lieu dung chung');
  mk(path.join(work, 'out', '222'), 'm.txt', 'out cua 222'); mk(path.join(work, 'out', '333'), 'n.txt', 'out cua 333'); mk(path.join(work, 'inbox', '333'), 'x.jpg', 'anh cua 333');
  for (const d of [data, jobs, home]) mk(d);
  const sb = createSandbox({ mode: 'bwrap', paths: { home, workdir: work, dataDir: data, jobDir: jobs, rw: [od], hide: [] } });
  assert.equal(sb.enabled, true);
  const run = (isolate, script) => { const w = sb.wrap({ bin: '/bin/sh', args: ['-c', script], cwd: work, isolate }); const r = spawnSync(w.bin, w.args, { encoding: 'utf8', timeout: 15000 }); return r.stdout + r.stderr; };
  const probe = 'for f in ' + [path.join(od, 'AgentOS/DU-AN/mine/a.txt'), path.join(od, 'AgentOS/DU-AN/other/b.txt'), path.join(od, 'AgentOS/SO-TAY/chuong-chung.md'), path.join(od, 'Chung/tai-lieu.txt'), path.join(work, 'out/222/m.txt'), path.join(work, 'out/333/n.txt'), path.join(work, 'inbox/333/x.jpg')].join(' ') + '; do cat $f 2>/dev/null; echo "|"; done';
  const iso = { hide: [path.join(od, 'AgentOS'), path.join(work, 'out'), path.join(work, 'inbox')], bind: [path.join(od, 'AgentOS', 'DU-AN', 'mine'), path.join(work, 'out', '222')] };
  const mine = run(iso, probe);
  assert.match(mine, /cua toi/); assert.match(mine, /tai lieu dung chung/); assert.match(mine, /out cua 222/);
  for (const secret of ['bi mat nguoi khac', 'so tay chung', 'out cua 333', 'anh cua 333']) assert.doesNotMatch(mine, new RegExp(secret), 'lộ: ' + secret);
  assert.equal(run(iso, 'echo hello > ' + path.join(od, 'AgentOS/DU-AN/mine/moi.txt') + ' && echo ghi-duoc').includes('ghi-duoc'), true, 'vẫn ghi được vào dự án của mình');
  assert.equal(run(iso, 'ls ' + path.join(od, 'AgentOS/DU-AN')).trim(), 'mine', 'không liệt kê được dự án của người khác');
  const adm = run(null, probe);                                                                  // chủ máy: không che
  for (const seen of ['bi mat nguoi khac', 'so tay chung', 'out cua 333']) assert.match(adm, new RegExp(seen));
});

test('/doc không tham số chỉ lấy tệp mới nhất trong thư mục của CHÍNH chat đó; tệp tải về của mỗi chat nằm thư mục riêng', async () => {
  const inbox = tmp(); fs.mkdirSync(path.join(inbox, A)); fs.mkdirSync(path.join(inbox, B));
  fs.writeFileSync(path.join(inbox, A, 'a.docx'), 'x'); fs.writeFileSync(path.join(inbox, B, 'b.docx'), 'y');
  const now = Date.now() / 1000; fs.utimesSync(path.join(inbox, B, 'b.docx'), now + 100, now + 100);       // tệp của B mới hơn
  const off = createOffice({ inboxDir: inbox });
  assert.equal(path.basename(off.latest(A)), 'a.docx'); assert.equal(path.basename(off.latest(B)), 'b.docx');
  assert.equal(path.basename(off.resolve('', A)), 'a.docx'); assert.equal(off.latest('999'), null);
  const tg = { downloadFile: async (id, dest) => { fs.writeFileSync(dest, 'img'); return dest; } };
  const media = createMedia({ tg, dir: inbox, log() {} });
  const r = await media.prepare([{ message_id: 7, chat: { id: 555 }, photo: [{ file_id: 'p1', file_size: 10, width: 1, height: 1 }] }]);
  assert.ok(r.files.length === 1 && r.files[0].path.startsWith(path.join(inbox, '555') + path.sep), r.files[0] && r.files[0].path);
});
