'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDesk } = require('../server');

// Màn hình ảo riêng từng ID ("slot"): dùng lệnh giả, không cần quyền root hay Xvfb thật.
function setup(extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-'));
  const vd = { dir: path.join(root, 'vd'), runDir: path.join(root, 'run'), sockDir: path.join(root, 'x11'), base: 40, max: 2, waitMs: 500, geometry: '800x600x24' };
  fs.mkdirSync(vd.sockDir, { recursive: true });
  const calls = [], detached = [], users = new Map(), alive = new Set();
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts && opts.env });
    if (cmd === 'id') return users.has(args[1]) ? { code: 0, out: String(users.get(args[1])) + '\n', err: '' } : { code: 1, out: '', err: 'no such user' };
    if (cmd === 'useradd') { users.set(args[args.length - 1], 2000 + users.size); fs.mkdirSync(args[args.indexOf('--home-dir') + 1], { recursive: true }); return { code: 0, out: '', err: '' }; }   // useradd --create-home tạo thư mục nhà
    if (cmd === 'pgrep') return { code: alive.has(args[1] + ':' + args[3]) ? 0 : 1, out: '', err: '' };
    if (cmd === 'pkill') return { code: 0, out: '', err: '' };
    if (cmd === 'runuser' && args.includes('scrot')) { fs.writeFileSync(args[args.length - 1], 'png'); return { code: 0, out: '', err: '' }; }
    if (cmd === 'loginctl' || cmd === 'getent') return { code: 0, out: '', err: '' };
    return { code: 0, out: '', err: '' };
  };
  const detach = (cmd, args) => {
    detached.push({ cmd, args });
    const u = args[args.indexOf('-u') + 1];
    if (args.includes('Xvfb')) { const d = args[args.indexOf('Xvfb') + 1]; fs.writeFileSync(path.join(vd.sockDir, 'X' + d.slice(1)), ''); alive.add(u + ':Xvfb'); }
    if (args.includes('xfwm4')) alive.add(u + ':xfwm4');
    return 4242;
  };
  const physical = { id: '3', uid: '1000', user: 'user', display: ':0', home: '/home/user', active: true, xauth: '' };
  const desk = createDesk(Object.assign({ run, detach, vd, outDir: root, sleep: async () => {}, wmWaitMs: 0, session: async () => physical }, extra || {}));
  return { desk, calls, detached, users, root, vd };
}
const shotCall = (calls, display) => calls.filter((c) => c.cmd === 'runuser' && c.args.includes('scrot') && c.args.includes('DISPLAY=' + display));

test('slot: ID thường có màn hình ảo riêng (tài khoản agv<n>, Xvfb :<40+n>, xfwm4), chụp bằng đúng tài khoản đó và chép ảnh ra thư mục ảnh', async () => {
  const E = setup();
  const r = await E.desk.handle({ cmd: 'screenshot', slot: '111' });
  assert.equal(r.ok, true, r.error); assert.ok(fs.existsSync(r.file), 'ảnh đã chép ra');
  const useradd = E.calls.find((c) => c.cmd === 'useradd'); assert.ok(useradd.args.includes('agv1') && useradd.args.includes('--system') && useradd.args.includes('/usr/sbin/nologin'));
  const xvfb = E.detached.find((d) => d.args.includes('Xvfb')); assert.deepEqual(xvfb.args.slice(0, 3), ['-u', 'agv1', '--']); assert.ok(xvfb.args.includes(':41') && xvfb.args.includes('800x600x24') && xvfb.args.includes('-nolisten'));
  assert.ok(E.detached.some((d) => d.args.includes('xfwm4') && d.args.includes('DISPLAY=:41')));
  assert.equal(shotCall(E.calls, ':41').length, 1);
  assert.equal(E.calls.some((c) => c.cmd === 'scrot'), false, 'không chụp trực tiếp bằng root/người ngồi máy');
});

test('slot: mỗi ID một màn hình khác nhau; dùng lại slot cũ không tạo lại; chạy song song không lẫn lộn (hai yêu cầu cùng lúc)', async () => {
  const E = setup();
  const [a, b] = await Promise.all([E.desk.handle({ cmd: 'screenshot', slot: '111' }), E.desk.handle({ cmd: 'screenshot', slot: '222' })]);
  assert.ok(a.ok && b.ok, (a.error || '') + (b.error || ''));
  assert.equal(shotCall(E.calls, ':41').length, 1); assert.equal(shotCall(E.calls, ':42').length, 1);
  assert.deepEqual(E.calls.filter((c) => c.cmd === 'useradd').map((c) => c.args[c.args.length - 1]).sort(), ['agv1', 'agv2']);
  const before = E.calls.filter((c) => c.cmd === 'useradd').length, bx = E.detached.length;
  await E.desk.handle({ cmd: 'screenshot', slot: '111' });
  assert.equal(E.calls.filter((c) => c.cmd === 'useradd').length, before); assert.equal(E.detached.length, bx, 'màn hình đang chạy: không khởi động lại');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(E.vd.dir, 'slots.json'), 'utf8')), { 111: 1, 222: 2 });
  const full = await E.desk.handle({ cmd: 'screenshot', slot: '333' });
  assert.equal(full.ok, false); assert.match(full.error, /Đã đủ 2 màn hình riêng/);
});

test('slot: không có slot thì vẫn là màn hình THẬT của người ngồi máy như cũ (xdotool chạy với DISPLAY=:0)', async () => {
  const E = setup();
  await E.desk.handle({ cmd: 'key', key: 'Return' });
  const c = E.calls.find((x) => x.cmd === 'xdotool'); assert.ok(c); assert.equal(c.env.DISPLAY, ':0');
  assert.equal(E.calls.some((x) => x.cmd === 'useradd' || x.cmd === 'pgrep'), false);
});

test('slot: lệnh gõ/bấm/mở ứng dụng chạy bằng tài khoản của slot (hồ sơ riêng, bỏ runAs agentos); RustDesk nối trong màn hình ảo của ID đó', async () => {
  const E = setup();
  await E.desk.handle({ cmd: 'key', key: 'ctrl+l', slot: '111' }); await E.desk.handle({ cmd: 'type', text: 'xin chao', slot: '111' });
  const xd = E.calls.filter((c) => c.cmd === 'runuser' && c.args.includes('xdotool')); assert.ok(xd.length >= 2); assert.ok(xd.every((c) => c.args.includes('DISPLAY=:41') && c.args[1] === 'agv1'));
  const o = await E.desk.handle({ cmd: 'open', app: 'fbbot', slot: '111' }); assert.equal(o.ok, true, o.error);
  const app = E.detached.filter((d) => d.args.includes('/usr/bin/google-chrome-stable')).pop(); assert.equal(app.args[1], 'agv1'); assert.ok(!app.args.includes('agentos'));
  assert.equal(E.calls.some((c) => c.args && c.args.some((a) => /xhost/.test(String(a)))), false, 'không mở quyền vẽ lên màn hình thật');
  const rd = await E.desk.handle({ cmd: 'rdconnect', id: '264372510', password: 'pw', slot: '222' }); assert.equal(rd.ok, true, rd.error);
  const rdp = E.detached.filter((d) => d.args.includes('/usr/bin/rustdesk')).pop(); assert.equal(rdp.args[1], 'agv2'); assert.ok(rdp.args.includes('DISPLAY=:42'));
});

test('slot: đóng màn hình riêng (vdclose) chỉ tắt tiến trình của slot đó; slot sai/lệnh nguy hiểm bị từ chối', async () => {
  const E = setup();
  await E.desk.handle({ cmd: 'screenshot', slot: '111' });
  assert.deepEqual(await E.desk.handle({ cmd: 'vdclose', slot: '111' }), { ok: true, closed: true });
  const k = E.calls.find((c) => c.cmd === 'pkill'); assert.deepEqual(k.args, ['-KILL', '-u', 'agv1']);
  assert.deepEqual(await E.desk.handle({ cmd: 'vdclose', slot: '999' }), { ok: true, closed: false });
  assert.match((await E.desk.handle({ cmd: 'screenshot', slot: 'abc' })).error, /không hợp lệ/);
  for (const cmd of ['reboot', 'poweroff', 'lock', 'nolock']) assert.match((await E.desk.handle({ cmd, slot: '111' })).error, /chỉ áp dụng cho màn hình thật/, cmd);
  const l = await E.desk.handle({ cmd: 'vdlist' }); assert.equal(l.ok, true); assert.equal(l.slots.length, 1); assert.equal(l.max, 2);
});
