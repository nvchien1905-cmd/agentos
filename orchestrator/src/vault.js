'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// KHO MẬT KHẨU MÁY TỪ XA (RustDesk): chủ máy nhập ID + mật khẩu MỘT lần ở Cài đặt AgentOS → "Máy từ xa"; sau đó /vao <máy> tự đăng nhập.
//  - mã hóa AES-256-GCM; khóa mã hóa là tệp RIÊNG (keyFile, 0600) nằm NGOÀI thư mục dữ liệu → bản sao lưu/OneDrive của thư mục dữ liệu không chứa khóa;
//  - mật khẩu KHÔNG bao giờ trả ra ngoài qua list()/Cài đặt/Telegram; chỉ lệnh cố định (/vao → trợ lý màn hình) gọi secret();
//  - AI không có lệnh nào đọc được kho (và trong sandbox thư mục dữ liệu bị che).
const NAME_RE = /^[^\x00-\x1f]{1,40}$/;
const ID_RE = /^[A-Za-z0-9._@:-]{4,64}$/;                 // ID RustDesk (số) hoặc ID@máy-chủ-riêng
const noAccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function createVault(o) {
  const file = o.file, keyFile = o.keyFile;
  const chown = o.chown || (() => {});
  let cache = null, cacheMt = -1;       // cache theo thời điểm sửa tệp: Cài đặt (tiến trình khác) ghi thì bộ điều phối đọc lại
  const mtime = () => { try { return fs.statSync(file).mtimeMs; } catch (e) { return 0; } };

  function key() {
    let k = null;
    try { k = fs.readFileSync(keyFile); } catch (e) { /* chưa có */ }
    if (k && k.length === 32) return k;
    k = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile, k, { mode: 0o600 }); chown(keyFile);
    return k;
  }
  function load() {
    if (cache && mtime() === cacheMt) return cache;
    cacheMt = mtime();
    let raw = null; try { raw = fs.readFileSync(file); } catch (e) { cache = {}; return cache; }
    try {
      const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
      const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
      cache = JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
    } catch (e) { throw new Error('Không mở được kho mật khẩu (sai khóa hoặc tệp hỏng). Tệp: ' + file); }
    return cache;
  }
  function save(all) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const enc = Buffer.concat([c.update(JSON.stringify(all), 'utf8'), c.final()]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp'; fs.writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 }); fs.renameSync(tmp, file); chown(file);
    cache = all; cacheMt = mtime();
  }
  const find = (all, name) => { const w = noAccent(name); return Object.keys(all).find((k) => noAccent(k) === w) || null; };

  return {
    // Danh sách KHÔNG có mật khẩu
    list() { const a = load(); return Object.keys(a).sort((x, y) => x.localeCompare(y)).map((n) => ({ name: n, id: a[n].id, note: a[n].note || '', hasPassword: !!a[n].password, at: a[n].at || '' })); },
    has(name) { return !!find(load(), name); },
    // Thêm/sửa. Sửa mà để trống mật khẩu = giữ mật khẩu cũ.
    put(name, v) {
      name = String(name || '').trim(); v = v || {};
      if (!NAME_RE.test(name)) throw new Error('Tên máy 1–40 ký tự.');
      const id = String(v.id || '').trim().replace(/\s+/g, '');
      if (!ID_RE.test(id)) throw new Error('ID RustDesk không hợp lệ (số, vd 264372510).');
      const all = Object.assign({}, load()), old = find(all, name);
      const password = v.password ? String(v.password) : (old ? all[old].password : '');
      if (!password) throw new Error('Cần nhập mật khẩu RustDesk của máy này.');
      if (/[\x00-\x1f]/.test(password) || password.length > 128 || password.startsWith('-')) throw new Error('Mật khẩu không hợp lệ (không xuống dòng, không bắt đầu bằng "-", tối đa 128 ký tự).');
      if (old && old !== name) delete all[old];
      all[name] = { id, password, note: String(v.note || '').slice(0, 120), at: new Date().toISOString() };
      save(all);
      return { name, id };
    },
    remove(name) { const all = Object.assign({}, load()), k = find(all, name); if (!k) return false; delete all[k]; save(all); return true; },
    // CHỈ cho lệnh cố định (/vao): trả { name, id, password }
    secret(name) {
      const all = load(), k = find(all, name); if (!k) return null;
      return { name: k, id: all[k].id, password: all[k].password };
    },
    // Tìm máy theo chữ gõ (không dấu, khớp đúng hoặc là phần của tên duy nhất)
    match(text) {
      const a = load(), w = noAccent(text); if (!w) return { list: Object.keys(a) };
      const names = Object.keys(a), exact = names.filter((n) => noAccent(n) === w);
      if (exact.length === 1) return { name: exact[0] };
      const part = names.filter((n) => noAccent(n).includes(w));
      return part.length === 1 ? { name: part[0] } : { list: part.length ? part : names, many: part.length > 1 };
    },
    // Nhập từ tệp rõ cũ (rustdesk-may-con.json do /ketnoi tạo): { tên: {id,password} } rồi XÓA tệp rõ
    importPlain(plainFile) {
      let j; try { j = JSON.parse(fs.readFileSync(plainFile, 'utf8')); } catch (e) { return 0; }
      let n = 0;
      for (const [name, v] of Object.entries(j || {})) { try { if (!this.has(name)) { this.put(name, { id: v.id, password: v.password, note: 'từ /ketnoi' }); n++; } } catch (e) { /* bỏ mục hỏng */ } }
      try { fs.rmSync(plainFile, { force: true }); } catch (e) { /* không xóa được */ }
      return n;
    },
  };
}

module.exports = { createVault, ID_RE };
