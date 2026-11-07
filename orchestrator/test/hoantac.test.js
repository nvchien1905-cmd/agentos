'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProjects } = require('../src/projects');
const { createBot } = require('../src/bot');
const { createCheckpoints } = require('../src/checkpoints');
const openDb = (f) => require('../src/db').openDb(f);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ht-'));
const ADMIN = '111', A = '222';
const isAdmin = (u) => String(u) === ADMIN;

function env(withCk) {
  const db = openDb(':memory:'); let t = Date.parse('2026-11-07T10:00:00+07:00');
  const P = createProjects({ db, baseDir: tmp(), now: () => t });
  const ck = createCheckpoints({ dir: tmp(), now: () => (t += 1000), limits: { keep: 5 } });
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => true };
  const sent = [];
  const bot = createBot({ db, worker, allowed: new Set([ADMIN, A]), profiles: [], isAdmin, projects: P, approvals: { pendingJobIds: () => new Set(), cancelJob() {} }, quietAck: true, now: () => t, send: async (c, r) => { sent.push(r); }, checkpoints: withCk === false ? null : ck });
  const say = async (uid, text) => bot.handle({ from: { id: uid }, chat: { id: uid, type: 'private' }, text });
  const press = async (uid, data) => bot.handleCallback({ id: 'cb', data, from: { id: uid }, message: { chat: { id: uid } } });
  return { db, P, ck, say, press, sent };
}
const write = (p, rel, text) => { const f = path.join(p.dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const read = (p, rel) => fs.readFileSync(path.join(p.dir, rel), 'utf8');

test('/hoantac: chưa có dự án / chưa có mốc / máy không hỗ trợ → báo rõ ràng, không lỗi', async () => {
  const E = env();
  assert.match(await E.say(ADMIN, '/hoantac'), /chưa có mốc nào/, 'chưa chọn dự án: dùng dự án tổng của chính mình');
  await E.say(ADMIN, '/moi Kế toán'); await E.say(ADMIN, 'Kế toán');
  assert.match(await E.say(ADMIN, '/hoantac'), /chưa có mốc nào/);
  assert.match(await env(false).say(ADMIN, '/hoantac'), /chưa hỗ trợ|chế độ chung/);
});

test('/hoantac: thẻ mốc → xem AI đã đổi gì → quay về → tệp về như cũ; quay về là mốc mới nên hoàn tác được', async () => {
  const E = env();
  await E.say(ADMIN, '/moi Kế toán'); await E.say(ADMIN, 'Kế toán');
  const p = E.P.active(ADMIN); E.P.ensureDirs(p);
  write(p, 'bang-gia.txt', 'giá đúng'); write(p, 'ghi-chu.md', 'ghi chú');
  const s1 = await E.ck.snapshot(p.id, p.dir, { label: 'trước việc #7: sửa bảng giá', jobId: 7 });
  write(p, 'bang-gia.txt', 'AI làm hỏng'); write(p, 'rac.txt', 'tệp AI tạo'); fs.rmSync(path.join(p.dir, 'ghi-chu.md'));
  const card = await E.say(ADMIN, '/hoantac');
  assert.match(card.text, /Mốc khôi phục của Kế toán/); assert.match(card.text, /1\) .*trước việc #7: sửa bảng giá · \d+ tệp/);
  assert.deepEqual(card.buttons.flat().map((b) => b.data), ['pj:ck:show:' + s1.id]);
  assert.equal(await E.press(ADMIN, 'pj:ck:show:' + s1.id), '');
  const view = E.sent[E.sent.length - 1];
  assert.match(view.text, /✏️ 1 tệp đã bị sửa[\s\S]*bang-gia\.txt/); assert.match(view.text, /➕ 1 tệp mới tạo sau mốc[\s\S]*rac\.txt/); assert.match(view.text, /➖ 1 tệp đã bị xóa[\s\S]*ghi-chu\.md/);
  assert.deepEqual(view.buttons.flat().map((b) => b.data), ['pj:ck:do:' + s1.id, 'pj:ck:no']);
  assert.equal(await E.press(ADMIN, 'pj:ck:no'), 'Thôi, giữ nguyên.'); assert.equal(read(p, 'bang-gia.txt'), 'AI làm hỏng');
  assert.equal(await E.press(ADMIN, 'pj:ck:do:' + s1.id), 'Đã quay về');
  assert.match(String(E.sent[E.sent.length - 1]), /Đã quay về mốc[\s\S]*khôi phục 2 tệp/);
  assert.equal(read(p, 'bang-gia.txt'), 'giá đúng'); assert.equal(read(p, 'ghi-chu.md'), 'ghi chú');
  const list = await E.ck.list(p.id); assert.equal(list[0].label, 'Trước khi khôi phục');
  assert.equal(await E.press(ADMIN, 'pj:ck:do:' + list[0].id), 'Đã quay về'); assert.equal(read(p, 'bang-gia.txt'), 'AI làm hỏng');
  assert.equal(await E.press(ADMIN, 'pj:ck:show:khong-co'), 'Mốc này không còn (đã quá 5 mốc gần nhất).');
});

test('/hoantac: giống nhau thì báo "không cần"; đang có việc chạy trong cuộc này thì từ chối; ID khác không đụng được dự án của người khác', async () => {
  const E = env();
  await E.say(ADMIN, '/moi Kho'); await E.say(ADMIN, 'Kho');
  const p = E.P.active(ADMIN); E.P.ensureDirs(p); write(p, 'a.txt', '1');
  const s1 = await E.ck.snapshot(p.id, p.dir, { label: 'v1' });
  assert.equal(await E.press(ADMIN, 'pj:ck:show:' + s1.id), ''); assert.match(String(E.sent[E.sent.length - 1]), /không có gì khác so với bây giờ/);
  write(p, 'a.txt', '2');
  E.db.addJob(ADMIN, 'đang làm dở', null, null, 'main', p.id); const ran = []; for (let x; (x = E.db.claimNext());) ran.push(x.id);          // có việc đang chạy trong cuộc này
  assert.match(await E.press(ADMIN, 'pj:ck:do:' + s1.id), /Đang có việc chạy/); assert.equal(read(p, 'a.txt'), '2', 'đang chạy: không ghi đè');
  for (const id of ran) E.db.finishJob(id, 'done', { result: 'xong' });
  assert.equal(await E.press(ADMIN, 'pj:ck:do:' + s1.id), 'Đã quay về'); assert.equal(read(p, 'a.txt'), '1');
  // ID thường chưa vào dự án nào: không thấy/không đụng được mốc của chủ máy, kể cả đoán đúng mã mốc
  assert.match(await E.say(A, '/hoantac'), /chưa có mốc nào/, 'ID thường chỉ thấy dự án tổng của chính mình (trống), không thấy mốc của chủ máy');
  assert.equal(await E.press(A, 'pj:ck:do:' + s1.id), 'Mốc này không còn (đã quá 5 mốc gần nhất).', 'đoán đúng mã mốc của người khác cũng không dùng được'); assert.equal(read(p, 'a.txt'), '1');
  // ID thường có dự án riêng: chỉ thấy mốc của dự án đó (mốc của dự án chủ máy không lẫn sang)
  await E.say(A, '/moi Việc riêng'); await E.say(A, 'Việc riêng');
  assert.match(await E.say(A, '/hoantac'), /chưa có mốc nào/);
  assert.equal(await E.press(A, 'pj:ck:do:' + s1.id), 'Mốc này không còn (đã quá 5 mốc gần nhất).', 'mã mốc của dự án khác không dùng được');
});
