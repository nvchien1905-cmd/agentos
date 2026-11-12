'use strict';
// db.search chạy ĐỒNG BỘ trước mỗi việc để nhớ lại việc cũ: phải nhanh dù lịch sử dài và từ khóa phổ biến (trước đây 9 giây ở 10.000 việc, hơn 1 phút ở 30.000 → đơ cả bot).
const test = require('node:test');
const assert = require('node:assert/strict');
let Database = null; try { Database = require('better-sqlite3'); } catch (e) { /* Windows dev */ }
const dbTest = (name, fn) => test(name, { skip: !Database && 'thiếu better-sqlite3' }, fn);

dbTest('db.search: tìm đúng việc liên quan giữa rất nhiều việc nhiễu, đúng chat/dự án, bỏ việc lỗi/đã loại trừ/cũ hơn mốc, xếp theo độ liên quan', () => {
  const { openDb } = require('../src/db'); const db = openDb(':memory:');
  const noise = ['gia bao nhieu hom nay', 'khong con hang cho khach', 'ban cho khach nay duoc khong', 'nhap hang ve kho hom nay'];
  db.raw.exec('BEGIN');
  for (let i = 0; i < 3000; i++) { const id = db.addJob('7', noise[i % 4] + ' so ' + i, null, null, 'main', null); db.finishJob(id, 'done', { result: noise[(i + 1) % 4] }); }
  db.raw.exec('COMMIT');
  const target = db.addJob('7', 'Bảo hành nồi chiên Sunhouse bao lâu', null, null, 'main', null); db.finishJob(target, 'done', { result: 'Nồi chiên Sunhouse bảo hành 12 tháng tại cửa hàng' });
  const half = db.addJob('7', 'Nồi cơm điện giá bao nhiêu', null, null, 'main', null); db.finishJob(half, 'done', { result: 'Nồi cơm 1,2 triệu' });
  const other = db.addJob('8', 'Bảo hành nồi chiên Sunhouse', null, null, 'main', null); db.finishJob(other, 'done', { result: 'chat khác' });
  const inProj = db.addJob('7', 'Bảo hành nồi chiên Sunhouse trong dự án', null, null, 'main', 'duan1'); db.finishJob(inProj, 'done', { result: 'dự án' });
  const failed = db.addJob('7', 'Bảo hành nồi chiên Sunhouse bị lỗi', null, null, 'main', null); db.finishJob(failed, 'error', { error: 'x' });
  const t0 = Date.now();
  let r = db.search('7', 'cho em hỏi bảo hành nồi chiên Sunhouse bao nhiêu lâu', 3, 0, []);
  assert.ok(Date.now() - t0 < 500, 'phải nhanh: ' + (Date.now() - t0) + ' ms');
  assert.equal(r[0].id, target, 'việc liên quan nhất đứng đầu');
  assert.ok(r.every((x) => ![other, inProj, failed].includes(x.id)), 'không lẫn chat khác / dự án khác / việc lỗi');
  assert.ok(r.length <= 3);
  r = db.search('7', 'bảo hành nồi chiên Sunhouse', 3, 0, [target]); assert.ok(!r.some((x) => x.id === target), 'bỏ việc đã loại trừ');
  r = db.search('7', 'bảo hành nồi chiên Sunhouse', 3, target, []); assert.ok(r.every((x) => x.id > target), 'chỉ việc mới hơn mốc (sau /moi)');
  r = db.search('7#duan1', 'bảo hành nồi chiên Sunhouse', 3, 0, []); assert.deepEqual(r.map((x) => x.id), [inProj]);
  assert.deepEqual(db.search('7', 'xin chào', 3, 0, []), []);               // từ quá ngắn / không có việc khớp
  assert.deepEqual(db.search('7', '', 3, 0, []), []);
  assert.deepEqual(db.search('9', 'bảo hành nồi chiên', 3, 0, []), []);
});

dbTest('db.search: từ khóa rất phổ biến trên lịch sử dài vẫn trả lời trong chớp mắt (không phụ thuộc số việc)', () => {
  const { openDb } = require('../src/db'); const db = openDb(':memory:');
  db.raw.exec('BEGIN');
  for (let i = 0; i < 12000; i++) { const id = db.addJob('7', 'gia ban khong hang cho khach nay ' + i, null, null, 'main', null); db.finishJob(id, 'done', { result: 'gia ban khong con hang cho khach ' + (i % 50) }); }
  db.raw.exec('COMMIT');
  const t0 = Date.now(); const r = db.search('7', 'giá bán không còn hàng cho khách này', 3, 0, [1, 2, 3]); const ms = Date.now() - t0;
  assert.equal(r.length, 3); assert.ok(ms < 300, 'mất ' + ms + ' ms');
});
