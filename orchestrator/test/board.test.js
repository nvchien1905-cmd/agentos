'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLessons } = require('../src/lessons');
const { createJobReview, extractJson, clean } = require('../src/jobreview');
const { createControl, ACTIONS } = require('../src/control');
const { runProcess } = require('../src/engines/proc');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bd-'));

test('bài học chủ máy dạy: đọc lại khi tệp đổi, ghép thành lời dặn đầu lệnh, bỏ mục rỗng', () => {
  const d = tmp(), f = path.join(d, 'lessons.json');
  const L = createLessons({ file: f });
  assert.equal(L.text(), '');                                              // chưa có tệp
  fs.writeFileSync(f, JSON.stringify({ lessons: [{ id: 'a', text: 'Luôn báo giá có VAT' }, { id: 'b', text: '   ' }, { id: 'c', text: 'Trả lời ngắn' }] }));
  assert.match(L.text(), /1\. Luôn báo giá có VAT\n2\. Trả lời ngắn/); assert.equal(L.list().length, 2);
  fs.writeFileSync(f, JSON.stringify({ lessons: [{ id: 'd', text: 'Điều mới' }] })); fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.match(L.text(), /1\. Điều mới/); assert.doesNotMatch(L.text(), /VAT/);
  fs.writeFileSync(f, '{hỏng'); fs.utimesSync(f, new Date(), new Date(Date.now() + 9000));
  assert.equal(L.text(), '');
});

test('đánh giá lệnh: đọc dữ liệu, nhờ AI KHÁC AI đã làm, ghi kết quả đã làm sạch; AI trả sai dạng hoặc lỗi thì ghi lỗi rõ', async () => {
  const d = tmp(); fs.mkdirSync(path.join(d, 'in'), { recursive: true });
  fs.writeFileSync(path.join(d, 'in', 'a1-7.json'), JSON.stringify({ prompt: 'Làm báo cáo', result: 'Xong', status: 'done', engine: 'claude', secs: 12, stepCount: 3, steps: 'Read: a.txt' }));
  let seen = null;
  const R = createJobReview({ dir: d, ask: async (sys, user, avoid) => { seen = { sys, user, avoid }; return { via: 'codex', text: 'Đây:\n{"diem": 12, "ketLuan":"Ổn", "daLam":["a"], "vanDe":[], "cachTotHon":["Dùng 1 lệnh"], "baiHoc":"Gộp lệnh"} hết' }; } });
  assert.equal(await R.run('a1', 7), true);
  assert.equal(seen.avoid, 'claude'); assert.match(seen.user, /Làm báo cáo/); assert.match(seen.user, /Read: a\.txt/);
  const out = JSON.parse(fs.readFileSync(R.outFile('a1', 7), 'utf8'));
  assert.equal(out.diem, 10, 'điểm bị kẹp 1-10'); assert.equal(out.by, 'codex'); assert.equal(out.baiHoc, 'Gộp lệnh'); assert.deepEqual(out.cachTotHon, ['Dùng 1 lệnh']);
  const bad = createJobReview({ dir: d, ask: async () => ({ via: 'x', text: 'không phải JSON' }) });
  assert.equal(await bad.run('a1', 7), false); assert.match(JSON.parse(fs.readFileSync(bad.outFile('a1', 7), 'utf8')).error, /không đúng dạng/);
  const err = createJobReview({ dir: d, ask: async () => { throw new Error('hết hạn mức'); } });
  assert.equal(await err.run('a1', 7), false); assert.match(JSON.parse(fs.readFileSync(err.outFile('a1', 7), 'utf8')).error, /hết hạn mức/);
  assert.equal(await err.run('a1', 99), false, 'không có dữ liệu đầu vào');
  assert.equal(extractJson('xx'), null); assert.equal(clean(null), null);
});

test('điều khiển: tạm dừng / tiếp tục chỉ nhận mã việc, nhờ đánh giá chỉ nhận mã bot hợp lệ', () => {
  assert.ok(ACTIONS.includes('job.pause') && ACTIONS.includes('job.resume') && ACTIONS.includes('review.run'));
  const calls = [];
  const worker = { pauseJob: (id) => { calls.push(['pause', id]); return true; }, resumeJob: (id) => { calls.push(['resume', id]); return true; } };
  const review = { run: async (bot, id) => { calls.push(['review', bot, id]); } };
  const C = createControl({ dir: tmp(), db: {}, worker, review });
  assert.equal(C.apply({ action: 'job.pause', id: 5 }), true); assert.equal(C.apply({ action: 'job.resume', id: 5 }), true);
  assert.equal(C.apply({ action: 'job.pause', id: 'x' }), false);
  assert.equal(C.apply({ action: 'review.run', bot: 'a1', id: 5 }), true); assert.equal(C.apply({ action: 'review.run', bot: '../x', id: 5 }), false);
  assert.deepEqual(calls, [['pause', 5], ['resume', 5], ['review', 'a1', 5]]);
});

test('tạm dừng tiến trình AI: đóng băng thì không bị cắt vì quá giờ, tiếp tục thì chạy nốt (chỉ Linux)', { skip: process.platform === 'win32' }, async () => {
  const p = runProcess({ bin: 'sh', args: ['-c', 'sleep 1; echo xong'], timeoutMs: 2500 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(p.pause(), true); assert.equal(p.pause(), false, 'đã tạm dừng rồi');
  await new Promise((r) => setTimeout(r, 3000));                           // lâu hơn timeoutMs: nếu còn tính giờ sẽ bị cắt
  assert.equal(p.resume(), true);
  const r = await p.done;
  assert.equal(r.killedBy, null); assert.match(r.out, /xong/);
});
