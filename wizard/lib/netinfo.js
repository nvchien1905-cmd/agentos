'use strict';
const os = require('os');

// Địa chỉ mạng của máy để hiện cho người dùng (mã QR / địa chỉ cho điện thoại).
function lanAddresses(ifaces) {
  ifaces = ifaces || os.networkInterfaces();
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(docker|veth|br-|virbr|vbox|vmnet|tailscale|zt)/.test(name)) continue;
      out.push({ name, address: a.address });
    }
  }
  // Card mạng thật (eth/en/wl) lên đầu để mã QR dùng địa chỉ mà điện thoại tới được
  const real = (n) => (/^(eth|en|wl)/.test(n) ? 0 : 1);
  return out.sort((a, b) => real(a.name) - real(b.name));
}

function hostLabel(hostname) {
  const h = String(hostname || os.hostname()).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return h ? h + '.local' : null;
}

// Host trong tiêu đề HTTP: chỉ nhận IP, localhost và tên .local (chặn DNS rebinding từ tên miền lạ).
function hostAllowed(hostHeader) {
  const h = String(hostHeader || '').replace(/:\d+$/, '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || /\.local$/.test(h)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^\[[0-9a-f:]+\]$/.test(h)) return true;
  return false;
}

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

module.exports = { lanAddresses, hostLabel, hostAllowed, isLoopback };
