'use strict';

// NetworkManager (nmcli) cho bước Wi-Fi. `run(cmd, args, opts)` -> Promise<{ code, out, err }> được tiêm vào để test không cần nmcli.

// Tách một dòng đầu ra dạng -t của nmcli: các trường cách nhau ':' và ':' trong giá trị được thoát thành '\:'.
function splitTerse(line) {
  const out = []; let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
    if (c === ':') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// `nmcli -t -f SSID,SIGNAL,SECURITY dev wifi list` -> [{ ssid, signal, secured }], bỏ SSID rỗng/trùng (giữ sóng mạnh nhất).
function parseWifiList(text) {
  const best = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ssid, signal, security] = splitTerse(line);
    if (!ssid) continue;
    const item = { ssid, signal: Number(signal) || 0, secured: !!security && security !== '--' };
    const old = best.get(ssid);
    if (!old || item.signal > old.signal) best.set(ssid, item);
  }
  return [...best.values()].sort((a, b) => b.signal - a.signal);
}

// `nmcli -t -f DEVICE,TYPE,STATE dev` -> [{ device, type, state }]
function parseDevices(text) {
  return String(text || '').split(/\r?\n/).filter(Boolean).map(splitTerse).map(([device, type, state]) => ({ device, type, state }));
}

async function status(run) {
  const conn = await run('nmcli', ['-t', '-f', 'CONNECTIVITY', 'general']);
  const dev = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'dev']);
  const devices = parseDevices(dev.out);
  return {
    connectivity: conn.code === 0 ? conn.out.trim() : 'unknown',
    online: conn.code === 0 && conn.out.trim() === 'full',
    hasWifi: devices.some((d) => d.type === 'wifi'),
    hasEthernet: devices.some((d) => d.type === 'ethernet' && d.state === 'connected'),
  };
}

async function scan(run) {
  await run('nmcli', ['dev', 'wifi', 'rescan']);            // lỗi (quá thường xuyên) bỏ qua
  const r = await run('nmcli', ['-t', '-f', 'SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list']);
  return r.code === 0 ? parseWifiList(r.out) : [];
}

// Kết nối Wi-Fi. SSID/mật khẩu truyền bằng mảng tham số (không qua shell). Mật khẩu không bao giờ ghi vào log.
async function connect(run, ssid, password) {
  if (!ssid || /[\0\n\r]/.test(ssid)) throw new Error('Tên Wi-Fi không hợp lệ');
  if (password != null && /[\0\n\r]/.test(password)) throw new Error('Mật khẩu Wi-Fi không hợp lệ');
  const args = ['--wait', '25', 'dev', 'wifi', 'connect', ssid];
  if (password) args.push('password', password);
  const r = await run('nmcli', args, { secret: true });
  if (r.code !== 0) {
    const why = /secrets were required|no secrets|invalid/i.test(r.err + r.out) ? 'Sai mật khẩu hoặc không kết nối được' : 'Không kết nối được Wi-Fi này';
    throw new Error(why);
  }
  return true;
}

module.exports = { splitTerse, parseWifiList, parseDevices, status, scan, connect };
