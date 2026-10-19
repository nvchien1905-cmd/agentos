'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Wi-Fi tạm do máy tự phát (NetworkManager chế độ AP + dnsmasq "shared"), để điện thoại vào cài đặt mà không cần màn hình/bàn phím.
// Địa chỉ máy trong mạng tạm luôn là 10.42.0.1 (mặc định của NetworkManager).
const HOTSPOT_IP = '10.42.0.1';
const CON_NAME = 'AgentOS-Setup';

// Tên mạng + mật khẩu riêng cho từng máy, sinh ngẫu nhiên lần đầu và lưu lại (để in nhãn QR dán lên thân máy).
function credentials(file, rnd) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && c.ssid && c.psk) return c;
  } catch (e) { /* chưa có */ }
  const r = rnd || ((n) => crypto.randomBytes(n));
  const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';                // bỏ ký tự dễ nhầm (i l o 0 1)
  const pick = (n) => Array.from(r(n)).map((b) => ALPHA[b % ALPHA.length]).join('');
  const c = { ssid: 'AgentOS-' + Array.from(r(2)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(), psk: pick(10) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c), { mode: 0o600 });
  return c;
}

// Chuỗi QR chuẩn Wi-Fi: điện thoại quét bằng camera là tự nối mạng.
function wifiQrText(ssid, psk) {
  const esc = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
  return 'WIFI:T:WPA;S:' + esc(ssid) + ';P:' + esc(psk) + ';;';
}

async function wifiDevice(run) {
  const r = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'dev']);
  if (r.code !== 0) return null;
  for (const line of r.out.split('\n')) {
    const [device, type, state] = line.split(':');
    if (type === 'wifi' && state && state !== 'unmanaged' && state !== 'unavailable') return device;
  }
  return null;
}

async function up(run, cred, ifname) {
  ifname = ifname || await wifiDevice(run);
  if (!ifname) throw new Error('Máy không có card Wi-Fi dùng được');
  await run('nmcli', ['con', 'delete', CON_NAME]);                 // bỏ cấu hình cũ nếu có (lỗi bỏ qua)
  const add = await run('nmcli', ['con', 'add', 'type', 'wifi', 'ifname', ifname, 'con-name', CON_NAME, 'autoconnect', 'no',
    'ssid', cred.ssid, 'mode', 'ap', 'ipv4.method', 'shared', 'ipv4.addresses', HOTSPOT_IP + '/24',
    'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', cred.psk], { secret: true });
  if (add.code !== 0) throw new Error('Không tạo được Wi-Fi tạm: ' + String(add.err || add.out).trim().slice(0, 160));
  const act = await run('nmcli', ['--wait', '30', 'con', 'up', CON_NAME, 'ifname', ifname]);
  if (act.code !== 0) { await run('nmcli', ['con', 'delete', CON_NAME]); throw new Error('Card Wi-Fi không phát được mạng (có thể không hỗ trợ chế độ AP): ' + String(act.err || act.out).trim().slice(0, 160)); }
  return ifname;
}

async function down(run) {
  await run('nmcli', ['con', 'down', CON_NAME]);
  await run('nmcli', ['con', 'delete', CON_NAME]);
}

async function isUp(run) {
  const r = await run('nmcli', ['-t', '-f', 'NAME,STATE', 'con', 'show', '--active']);
  return r.code === 0 && r.out.split('\n').some((l) => l.startsWith(CON_NAME + ':') && /activated/.test(l));
}

module.exports = { HOTSPOT_IP, CON_NAME, credentials, wifiQrText, wifiDevice, up, down, isUp };
