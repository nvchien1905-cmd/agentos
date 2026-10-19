#!/usr/bin/env node
'use strict';
// In thông tin để dán NHÃN lên thân máy / hộp: tên Wi-Fi tạm, mật khẩu, mã QR Wi-Fi (điện thoại quét là tự vào mạng) và trang cài đặt.
//   sudo node /opt/agentos/wizard/label.js          in ra màn hình (mã QR dạng ký tự)
//   sudo node /opt/agentos/wizard/label.js --svg    ghi thêm /var/lib/agentos-wizard/label.svg (để in)
// Mỗi máy có SSID/mật khẩu riêng, sinh lần đầu và lưu ở /var/lib/agentos-wizard/hotspot.json (quyền 600).
const fs = require('fs');
const { spawnSync } = require('child_process');
const hotspot = require('./lib/hotspot');

const FILE = process.env.HOTSPOT_FILE || '/var/lib/agentos-wizard/hotspot.json';
const cred = hotspot.credentials(FILE);
const qrText = hotspot.wifiQrText(cred.ssid, cred.psk);
const host = (fs.existsSync('/etc/hostname') ? fs.readFileSync('/etc/hostname', 'utf8').trim() : 'agentos');

console.log('==== NHÃN AgentOS ====');
console.log('Wi-Fi cài đặt : ' + cred.ssid);
console.log('Mật khẩu      : ' + cred.psk);
console.log('Trang cài đặt : http://' + host + '.local:8088  (hoặc tự mở khi vào Wi-Fi trên)');
console.log('');
const ansi = spawnSync('qrencode', ['-t', 'ANSIUTF8', '-m', '1', qrText], { encoding: 'utf8' });
console.log(ansi.status === 0 ? ansi.stdout : '(chưa cài qrencode, mã QR: ' + qrText + ')');
if (process.argv.includes('--svg')) {
  const svg = spawnSync('qrencode', ['-t', 'SVG', '-m', '2', '-s', '8', '-o', '-', qrText], { encoding: 'utf8' });
  if (svg.status === 0) { fs.writeFileSync('/var/lib/agentos-wizard/label.svg', svg.stdout); console.log('Đã ghi /var/lib/agentos-wizard/label.svg'); }
}
