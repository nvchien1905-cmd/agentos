'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOutbox, convDir } = require('../src/outbox');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t || 'x'); };

test('hộp thư ra theo CUỘC TRÒ CHUYỆN: hai dự án chạy song song trong cùng một ID không nhận nhầm/gửi trùng tệp của nhau; không dự án → _chung; tên lạ được làm sạch', () => {
  const out = tmp();
  const A = { id: 1, chat_id: '111', project: 'ke-toan', started_at: 0 }, B = { id: 2, chat_id: '111', project: 'kho-hang', started_at: 0 }, C = { id: 3, chat_id: '111', project: null }, D = { id: 4, chat_id: '222', project: 'ke-toan' };
  assert.equal(convDir(out, A), path.join(out, '111', 'ke-toan')); assert.equal(convDir(out, C), path.join(out, '111', '_chung'));
  assert.equal(convDir(out, { chat_id: '1/../2', project: '../x y' }), path.join(out, '1_.._2', '.._x_y'), 'không thoát khỏi thư mục ra');
  assert.ok(convDir(out, { chat_id: '1/../2', project: '../x y' }).startsWith(out + path.sep));
  put(path.join(convDir(out, A), 'bao-cao-ke-toan.pdf')); put(path.join(convDir(out, A), 'browser', 'anh-a.png'));
  put(path.join(convDir(out, B), 'ton-kho.xlsx')); put(path.join(convDir(out, C), 'chung.png')); put(path.join(convDir(out, D), 'cua-222.png'));
  const box = createOutbox(out, null, (chatId, job) => convDir(out, job));
  assert.deepEqual(box(0, A).map((f) => f.name).sort(), ['anh-a.png', 'bao-cao-ke-toan.pdf']);
  assert.deepEqual(box(0, B).map((f) => f.name), ['ton-kho.xlsx']);
  assert.deepEqual(box(0, C).map((f) => f.name), ['chung.png']); assert.deepEqual(box(0, D).map((f) => f.name), ['cua-222.png']);
  assert.deepEqual(box(0, { id: 9, chat_id: '111', project: 'chua-co' }), [], 'cuộc chưa có tệp nào');
  put(path.join(out, '111', 'rac-o-goc.png'));                                     // tệp rơi ở thư mục của ID (cũ): không cuộc nào nhận
  for (const j of [A, B, C]) assert.ok(!box(0, j).some((f) => f.name === 'rac-o-goc.png'));
});
