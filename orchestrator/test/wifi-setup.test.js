'use strict';
// agentos-wifi-setup: Wi-Fi tự lưu mật khẩu (kho khóa không mật khẩu) + tự kết nối. Chạy script thật với thư mục/nmcli giả (chỉ Linux, người dùng thường uid >= 1000).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'iso', 'config', 'includes.chroot', 'usr', 'local', 'sbin', 'agentos-wifi-setup');
const can = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() >= 1000;
const t = (name, fn) => test(name, { skip: !can && 'cần Linux và người dùng thường (uid >= 1000)' }, fn);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-'));

function setup() {
  const root = tmp(), bin = path.join(root, 'bin'), homes = path.join(root, 'home'), conf = path.join(root, 'conf.d'), log = path.join(root, 'nmcli.log');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(homes, 'cuahang'), { recursive: true }); fs.mkdirSync(path.join(homes, 'nhanvien'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'nmcli'), '#!/bin/sh\necho "$@" >> "' + log + '"\ncase "$*" in "-t -f UUID,TYPE connection show") printf "u-wifi-1:802-11-wireless\nu-eth:802-3-ethernet\nu-wifi-2:802-11-wireless\n";; esac\nexit 0\n', { mode: 0o755 });
  const run = () => spawnSync('sh', [SCRIPT], { env: Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH, AGENTOS_HOME_ROOT: homes, AGENTOS_NM_CONF_DIR: conf, AGENTOS_WIFI_NO_APT: '1' }), encoding: 'utf8' });
  return { root, homes, conf, log, run, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

t('kho khóa: tạo kho "login" không mật khẩu cho mỗi người dùng, chỉ chủ đọc; có sẵn thì KHÔNG đụng; chạy lại không đổi gì', () => {
  const S = setup();
  fs.mkdirSync(path.join(S.homes, 'nhanvien', '.local', 'share', 'keyrings'), { recursive: true });
  fs.writeFileSync(path.join(S.homes, 'nhanvien', '.local', 'share', 'keyrings', 'login.keyring'), 'KHO-KHOA-CO-MAT-KHAU-RIENG');
  let r = S.run(); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /kho-khóa:/);
  const d = path.join(S.homes, 'cuahang', '.local', 'share', 'keyrings');
  const k = fs.readFileSync(path.join(d, 'login.keyring'), 'utf8');
  assert.match(k, /^\[keyring\]\ndisplay-name=login\nctime=\d+\nmtime=\d+\nlock-on-idle=false\nlock-after=false\n$/);
  assert.equal(fs.readFileSync(path.join(d, 'default'), 'utf8'), 'login');
  assert.equal(fs.statSync(path.join(d, 'login.keyring')).mode & 0o777, 0o600); assert.equal(fs.statSync(d).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(S.homes, 'nhanvien', '.local', 'share', 'keyrings', 'login.keyring'), 'utf8'), 'KHO-KHOA-CO-MAT-KHAU-RIENG');       // kho khóa người dùng tự đặt mật khẩu: giữ nguyên
  r = S.run(); assert.equal(r.status, 0); assert.match(r.stdout, /không có gì cần đổi/);                                                                      // lần 2: không đổi gì
  assert.equal(fs.readFileSync(path.join(d, 'login.keyring'), 'utf8'), k);
});

t('Wi-Fi: chỉ mạng Wi-Fi được bật tự kết nối (không đụng mạng dây); mỗi mạng thử lại mãi mãi; NetworkManager tắt tiết kiệm điện Wi-Fi; nạp lại cấu hình', () => {
  const S = setup(); const r = S.run(); assert.equal(r.status, 0, r.stderr);
  const c = S.calls();
  assert.ok(c.includes('connection modify u-wifi-1 connection.autoconnect yes connection.autoconnect-retries 0') && c.includes('connection modify u-wifi-2 connection.autoconnect yes connection.autoconnect-retries 0'), c.join(' | '));
  assert.ok(!c.some((x) => /u-eth/.test(x) && /modify/.test(x)));
  const conf = fs.readFileSync(path.join(S.conf, '50-agentos-wifi.conf'), 'utf8');
  assert.match(conf, /^\[connection\]$/m); assert.match(conf, /^wifi\.powersave=2$/m); assert.ok(!/autoconnect-retries/.test(conf), 'khóa này không hợp lệ trong NetworkManager.conf (NM cảnh báo unknown key)');
  assert.ok(c.includes('general reload'));
  const before = S.calls().filter((x) => x === 'general reload').length; S.run();
  assert.equal(S.calls().filter((x) => x === 'general reload').length, before, 'cấu hình không đổi thì không nạp lại');
});

t('bộ cài: ISO mới có kho khóa trống trong /etc/skel, cấu hình NetworkManager, gói gnome-keyring và KHÔNG gỡ nó; bản cập nhật gọi script', () => {
  const R = path.join(__dirname, '..', '..');
  const skel = path.join(R, 'iso/config/includes.chroot/etc/skel/.local/share/keyrings');
  assert.match(fs.readFileSync(path.join(skel, 'login.keyring'), 'utf8'), /^\[keyring\]\ndisplay-name=login\n/); assert.equal(fs.readFileSync(path.join(skel, 'default'), 'utf8'), 'login');
  assert.ok(!/secret=/.test(fs.readFileSync(path.join(skel, 'login.keyring'), 'utf8')), 'không để lọt mật khẩu nào vào ISO');
  assert.match(fs.readFileSync(path.join(R, 'iso/config/includes.chroot/etc/NetworkManager/conf.d/50-agentos-wifi.conf'), 'utf8'), /wifi\.powersave=2/);
  const pk = fs.readFileSync(path.join(R, 'iso/config/package-lists/agentos.list.chroot'), 'utf8'); for (const p of ['gnome-keyring', 'libpam-gnome-keyring', 'libsecret-tools']) assert.match(pk, new RegExp('^' + p + '$', 'm'));
  assert.ok(!/apt-get purge[^\n]*gnome-keyring/.test(fs.readFileSync(path.join(R, 'iso/config/hooks/normal/0260-apps.hook.chroot'), 'utf8')));
  assert.match(fs.readFileSync(path.join(R, 'update/apply.sh'), 'utf8'), /agentos-wifi-setup/);
});
