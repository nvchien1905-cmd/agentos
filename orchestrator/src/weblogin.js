'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// KHO TÀI KHOẢN WEB + ĐĂNG NHẬP HỘ (/taikhoan, /dangnhap).
// Chủ máy lưu tài khoản/mật khẩu của các trang (Sổ quỹ, GS...) MỘT lần; sau đó /dangnhap <tên> (hoặc AI gọi bot_command) mở trang trong Chrome dùng chung và điền hộ.
//  - Mật khẩu mã hóa AES-256-GCM, khóa là tệp RIÊNG ngoài thư mục dữ liệu (0600); không bao giờ trả ra qua list()/Telegram; AI KHÔNG đọc được (nó chỉ nói tên trang).
//  - Việc điền chạy trong bộ điều phối (ngoài hộp cô lập của AI), AI không thấy mật khẩu, không gõ mật khẩu.
//  - Chỉ trang https đã lưu; điền xong mới tin: nếu sau khi mở trang bị chuyển sang TÊN MIỀN KHÁC thì dừng (chống trang giả).
//  - Gặp OTP/mã xác minh/CAPTCHA thì DỪNG và báo chủ máy tự làm (không tìm cách vượt).
//  - Phiên đăng nhập nằm trong hồ sơ Chrome (cookie) nên các lần sau AI vào trang là đã đăng nhập sẵn.
const NAME_RE = /^[^\x00-\x1f]{1,40}$/;
const noAccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const firstLine = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 160);
const CHALLENGE_RE = /captcha|recaptcha|hcaptcha|i(?:'?m| am) not a robot|không phải (là )?robot|mã otp|\botp\b|mã xác (minh|thực|nhận)|xác thực hai|two.factor|2fa|verification code/i;

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
// Cùng "trang": trùng tên miền hoặc là tên miền con/cha của nhau (www.x.vn ↔ x.vn ↔ app.x.vn). Không so lỏng hơn để không bị chuyển sang trang lạ.
const sameSite = (a, b) => { const x = hostOf(a), y = hostOf(b); return !!x && !!y && (x === y || x.endsWith('.' + y) || y.endsWith('.' + x)); };

function createWebLogin(o) {
  o = o || {};
  const file = o.file, keyFile = o.keyFile;
  const log = o.log || (() => {}), chown = o.chown || (() => {});
  const load = o.load || (() => require(require.resolve('playwright-core', { paths: [process.env.AGENTOS_TOOLS_DIR || '/opt/agentos/tools'] })));
  const settleMs = o.settleMs === undefined ? 2500 : o.settleMs;
  let cache = null, cacheMt = -1;
  const mtime = () => { try { return fs.statSync(file).mtimeMs; } catch (e) { return 0; } };
  const busy = new Set();

  function key() {
    let k = null; try { k = fs.readFileSync(keyFile); } catch (e) { /* chưa có */ }
    if (k && k.length === 32) return k;
    k = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile, k, { mode: 0o600 }); chown(keyFile);
    return k;
  }
  function read() {
    if (cache && mtime() === cacheMt) return cache;
    cacheMt = mtime();
    let raw = null; try { raw = fs.readFileSync(file); } catch (e) { cache = {}; return cache; }
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12)); d.setAuthTag(raw.subarray(12, 28));
      cache = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    } catch (e) { throw new Error('Không mở được kho tài khoản (sai khóa hoặc tệp hỏng).'); }
    return cache;
  }
  function write(all) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const enc = Buffer.concat([c.update(JSON.stringify(all), 'utf8'), c.final()]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp'; fs.writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 }); fs.renameSync(tmp, file); chown(file);
    cache = all; cacheMt = mtime();
  }
  const find = (all, name) => { const w = noAccent(name); return Object.keys(all).find((k) => noAccent(k) === w) || null; };

  function put(name, url, user, password) {
    name = String(name || '').trim(); url = String(url || '').trim(); user = String(user || '').trim(); password = String(password || '');
    if (!NAME_RE.test(name)) throw new Error('Tên trang 1–40 ký tự, không xuống dòng.');
    let u; try { u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url); } catch (e) { throw new Error('Địa chỉ trang không hợp lệ.'); }
    if (u.protocol !== 'https:') throw new Error('Chỉ lưu trang https (trang http gửi mật khẩu không mã hóa).');
    if (!user || user.length > 120 || /[\x00-\x1f]/.test(user)) throw new Error('Tài khoản không hợp lệ.');
    if (!password || password.length > 128 || /[\x00-\x1f]/.test(password)) throw new Error('Mật khẩu không hợp lệ (không xuống dòng, tối đa 128 ký tự).');
    const all = Object.assign({}, read()), old = find(all, name);
    if (old && old !== name) delete all[old];
    all[name] = { url: u.href, user, password, at: new Date().toISOString() };
    write(all);
    return { name, url: u.href, user };
  }
  const remove = (name) => { const all = Object.assign({}, read()), k = find(all, name); if (!k) return false; delete all[k]; write(all); return true; };
  // Danh sách KHÔNG có mật khẩu
  const list = () => { const a = read(); return Object.keys(a).sort((x, y) => x.localeCompare(y)).map((n) => ({ name: n, url: a[n].url, user: a[n].user, at: a[n].at })); };
  const names = () => list().map((x) => x.name);

  // Mở trang trong Chrome dùng chung, điền tài khoản + mật khẩu, gửi. Trả { ok, text }.
  async function login(name) {
    const all = read(), k = find(all, name);
    if (!k) return { ok: false, text: 'Chưa lưu tài khoản "' + name + '". Đã lưu: ' + (names().join(', ') || '(chưa có)') + '. Thêm: /taikhoan them <tên> <địa chỉ> <tài khoản> <mật khẩu>' };
    if (busy.has(k)) return { ok: false, text: 'Đang đăng nhập "' + k + '" rồi, chờ một chút.' };
    busy.add(k);
    const acc = all[k]; let browser = null, page = null;
    try {
      let pw; try { pw = load(); } catch (e) { return { ok: false, text: 'Thiếu thư viện trình duyệt (' + firstLine(e) + ').' }; }
      try { browser = await pw.chromium.connectOverCDP(await o.endpoint(), { timeout: 30000 }); } catch (e) { return { ok: false, text: 'Không nối được trình duyệt dùng chung: ' + firstLine(e) }; }
      const ctx = browser.contexts()[0] || await browser.newContext();
      page = await ctx.newPage();
      await page.goto(acc.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (settleMs) await page.waitForTimeout(settleMs);
      if (!sameSite(page.url(), acc.url)) {
        // Trang đăng nhập đôi khi chuyển sang máy chủ định danh riêng (SSO) — chỉ cho phép khi ô mật khẩu vẫn nằm trên chính trang đã lưu; ở đây đã sang tên miền khác nên dừng.
        return { ok: false, text: '⚠️ "' + k + '" bị chuyển sang trang khác (' + hostOf(page.url()) + ') — em dừng, không nhập mật khẩu. Kiểm tra lại địa chỉ đã lưu.' };
      }
      const pwd = await page.$('input[type="password"]:visible');
      if (!pwd) return { ok: true, text: '✅ "' + k + '" đã đăng nhập sẵn (không thấy ô mật khẩu). Chrome giữ phiên này.' };
      const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 3000) : '').catch(() => '');
      const hasCaptcha = await page.$('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha').catch(() => null);
      if (hasCaptcha || CHALLENGE_RE.test(body)) return { ok: false, text: '🔐 "' + k + '" đang đòi CAPTCHA/mã xác minh — em không vượt được. Anh tự đăng nhập một lần (qua /tuxa hoặc ngay trên máy), Chrome sẽ giữ phiên.' };
      // ô tài khoản = ô chữ/email/số điện thoại hiện ra gần nhất TRƯỚC ô mật khẩu
      const userSel = await page.evaluateHandle((p) => {
        const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !e.disabled && !e.readOnly; };
        const all = [...document.querySelectorAll('input')].filter((e) => vis(e) && /^(text|email|tel|number|)$/i.test(e.getAttribute('type') || ''));
        const before = all.filter((e) => e.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
        return before[before.length - 1] || null;
      }, pwd);
      const userEl = userSel.asElement();
      if (!userEl) return { ok: false, text: '⚠️ Không thấy ô tài khoản trên trang "' + k + '" (trang đăng nhập hai bước?). Anh đăng nhập tay một lần.' };
      await userEl.click(); await userEl.fill('');
      await userEl.type(acc.user, { delay: 40 + Math.floor(Math.random() * 40) });
      await pwd.click(); await pwd.fill('');
      await pwd.type(acc.password, { delay: 40 + Math.floor(Math.random() * 40) });
      await pwd.press('Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(settleMs + 1500);
      const still = await page.$('input[type="password"]:visible').catch(() => null);
      const after = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 3000) : '').catch(() => '');
      if (still) {
        if (CHALLENGE_RE.test(after)) return { ok: false, text: '🔐 "' + k + '" đòi mã xác minh/OTP sau khi nhập — em dừng. Anh tự nhập mã (qua /tuxa hoặc trên máy).' };
        return { ok: false, text: '❌ "' + k + '": vẫn ở trang đăng nhập — có thể sai tài khoản/mật khẩu, hoặc trang đổi giao diện. Kiểm tra bằng /taikhoan, sửa bằng /taikhoan them (cùng tên).' };
      }
      log('weblogin: đã đăng nhập "' + k + '"');
      return { ok: true, text: '✅ Đã đăng nhập "' + k + '". Chrome giữ phiên, AI vào trang này sẽ thấy đã đăng nhập sẵn.' };
    } catch (e) {
      return { ok: false, text: '⚠️ Lỗi khi đăng nhập "' + k + '": ' + firstLine(e) };
    } finally {
      busy.delete(k);
      if (page) { try { await page.close(); } catch (e) { /* đã đóng */ } }
      if (browser) { try { await browser.close(); } catch (e) { /* chỉ ngắt kết nối */ } }
    }
  }

  // /taikhoan [them <tên> <địa chỉ> <tài khoản> <mật khẩu> | xoa <tên>]  ·  /dangnhap <tên>
  // Trả { text, secret } — secret=true: tin của chủ máy chứa mật khẩu, nơi gọi nên xóa khỏi Telegram.
  async function command(argText) {
    const a = String(argText || '').trim();
    const [verb, ...rest] = a.split(/\s+/);
    const v = noAccent(verb || '');
    try {
      if (!a || v === 'ds' || v === 'list' || v === 'danhsach') {
        const l = list();
        return { text: l.length ? '🔑 Tài khoản web đã lưu (mật khẩu không hiện):\n' + l.map((x) => '• ' + x.name + ' — ' + x.url + ' — ' + x.user).join('\n') + '\nĐăng nhập: /dangnhap <tên>. Xóa: /taikhoan xoa <tên>.' : '🔑 Chưa lưu tài khoản web nào.\nThêm: /taikhoan them <tên> <địa chỉ trang> <tài khoản> <mật khẩu>\nVí dụ: /taikhoan them SoQuy https://soquy.example.vn admin matkhau123\n(Tin có mật khẩu sẽ được xóa khỏi khung chat ngay sau khi lưu.)' };
      }
      if (v === 'them' || v === 'add') {
        if (rest.length < 4) return { text: 'Cú pháp: /taikhoan them <tên, không có dấu cách> <địa chỉ trang> <tài khoản> <mật khẩu>', secret: true };
        const [name, url, user, ...pw] = rest;
        const r = put(name, url, user, pw.join(' '));
        return { text: '🔐 Đã lưu "' + r.name + '" (' + r.url + ', tài khoản ' + r.user + '). Mật khẩu được mã hóa, không hiện lại. Tin của anh có mật khẩu đã được xóa khỏi khung chat — nếu mật khẩu này từng gõ ở chỗ khác thì nên đổi.\nĐăng nhập thử: /dangnhap ' + r.name, secret: true };
      }
      if (v === 'xoa' || v === 'del' || v === 'rm') return { text: remove(rest.join(' ')) ? '🗑️ Đã xóa tài khoản đã lưu.' : 'Không có tài khoản tên đó.' };
      return { text: 'Dùng: /taikhoan (xem danh sách) · /taikhoan them <tên> <địa chỉ> <tài khoản> <mật khẩu> · /taikhoan xoa <tên> · /dangnhap <tên>' };
    } catch (e) { return { text: '⚠️ ' + e.message, secret: noAccent(verb) === 'them' }; }
  }
  async function loginCommand(argText) {
    const a = String(argText || '').trim();
    if (!a) return { text: 'Dùng: /dangnhap <tên trang đã lưu>. Đã lưu: ' + (names().join(', ') || '(chưa có — /taikhoan them ...)') };
    return { text: (await login(a)).text };
  }

  return { put, remove, list, names, login, command, loginCommand, find: (n) => find(read(), n) };
}

module.exports = { createWebLogin, sameSite, hostOf, CHALLENGE_RE };
