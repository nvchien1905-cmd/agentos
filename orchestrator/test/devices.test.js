'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { createDevices, isLocalHost, maskUrl } = require('../src/devices');
const { createBot } = require('../src/bot');
const { createQuick } = require('../src/quick');
const { openDb } = require('../src/db');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dv-'));
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-data')]);

// Máy chủ HTTP giả cho camera/ổ cắm; ghi lại các yêu cầu
async function fakeServer(handler) {
  const reqs = []; const s = http.createServer((req, res) => { let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => { reqs.push({ method: req.method, url: req.url, auth: req.headers.authorization, body }); handler(req, res, body); }); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r)); return { port: s.address().port, reqs, close: () => new Promise((r) => s.close(r)) };
}
const mk = (extra) => createDevices(Object.assign({ file: path.join(tmp(), 'd.json'), outDir: tmp() }, extra || {}));

test('thiết bị: chỉ nhận địa chỉ NỘI BỘ (mạng nhà/Tailscale), từ chối địa chỉ Internet; địa chỉ có tài khoản được che', () => {
  for (const ok of ['192.168.1.5', '10.0.0.7', '172.16.3.1', '172.31.255.1', '100.64.0.2', '100.127.1.1', '127.0.0.1', 'localhost', 'cam.local']) assert.equal(isLocalHost(ok), true, ok);
  for (const bad of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.1.1', 'camera.example.com', '1.2.3']) assert.equal(isLocalHost(bad), false, bad);
  const D = mk();
  assert.throws(() => D.addCamera({ name: 'ngoai', url: 'rtsp://8.8.8.8/live' }), /Internet/); assert.throws(() => D.addCamera({ name: 'x', url: 'file:///etc/passwd' }), /bắt đầu bằng/); assert.throws(() => D.addCamera({ name: '<b>', url: 'rtsp://192.168.1.2' }), /Tên/);
  const r = D.addCamera({ name: 'Cửa hàng', url: 'rtsp://admin:matkhau123@192.168.1.20:554/stream1' }); assert.equal(r.url, 'rtsp://***@192.168.1.20:554/stream1');
  assert.ok(!JSON.stringify(D.list()).includes('matkhau123'), 'danh sách không lộ mật khẩu camera'); assert.equal(maskUrl('http://a:b@10.0.0.1/x'), 'http://***@10.0.0.1/x');
  assert.throws(() => D.addCamera({ name: 'cửa hàng', url: 'rtsp://192.168.1.21' }), /Đã có/);
  assert.throws(() => D.addPlug({ name: 'p', type: 'homeassistant', url: 'http://192.168.1.2:8123', entity: 'Sai Dinh Dang', token: 'x' }), /switch\./); assert.throws(() => D.addPlug({ name: 'p', type: 'tasmota', url: 'http://1.1.1.1' }), /Internet/);
});

test('camera: chụp qua địa chỉ HTTP (có tài khoản → Basic auth, kiểm ảnh thật), lỗi/không phải ảnh báo rõ; RTSP dùng ffmpeg, thiếu ffmpeg/lỗi báo rõ và không lộ mật khẩu', async () => {
  const S = await fakeServer((req, res) => { if (req.url === '/snap.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(JPG); } else if (req.url === '/html') { res.end('<html>login</html>'); } else { res.writeHead(401); res.end(); } });
  const dir = tmp(); const calls = []; let ff = 'ok';
  const D = mk({ outDir: dir, run: async (bin, args) => { calls.push([bin, args]); if (ff === 'missing') return { code: 1, missing: true, err: '' }; if (ff === 'fail') return { code: 1, err: 'Connection refused rtsp://admin:matkhau@192.168.1.20/s1\n', out: '' }; fs.writeFileSync(args[args.length - 1], JPG); return { code: 0, out: '', err: '' }; } });
  try {
    D.addCamera({ name: 'Quầy', url: 'http://thu:mk@127.0.0.1:' + S.port + '/snap.jpg' }); D.addCamera({ name: 'Hỏng', url: 'http://127.0.0.1:' + S.port + '/html' }); D.addCamera({ name: 'Sai', url: 'http://127.0.0.1:' + S.port + '/khong-co' }); D.addCamera({ name: 'Kho', url: 'rtsp://admin:matkhau@192.168.1.20/s1' });
    const s = await D.snapshot('quầy'); assert.ok(fs.readFileSync(s.file).equals(JPG)); assert.match(path.basename(s.file), /^camera-Qu.*\.jpg$/); assert.equal(S.reqs[0].auth, 'Basic ' + Buffer.from('thu:mk').toString('base64'));
    await assert.rejects(D.snapshot('Hỏng'), /không trả về ảnh/); await assert.rejects(D.snapshot('Sai'), /trả lỗi 401/); await assert.rejects(D.snapshot('Không có'), /Không có camera/);
    const k = await D.snapshot('Kho'); assert.ok(fs.existsSync(k.file)); assert.equal(calls[0][0], 'ffmpeg'); assert.ok(calls[0][1].includes('rtsp://admin:matkhau@192.168.1.20/s1')); assert.ok(calls[0][1].includes('tcp'));
    ff = 'missing'; await assert.rejects(D.snapshot('Kho'), /chưa cài ffmpeg/); ff = 'fail'; await assert.rejects(D.snapshot('Kho'), (e) => /Không lấy được ảnh/.test(e.message) && !e.message.includes('matkhau'));
  } finally { await S.close(); }
});

test('ổ cắm/đèn thông minh: Shelly (đời 1 và 2), Tasmota, Home Assistant, địa chỉ tự đặt — gửi đúng yêu cầu và đọc đúng trạng thái', async () => {
  let on = false;
  const S = await fakeServer((req, res, body) => {
    const u = new URL(req.url, 'http://x'); res.setHeader('content-type', 'application/json');
    if (u.pathname === '/relay/0') { if (u.searchParams.get('turn')) on = u.searchParams.get('turn') === 'on'; return res.end(JSON.stringify({ ison: on })); }
    if (u.pathname === '/rpc/Switch.Set') { on = u.searchParams.get('on') === 'true'; return res.end('{}'); }
    if (u.pathname === '/rpc/Switch.GetStatus') return res.end(JSON.stringify({ output: on }));
    if (u.pathname === '/cm') { const c = u.searchParams.get('cmnd'); if (/on$/i.test(c)) on = true; if (/off$/i.test(c)) on = false; return res.end(JSON.stringify({ POWER: on ? 'ON' : 'OFF' })); }
    if (u.pathname === '/api/states/switch.den_kho') return res.end(JSON.stringify({ state: on ? 'on' : 'off' }));
    if (u.pathname === '/api/services/switch/turn_on') { on = true; return res.end('[]'); } if (u.pathname === '/api/services/switch/turn_off') { on = false; return res.end('[]'); }
    if (u.pathname === '/bat') { on = true; return res.end('ok'); } if (u.pathname === '/tat') { on = false; return res.end('ok'); } if (u.pathname === '/tt') return res.end(on ? 'state: on' : 'state: off');
    res.writeHead(404); res.end('{}');
  });
  const D = mk(); const base = 'http://127.0.0.1:' + S.port;
  try {
    D.addPlug({ name: 'S1', type: 'shelly', url: base }); D.addPlug({ name: 'S2', type: 'shelly2', url: base }); D.addPlug({ name: 'T', type: 'tasmota', url: base }); D.addPlug({ name: 'HA', type: 'homeassistant', url: base, entity: 'switch.den_kho', token: 'TOKEN123' });
    D.addPlug({ name: 'U', type: 'url', onUrl: base + '/bat', offUrl: base + '/tat', statusUrl: base + '/tt' }); D.addPlug({ name: 'U2', type: 'url', onUrl: base + '/bat', offUrl: base + '/tat' });
    for (const n of ['S1', 'S2', 'T', 'HA', 'U']) { assert.deepEqual(await D.plug(n, 'on'), { on: true }, n + ' bật'); assert.deepEqual(await D.plug(n, 'status'), { on: true }, n + ' xem'); assert.deepEqual(await D.plug(n, 'off'), { on: false }, n + ' tắt'); assert.deepEqual(await D.plug(n, 'status'), { on: false }); }
    assert.deepEqual(await D.plug('U2', 'status'), { on: null }); assert.deepEqual(await D.plug('u2', 'on'), { on: true });
    assert.ok(S.reqs.some((r) => r.url.startsWith('/api/services/switch/turn_on') && r.auth === 'Bearer TOKEN123' && JSON.parse(r.body).entity_id === 'switch.den_kho'), 'Home Assistant: đúng mã truy cập và thực thể');
    assert.ok(!JSON.stringify(D.list()).includes('TOKEN123'), 'danh sách không lộ mã truy cập');
    await assert.rejects(D.plug('S1', 'reboot'), /bat, tat/); await assert.rejects(D.plug('Không có', 'on'), /Không có thiết bị/);
  } finally { await S.close(); }
});

test('Telegram /dien và /camera: chỉ chủ máy; bật/tắt/xem; camera gửi ảnh, có câu hỏi thì giao AI kèm ảnh', async () => {
  const S = await fakeServer((req, res) => { if (req.url === '/snap.jpg') { res.writeHead(200); res.end(JPG); } else if (req.url.startsWith('/relay/0')) { res.end(JSON.stringify({ ison: /turn=on/.test(req.url) })); } else { res.writeHead(404); res.end(); } });
  const D = mk(); const base = 'http://127.0.0.1:' + S.port; D.addCamera({ name: 'Cửa hàng', url: base + '/snap.jpg' }); D.addCamera({ name: 'Kho', url: base + '/snap.jpg' }); D.addPlug({ name: 'Đèn kho', type: 'shelly', url: base });
  const db = openDb(':memory:'); const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const quick = createQuick({ iot: D });
  const bot = createBot({ db, worker, allowed: new Set(['111', '222']), profiles: [], isAdmin: (u) => String(u) === '111', quietAck: true, iot: D, quick });
  const say = (u, t) => bot.handle({ from: { id: u }, chat: { id: u, type: 'private' }, text: t });
  try {
    assert.match(await say(222, '/camera Kho'), /Chỉ chủ máy/); assert.match(await say(222, '/dien Đèn kho bat'), /chỉ dành cho quản trị viên/);
    assert.match(await say(111, '/dien'), /Đèn kho \(shelly\)/); assert.match(await say(111, '/dien Đèn kho bat'), /💡 Đèn kho: ĐANG BẬT/); assert.match(await say(111, '/dien Đèn kho tat'), /⚫ Đèn kho: đang tắt/); assert.match(await say(111, '/dien Không có xem'), /Không có thiết bị/); assert.match(await say(111, '/dien chỉ tên'), /Cách dùng/);
    assert.match(await say(111, '/camera'), /Camera: Cửa hàng, Kho/); const r = await say(111, '/camera Kho'); assert.match(r.text, /📷 Kho lúc \d\d:\d\d/); assert.equal(r.files[0].kind, 'photo'); assert.ok(fs.existsSync(r.files[0].path));
    const q = await say(111, '/camera Cửa hàng đang có mấy khách?'); assert.match(q.text, /Cửa hàng lúc/); const j = db.recentJobs('111', 1)[0]; assert.match(j.prompt, /Camera "Cửa hàng".*đang có mấy khách/); assert.match(j.prompt, /- Ảnh: .*camera-.*\.jpg/); assert.equal(j.project, null);
    assert.match(await say(111, '/camera Phòng ngủ'), /Không có camera/);
  } finally { await S.close(); }
});
