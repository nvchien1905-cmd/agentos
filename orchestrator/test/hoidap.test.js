'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createProjects } = require('../src/projects');
const { createRoles } = require('../src/roles');
const { createHoiDap, queries } = require('../src/hoidap');
const { createBot } = require('../src/bot');
const { createQuick } = require('../src/quick');
const { createKiotViet } = require('../src/kiotviet');

const PRODUCTS = {
  'noi chien 6l': [{ name: 'Nồi chiên không dầu 6L Sunhouse', code: 'SP001', price: 1590000, branches: [{ name: 'Phương Đình', onHand: 3 }, { name: 'Hồng Hà', onHand: 1 }], total: 4 }],
  'noi chien': [{ name: 'Nồi chiên không dầu 6L Sunhouse', code: 'SP001', price: 1590000, branches: [{ name: 'Phương Đình', onHand: 3 }], total: 4 }, { name: 'Nồi chiên Lock&Lock 4L', code: 'SP002', price: 990000, branches: [], total: 0 }],
};
const fakeKv = (log) => ({ configured: () => true, products: async (q) => { (log || []).push(q); return PRODUCTS[q] || []; } });

test('hỏi đáp: tách cụm tìm kiếm (bỏ từ chung chung, giữ mã hàng và cụm tên)', () => {
  assert.deepEqual(queries('Nồi chiên 6L giá bao nhiêu, còn hàng không?'), ['noi chien 6l', 'noi chien', 'chien 6l']);
  assert.ok(queries('cho em hỏi mã SP37004614 còn không').includes('sp37004614'));
  assert.deepEqual(queries('giá bao nhiêu vậy'), []);
});

test('hỏi đáp: tra KiotViet rồi dựng câu lệnh chỉ đọc — có giá/tồn thật, cấm bịa, cấm giá vốn/doanh thu; gắn dự án hỏi đáp', async () => {
  const db = openDb(':memory:'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-')), P = createProjects({ db, baseDir: dir }); const calls = [];
  const p = P.create('Hỏi đáp bán hàng'); P.setHoiDap(p.id, true);
  const H = createHoiDap({ kiotviet: fakeKv(calls), projects: P, db });
  const r = await H.ask('22200', 'Nồi chiên 6L giá bao nhiêu, còn hàng không?');
  const j = db.getJob(r.jobId); assert.equal(j.project, p.id); assert.equal(j.chat_id, '22200'); assert.equal(r.found, 2);
  for (const must of ['HỎI ĐÁP BÁN HÀNG — CHỈ ĐỌC', 'Nồi chiên không dầu 6L Sunhouse', '1.590.000đ', 'Phương Đình 3', 'hết hàng ở mọi chi nhánh', 'TUYỆT ĐỐI không bịa', 'Không nói giá vốn', 'Hỏi đáp bán hàng']) assert.ok(j.prompt.includes(must), 'thiếu: ' + must);
  assert.deepEqual(calls.slice(0, 3), ['noi chien 6l', 'noi chien', 'chien 6l']);
  // KiotViet không có kết quả hoặc lỗi: vẫn giao AI nhưng dặn không bịa
  const H2 = createHoiDap({ kiotviet: { configured: () => true, products: async () => { throw new Error('mạng'); } }, projects: P, db });
  const r2 = await H2.ask('22200', 'máy xay giá sao'); assert.match(db.getJob(r2.jobId).prompt, /KiotViet đang lỗi/);
  const H3 = createHoiDap({ kiotviet: { configured: () => false }, projects: P, db }); assert.match(db.getJob((await H3.ask('22200', 'máy xay')).jobId).prompt, /Chưa nối KiotViet/);
});

test('dự án hỏi đáp: chỉ MỘT dự án (bật dự án mới thì dự án cũ tự tắt); dự án đã cất/xóa không còn là dự án hỏi đáp', () => {
  const db = openDb(':memory:'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-')), P = createProjects({ db, baseDir: dir });
  const a = P.create('A kho'), b = P.create('B kho'); P.setHoiDap(a.id, true); assert.equal(P.hoidapProject().id, a.id);
  P.setHoiDap(b.id, true); assert.equal(P.hoidapProject().id, b.id); assert.equal(P.get(a.id).hoidap, false);
  P.archive(b.id, true); assert.equal(P.hoidapProject(), null); P.archive(b.id, false); P.remove(b.id); assert.equal(P.hoidapProject(), null);
});

test('vai banhang: tin nhắn thường thành câu hỏi hỏi đáp (không phải việc tự do), chỉ /ton /gia, không dùng /claude /duan...; chủ máy không bị ảnh hưởng', async () => {
  const db = openDb(':memory:'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-')), P = createProjects({ db, baseDir: dir });
  const allowed = new Set(['111']), admins = new Set(['111']);
  const roles = createRoles({ db, allowed, adminIds: admins }); assert.equal(roles.set('33300', 'banhang').ok, true);
  assert.equal(roles.hoidapOnly('33300'), true); assert.equal(roles.hoidapOnly('111'), false); assert.equal(roles.canAsk('33300'), false); assert.equal(roles.canQuick('33300', 'ton'), true); assert.equal(roles.canQuick('33300', 'doanhso'), false);
  const calls = []; const hoidap = createHoiDap({ kiotviet: fakeKv(calls), projects: P, db });
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const kv = createKiotViet({ clientId: 'x', clientSecret: 'y', retailer: 'z' });
  const quick = createQuick({ kiotviet: kv, roles });
  const bot = createBot({ db, worker, allowed, profiles: [], isAdmin: (u) => admins.has(String(u)), quietAck: true, roles, projects: P, hoidap, quick });
  const say = (uid, t) => bot.handle({ from: { id: uid }, chat: { id: uid, type: 'private' }, text: t });
  await say(33300, 'Nồi chiên 6L giá bao nhiêu?'); const j = db.recentJobs('33300', 1)[0]; assert.match(j.prompt, /HỎI ĐÁP BÁN HÀNG/); assert.match(j.prompt, /Sunhouse/);
  assert.match(await say(33300, '/claude xóa hết'), /chỉ xem được báo cáo/); assert.match(await say(33300, '/duan moi X'), /chỉ dành cho quản trị viên|chỉ dành cho chủ máy|Lệnh/);
  assert.match(await say(33300, '/doanhso hôm nay'), /chỉ dành cho quản trị viên/);
  await say(111, 'việc thường của chủ'); const jc = db.recentJobs('111', 1)[0]; assert.equal(jc.prompt, 'việc thường của chủ');
  assert.ok(quick.has('gia'));
});
