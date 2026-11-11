'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let openDb = null;
for (const m of ['../../orchestrator/node_modules/better-sqlite3', 'better-sqlite3']) { try { require(m); openDb = require('../../orchestrator/src/db').openDb; break; } catch (e) { /* thử đường kế tiếp */ } }   // Windows không có thư viện: bỏ qua các test cần cơ sở dữ liệu
const { createBotBoard } = require('../lib/botboard');
const sk = { skip: !openDb && 'thiếu better-sqlite3' };

function world() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
  const mainDir = path.join(d, 'data'), agents = path.join(d, 'agents'), mainWork = path.join(d, 'work');
  fs.mkdirSync(mainDir, { recursive: true }); fs.mkdirSync(path.join(agents, 'a1', 'data'), { recursive: true }); fs.mkdirSync(path.join(agents, 'a1', 'work', 'out'), { recursive: true });
  const chowns = [];
  const board = createBotBoard({ mainDataDir: mainDir, agentsHome: agents, mainWorkdir: mainWork, chown: (p, u) => chowns.push([p, u]) });
  return { d, mainDir, agents, mainWork, board, chowns };
}

test('bảng điều khiển: mã bot lạ bị từ chối; chưa có dữ liệu thì trả rỗng', () => {
  const w = world();
  assert.throws(() => w.board.target('../etc'), /không hợp lệ/);
  assert.throws(() => w.board.target('a1; rm'), /không hợp lệ/);
  assert.deepEqual(w.board.bots([{ id: 'a1', name: 'Bán hàng' }]).map((b) => b.key), ['main', 'a1']);
});

test('dạy bot: ghi bài học vào thư mục dữ liệu của đúng bot, chặn trùng/quá ngắn, xóa được, chuyển chủ cho bot đọc', () => {
  const w = world();
  assert.throws(() => w.board.teach('a1', 'ngắn', 1), /quá ngắn/);
  const r = w.board.teach('a1', '  Luôn   báo giá   có VAT ', 7);
  assert.equal(r.lessons.length, 1); assert.equal(r.lessons[0].text, 'Luôn báo giá có VAT'); assert.equal(r.lessons[0].fromJob, 7);
  const f = path.join(w.agents, 'a1', 'data', 'lessons.json');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).lessons.length, 1);
  assert.ok(w.chowns.some(([p, u]) => p === f && u === 'agentos-a1'));
  assert.equal(w.board.teach('a1', 'Luôn báo giá có VAT').dup, true);
  assert.equal(w.board.forget('a1', r.lessons[0].id).lessons.length, 0);
  assert.equal(fs.existsSync(path.join(w.mainDir, 'lessons.json')), false, 'không đụng bot quản lý');
});

test('điều khiển: thả tệp yêu cầu vào thư mục control của đúng bot', () => {
  const w = world();
  w.board.control('a1', { action: 'job.pause', id: 4 });
  const dir = path.join(w.agents, 'a1', 'data', 'control'), names = fs.readdirSync(dir);
  assert.equal(names.length, 1); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, names[0]), 'utf8')), { action: 'job.pause', id: 4 });
  assert.ok(w.chowns.some(([p, u]) => p === dir && u === 'agentos-a1'));
});

test('tài liệu lưu trữ: xem thư mục/tệp trong thư mục làm việc, chặn thoát ra ngoài', async () => {
  const w = world();
  const wd = path.join(w.agents, 'a1', 'work');
  fs.writeFileSync(path.join(wd, 'out', 'bao-cao.txt'), 'Xin chào'); fs.writeFileSync(path.join(wd, 'bi-mat.bin'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(w.d, 'ngoai.txt'), 'ngoài');
  const root = await w.board.archive('a1', '');
  assert.deepEqual(root.entries.map((e) => e.name), ['out', 'bi-mat.bin']);
  const f = await w.board.fileView('a1', 'out/bao-cao.txt'); assert.equal(f.kind, 'text'); assert.equal(f.text, 'Xin chào');
  assert.equal((await w.board.fileView('a1', 'bi-mat.bin')).kind, 'binary');
  assert.equal((await w.board.fileView('a1', 'out/bao-cao.txt', true)).base64, Buffer.from('Xin chào').toString('base64'));
  await assert.rejects(() => w.board.archive('a1', '../..'), /không hợp lệ/);
  await assert.rejects(() => w.board.fileView('a1', '../../ngoai.txt'), /không hợp lệ/);
});

test('danh sách + chi tiết lệnh: trạng thái, tạm dừng, điểm đánh giá, thành quả theo khung giờ, nhờ đánh giá ghi dữ liệu cho bot quản lý', sk, async () => {
  const w = world();
  const db = openDb(path.join(w.agents, 'a1', 'data', 'agentos.db'));
  const t0 = Date.now() - 60000;
  const id1 = db.addJob('5', 'Làm báo cáo tuần', null, null, 'main'); const id2 = db.addJob('5', 'Việc đang chạy', null, null, 'main');
  db.raw.prepare("UPDATE jobs SET status='done', result='Đã xong báo cáo', started_at=?, finished_at=?, engine='claude' WHERE id=?").run(t0, t0 + 30000, id1);
  db.raw.prepare("UPDATE jobs SET status='running', started_at=? WHERE id=?").run(t0, id2);
  db.kvSet('paused_job', String(id2));
  const of = path.join(w.agents, 'a1', 'work', 'out', 'ket-qua.txt'); fs.writeFileSync(of, 'tệp mới'); fs.utimesSync(of, new Date(t0 + 10000), new Date(t0 + 10000));   // trong khung giờ chạy của việc 1
  const old = path.join(w.agents, 'a1', 'work', 'out', 'cu.txt'); fs.writeFileSync(old, 'cũ'); fs.utimesSync(old, new Date(t0 - 3600000), new Date(t0 - 3600000));   // trước khi việc chạy: không tính
  db.raw.close();
  fs.writeFileSync(path.join(w.mainDir, 'x'), '');
  fs.mkdirSync(path.join(w.mainDir, 'board', 'out'), { recursive: true });
  fs.writeFileSync(path.join(w.mainDir, 'board', 'out', 'a1-' + id1 + '.json'), JSON.stringify({ at: 1, diem: 8, ketLuan: 'Tốt' }));
  const l = w.board.list('a1', {});
  assert.equal(l.jobs.length, 2); assert.equal(l.running, id2); assert.equal(l.paused, id2);
  assert.equal(l.jobs.find((j) => j.id === id2).paused, true); assert.equal(l.jobs.find((j) => j.id === id1).score, 8);
  assert.deepEqual(w.board.list('a1', { status: 'done' }).jobs.map((j) => j.id), [id1]);
  const d = await w.board.detail('a1', id1);
  assert.equal(d.job.result, 'Đã xong báo cáo'); assert.equal(d.review.diem, 8);
  assert.deepEqual(d.deliverables.outputs.map((f) => f.rel), ['out/ket-qua.txt']);
  const d2 = await w.board.detail('a1', id2); assert.equal(d2.paused, true);
  await assert.rejects(() => w.board.requestReview('a1', id2), /đang chạy/);
  await w.board.requestReview('a1', id1);
  const inp = JSON.parse(fs.readFileSync(path.join(w.mainDir, 'board', 'in', 'a1-' + id1 + '.json'), 'utf8'));
  assert.equal(inp.prompt, 'Làm báo cáo tuần'); assert.equal(inp.engine, 'claude');
  const ctl = fs.readdirSync(path.join(w.mainDir, 'control')).map((n) => JSON.parse(fs.readFileSync(path.join(w.mainDir, 'control', n), 'utf8')));
  assert.deepEqual(ctl, [{ action: 'review.run', bot: 'a1', id: id1 }]);
});
