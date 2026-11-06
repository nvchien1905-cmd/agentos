'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBook } = require('../src/book');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sotay-'));
const mk = (dir, extra) => createBook(Object.assign({ rootDir: dir, now: () => Date.UTC(2026, 10, 6, 5) }, extra || {}));

test('sổ tay như cuốn sách: chương thuộc PHẦN, có số phần.thứ tự cố định, mục lục xếp theo trật tự đó (không theo ngày sửa)', () => {
  const b = mk(tmp());
  b.put('Hàng hóa Tulibaby', 'Nồi chiên Thaitech giá bán 1.290.000đ, tồn kho Thượng Mỗ còn 3 cái');
  b.put('Máy văn phòng', 'Máy văn phòng điều khiển bằng RustDesk qua Tailscale, tên máy là vanphong');
  b.put('Giờ mở cửa', 'Cửa hàng Phương Đình mở cửa 8 giờ sáng, nghỉ chủ nhật');
  const l = b.list();
  assert.deepEqual(l.map((c) => c.part + '.' + c.no), ['2.1', '4.1', '5.1']);
  assert.deepEqual(l.map((c) => c.title), ['Giờ mở cửa', 'Hàng hóa Tulibaby', 'Máy văn phòng']);
  b.put('Giá vốn', 'Giá vốn nồi cơm tính theo bảng nhập hàng tháng 10');
  assert.equal(b.get('gia-von').no, 2); assert.equal(b.get('gia-von').part, 4);          // chương mới cùng phần: số kế tiếp
  assert.equal(b.get('hang-hoa-tulibaby').no, 1);                                          // số cũ không đổi
  b.put('Hàng hóa Tulibaby', 'Bếp từ đôi Yoake tồn kho còn 1 cái');                       // sửa chương cũ không làm nhảy thứ tự
  assert.deepEqual(b.list().map((c) => c.part + '.' + c.no), ['2.1', '4.1', '4.2', '5.1']);
  const toc = b.toc();
  assert.match(toc, /PHẦN 2 — Cửa hàng và kinh doanh\n- Chương 2\.1 Giờ mở cửa/);
  assert.ok(toc.indexOf('PHẦN 4') < toc.indexOf('PHẦN 5'));
  assert.match(b.chapterText(b.get('hang-hoa-tulibaby')), /Chương 4\.1 "Hàng hóa Tulibaby" \(Phần 4 — Hàng hóa và giá\)[\s\S]*- 4\.1\.2 \[/);
  assert.match(fs.readFileSync(path.join(b.root(), 'MUC-LUC.md'), 'utf8'), /PHẦN 5 — Máy móc và hệ thống/);
});

test('mô hình chọn phần (part) cho chương mới; số phần sai thì dùng đoán theo từ khóa', () => {
  const b = mk(tmp());
  b.put('Nhà cung cấp Hà Nội', 'Anh Nam giao hàng thứ ba hằng tuần', { part: 3 });
  b.put('Gì đó', 'Máy in tem nhãn đặt ở quầy thu ngân', { part: 99 });
  assert.equal(b.get('nha-cung-cap-ha-noi').part, 3);
  assert.equal(b.get('gi-do').part, 5);
});

test('sổ tay cũ chưa có số: numberAll() đánh số một lần, giữ nguyên nội dung và ngày cập nhật, lần sau không đổi', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'chuong-khach-hang.md'), '# Khách hàng\n> Tóm tắt: khách quen\n> Cập nhật: 2026-10-01\n\n## Chi tiết\n- [2026-10-01] {aaaaaa} Khách Lan hay mua nồi chiên\n');
  fs.writeFileSync(path.join(dir, 'chuong-quy-dinh.md'), '# Quy định đổi trả\n> Tóm tắt: x\n> Cập nhật: 2026-10-02\n\n## Chi tiết\n- [2026-10-02] {bbbbbb} Quy định đổi trả trong 7 ngày\n');
  const b = mk(dir);
  assert.equal(b.numberAll(), 2);
  const first = b.list().map((c) => c.slug + ':' + c.part + '.' + c.no + ':' + c.updated);
  assert.deepEqual(first, ['khach-hang:3.1:2026-10-01', 'quy-dinh:6.1:2026-10-02']);
  assert.equal(b.numberAll(), 0);
  assert.deepEqual(b.list().map((c) => c.slug + ':' + c.part + '.' + c.no + ':' + c.updated), first);
  assert.equal(b.get('khach-hang').entries[0].text, 'Khách Lan hay mua nồi chiên');
});

test('tìm trong cả cuốn: trả mục khớp kèm số chương.mục, mục khớp nhiều từ trước', () => {
  const b = mk(tmp());
  b.put('Hàng hóa', 'Nồi chiên Thaitech tồn kho Thượng Mỗ còn 3 cái');
  b.put('Hàng hóa', 'Bếp từ Yoake đã hết hàng');
  b.put('Giờ mở cửa', 'Cửa hàng nghỉ chủ nhật');
  const r = b.search('nồi chiên Thaitech', 5);
  assert.equal(r.length, 1); assert.equal(r[0].part + '.' + r[0].no + '.' + r[0].idx, '4.1.1');
  assert.deepEqual(b.search('chủ nhật nghỉ').map((x) => x.title), ['Giờ mở cửa']);
  assert.deepEqual(b.search('xyz không có'), []);
});
