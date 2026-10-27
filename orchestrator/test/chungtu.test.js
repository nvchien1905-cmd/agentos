'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { openDb } = require('../src/db');
const { createProjects } = require('../src/projects');
const { createChungTu, promptFor } = require('../src/chungtu');
const { createProjectCommands } = require('../src/projectCmd');

const ROOT = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
function mk() { const db = openDb(':memory:'), dir = tmp(); return { db, dir, P: createProjects({ db, baseDir: dir }) }; }

test('chứng từ: bật chế độ bằng /duan chungtu, lời nhắc đọc chứng từ thay lời nhắc mặc định (chỉ trong dự án bật chế độ)', async () => {
  const { db, P } = mk(); const pc = createProjectCommands({ db, projects: P, isAdmin: (u) => u === '111' });
  const p = P.create('Kế toán'); P.setActive('111', p.id);
  assert.equal(pc.chungtuAsk('111', '111', 'x', ['/a.jpg']), null, 'chưa bật thì không đổi gì');
  assert.match(await pc.run('111', '111', 'chungtu'), /tắt/); assert.match(await pc.run('111', '111', 'chungtu bat'), /đã BẬT chế độ chứng từ/);
  assert.ok(fs.existsSync(path.join(p.dir, 'CHUNG-TU-MOI'))); assert.equal(P.get(p.id).chungtu, true);
  const ask = pc.chungtuAsk('111', '111', 'hóa đơn tháng 10', ['/x/hd1.jpg']);
  for (const must of ['CHỨNG TỪ', '/x/hd1.jpg', 'agentos-chungtu add', 'chung-tu.xlsx', 'KHÔNG bịa|không bịa|TUYỆT ĐỐI không bịa', 'needs_review', 'duplicate', 'hóa đơn tháng 10']) assert.match(ask, new RegExp(must), must);
  assert.match(ask, new RegExp(p.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/KET-QUA/.tam-chung-tu.json'));
  assert.match(await pc.run('222', '222', 'chungtu tat'), /chỉ dành cho chủ máy/); assert.match(await pc.run('111', '111', 'chungtu tat'), /đã tắt/); assert.equal(pc.chungtuAsk('111', '111', '', []), null);
});

test('chứng từ: quét thư mục CHUNG-TU-MOI — chỉ dự án bật chế độ, chỉ ảnh/PDF, tệp vừa ghi thì đợi, chuyển sang DA-NHAN rồi mới giao việc (không giao lặp)', () => {
  const { P } = mk(); const a = P.create('Kế toán'), b = P.create('Khác'); P.setChungTu(a.id, true);
  const jobs = []; let t = Date.now();
  const C = createChungTu({ projects: P, now: () => t, settleMs: 30000, submit: (text, proj) => jobs.push({ text, proj }) });
  for (const p of [a, b]) fs.mkdirSync(path.join(p.dir, 'CHUNG-TU-MOI'), { recursive: true });
  const w = (p, name) => fs.writeFileSync(path.join(p.dir, 'CHUNG-TU-MOI', name), 'x');
  w(a, 'hd1.jpg'); w(a, 'phieu.PDF'); w(a, 'ghichu.txt'); w(a, '.an.jpg'); w(b, 'hd2.jpg');
  assert.equal(C.scan(), 0, 'tệp mới ghi: đợi đồng bộ xong');
  t += 31000; assert.equal(C.scan(), 2);
  assert.deepEqual(jobs.map((j) => j.proj), [a.id, a.id]); assert.match(jobs[0].text, /CHUNG-TU-DA-NHAN/);
  assert.deepEqual(fs.readdirSync(path.join(a.dir, 'CHUNG-TU-MOI')).sort(), ['.an.jpg', 'ghichu.txt']); assert.deepEqual(fs.readdirSync(path.join(a.dir, 'CHUNG-TU-DA-NHAN')).sort(), ['hd1.jpg', 'phieu.PDF']);
  assert.equal(fs.readdirSync(path.join(b.dir, 'CHUNG-TU-MOI')).length, 1, 'dự án không bật chế độ: không đụng');
  assert.equal(C.scan(), 0, 'không giao lặp');
  w(a, 'hd1.jpg'); t += 31000; assert.equal(C.scan(), 1, 'cùng tên: đổi tên bản mới, không ghi đè bản cũ'); assert.equal(fs.readdirSync(path.join(a.dir, 'CHUNG-TU-DA-NHAN')).length, 3);
});

test('công cụ agentos-chungtu: ghi sổ Excel, chống trùng, bắt lỗi số học/MST/ngày, vẫn ghi dòng cần xem lại', { skip: process.platform !== 'linux' || spawnSync('python3', ['-c', 'import openpyxl']).status !== 0 }, () => {
  const bin = path.join(ROOT, 'iso/config/includes.chroot/usr/local/bin/agentos-chungtu'); const d = tmp();
  const inv = { loai: 'hoa-don-mua', ngay: '2026-10-20', so: '0001234', ky_hieu: 'C26TAA', ben_ban: { ten: 'Cty ABC', mst: '0101234567' }, ben_mua: { ten: 'HA', mst: '8896654942-001' },
    tong_chua_thue: '10.000.000', thue_suat: 8, tien_thue: 800000, tong_thanh_toan: '10.800.000', lines: [{ ten: 'Nồi', dvt: 'cái', so_luong: 10, don_gia: 600000, thanh_tien: 6000000 }, { ten: 'Bếp', dvt: 'cái', so_luong: 4, don_gia: 1000000, thanh_tien: 4000000 }] };
  const run = (obj) => { const f = path.join(d, 'x.json'); fs.writeFileSync(f, JSON.stringify(obj)); const r = spawnSync('python3', [bin, 'add', '--project-dir', d, '--file', f, '--source', 'a.jpg'], { encoding: 'utf8' }); return JSON.parse(r.stdout); };
  assert.equal(run(inv).status, 'added'); assert.equal(run(inv).status, 'duplicate');
  const bad = run(Object.assign({}, inv, { so: '0001235', tong_thanh_toan: 11500000 })); assert.equal(bad.status, 'needs_review'); assert.match(bad.issues.join(' '), /≠ tổng/);
  const lineBad = run(Object.assign({}, inv, { so: '9', lines: [{ ten: 'Nồi', so_luong: 10, don_gia: 600000, thanh_tien: 5000000 }] })); assert.match(lineBad.issues.join(' '), /dòng 1.*10 × 600000/);
  const weird = run({ loai: 'hoa-don-mua', ngay: '2099-01-01', ben_ban: { ten: 'X', mst: '12345' } }); assert.equal(weird.status, 'needs_review'); assert.match(weird.issues.join(' '), /tương lai/); assert.match(weird.issues.join(' '), /MST bên bán có 5/);
  const list = JSON.parse(spawnSync('python3', [bin, 'list', '--project-dir', d], { encoding: 'utf8' }).stdout); assert.equal(list.length, 4); assert.equal(list[0]['MST bên mua'], '8896654942001'); assert.equal(list[1]['Cần xem lại'], 'CÓ'); assert.ok(!list[0]['Cần xem lại']);
  assert.ok(fs.existsSync(path.join(d, 'KET-QUA', 'chung-tu.xlsx')));
});

test('cổng duyệt: dự án bật chế độ chứng từ — AI được ghi ĐÚNG tệp tạm và chạy ĐÚNG lệnh ghi sổ không cần hỏi; mọi thứ khác vẫn hỏi/cấm; dự án không bật thì không được', async () => {
  const { createGate } = require('../src/gate'); const { db, dir, P } = mk();
  const a = P.create('Kế toán'), b = P.create('Khác'); P.setChungTu(a.id, true);
  const tmpf = (p) => path.join(p.dir, 'KET-QUA', '.tam-chung-tu.json');
  const { autoAllowFor } = require('../src/chungtu'); const allow = autoAllowFor(P);
  const asked = []; const approvals = { request: async (job, tool) => { asked.push(tool); return { allowed: false, source: 'user' }; }, cancelJob() {} };
  const gate = createGate({ db, approvals, workdir: tmp(), log() {}, extraDirs: [dir], autoAllow: allow, dirsFor: (j) => { const p = j.project && P.get(j.project); return p ? [p.dir] : null; } });
  const port = await gate.listen(0);
  try {
    const ja = db.getJob(db.addJob('1', 'x', null, null, 'main', a.id)), jb = db.getJob(db.addJob('1', 'x', null, null, 'main', b.id)); gate.begin(ja, { policy: {} }, {}); gate.begin(jb, { policy: {} }, {});
    const ask = async (j, tool, input) => (await (await fetch('http://127.0.0.1:' + port + '/gate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': gate.token }, body: JSON.stringify({ jobId: j.id, tool, input }) })).json()).behavior;
    const cmd = 'agentos-chungtu add --project-dir ' + a.dir + ' --file ' + tmpf(a) + ' --source ' + a.dir + '/CHUNG-TU-DA-NHAN/hd1.jpg';
    assert.equal(await ask(ja, 'Write', { file_path: tmpf(a), content: '{}' }), 'allow'); assert.equal(await ask(ja, 'Bash', { command: cmd }), 'allow');
    assert.equal(asked.length, 0, 'không hỏi chủ máy');
    assert.equal(await ask(ja, 'Write', { file_path: path.join(a.dir, 'KET-QUA', 'khac.json'), content: '{}' }), 'deny', 'tệp khác: vẫn hỏi (ở đây từ chối)');
    assert.equal(await ask(ja, 'Bash', { command: cmd + '; rm -rf /' }), 'deny'); assert.equal(await ask(ja, 'Bash', { command: 'agentos-chungtu add --project-dir /etc --file ' + tmpf(a) }), 'deny');
    assert.equal(await ask(jb, 'Write', { file_path: tmpf(b), content: '{}' }), 'deny', 'dự án không bật chế độ chứng từ'); assert.equal(await ask(ja, 'Write', { file_path: tmpf(b), content: '{}' }), 'deny', 'không ghi sang dự án khác');
    assert.ok(asked.length >= 4);
  } finally { await gate.close(); }
});
