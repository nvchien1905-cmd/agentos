'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProjects } = require('../src/projects');
const { createBot } = require('../src/bot');
const { createSkillsUi } = require('../src/skillsUi');
const openDb = (f) => require('../src/db').openDb(f);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sk-'));
const ADMIN = '111', A = '222';
const isAdmin = (u) => String(u) === ADMIN;
const txt = (r) => (r && typeof r === 'object' ? r.text : String(r));

function env() {
  const db = openDb(':memory:'); let t = Date.parse('2026-11-07T10:00:00+07:00');
  const P = createProjects({ db, baseDir: tmp(), now: () => t });
  const sent = [];
  const send = async (c, r) => { sent.push(r); };
  const skillsUi = createSkillsUi({ projects: P, isAdmin, send, now: () => t });
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => true };
  const bot = createBot({ db, worker, allowed: new Set([ADMIN, A]), profiles: [], isAdmin, projects: P, approvals: { pendingJobIds: () => new Set(), cancelJob() {} }, quietAck: true, now: () => t, send, skillsUi });
  const say = async (uid, text) => bot.handle({ from: { id: uid }, chat: { id: uid, type: 'private' }, text });
  const press = async (uid, data) => bot.handleCallback({ id: 'cb', data, from: { id: uid }, message: { chat: { id: uid } } });
  return { db, P, say, press, sent, advance: (ms) => { t += ms; }, proj: (uid) => P.active(uid) || P.homeOf(uid) };
}

test('/kynang: tạo kỹ năng bằng tin kế tiếp (dòng đầu = mô tả), AI thấy nó trong chỉ dẫn; trùng tên thì từ chối, sửa thì ghi đè; xem không phân biệt hoa/dấu', async () => {
  const E = env();
  assert.match(txt(await E.say(ADMIN, '/kynang')), /Chưa có kỹ năng nào/);
  assert.match(txt(await E.say(ADMIN, '/kynang moi Báo giá khách sỉ')), /Gửi nội dung kỹ năng "Báo giá khách sỉ"[\s\S]*Dòng ĐẦU/);
  const r = await E.say(ADMIN, 'Lập báo giá cho khách mua sỉ\n1. Hỏi số lượng và mã hàng\n2. Giảm 5% nếu từ 10 cái');
  assert.match(r, /✅ Đã tạo kỹ năng "Báo giá khách sỉ" \(KY-NANG\/bao-gia-khach-si\.md\)/);
  const p = E.proj(ADMIN), file = path.join(p.dir, 'KY-NANG', 'bao-gia-khach-si.md'), raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /^---\nname: Báo giá khách sỉ\ndescription: Lập báo giá cho khách mua sỉ\n---\n# Báo giá khách sỉ\n\n1\. Hỏi số lượng và mã hàng\n2\. Giảm 5% nếu từ 10 cái\n$/);
  assert.deepEqual(E.P.skillsOf(p.id).map((s) => [s.name, s.description]), [['Báo giá khách sỉ', 'Lập báo giá cho khách mua sỉ']]);
  assert.match(E.P.instructions(p.id), /KỸ NĂNG CỦA DỰ ÁN[\s\S]*Báo giá khách sỉ: Lập báo giá cho khách mua sỉ/);
  assert.match(txt(await E.say(ADMIN, '/kynang moi BÁO GIÁ khách sỉ')), /Đã có kỹ năng "bao-gia-khach-si"/);
  assert.match(txt(await E.say(ADMIN, '/kynang sua Báo giá khách sỉ')), /Gửi nội dung kỹ năng/);
  assert.match(await E.say(ADMIN, 'Báo giá sỉ (bản mới)\nBước duy nhất: gọi chủ'), /Đã cập nhật kỹ năng/);
  assert.match(fs.readFileSync(file, 'utf8'), /description: Báo giá sỉ \(bản mới\)[\s\S]*Bước duy nhất: gọi chủ/);
  assert.match(txt(await E.say(ADMIN, '/kynang xem bao gia KHACH si')), /🧠 Báo giá khách sỉ[\s\S]*Bước duy nhất/);
  assert.match(txt(await E.say(ADMIN, '/kynang xem khong co')), /Không có kỹ năng/); assert.match(txt(await E.say(ADMIN, '/kynang sua Không có')), /Không có kỹ năng "Không có" trong KY-NANG/);
  assert.match(txt(await E.say(ADMIN, '/kynang lung tung')), /Không hiểu/);
});

test('/kynang: chỉ một dòng thì dùng luôn làm nội dung; dòng đầu trống/quá dài bị từ chối; hủy; hết hạn; tin thường không bị nuốt khi không chờ; tên kiểu "../" vẫn nằm trong KY-NANG', async () => {
  const E = env(); const p = E.proj(ADMIN); E.P.ensureDirs(p);
  await E.say(ADMIN, '/kynang moi Chốt ca'); await E.say(ADMIN, 'Đối chiếu tiền mặt cuối ngày');
  assert.match(fs.readFileSync(path.join(p.dir, 'KY-NANG', 'chot-ca.md'), 'utf8'), /description: Đối chiếu tiền mặt cuối ngày[\s\S]*# Chốt ca\n\nĐối chiếu tiền mặt cuối ngày\n$/);
  await E.say(ADMIN, '/kynang moi Quá dài'); assert.match(await E.say(ADMIN, 'x'.repeat(20001)), /quá dài/); assert.equal(fs.existsSync(path.join(p.dir, 'KY-NANG', 'qua-dai.md')), false);
  await E.say(ADMIN, '/kynang moi Hủy thử'); assert.match(txt(await E.say(ADMIN, '/kynang huy')), /Đã thôi/); assert.equal(fs.existsSync(path.join(p.dir, 'KY-NANG', 'huy-thu.md')), false);
  await E.say(ADMIN, '/kynang moi Hết hạn'); E.advance(11 * 60000);
  const after = await E.say(ADMIN, 'một tin nhắn thường sau 11 phút'); assert.equal(fs.existsSync(path.join(p.dir, 'KY-NANG', 'het-han.md')), false, 'hết hạn: không nuốt tin');
  assert.ok(after === null || !/Đã tạo kỹ năng/.test(txt(after)));
  await E.say(ADMIN, '/kynang moi ../../etc/passwd'); await E.say(ADMIN, 'thử thoát thư mục');
  assert.equal(fs.existsSync(path.join(p.dir, 'KY-NANG', 'etc-passwd.md')), true); assert.equal(fs.existsSync(path.join(p.dir, '..', '..', 'etc', 'passwd.md')), false);
  assert.match(txt(await E.say(ADMIN, '/kynang moi !!!')), /cần có chữ hoặc số/);
});

test('/kynang: nút Xem/Sửa/Xóa (xóa có xác nhận); kỹ năng ở .claude/skills chỉ liệt kê, không sửa/xóa được; ID thường xem được kỹ năng dự án của mình nhưng không tạo/sửa/xóa', async () => {
  const E = env(); const p = E.proj(ADMIN); E.P.ensureDirs(p);
  await E.say(ADMIN, '/kynang moi Nhập hàng'); await E.say(ADMIN, 'Nhập hàng từ file Excel\nBước 1: mở file');
  fs.mkdirSync(path.join(p.dir, '.claude', 'skills', 'ngoai'), { recursive: true }); fs.writeFileSync(path.join(p.dir, '.claude', 'skills', 'ngoai', 'SKILL.md'), '---\nname: ngoai\ndescription: Kỹ năng đặt ngoài\n---\n…');
  const card = await E.say(ADMIN, '/kynang'); assert.match(card.text, /1\) Nhập hàng — Nhập hàng từ file Excel\n2\) ngoai — Kỹ năng đặt ngoài \[tệp ngoài, chỉ xem\]/);
  assert.deepEqual(card.buttons.flat().map((b) => b.data), ['ky:view:nhap-hang', 'ky:edit:nhap-hang', 'ky:del:nhap-hang'], 'tệp ngoài không có nút sửa/xóa');
  assert.equal(await E.press(ADMIN, 'ky:view:nhap-hang'), ''); assert.match(txt(E.sent.pop()), /🧠 Nhập hàng[\s\S]*Bước 1: mở file/);
  assert.equal(await E.press(ADMIN, 'ky:edit:nhap-hang'), ''); assert.match(txt(E.sent.pop()), /Gửi nội dung kỹ năng "Nhập hàng"/, 'sửa giữ nguyên tên có dấu');
  await E.say(ADMIN, '/kynang huy');
  assert.match(txt(await E.say(ADMIN, '/kynang xoa ngoai')), /Không có kỹ năng "ngoai" trong KY-NANG/);
  assert.equal(await E.press(ADMIN, 'ky:del:nhap-hang'), ''); assert.deepEqual(E.sent.pop().buttons.flat().map((b) => b.data), ['ky:delyes:nhap-hang', 'ky:no']);
  assert.equal(await E.press(ADMIN, 'ky:no'), 'Thôi, giữ nguyên.'); assert.ok(fs.existsSync(path.join(p.dir, 'KY-NANG', 'nhap-hang.md')));
  // ID thường: dự án tổng riêng của họ
  const pa = E.proj(A); E.P.ensureDirs(pa); fs.mkdirSync(path.join(pa.dir, 'KY-NANG'), { recursive: true }); fs.writeFileSync(path.join(pa.dir, 'KY-NANG', 'cua-a.md'), '---\nname: Của A\ndescription: Việc của A\n---\n…');
  assert.match(txt(await E.say(A, '/kynang')), /1\) Của A — Việc của A/); assert.match(txt(await E.say(A, '/kynang xem Của A')), /🧠 Của A/);
  assert.equal(await E.say(A, '/kynang moi Gì đó'), 'Chỉ chủ máy tạo/sửa/xóa kỹ năng.'); assert.equal(await E.say(A, '/kynang xoa cua-a'), 'Chỉ chủ máy tạo/sửa/xóa kỹ năng.');
  assert.equal(await E.press(A, 'ky:delyes:cua-a'), 'Chỉ chủ máy sửa/xóa kỹ năng.'); assert.ok(fs.existsSync(path.join(pa.dir, 'KY-NANG', 'cua-a.md')));
  assert.equal(await E.press(A, 'ky:delyes:nhap-hang'), 'Kỹ năng này không còn.', 'không với tới kỹ năng của dự án người khác');
  assert.ok(fs.existsSync(path.join(p.dir, 'KY-NANG', 'nhap-hang.md')));
  assert.equal(await E.press(ADMIN, 'ky:delyes:nhap-hang'), 'Đã xóa'); assert.equal(fs.existsSync(path.join(p.dir, 'KY-NANG', 'nhap-hang.md')), false);
});
