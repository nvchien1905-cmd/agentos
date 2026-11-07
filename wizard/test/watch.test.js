'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWatch } = require('../lib/watch');
const { createJournal } = require('../../orchestrator/src/journal');
const { createTrace } = require('../../orchestrator/src/trace');
const { diffLines } = require('../../orchestrator/src/textdiff');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));

test('so sánh từng dòng: thêm/xóa/sửa, gộp đoạn dài không đổi, đánh số dòng', () => {
  const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].join('\n'), b = ['1', '2', '3', '4', '5', 'SỬA', '7', '8', '9', '10', '11', '12', '13'].join('\n');
  const d = diffLines(a, b);
  assert.equal(d.add, 2); assert.equal(d.del, 1); assert.equal(d.truncated, false);
  assert.deepEqual(d.rows.filter((r) => r.t === 'del').map((r) => [r.text, r.a]), [['6', 6]]);
  assert.deepEqual(d.rows.filter((r) => r.t === 'add').map((r) => [r.text, r.b]), [['SỬA', 6], ['13', 13]]);
  assert.ok(d.rows.some((r) => r.t === 'skip'), 'đoạn dài giống nhau được gộp (đầu: dòng 1–2 bị gộp)');
  assert.deepEqual(diffLines('a\nb', 'a\nb').rows.map((r) => r.t), ['skip'], 'giống hệt: gộp thành "2 dòng không đổi"');
  assert.equal(diffLines('', 'x\ny').add, 2); assert.equal(diffLines('x\r\ny', 'x\ny').add, 0, 'CRLF không phải thay đổi');
  assert.equal(diffLines('x', '').del, 1);
});

test('màn hình AI: tệp đã đổi (mới tạo / sửa / xóa) kèm khác biệt; tệp nhị phân và quá lớn chỉ ghi chú; chỉ đổi giờ sửa thì bỏ qua', async () => {
  const root = tmp(), work = path.join(root, 'w'), jd = path.join(root, 'journal'), td = path.join(root, 'trace'); fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'gia.txt'), 'dòng 1\ndòng 2\ndòng 3\n'); fs.writeFileSync(path.join(work, 'xoa.md'), 'sắp xóa\n'); fs.writeFileSync(path.join(work, 'anh.bin'), Buffer.from([0, 1, 2, 3])); fs.writeFileSync(path.join(work, 'giu.txt'), 'giữ');
  const j = createJournal({ dir: jd, cwdOf: () => work });
  const job = { id: 31, prompt: 'thử' };
  await j.before(job, 'Write', { file_path: path.join(work, 'gia.txt') });
  await j.before(job, 'Write', { file_path: path.join(work, 'moi.txt') });
  await j.before(job, 'Bash', { command: 'rm xoa.md' });
  await j.before(job, 'Write', { file_path: path.join(work, 'anh.bin') });
  await j.before(job, 'Write', { file_path: path.join(work, 'giu.txt') });
  fs.writeFileSync(path.join(work, 'gia.txt'), 'dòng 1\ndòng HAI\ndòng 3\ndòng 4\n'); fs.writeFileSync(path.join(work, 'moi.txt'), 'tệp mới\nhai dòng\n'); fs.rmSync(path.join(work, 'xoa.md'));
  fs.writeFileSync(path.join(work, 'anh.bin'), Buffer.from([9, 0, 9])); fs.utimesSync(path.join(work, 'giu.txt'), new Date(), new Date(Date.now() + 5000));
  const w = createWatch({ traceDir: td, journalDir: jd, projects: { get: () => ({ dir: work }) } });
  const c = await w.changes(31);
  assert.equal(c.exists, true);
  const by = Object.fromEntries(c.files.map((f) => [path.basename(f.p), f]));
  assert.equal(by['gia.txt'].status, 'modified'); assert.equal(by['gia.txt'].add, 2); assert.equal(by['gia.txt'].del, 1);
  assert.ok(by['gia.txt'].rows.some((r) => r.t === 'del' && r.text === 'dòng 2') && by['gia.txt'].rows.some((r) => r.t === 'add' && r.text === 'dòng HAI'));
  assert.equal(by['moi.txt'].status, 'created'); assert.equal(by['moi.txt'].add, 2);
  assert.equal(by['xoa.md'].status, 'deleted'); assert.equal(by['xoa.md'].del, 1); assert.equal(by['xoa.md'].add, 0);
  assert.equal(by['anh.bin'].status, 'modified'); assert.match(by['anh.bin'].note, /không phải chữ/); assert.equal(by['anh.bin'].rows, undefined);
  assert.equal(by['giu.txt'], undefined, 'chỉ đổi giờ sửa, nội dung y hệt → không liệt kê');
  assert.equal((await w.changes(999)).exists, false);
});

test('màn hình AI: dấu vết đọc qua API; duyệt tệp dự án chỉ đọc, chặn .. và liên kết trỏ ra ngoài, xem trước chữ/ảnh/html', async () => {
  const root = tmp(), work = path.join(root, 'w'), outside = path.join(root, 'ngoai'); fs.mkdirSync(path.join(work, 'con'), { recursive: true }); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(work, 'a.txt'), 'xin chào'); fs.writeFileSync(path.join(work, 'con', 'b.html'), '<h1>Báo cáo</h1>'); fs.writeFileSync(path.join(work, 'x.png'), Buffer.from('89504e470d0a1a0a', 'hex')); fs.writeFileSync(path.join(work, 'bin.dat'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(outside, 'mat.txt'), 'BÍ MẬT'); try { fs.symlinkSync(outside, path.join(work, 'lk')); } catch (e) { /* hệ thống không cho liên kết */ }
  const tr = createTrace({ dir: path.join(root, 't') }); tr.begin({ id: 5, chat_id: 1, prompt: 'x' }); tr.step({ id: 5 }, { kind: 'tool', name: 'Read', input: { file_path: '/a' } });
  const w = createWatch({ traceDir: path.join(root, 't'), journalDir: path.join(root, 'j'), projects: { get: (id) => (id === 'p1' ? { dir: work } : null) } });
  const t = await w.trace(5, 0); assert.equal(t.events.length, 2); assert.equal((await w.trace(5, 1)).events.length, 1);
  const tree = await w.tree('p1', ''); assert.deepEqual(tree.entries.filter((e) => e.dir).map((e) => e.name).sort().slice(0, 1), ['con']); assert.ok(tree.entries.find((e) => e.name === 'a.txt'));
  assert.equal(tree.entries[0].dir, true, 'thư mục trước');
  assert.equal((await w.file('p1', 'a.txt')).text, 'xin chào');
  assert.equal((await w.file('p1', 'con/b.html')).kind, 'html'); assert.equal((await w.file('p1', 'x.png')).kind, 'image'); assert.match((await w.file('p1', 'x.png')).dataUrl, /^data:image\/png;base64,/);
  assert.equal((await w.file('p1', 'bin.dat')).kind, 'binary');
  await assert.rejects(() => w.file('p1', '../ngoai/mat.txt'), /không hợp lệ|ngoài/);
  await assert.rejects(() => w.file('p1', '/etc/passwd'), /không hợp lệ/);
  await assert.rejects(() => w.tree('p1', 'con/../../ngoai'), /không hợp lệ/);
  await assert.rejects(() => w.file('khac', 'a.txt'), /Không có dự án/);
  if (fs.existsSync(path.join(work, 'lk'))) { await assert.rejects(() => w.file('p1', 'lk/mat.txt'), /Liên kết/); await assert.rejects(() => w.tree('p1', 'lk'), /Liên kết/); }
  const small = createWatch({ traceDir: path.join(root, 't'), journalDir: path.join(root, 'j'), projects: { get: () => ({ dir: work }) }, limits: { textPreview: 4 } });
  const cut = await small.file('x', 'a.txt'); assert.equal(cut.cut, true); assert.equal(cut.text.length <= 6, true);
});
