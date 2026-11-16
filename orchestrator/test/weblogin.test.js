'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWebLogin, sameSite } = require('../src/weblogin');
const { classify } = require('../src/cmdTool');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'));
const mk = (extra) => { const d = tmp(); return Object.assign({ d, wl: createWebLogin(Object.assign({ file: d + '/w.enc', keyFile: d + '/w.key', endpoint: async () => 'http://x', settleMs: 0 }, extra || {})) }); };

// Playwright giả: một trang có ô tài khoản + ô mật khẩu; ghi lại những gì được gõ
function fakePw(opt) {
  opt = opt || {};
  const typed = [], pages = []; let closed = 0;
  const pwdEl = { click: async () => {}, fill: async () => {}, type: async (t) => { typed.push(['pass', t]); }, press: async () => { opt.afterEnter && opt.afterEnter(state); } };
  const userEl = { click: async () => {}, fill: async () => {}, type: async (t) => { typed.push(['user', t]); } };
  const state = { url: opt.url || 'https://soquy.example.vn/login', hasPwd: opt.hasPwd !== false, body: opt.body || 'Đăng nhập' };
  const page = {
    goto: async () => {}, waitForTimeout: async () => {}, waitForLoadState: async () => {}, url: () => state.url,
    $: async (sel) => (/password/.test(sel) ? (state.hasPwd ? pwdEl : null) : null),
    evaluate: async () => state.body, evaluateHandle: async () => ({ asElement: () => (opt.noUser ? null : userEl) }),
    close: async () => { closed++; },
  };
  const pw = { chromium: { connectOverCDP: async () => ({ contexts: () => [{ newPage: async () => { pages.push(page); return page; } }], close: async () => {} }) } };
  return { pw, typed, state, closedCount: () => closed };
}

test('kho: lưu mã hóa (tệp không chứa mật khẩu rõ), list không lộ mật khẩu, sửa/xóa; chỉ https', () => {
  const { d, wl } = mk();
  wl.put('SoQuy', 'soquy.example.vn', 'admin', 'MAT-KHAU-BI-MAT');
  assert.ok(!fs.readFileSync(d + '/w.enc').toString('latin1').includes('MAT-KHAU-BI-MAT'));
  assert.deepEqual(Object.keys(wl.list()[0]).sort(), ['at', 'name', 'url', 'user']);
  assert.ok(!JSON.stringify(wl.list()).includes('MAT-KHAU'));
  assert.throws(() => wl.put('X', 'http://a.vn', 'u', 'p'), /https/);
  assert.throws(() => wl.put('X', 'https://a.vn', 'u', 'a\nb'), /Mật khẩu/);
  wl.put('soquy', 'https://soquy.example.vn', 'admin2', 'moi');              // cùng tên (không phân biệt hoa/thường, dấu) = sửa
  assert.equal(wl.list().length, 1); assert.equal(wl.list()[0].user, 'admin2');
  assert.equal(wl.remove('SOQUY'), true); assert.equal(wl.list().length, 0);
});

test('/taikhoan them: lưu, đánh dấu secret (để xóa tin), không in lại mật khẩu; thiếu tham số vẫn secret', async () => {
  const { wl } = mk();
  const r = await wl.command('them SoQuy https://soquy.example.vn admin 66778899');
  assert.equal(r.secret, true); assert.ok(!r.text.includes('66778899')); assert.match(r.text, /Đã lưu/);
  const r2 = await wl.command('them SoQuy https://soquy.example.vn'); assert.equal(r2.secret, true); assert.match(r2.text, /Cú pháp/);
  const l = await wl.command(''); assert.match(l.text, /SoQuy/); assert.ok(!l.text.includes('66778899'));
});

test('đăng nhập: gõ tài khoản + mật khẩu vào đúng ô, đóng tab, báo thành công khi ô mật khẩu biến mất', async () => {
  const f = fakePw({ afterEnter: (s) => { s.hasPwd = false; s.body = 'Xin chào'; } });
  const { wl } = mk({ load: () => f.pw });
  wl.put('SoQuy', 'https://soquy.example.vn', 'admin', '66778899');
  const r = await wl.login('soquy');
  assert.equal(r.ok, true); assert.match(r.text, /Đã đăng nhập/); assert.ok(!r.text.includes('66778899'));
  assert.deepEqual(f.typed, [['user', 'admin'], ['pass', '66778899']]);
  assert.equal(f.closedCount(), 1);
});

test('đăng nhập: đã đăng nhập sẵn (không có ô mật khẩu) → không gõ gì', async () => {
  const f = fakePw({ hasPwd: false });
  const { wl } = mk({ load: () => f.pw }); wl.put('SoQuy', 'https://soquy.example.vn', 'a', 'b');
  const r = await wl.login('SoQuy'); assert.equal(r.ok, true); assert.match(r.text, /đã đăng nhập sẵn/); assert.deepEqual(f.typed, []);
});

test('đăng nhập: bị chuyển sang tên miền KHÁC → dừng, không gõ mật khẩu', async () => {
  const f = fakePw({ url: 'https://evil.example.com/login' });
  const { wl } = mk({ load: () => f.pw }); wl.put('SoQuy', 'https://soquy.example.vn', 'a', 'SECRET');
  const r = await wl.login('SoQuy'); assert.equal(r.ok, false); assert.match(r.text, /trang khác/); assert.deepEqual(f.typed, []);
  assert.equal(sameSite('https://app.x.vn/a', 'https://x.vn'), true); assert.equal(sameSite('https://x.vn.evil.com', 'https://x.vn'), false);
});

test('đăng nhập: CAPTCHA/OTP → dừng, không gõ; sai mật khẩu (vẫn ở trang đăng nhập) → báo lỗi; thiếu ô tài khoản → báo', async () => {
  let f = fakePw({ url: 'https://a.vn/', body: 'Vui lòng tick vào ô I am not a robot' });
  let { wl } = mk({ load: () => f.pw }); wl.put('A', 'https://a.vn', 'u', 'p');
  let r = await wl.login('A'); assert.equal(r.ok, false); assert.match(r.text, /CAPTCHA/); assert.deepEqual(f.typed, []);
  f = fakePw({ url: 'https://a.vn/' }); ({ wl } = mk({ load: () => f.pw })); wl.put('A', 'https://a.vn', 'u', 'p');
  r = await wl.login('A'); assert.equal(r.ok, false); assert.match(r.text, /vẫn ở trang đăng nhập/);
  f = fakePw({ url: 'https://a.vn/', afterEnter: (s) => { s.body = 'Nhập mã OTP gửi về điện thoại'; } }); ({ wl } = mk({ load: () => f.pw })); wl.put('A', 'https://a.vn', 'u', 'p');
  r = await wl.login('A'); assert.equal(r.ok, false); assert.match(r.text, /OTP|xác minh/);
  f = fakePw({ url: 'https://a.vn/', noUser: true }); ({ wl } = mk({ load: () => f.pw })); wl.put('A', 'https://a.vn', 'u', 'p');
  r = await wl.login('A'); assert.equal(r.ok, false); assert.match(r.text, /ô tài khoản/); assert.deepEqual(f.typed, []);
});

test('đăng nhập: chưa lưu → gợi ý danh sách; Chrome không nối được → báo lỗi, không ném', async () => {
  const { wl } = mk({ load: () => ({ chromium: { connectOverCDP: async () => { throw new Error('refused'); } } }) });
  assert.match((await wl.login('Nope')).text, /Chưa lưu/);
  wl.put('A', 'https://a.vn', 'u', 'p'); const r = await wl.login('A'); assert.equal(r.ok, false); assert.match(r.text, /Không nối được trình duyệt/);
});

test('AI qua bot_command: /dangnhap và /taikhoan (xem) thường; /taikhoan them|xoa là nhạy cảm (mật khẩu không đi qua AI)', () => {
  assert.equal(classify('/dangnhap SoQuy').level, 'normal');
  assert.equal(classify('/taikhoan').level, 'normal');
  assert.equal(classify('/taikhoan them A https://a.vn u p').level, 'danger');
  assert.equal(classify('/taikhoan xoa A').level, 'danger');
});
