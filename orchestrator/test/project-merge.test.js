'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const openDb = (f) => require('../src/db').openDb(f);          // nạp muộn: các test không cần SQLite vẫn chạy được trên máy không có better-sqlite3
const { createProjects } = require('../src/projects');
const { createBook } = require('../src/book');
const { mergeProjects } = require('../src/projectMerge');
const { createMemory } = require('../src/memory');
const { createBot } = require('../src/bot');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gop-'));
const T0 = Date.parse('2026-11-06T10:00:00+07:00');
function setup(withDb) {
  const dir = tmp(); let t = T0;
  const db = withDb ? openDb(':memory:') : undefined;
  const P = createProjects({ db, baseDir: dir, now: () => (t += 1000) });
  return { dir, db, P };
}
const bookOf = (P, id, extra) => createBook(Object.assign({ rootDir: P.bookDir(id), now: () => T0 }, extra || {}));

test('gộp dự án: sổ tay đổ vào dự án đích (cùng chương gom, trùng ý thay), chỉ dẫn nối, tệp chuyển không ghi đè, lịch + người dùng gộp, nguồn được cất; đích chờ AI sắp xếp', () => {
  const { P } = setup(false);
  const a = P.create('Cuộc A', '111'), b = P.create('Cuộc B', '111');
  bookOf(P, a.id).put('Hàng hóa', 'Nồi chiên Thaitech giá 1.290.000đ');
  bookOf(P, a.id).put('Máy văn phòng', 'Máy văn phòng điều khiển bằng RustDesk');
  bookOf(P, b.id).put('Hàng hóa', 'Nồi chiên Thaitech giá 1.290.000đ');                    // trùng hệt
  bookOf(P, b.id).put('Hàng hóa', 'Bếp từ Yoake hết hàng');
  P.setInstructions(a.id, '# Chỉ dẫn dự án: A\n\nLuôn trả lời bằng bảng');
  fs.writeFileSync(path.join(P.dirOf(a.id), 'TAI-LIEU', 'bang-gia.txt'), 'A'); fs.writeFileSync(path.join(P.dirOf(b.id), 'TAI-LIEU', 'bang-gia.txt'), 'B');
  P.addSchedule(a.id, { time: '08:00', days: [], text: 'báo cáo doanh số' });
  P.setUsers(a.id, ['222']);
  const r = mergeProjects({ projects: P, ids: [a.id], into: b.id, now: () => T0 });
  assert.equal(r.target, b.id); assert.deepEqual(r.merged, [a.id]); assert.equal(r.files, 1); assert.equal(r.schedules, 1);
  const tb = bookOf(P, b.id);
  assert.deepEqual(tb.list().map((c) => c.title).sort(), ['Hàng hóa', 'Máy văn phòng']);
  assert.equal(tb.get('hang-hoa').entries.length, 2);                                       // trùng hệt chỉ còn một
  assert.match(P.rawInstructions(b.id), /Gộp từ dự án "Cuộc A"[\s\S]*Luôn trả lời bằng bảng/);
  const files = fs.readdirSync(path.join(P.dirOf(b.id), 'TAI-LIEU')).sort();
  assert.equal(files.length, 2); assert.ok(files.some((f) => /từ cuoc-a/.test(f)), files.join());
  assert.equal(P.get(b.id).schedule.length, 1); assert.deepEqual(P.get(b.id).users, ['222']);
  const src = P.get(a.id); assert.equal(src.archived, true); assert.equal(src.mergedInto, b.id);
  assert.ok(fs.existsSync(path.join(P.bookDir(a.id), 'MUC-LUC.md')) || fs.readdirSync(P.bookDir(a.id)).length > 0, 'thư mục gốc của dự án nguồn vẫn còn');
  assert.deepEqual(P.pending().map((p) => p.id), [b.id]); assert.deepEqual(P.get(b.id).pendingOrganize.from, [a.id]);
  assert.throws(() => mergeProjects({ projects: P, ids: [], into: b.id }), /Chưa chọn/);
  assert.throws(() => mergeProjects({ projects: P, ids: [b.id], into: b.id }), /ít nhất một dự án khác/);
  assert.throws(() => mergeProjects({ projects: P, ids: [a.id], into: '' }), /Đặt tên/);
});

test('gộp thành dự án MỚI từ nhiều dự án', () => {
  const { P } = setup(false);
  const a = P.create('Một', '111'), b = P.create('Hai', '111');
  bookOf(P, a.id).put('Giờ mở cửa', 'Mở cửa 8 giờ sáng'); bookOf(P, b.id).put('Khách quen', 'Khách Lan hay mua nồi chiên');
  const r = mergeProjects({ projects: P, ids: [a.id, b.id], name: 'Gộp chung', now: () => T0 });
  const t = P.get(r.target); assert.equal(t.name, 'Gộp chung'); assert.equal(bookOf(P, t.id).list().length, 2);
  assert.equal(P.get(a.id).mergedInto, t.id); assert.equal(P.get(b.id).mergedInto, t.id);
});

test('book.reorganize: không có AI thì chỉ dọn trùng; có AI thì chuyển mục đúng chương, bỏ mục lỗi thời, viết lại tóm tắt, rút ghi chú', async () => {
  const dir = tmp();
  const plain = createBook({ rootDir: dir, now: () => T0 });
  plain.put('Giao hàng', 'Phí giao hàng ngoại thành 30 nghìn', { date: '2026-10-01' });
  plain.put('Giao hàng', 'Phí giao hàng ngoại thành là 35 nghìn đồng', { date: '2026-11-01', autoReplace: false });
  assert.equal((await plain.reorganize()).dropped, 1);                                      // gần trùng: bỏ bản cũ
  assert.match(plain.get('giao-hang').entries[0].text, /35 nghìn/);

  const b = createBook({ rootDir: tmp(), now: () => T0 });
  b.put('Linh tinh', 'Nồi chiên Thaitech giá 1.290.000đ', { part: 9 });
  b.put('Linh tinh', 'Cửa hàng nghỉ chủ nhật', { part: 9 });
  b.put('Linh tinh', 'Giá nồi chiên cũ là 1.390.000đ', { part: 9 });
  const ids = Object.fromEntries(b.get('linh-tinh').entries.map((e) => [e.text.slice(0, 8), e.id]));
  const fake = { available: () => true, provider: () => 'fake', run: async () => ({ via: 'fake', text: JSON.stringify({
    moves: [{ id: ids['Nồi chiê'], chapter: 'Hàng hóa', part: 4 }, { id: ids['Cửa hàng'], chapter: 'Giờ mở cửa', part: 2 }],
    drop: [ids['Giá nồi ']], summaries: { 'Hàng hóa': 'Giá và tồn kho hàng hóa.' }, notes: [{ chapter: 'Quy định', part: 6, text: 'Đổi trả trong 7 ngày' }] }) }) };
  const b2 = createBook({ rootDir: b.root(), summarizer: fake, now: () => T0 });
  const r = await b2.reorganize({ summaries: 'Cuộc trò chuyện X: bàn về giá' });
  assert.equal(r.moved, 2); assert.equal(r.removed, 1); assert.equal(r.notes, 1); assert.equal(r.via, 'fake');
  assert.equal(b2.get('linh-tinh'), null);                                                  // chương cũ rỗng: gỡ
  assert.equal(b2.get('hang-hoa').part, 4); assert.equal(b2.get('hang-hoa').summary, 'Giá và tồn kho hàng hóa.'); assert.equal(b2.get('hang-hoa').entries.length, 1);
  assert.equal(b2.get('gio-mo-cua').part, 2); assert.match(b2.get('quy-dinh').entries[0].text, /Đổi trả/);
});

test('cuộc trò chuyện mới = dự án mới: tên theo giờ rồi theo câu đầu tiên; đang ở dự án đã gộp thì chuyển sang dự án đích', () => {
  const { P } = setup(true);
  const a = P.newChat('111', '111');
  assert.equal(a.auto, true); assert.match(a.name, /^Cuộc trò chuyện \d\d\/\d\d \d\d:\d\d$/); assert.equal(P.active('111').id, a.id);
  P.titleFromPrompt(a.id, 'Tính doanh thu từng ngày của Tulibaby từ đầu tháng 11 giúp anh nhé');
  assert.match(P.get(a.id).name, /^Tính doanh thu từng ngày của Tulibaby/); assert.equal(P.get(a.id).autoTitle, false);
  P.titleFromPrompt(a.id, 'câu thứ hai không đổi tên'); assert.doesNotMatch(P.get(a.id).name, /thứ hai/);
  const b = P.newChat('111', '111'); assert.notEqual(b.id, a.id); assert.equal(P.active('111').id, b.id);
  mergeProjects({ projects: P, ids: [b.id], into: a.id, now: () => T0 });
  assert.equal(P.active('111').id, a.id);                                                   // b đã gộp vào a
});

// Bot dựng sẵn cho các test dự án: giờ giả (now) để thử "quay lại sau vài giờ"; send ghi lại tin gửi qua nút bấm
function botEnv() {
  const { P, db, dir } = setup(true);
  const memory = createMemory({ db, dir, projects: P, now: () => T0, cfg: {} });
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const sent = []; let t = T0;
  const bot = createBot({ db, worker, allowed: new Set(['111']), profiles: [], isAdmin: (u) => String(u) === '111', projects: P, memory, quietAck: true, now: () => t, send: async (chat, r) => { sent.push(r); } });
  const txt = (r) => (r && typeof r === 'object' ? r.text : r);
  const say = async (text) => bot.handle({ from: { id: 111 }, chat: { id: 111, type: 'private' }, text });
  const press = async (data) => bot.handleCallback({ id: 'cb', data, from: { id: 111 }, message: { chat: { id: 111 } } });
  return { P, db, bot, say, press, sent, txt, advance: (ms) => { t += ms; } };
}
const HOURS = 3600000;

test('bot /moi: cuộc trò chuyện mới = dự án mới và bot HỎI TÊN ngay trên Telegram (gõ tên, hoặc "Bot tự đặt tên"); /moi <tên> đặt tên luôn; cuộc trước giữ nguyên', async () => {
  const E = botEnv();
  await E.say('xin chào, tính doanh thu hôm nay');
  const home = E.db.recentJobs('111', 1)[0].project; assert.match(home, /^tong-111/);
  const r = await E.say('/moi'); assert.match(r.text, /Dự án mới\. Anh đặt tên/); assert.equal(r.buttons[0][0].data, 'pj:auto');
  const p1 = E.P.active('111'); assert.equal(p1.auto, true); assert.notEqual(p1.id, home);
  assert.match(await E.say('Kế toán tháng 11'), /Đã đặt tên dự án mới: "Kế toán tháng 11"/); assert.equal(E.P.get(p1.id).name, 'Kế toán tháng 11');
  await E.say('việc đầu tiên'); assert.equal(E.db.recentJobs('111', 1)[0].project, p1.id); assert.equal(E.P.get(p1.id).name, 'Kế toán tháng 11', 'đã có tên thì không bị đổi theo câu đầu');
  assert.match(await E.say('/moi Chuyện kho hàng'), /dự án "Chuyện kho hàng"/); assert.equal(E.P.active('111').name, 'Chuyện kho hàng');
  assert.match(await E.say('/moi Chuyện kho hàng'), /Đã có dự án tên/);                       // trùng tên: báo, không tạo lỗi
  assert.match(await E.say('/moi'), /còn trống|Đặt tên|đặt tên/);                               // cuộc hiện tại còn trống hoặc hỏi tên, không sinh dự án rác
  assert.ok(E.P.get(p1.id) && !E.P.get(p1.id).archived, 'cuộc trước vẫn còn dưới dạng dự án');
  assert.match(await E.say('/moi tiep'), /Đã mở phiên AI mới trong dự án/); assert.match(await E.say('/moi xoa'), /Đã xóa ngữ cảnh/);
});

test('/duan: danh sách có nút "▶️ Tiếp tục" cho từng dự án và "🆕 Dự án mới" ở cuối; bấm Tiếp tục thì đặt dự án đó làm dự án đang làm và nhắc lại việc gần nhất', async () => {
  const E = botEnv();
  await E.say('/moi Kế toán'); await E.say('/moi Kho hàng');
  const kt = E.P.get('ke-toan'), kho = E.P.get('kho-hang'); assert.equal(E.P.active('111').id, kho.id);
  const r = await E.say('/duan');
  assert.ok(r.text && Array.isArray(r.buttons));
  const flat = r.buttons.flat(); assert.ok(flat.some((b) => b.data === 'pj:go:' + kt.id && /Tiếp tục/.test(b.text)));
  assert.equal(r.buttons[r.buttons.length - 1][0].data, 'pj:new');                          // lựa chọn cuối là Dự án mới
  assert.ok(Math.max(...flat.map((b) => b.data.length)) <= 64, 'callback_data ≤ 64 byte');
  const id = E.db.addJob('111', 'sổ sách quý 3', null, null, 'main', kt.id); E.db.claimNext(); E.db.finishJob(id, 'done', { result: 'đã đối chiếu xong quý 3' });
  assert.match(await E.press('pj:go:' + kt.id), /Đã chuyển sang Kế toán/);
  assert.equal(E.P.active('111').id, kt.id); assert.match(E.txt(E.sent[E.sent.length - 1]), /Tiếp tục dự án "Kế toán"[\s\S]*sổ sách quý 3[\s\S]*đối chiếu xong quý 3/);
  await E.say('tiếp nhé'); assert.equal(E.db.recentJobs('111', 1)[0].project, kt.id);
});

test('quay lại sau vài giờ: tin được GIỮ và bot hiện danh sách dự án để chọn; chọn dự án thì tin vào đúng dự án; "Dự án mới" hỏi tên rồi giao tin; nhắn dồn tin khi đang chọn', async () => {
  const E = botEnv();
  await E.say('/moi Kế toán'); await E.say('Kế toán tháng 11'); await E.say('/moi Kho hàng'); await E.say('kiểm kho'); // đang ở Kho hàng
  const kt = E.P.get('ke-toan'), kho = E.P.get('kho-hang');
  await E.say('nhắn tiếp sau 1 phút'); assert.equal(E.db.recentJobs('111', 1)[0].project, kho.id);        // chưa lâu: giao thẳng, không hỏi
  E.advance(5 * HOURS);
  const before = E.db.recentJobs('111', 1)[0].id;
  const r = await E.say('chốt sổ tháng 11 giúp anh');
  assert.match(r.text, /thuộc dự án nào/); assert.equal(E.db.recentJobs('111', 1)[0].id, before, 'chưa giao việc khi chưa chọn');
  const picks = r.buttons.map((row) => row[0].data).filter((d) => d.startsWith('pj:pick:'));
  assert.ok(picks.includes('pj:pick:' + kho.id) && picks.includes('pj:pick:' + kt.id));        // có cả dự án tổng của người dùng; dự án mới dùng nhất đứng đầu
  assert.equal(picks[0], 'pj:pick:' + kho.id);
  assert.equal(r.buttons[r.buttons.length - 1][0].data, 'pj:new');
  const r2 = await E.say('và gửi cho anh bảng đối chiếu'); assert.match(r2.text, /thuộc dự án nào/);       // gõ thêm khi đang chọn: gộp vào tin giữ
  assert.match(await E.press('pj:pick:' + kt.id), /Đã chọn Kế toán/);
  const j = E.db.recentJobs('111', 1)[0]; assert.equal(j.project, kt.id); assert.match(j.prompt, /chốt sổ tháng 11[\s\S]*bảng đối chiếu/);
  assert.equal(E.P.active('111').id, kt.id);
  assert.match(await E.press('pj:pick:' + kt.id), /đã được xử lý/);                                      // bấm lại nút cũ: không giao trùng
  // quay lại lần nữa, tin không liên quan → Dự án mới
  E.advance(6 * HOURS); const r3 = await E.say('mua nồi cơm điện giá bao nhiêu'); assert.match(r3.text, /thuộc dự án nào/);
  await E.press('pj:new'); const ask = E.sent[E.sent.length - 1]; assert.match(ask.text, /Anh đặt tên/); assert.equal(ask.buttons[0][0].data, 'pj:auto');
  assert.match(await E.say('Hỏi giá nồi cơm'), /Đã đặt tên dự án mới: "Hỏi giá nồi cơm" và giao tin/);
  const j2 = E.db.recentJobs('111', 1)[0]; assert.equal(E.P.get(j2.project).name, 'Hỏi giá nồi cơm'); assert.match(j2.prompt, /mua nồi cơm điện/);
  // "Bot tự đặt tên": tên lấy theo tin đang giữ
  E.advance(5 * HOURS); await E.say('Soạn hợp đồng thuê kho cho anh'); await E.press('pj:new'); await E.press('pj:auto');
  const j3 = E.db.recentJobs('111', 1)[0]; assert.match(E.P.get(j3.project).name, /^Soạn hợp đồng thuê kho/);
});

test('memory.organizePending: dự án vừa gộp được AI sắp xếp lại một lần, kèm tóm tắt cuộc trò chuyện nguồn; kết quả ghi vào dự án', async () => {
  const { P, db, dir } = setup(true);
  const a = P.newChat('111', '111'), b = P.newChat('111', '111');
  db.kvSet('sum:111#' + a.id, 'Hai bên bàn về giá bếp từ');
  bookOf(P, a.id).put('Linh tinh', 'Bếp từ Yoake giá 3 triệu', { part: 9 });
  mergeProjects({ projects: P, ids: [a.id], into: b.id, now: () => T0 });
  const seen = [];
  const fake = { available: () => true, provider: () => 'fake', run: async (sys, user) => { seen.push(user); return { via: 'fake', text: JSON.stringify({ moves: [], drop: [], summaries: {}, notes: [{ chapter: 'Hàng hóa', part: 4, text: 'Bếp từ Yoake đang bàn giá 3 triệu' }] }) }; } };
  const m = createMemory({ db, dir, projects: P, summarizer: fake, now: () => T0, cfg: {} });
  assert.equal(await m.organizePending(), 1);
  assert.match(seen[0], /Hai bên bàn về giá bếp từ/);
  const t = P.get(b.id); assert.equal(t.pendingOrganize, undefined); assert.equal(t.lastOrganized.notes, 1); assert.equal(t.lastOrganized.via, 'fake');
  assert.equal(await m.organizePending(), 0);                                               // đã xong: không làm lại
  assert.match(m.bookFor(b.id).search('bếp từ Yoake', 3)[0].text, /Bếp từ Yoake/);
});
