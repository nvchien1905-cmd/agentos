'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVault } = require('../../orchestrator/src/vault');
const { createQuick } = require('../../orchestrator/src/quick');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
const make = (dir) => createVault({ file: path.join(dir, 'data', 'vault.enc'), keyFile: path.join(dir, 'vault.key') });

test('kho mật khẩu: mã hóa (tệp không chứa chữ rõ), list không lộ mật khẩu, sửa để trống mật khẩu = giữ cũ, xóa, khóa nằm ngoài thư mục dữ liệu', () => {
  const dir = tmp(), v = make(dir);
  v.put('Máy văn phòng', { id: '264 372 510', password: 'Bí mật 123!', note: 'tầng 2' });
  const raw = fs.readFileSync(path.join(dir, 'data', 'vault.enc'));
  assert.ok(!raw.includes('264372510') && !raw.includes('Bí mật'));
  assert.ok(fs.existsSync(path.join(dir, 'vault.key')) && !fs.existsSync(path.join(dir, 'data', 'vault.key')));
  assert.deepEqual(v.list().map((x) => [x.name, x.id, x.hasPassword]), [['Máy văn phòng', '264372510', true]]);
  assert.ok(!JSON.stringify(v.list()).includes('Bí mật'));
  v.put('Máy văn phòng', { id: '264372511', password: '' });               // sửa ID, giữ mật khẩu
  assert.deepEqual(v.secret('may van phong'), { name: 'Máy văn phòng', id: '264372511', password: 'Bí mật 123!' });
  const again = make(dir); assert.equal(again.secret('Máy văn phòng').password, 'Bí mật 123!');   // đọc lại từ đĩa
  assert.equal(v.remove('máy văn phòng'), true); assert.equal(v.remove('khong co'), false); assert.deepEqual(v.list(), []);
});

test('kho mật khẩu: kiểm đầu vào, khóa sai thì báo lỗi, tiến trình khác ghi thì đọc lại (mtime), nhập từ tệp rõ cũ rồi xóa tệp', () => {
  const dir = tmp(), v = make(dir);
  assert.throws(() => v.put('', { id: '123456', password: 'x' }), /Tên máy/);
  assert.throws(() => v.put('A', { id: 'a b;', password: 'x' }), /ID/);
  assert.throws(() => v.put('A', { id: '123456' }), /mật khẩu/i);
  assert.throws(() => v.put('A', { id: '123456', password: '-x' }), /không hợp lệ/);
  const other = make(dir); other.put('B', { id: '654321', password: 'pw' });   // "Cài đặt" ghi
  v.put('C', { id: '111222', password: 'p2' });                                 // bộ điều phối đọc lại trước khi ghi → không mất máy B
  assert.deepEqual(v.list().map((x) => x.name), ['B', 'C']);
  fs.writeFileSync(path.join(dir, 'vault.key'), Buffer.alloc(32, 7));
  assert.throws(() => make(dir).list(), /Không mở được kho/);
  const dir2 = tmp(), plain = path.join(dir2, 'rustdesk-may-con.json'), w = make(dir2);
  fs.writeFileSync(plain, JSON.stringify({ 'Máy A': { id: '123456789', password: 'abc' }, hong: { id: 'x y' } }));
  assert.equal(w.importPlain(plain), 1); assert.equal(fs.existsSync(plain), false); assert.equal(w.secret('Máy A').password, 'abc');
});

test('/vao: không đối số liệt kê máy (không có mật khẩu); có tên thì gửi ID + mật khẩu cho trợ lý màn hình rồi chụp màn hình; nhiều máy khớp thì hỏi lại', async () => {
  const v = make(tmp());
  const calls = [], desk = { call: async (r) => { calls.push(r); return r.cmd === 'screenshot' ? { ok: true, file: '/tmp/x.png' } : { ok: true }; } };
  const q = createQuick({ desk, vault: v, shotWaitMs: 0, rdWaitMs: 0 });
  assert.match(String(await q.run('vao', '')), /Cài đặt.*Máy từ xa/);
  v.put('Máy văn phòng', { id: '264372510', password: 'S3cret!' }); v.put('Máy kho', { id: '111222333', password: 'k' });
  const list = String(await q.run('vao', ''));
  assert.match(list, /Máy văn phòng — ID 264372510/); assert.doesNotMatch(list, /S3cret/);
  const r = await q.run('vao', 'văn phòng');
  assert.deepEqual(calls[0], { cmd: 'rdconnect', id: '264372510', password: 'S3cret!' });
  assert.match(r.text, /Máy văn phòng.*264372510/); assert.doesNotMatch(r.text, /S3cret/);
  const many = String(await q.run('vao', 'may'));
  assert.match(many, /nhiều máy khớp/); assert.equal(calls.filter((c) => c.cmd === 'rdconnect').length, 1);
  assert.match(String(await q.run('vao', 'khong co may nay')), /Máy kho|Máy văn phòng/);
  const fail = createQuick({ desk: { call: async () => ({ ok: false, error: 'khóa' }) }, vault: v, shotWaitMs: 0, rdWaitMs: 0 });
  assert.match(String(await fail.run('vao', 'kho')), /⚠️ khóa/);
});
