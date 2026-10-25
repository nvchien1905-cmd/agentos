'use strict';
const dgram = require('dgram');
const os = require('os');

// BẬT MÁY KHÁC trong mạng nhà bằng Wake-on-LAN (gói "magic packet"). Máy này không tự bật được chính nó khi đã tắt hẳn
// (đã tắt thì không còn chạy bot): muốn vậy phải đặt BIOS "Power On After AC Loss" hoặc dùng ổ cắm hẹn giờ.
// Máy cần bật phải bật WoL trong BIOS/card mạng.
const MAC = /^([0-9a-f]{2})[:\-.]?([0-9a-f]{2})[:\-.]?([0-9a-f]{2})[:\-.]?([0-9a-f]{2})[:\-.]?([0-9a-f]{2})[:\-.]?([0-9a-f]{2})$/i;
const parseMac = (s) => { const m = String(s || '').trim().match(MAC); return m ? m.slice(1).map((x) => x.toLowerCase()).join(':') : null; };
const magic = (mac) => { const b = Buffer.from(mac.replace(/:/g, ''), 'hex'); return Buffer.concat([Buffer.alloc(6, 0xff)].concat(Array(16).fill(b))); };

// Địa chỉ phát sóng của các mạng con đang nối (để gói tới được đúng mạng nhà), cộng 255.255.255.255
function broadcasts() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const ip = a.address.split('.').map(Number), mk = a.netmask.split('.').map(Number);
    out.add(ip.map((x, i) => (x | (~mk[i] & 255))).join('.'));
  }
  return [...out];
}

function send(macText, opts) {
  opts = opts || {};
  const mac = parseMac(macText);
  if (!mac) return Promise.resolve({ ok: false, error: 'Địa chỉ MAC không hợp lệ (ví dụ AA:BB:CC:DD:EE:FF).' });
  const pkt = magic(mac), targets = opts.targets || broadcasts();
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('error', (e) => { try { s.close(); } catch (x) { /* đã đóng */ } resolve({ ok: false, error: e.message }); });
    s.bind(0, () => {
      try { s.setBroadcast(true); } catch (e) { /* bỏ qua */ }
      let left = targets.length * 2;
      const done = () => { if (--left <= 0) { try { s.close(); } catch (e) { /* đã đóng */ } resolve({ ok: true, mac, targets }); } };
      for (const t of targets) for (const port of [9, 7]) s.send(pkt, port, t, () => done());
    });
  });
}

module.exports = { parseMac, magic, broadcasts, send };
