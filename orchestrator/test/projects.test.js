'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createProjects, slugify } = require('../src/projects');
const { createMemory } = require('../src/memory');
const { createWorker } = require('../src/worker');
const { createBot } = require('../src/bot');
const { createGate } = require('../src/gate');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'duan-'));
const T0 = Date.parse('2026-10-27T10:00:00+07:00');
function mk(extra) {
  const db = openDb(':memory:'), dir = tmp(); let t = T0;
  const projects = createProjects({ db, baseDir: dir, now: () => t++ });
  const m = createMemory(Object.assign({ db, dir, projects, now: () => T0, cfg: { recentTurns: 2, summarizeAfter: 3, rotateAfter: 4 } }, extra || {}));
  return { db, dir, projects, m };
}

test('dự án: tạo (mã không dấu, thư mục + CHI-DAN.md + TAI-LIEU/KET-QUA/SO-TAY), trùng tên bị từ chối, đổi tên giữ mã, cất/hiện lại, giao người dùng', () => {
  const { projects: P } = mk();
  assert.equal(slugify('Kế toán 2026 – Đặng Văn'), 'ke-toan-2026-dang-van');
  const p = P.create('Kế toán 2026', '111');
  assert.equal(p.id, 'ke-toan-2026'); assert.ok(fs.existsSync(path.join(p.dir, 'CHI-DAN.md')));
  for (const d of ['TAI-LIEU', 'KET-QUA', 'SO-TAY']) assert.ok(fs.statSync(path.join(p.dir, d)).isDirectory(), d);
  assert.throws(() => P.create('kế toán 2026'), /Đã có dự án/); assert.throws(() => P.create('x'), /2–60/);
  const q = P.create('Kế toán, 2026'); assert.equal(q.id, 'ke-toan-2026-2');               // cùng mã thì đánh số, không đè thư mục
  assert.equal(P.rename('ke-toan-2026', 'Sổ sách 2026').id, 'ke-toan-2026'); assert.equal(P.get('so sach 2026').id, 'ke-toan-2026'); assert.equal(P.get('ke-toan-2026').name, 'Sổ sách 2026');
  P.archive('ke-toan-2026-2'); assert.deepEqual(P.list().map((x) => x.id), ['ke-toan-2026']); assert.equal(P.list({ all: true }).length, 2);
  P.setUsers('ke-toan-2026', ['222', 'abc', '222']); assert.deepEqual(P.get('ke-toan-2026').users, ['222']);
  const admin = (u) => u === '111';
  assert.ok(P.canUse('111', P.get('ke-toan-2026'), admin)); assert.ok(P.canUse('222', P.get('ke-toan-2026'), admin)); assert.ok(!P.canUse('333', P.get('ke-toan-2026'), admin));
});

test('dự án: chỉ dẫn (bỏ ô chú thích mẫu), vào/thoát dự án, #tên, xóa vào thùng rác rồi dọn sau 30 ngày; tên ma không đi ra ngoài thư mục', () => {
  const { db, dir } = mk(); let t = T0;
  const P = createProjects({ db, baseDir: dir, now: () => t });
  const p = P.create('Bán hàng');
  assert.equal(P.instructions(p.id), '');                                       // mẫu chỉ có chú thích -> coi như chưa có
  P.setInstructions(p.id, '# Chỉ dẫn dự án: Bán hàng\n\nLuôn báo giá có VAT.\n'); assert.equal(P.instructions(p.id), 'Luôn báo giá có VAT.');
  P.setActive('9', p.id); assert.equal(P.active('9').id, p.id); P.setActive('9', null); assert.equal(P.active('9'), null);
  assert.equal(P.parseTag('#ban-hang giá nồi chiên?').project.id, p.id); assert.equal(P.parseTag('#ban-hang giá nồi chiên?').text, 'giá nồi chiên?');
  assert.equal(P.parseTag('#khong-co gì đó'), null); assert.equal(P.parseTag('xin chào #ban-hang'), null);
  assert.equal(P.get('../../etc'), null);
  P.setActive('9', p.id); P.remove(p.id);
  assert.equal(P.get(p.id), null); assert.equal(P.active('9'), null, 'người đang ở dự án đã xóa tự về chế độ chung'); assert.ok(!fs.existsSync(p.dir));
  assert.equal(fs.readdirSync(path.join(P.root(), '.thung-rac')).length, 1);
  assert.equal(P.purge(), 0); t += 31 * 86400000; assert.equal(P.purge(), 1); assert.equal(fs.readdirSync(path.join(P.root(), '.thung-rac')).length, 0);
});

test('lịch sử/phiên theo phạm vi: việc trong dự án không lẫn với trò chuyện chung và dự án khác', () => {
  const db = openDb(':memory:');
  const a = db.addJob('1', 'chung 1'), b = db.addJob('1', 'kho 1', null, null, 'main', 'kho'), c = db.addJob('1', 'ketoan 1', null, null, 'main', 'ketoan');
  for (const id of [a, b, c]) { db.claimNext(); db.finishJob(id, 'done', { result: 'kq ' + id }); }
  assert.equal(db.scopeOf(db.getJob(a)), '1'); assert.equal(db.scopeOf(db.getJob(b)), '1#kho');
  assert.deepEqual(db.history('1', 0, 99, 9).map((x) => x.id), [a]); assert.deepEqual(db.history('1#kho', 0, 99, 9).map((x) => x.id), [b]);
  assert.equal(db.lastJobId('1#ketoan'), c); assert.equal(db.lastJobId('1'), a); assert.deepEqual(db.doneAfter('1#kho', 0, null, 9).map((x) => x.id), [b]);
  assert.deepEqual(db.search('1#kho', 'kho 1 ketoan', 5, 0, []).map((x) => x.id), [b]);
});

test('ngữ cảnh dự án: chỉ dẫn + sổ tay RIÊNG ghép cho AI nào đang chạy; dự án khác và chat chung không lộ sang nhau; AI đã có phiên chỉ nhận phần thay đổi', async () => {
  const { db, projects: P, m } = mk();
  const a = P.create('Kế toán'), b = P.create('Bán hàng');
  P.setInstructions(a.id, 'Luôn trả lời bằng bảng, đơn vị VNĐ.');
  await m.addFact('Thuế GTGT 8% đến hết 2026', a.id); await m.addFact('Nồi chiên giảm giá 20%', b.id); await m.addFact('Cửa hàng nghỉ chủ nhật');
  const jid = db.addJob('1', 'thuế GTGT năm nay?', null, null, 'main', a.id), job = db.getJob(jid);
  const p1 = m.pack(job, false, 'claude');
  assert.match(p1, /DỰ ÁN "Kế toán"/); assert.match(p1, /Luôn trả lời bằng bảng/); assert.match(p1, /Thuế GTGT 8%/); assert.match(p1, /Cửa hàng nghỉ chủ nhật/, 'sổ tay chung vẫn có');
  assert.doesNotMatch(p1, /Nồi chiên giảm giá/, 'không lộ sổ tay dự án khác'); assert.doesNotMatch(p1, /Bán hàng/);
  // Codex (AI dự phòng) cũng nhận ĐÚNG cùng dữ liệu dự án
  const p2 = m.pack(job, false, 'codex'); assert.match(p2, /Luôn trả lời bằng bảng/); assert.match(p2, /Thuế GTGT 8%/);
  // đã có phiên: lần sau không gửi lại chỉ dẫn; sửa chỉ dẫn thì gửi bản cập nhật
  const p3 = m.pack(job, true, 'claude'); assert.doesNotMatch(p3, /Luôn trả lời bằng bảng/);
  P.setInstructions(a.id, 'Luôn trả lời bằng bảng, ghi rõ nguồn.'); assert.match(m.pack(job, true, 'claude'), /CẬP NHẬT[\s\S]*ghi rõ nguồn/);
  // việc chung không nhận gì của dự án
  const g = db.getJob(db.addJob('1', 'thuế GTGT năm nay?')); const pg = m.pack(g, false, 'claude'); assert.doesNotMatch(pg, /DỰ ÁN|Luôn trả lời bằng bảng|Thuế GTGT 8%/);
});

test('hội thoại dự án được tóm tắt riêng và ghi chú rút ra vào sổ tay CỦA DỰ ÁN', async () => {
  const summarizer = { available: () => true, provider: () => 'gemini', run: async () => ({ via: 'gemini', text: JSON.stringify({ summary: 'đã chốt giá', notes: [{ chapter: 'Giá', text: 'Giá sỉ giảm 10% từ 20 cái' }] }) }) };
  const { db, projects: P, m } = mk({ summarizer });
  const p = P.create('Bán sỉ');
  for (let i = 0; i < 6; i++) { const id = db.addJob('1', 'việc dự án ' + i, null, null, 'main', p.id); db.claimNext(); db.finishJob(id, 'done', { result: 'ok ' + i }); }
  const g = db.addJob('1', 'việc chung'); db.claimNext(); db.finishJob(g, 'done', { result: 'ok chung' });
  const r = await m.maybeSummarize('1#' + p.id, true); assert.equal(r.done, true);
  assert.match(db.kvGet('sum:1#' + p.id), /đã chốt giá/); assert.equal(db.kvGet('sum:1'), null, 'trò chuyện chung không bị đụng');
  assert.match(fs.readFileSync(path.join(P.bookDir(p.id), 'chuong-gia.md'), 'utf8'), /Giá sỉ giảm 10%/);
  assert.equal(m.book.list().length, 0, 'sổ tay chung không nhận ghi chú của dự án');
});

test('worker: việc trong dự án chạy bằng Claude; Claude hết hạn mức thì Codex làm tiếp ĐÚNG dự án đó với cùng chỉ dẫn/sổ tay; phiên theo từng dự án', async () => {
  const { db, projects: P, m } = mk(); const sent = [];
  const p = P.create('Kế toán'); P.setInstructions(p.id, 'Trả lời bằng bảng VNĐ.'); await m.addFact('Hạn nộp tờ khai: ngày 20', p.id);
  const calls = [];
  const engines = {
    claude: { start: (a) => { calls.push({ eng: 'claude', prompt: a.prompt, resumeId: a.resumeId, job: a.job }); return { done: Promise.resolve({ ok: false, limit: true, resetAt: Date.now() + 3600000, error: 'limit' }), kill() {} }; } },
    codex: { start: (a) => { calls.push({ eng: 'codex', prompt: a.prompt, resumeId: a.resumeId, job: a.job }); return { done: Promise.resolve({ ok: true, text: 'Đã làm tiếp', sessionId: 'cx-1' }), kill() {} }; } },
  };
  const w = createWorker({ db, engines, order: ['claude', 'codex'], notify: async (c, t) => { sent.push(t); }, context: m, retryDelaysMs: [1] });
  const id = db.addJob('1', 'Hạn nộp tờ khai khi nào?', null, null, 'main', p.id); await w.wake();
  assert.equal(db.getJob(id).status, 'done'); assert.deepEqual(calls.map((c) => c.eng), ['claude', 'codex']);
  for (const c of calls) { assert.match(c.prompt, /DỰ ÁN "Kế toán"/); assert.match(c.prompt, /Trả lời bằng bảng VNĐ/); assert.match(c.prompt, /Hạn nộp tờ khai: ngày 20/); assert.equal(c.job.project, p.id); }
  assert.ok(sent.some((s) => /Chuyển việc #\d+ sang Codex/.test(s)));
  assert.equal(db.kvGet('session:1#' + p.id + ':codex'), 'cx-1'); assert.equal(db.kvGet('session:1:codex'), null, 'phiên của dự án không ghi vào cuộc trò chuyện chung');
  // lượt sau trong dự án: Codex dùng lại phiên của dự án (và Claude đang nghỉ)
  const id2 = db.addJob('1', 'còn gì nữa?', null, null, 'main', p.id); await w.wake();
  assert.equal(calls[calls.length - 1].resumeId, 'cx-1');
  // việc chung: không có phiên của dự án
  db.addJob('1', 'chuyện khác'); await w.wake(); assert.equal(calls[calls.length - 1].resumeId, null); assert.doesNotMatch(calls[calls.length - 1].prompt, /DỰ ÁN/);
});

test('worker: AI ưu tiên của dự án đứng đầu nhưng vẫn có dự phòng', async () => {
  const { db, projects: P } = mk(); const order = [];
  const p = P.create('Nội dung'); P.setEngine(p.id, 'codex');
  const eng = (n, res) => ({ start: () => { order.push(n); return { done: Promise.resolve(res), kill() {} }; } });
  const w = createWorker({ db, engines: { claude: eng('claude', { ok: true, text: 'x' }), codex: eng('codex', { ok: false, limit: true, resetAt: Date.now() + 99999 }) }, order: ['claude', 'codex'], notify: async () => {}, retryDelaysMs: [1],
    projectEngine: (job) => (P.get(job.project) || {}).engine });
  db.addJob('1', 'viết bài', null, null, 'main', p.id); await w.wake();
  assert.deepEqual(order, ['codex', 'claude']);
  order.length = 0; db.addJob('1', 'ép claude', 'claude', null, 'main', p.id); await w.wake(); assert.deepEqual(order, ['claude'], 'lệnh ép AI cụ thể thắng cấu hình dự án');
});

test('cổng duyệt: việc trong dự án chỉ được đọc/ghi trong thư mục dự án (không sang dự án khác hay OneDrive chung)', async () => {
  const { db, projects: P, dir } = mk(); const a = P.create('Alpha'), b = P.create('Beta');
  const gate = createGate({ db, approvals: null, workdir: tmp(), log() {}, extraDirs: [dir], dirsFor: (job) => { const p = job.project && P.get(job.project); return p ? [p.dir] : null; } });
  const port = await gate.listen(0);
  try {
    const job = db.getJob(db.addJob('1', 'x', null, null, 'main', a.id)); gate.begin(job, { policy: {} }, { guard: false });
    const gen = db.getJob(db.addJob('1', 'chung')); gate.begin(gen, { policy: {} }, { guard: false });
    const ask = async (j, file) => (await (await fetch('http://127.0.0.1:' + port + '/gate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': gate.token }, body: JSON.stringify({ jobId: j.id, tool: 'Read', input: { file_path: file } }) })).json()).behavior;
    assert.equal(await ask(job, path.join(a.dir, 'TAI-LIEU', 'x.txt')), 'allow');
    assert.equal(await ask(job, path.join(b.dir, 'TAI-LIEU', 'x.txt')), 'deny', 'không sang dự án khác');
    assert.equal(await ask(job, path.join(dir, 'AgentOS', 'SO-TAY', 'x.md')), 'deny', 'không ra OneDrive chung');
    assert.equal(await ask(gen, path.join(b.dir, 'TAI-LIEU', 'x.txt')), 'allow', 'chat chung giữ quyền cũ');
  } finally { await gate.close(); }
});

function botOf(P, db, extra) {
  const jobs = []; const worker = { wake() {}, engineNames: () => ['claude', 'codex'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const bot = createBot(Object.assign({ db, worker, allowed: new Set(['111', '222']), profiles: [], isAdmin: (u) => String(u) === '111', projects: P, quietAck: true }, extra || {}));
  const say = async (uid, text) => bot.handle({ from: { id: uid }, chat: { id: uid, type: 'private' }, text });
  return { say, jobs };
}

test('Telegram /duan: tạo, vào, việc mới gắn đúng dự án, #tên hỏi một lần, /moi chỉ làm mới dự án, thoát; người thường chỉ vào dự án được gán', async () => {
  const { db, projects: P } = mk(); const { say } = botOf(P, db);
  assert.match(await say(111, '/duan'), /Chưa có dự án/);
  assert.match(await say(111, '/duan moi Kế toán 2026'), /Đã tạo.*Kế toán 2026/);
  await say(111, 'Doanh thu tháng này?'); const j1 = db.recentJobs('111', 1)[0]; assert.equal(j1.project, 'ke-toan-2026');
  assert.match(await say(111, '/duan thoat'), /về chế độ chung/); await say(111, 'chuyện chung'); assert.equal(db.recentJobs('111', 1)[0].project, null);
  await say(111, '#ke-toan-2026 so sánh với tháng trước'); const jt = db.recentJobs('111', 1)[0]; assert.equal(jt.project, 'ke-toan-2026'); assert.equal(jt.prompt, 'so sánh với tháng trước');
  await say(111, 'lại chung'); assert.equal(db.recentJobs('111', 1)[0].project, null, '#tên không đổi dự án đang đứng');
  assert.match(await say(111, '/duan Kế toán 2026'), /Đã vào dự án/);
  assert.match(await say(111, '/duan chidan Luôn trả lời bằng bảng'), /Đã đặt chỉ dẫn/); assert.match(await say(111, '/duan chidan'), /Luôn trả lời bằng bảng/);
  assert.match(await say(111, '/duan chidan them Ghi rõ nguồn'), /thêm vào/); assert.match(P.instructions('ke-toan-2026'), /Ghi rõ nguồn/);
  assert.match(await say(111, '/duan ai codex'), /ưu tiên Codex/); assert.equal(P.get('ke-toan-2026').engine, 'codex');
  assert.match(await say(111, '/duan ai khong-co'), /chưa bật/);
  // /moi trong dự án: chỉ dự án này đặt mốc mới
  const idp = db.addJob('111', 'cũ', null, null, 'main', 'ke-toan-2026'); db.claimNext(); db.finishJob(idp, 'done', { result: 'x' });
  await say(111, '/moi'); assert.equal(db.kvGet('ctxfrom:111#ke-toan-2026'), String(idp)); assert.equal(db.kvGet('ctxfrom:111'), null);
  // người thường (222): chưa được gán thì không vào/không hỏi; được gán thì vào; không tạo/xóa được
  assert.match(await say(222, '/duan Kế toán 2026'), /chưa được gán/); assert.match(await say(222, '#ke-toan-2026 xin chào'), /chưa được gán/);
  assert.match(await say(222, '/duan moi Lén'), /chỉ dành cho chủ máy/);
  assert.match(await say(111, '/duan giao 222'), /222 được dùng/); assert.match(await say(222, '/duan Kế toán 2026'), /Đã vào dự án/);
  await say(222, 'cho tôi xem số liệu'); assert.equal(db.recentJobs('222', 1)[0].project, 'ke-toan-2026');
  assert.match(await say(111, '/duan bogiao 222'), /Đã gỡ 222/); await say(222, 'còn đó không'); assert.equal(db.recentJobs('222', 1)[0].project, null, 'bị gỡ quyền thì việc về chế độ chung');
  // cất / hiện lại / xóa cần xác nhận
  assert.match(await say(111, '/duan luutru Kế toán 2026'), /Đã cất/); assert.match(await say(111, '/duan Kế toán 2026'), /đang được cất/);
  assert.match(await say(111, '/duan hienlai Kế toán 2026'), /Đã hiện lại/);
  assert.match(await say(111, '/duan xoa Kế toán 2026'), /Gõ: \/duan xoa/); assert.ok(P.get('ke-toan-2026'));
  assert.match(await say(111, '/duan xoa Kế toán 2026 co'), /thùng rác/); assert.equal(P.get('ke-toan-2026'), null);
});

test('Telegram: tệp gửi lúc đang ở dự án được chép vào TAI-LIEU và câu lệnh trỏ tới bản đó', async () => {
  const { db, projects: P } = mk(); const p = P.create('Hóa đơn'); P.setActive('111', p.id);
  const src = path.join(tmp(), 'hoadon.pdf'); fs.writeFileSync(src, 'PDF');
  const { createProjectCommands } = require('../src/projectCmd');
  const pc = createProjectCommands({ db, projects: P, isAdmin: () => true });
  const out = pc.adoptFiles('111', '111', { block: '- Tài liệu "hoadon.pdf": ' + src, files: [{ path: src, kind: 'document', name: 'hoadon.pdf' }], errors: [] });
  assert.ok(fs.existsSync(path.join(p.dir, 'TAI-LIEU', 'hoadon.pdf'))); assert.ok(out.block.includes(path.join(p.dir, 'TAI-LIEU', 'hoadon.pdf')) && !out.block.includes(src));
  P.setActive('111', null); const same = pc.adoptFiles('111', '111', { block: 'b', files: [{ path: src }] }); assert.equal(same.block, 'b');
});
