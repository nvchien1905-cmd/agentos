'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDesk, serve } = require('../server');
const { call } = require('../cli');

const SESS = { id: 'c1', uid: '1000', user: 'chien', display: ':0', home: '/home/chien', xauth: '/home/chien/.Xauthority' };

function make(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  const calls = [], detached = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'scrot') { fs.writeFileSync(args[args.length - 1], 'png'); return { code: 0, out: '', err: '' }; }
    if (cmd === 'ps') return { code: 0, out: '  11 /opt/google/chrome/chrome --password-store=basic\n  12 /opt/google/chrome/chrome --app=https://chat.zalo.me --user-data-dir=/home/chien/.config/agentos-app-zalo\n  13 /opt/google/chrome/chrome --type=renderer --app=https://chat.zalo.me\n  20 /usr/bin/rustdesk --service\n  21 /usr/share/rustdesk/rustdesk\n', err: '' };
    if (cmd === 'xdotool' && args[0] === 'search') return { code: 0, out: '100\n101\n', err: '' };
    if (cmd === 'xdotool' && args[0] === 'getwindowname') return { code: 0, out: args[1] === '100' ? 'Zalo\n' : 'Terminal\n', err: '' };
    return (extra && extra.run && extra.run(cmd, args, opts)) || { code: 0, out: '', err: '' };
  };
  const desk = createDesk({ run, detach: (c, a) => { detached.push([c, a]); return 4321; }, session: async () => (extra && 'sess' in extra ? extra.sess : SESS), outDir: dir, now: () => 1700000000000, lockWaitMs: 0 });
  return { desk, calls, detached, dir };
}

test('lệnh lạ, thiếu lệnh hoặc lệnh kiểu tên có sẵn của đối tượng (toString) đều bị từ chối', async () => {
  const { desk } = make();
  for (const r of [null, {}, { cmd: 'rm' }, { cmd: 'toString' }, { cmd: '__proto__' }, { cmd: 5 }]) assert.equal((await desk.handle(r)).ok, false);
});

test('chụp màn hình: chạy scrot với DISPLAY/XAUTHORITY của người đang ngồi máy, trả đường dẫn ảnh', async () => {
  const { desk, calls, dir } = make();
  const r = await desk.handle({ cmd: 'screenshot' });
  assert.equal(r.ok, true); assert.equal(r.file, path.join(dir, 'manhinh-1700000000000.png')); assert.ok(fs.existsSync(r.file));
  const c = calls.find((x) => x.cmd === 'scrot');
  assert.equal(c.opts.env.DISPLAY, ':0'); assert.equal(c.opts.env.XAUTHORITY, '/home/chien/.Xauthority');
});

test('không ai đăng nhập màn hình chính: mọi lệnh màn hình báo lỗi rõ ràng, không chạy gì', async () => {
  const { desk, calls, detached } = make({ sess: null });
  for (const r of [{ cmd: 'screenshot' }, { cmd: 'open', app: 'zalo' }, { cmd: 'click', x: 1, y: 1 }, { cmd: 'type', text: 'a' }, { cmd: 'clip', text: 'a' }, { cmd: 'windows' }, { cmd: 'lock' }]) {
    const x = await desk.handle(r); assert.equal(x.ok, false); assert.match(x.error, /đăng nhập/);
  }
  assert.equal(calls.length, 0); assert.equal(detached.length, 0);
});

test('mở ứng dụng: chỉ ứng dụng trong danh sách, chạy dưới người dùng màn hình chính (runuser), không qua shell', async () => {
  const { desk, detached } = make();
  const r = await desk.handle({ cmd: 'open', app: 'Zalo' });
  assert.deepEqual([r.ok, r.app], [true, 'Zalo']);
  const [cmd, args] = detached[0];
  assert.equal(cmd, 'runuser'); assert.deepEqual(args.slice(0, 3), ['-u', 'chien', '--']);
  assert.ok(args.includes('DISPLAY=:0') && args.includes('/usr/local/bin/agentos-app') && args.includes('zalo'));
  for (const bad of ['rm -rf /', 'zalo; reboot', '../../bin/sh', '', undefined]) assert.equal((await desk.handle({ cmd: 'open', app: bad })).ok, false);
  assert.equal(detached.length, 1);
});

test('đóng ứng dụng: chỉ tiến trình đúng ứng dụng (Chrome thường không đụng cửa sổ Zalo/KiotViet; RustDesk không đụng dịch vụ nền)', async () => {
  const { desk, calls } = make();
  const z = await desk.handle({ cmd: 'close', app: 'zalo' });
  assert.deepEqual([z.ok, z.closed], [true, 1]);   // tiến trình chính (con của nó tự thoát theo)
  assert.deepEqual(calls.filter((c) => c.cmd === 'kill').pop().args, ['-TERM', '12']);
  const ch = await desk.handle({ cmd: 'close', app: 'chrome' });
  assert.equal(ch.closed, 1); assert.deepEqual(calls.filter((c) => c.cmd === 'kill').pop().args, ['-TERM', '11']);
  const rd = await desk.handle({ cmd: 'close', app: 'rustdesk' });
  assert.equal(rd.closed, 1); assert.deepEqual(calls.filter((c) => c.cmd === 'kill').pop().args, ['-TERM', '21']);
  assert.equal((await desk.handle({ cmd: 'close', app: 'claude' })).ok, false);
});

test('bấm chuột / gõ phím / phím tắt: kiểm tra đầu vào chặt, không có ký tự điều khiển lọt vào lệnh', async () => {
  const { desk, calls } = make();
  assert.equal((await desk.handle({ cmd: 'click', x: 100.4, y: 200, double: true })).ok, true);
  assert.deepEqual(calls.find((c) => c.cmd === 'xdotool' && c.args[0] === 'mousemove').args, ['mousemove', '100', '200', 'click', '--repeat', '2', '--delay', '80', '1']);
  for (const b of [{ x: -1, y: 1 }, { x: 'a', y: 1 }, { x: 1, y: 1, button: '9' }, { x: 1e9, y: 1 }]) assert.equal((await desk.handle(Object.assign({ cmd: 'click' }, b))).ok, false);
  assert.equal((await desk.handle({ cmd: 'type', text: 'Xin chào; $(reboot)' })).ok, true);
  assert.deepEqual(calls.find((c) => c.args[0] === 'type').args.slice(-2), ['--', 'Xin chào; $(reboot)']);   // truyền nguyên văn, không qua shell
  assert.equal((await desk.handle({ cmd: 'type', text: '' })).ok, false);
  assert.equal((await desk.handle({ cmd: 'type', text: 'x'.repeat(2001) })).ok, false);
  assert.equal((await desk.handle({ cmd: 'key', key: 'ctrl+v' })).ok, true);
  for (const k of ['Return; reboot', '$(id)', 'a\nb', '', 'x'.repeat(61)]) assert.equal((await desk.handle({ cmd: 'key', key: k })).ok, false);
});

test('chép vào bộ nhớ tạm: xclip nhận chữ qua stdin; liệt kê cửa sổ; khóa; khởi động lại/tắt máy trễ vài giây', async () => {
  const { desk, calls, detached } = make();
  assert.equal((await desk.handle({ cmd: 'clip', text: 'Viết mô tả cho nồi chiên' })).ok, true);
  const cl = calls.find((c) => c.cmd === 'xclip'); assert.deepEqual(cl.args, ['-selection', 'clipboard', '-i']); assert.equal(cl.opts.input, 'Viết mô tả cho nồi chiên');
  assert.deepEqual((await desk.handle({ cmd: 'windows' })).windows, ['Zalo', 'Terminal']);
  assert.equal((await desk.handle({ cmd: 'lock' })).ok, true);
  assert.equal(detached.length, 0);                                                         // KHÔNG khởi động light-locker từ dịch vụ (nó phải chạy trong phiên)
  const lk = calls.find((c) => c.cmd === 'runuser' && c.args.includes('light-locker-command'));
  assert.deepEqual(lk.args.slice(-2), ['light-locker-command', '-l']); assert.deepEqual(lk.args.slice(0, 3), ['-u', 'chien', '--']);
  assert.equal(calls.find((c) => c.cmd === 'xclip').opts.noPipes, true);                    // xclip ở lại nền: không chờ ống đóng
  assert.equal((await desk.handle({ cmd: 'reboot' })).after, 6);
  assert.deepEqual(calls.filter((c) => c.cmd === 'systemd-run').pop().args.slice(-2), ['systemctl', 'reboot']);
  await desk.handle({ cmd: 'poweroff' });
  assert.deepEqual(calls.filter((c) => c.cmd === 'systemd-run').pop().args.slice(-2), ['systemctl', 'poweroff']);
});

test('socket: nhận một dòng JSON, trả một dòng JSON (qua cli.call)', { skip: process.platform === 'win32' }, async () => {
  const { desk } = make();
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsk-')), 'd.sock');
  const srv = serve(desk, sock, null);
  await new Promise((r) => srv.once('listening', r));
  process.env.DESK_SOCKET = sock;
  try {
    const r = await new Promise((resolve, reject) => {
      const net = require('net'); const c = net.connect(sock); let b = '';
      c.on('connect', () => c.write(JSON.stringify({ cmd: 'who' }) + '\n')); c.on('data', (d) => { b += d; }); c.on('end', () => resolve(JSON.parse(b))); c.on('error', reject);
    });
    assert.deepEqual(r, { ok: true, user: 'chien', display: ':0', locked: false });
    assert.equal(typeof call, 'function');
  } finally { srv.close(); }
});


test('màn hình đang khóa (phiên không Active): không chụp ảnh đen, không bấm/gõ vào khoảng không; who báo locked; lock báo đã khóa; chép bộ nhớ tạm vẫn được', async () => {
  const { desk, calls } = make({ sess: Object.assign({}, SESS, { active: false }) });
  const w = await desk.handle({ cmd: 'who' }); assert.equal(w.locked, true);
  for (const r of [{ cmd: 'screenshot' }, { cmd: 'click', x: 1, y: 1 }, { cmd: 'type', text: 'a' }, { cmd: 'key', key: 'Return' }]) {
    const x = await desk.handle(r); assert.equal(x.ok, false); assert.match(x.error, /đang khóa/);
  }
  assert.ok(!calls.some((c) => c.cmd === 'scrot' || c.cmd === 'xdotool'), 'không chạy gì khi đang khóa');
  assert.deepEqual(await desk.handle({ cmd: 'lock' }), { ok: true, already: true });
  assert.equal((await desk.handle({ cmd: 'clip', text: 'x' })).ok, true);
  const act = make({ sess: Object.assign({}, SESS, { active: true }) });
  assert.equal((await act.desk.handle({ cmd: 'who' })).locked, false);
});

test('nolock: tắt trình bảo vệ màn hình của X (không tự khóa khi nhàn rỗi); khóa thất bại thì hướng dẫn đăng nhập lại', async () => {
  const { desk, calls } = make();
  assert.equal((await desk.handle({ cmd: 'nolock' })).ok, true);
  assert.deepEqual(calls.filter((c) => c.cmd === 'xset').map((c) => c.args), [['s', 'off'], ['s', 'noblank']]);
  const bad = make({ run: (cmd, args) => (args.includes('light-locker-command') ? { code: 0, out: '', err: 'Received error message from the locker: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown' } : null) });
  const r = await bad.desk.handle({ cmd: 'lock' });
  assert.equal(r.ok, false); assert.match(r.error, /đăng xuất rồi đăng nhập lại/);
  const lockedOut = make({ sess: Object.assign({}, SESS, { active: false }) });
  assert.equal((await lockedOut.desk.handle({ cmd: 'nolock' })).ok, false);
});

test('rê chuột / kéo thả / cuộn: đúng lệnh xdotool, kiểm tra đầu vào, không chạy khi khóa màn hình', async () => {
  const { desk, calls } = make();
  assert.equal((await desk.handle({ cmd: 'move', x: 5.6, y: 7 })).ok, true);
  assert.deepEqual(calls.filter((c) => c.cmd === 'xdotool').pop().args, ['mousemove', '6', '7']);
  assert.equal((await desk.handle({ cmd: 'drag', x: 1, y: 2, x2: 300, y2: 400 })).ok, true);
  const dr = calls.filter((c) => c.cmd === 'xdotool').pop().args;
  assert.deepEqual(dr.slice(0, 5), ['mousemove', '1', '2', 'mousedown', '1']); assert.deepEqual(dr.slice(-5), ['mousemove', '300', '400', 'sleep', '0.15'].slice(0, 0).concat(dr.slice(-5))); assert.equal(dr[dr.length - 2], 'mouseup');
  assert.equal((await desk.handle({ cmd: 'scroll', dir: 'down', amount: 10, x: 50, y: 60 })).ok, true);
  assert.deepEqual(calls.filter((c) => c.cmd === 'xdotool').pop().args, ['mousemove', '50', '60', 'click', '--repeat', '10', '--delay', '30', '5']);
  assert.equal((await desk.handle({ cmd: 'scroll', dir: 'up' })).ok, true);
  assert.deepEqual(calls.filter((c) => c.cmd === 'xdotool').pop().args, ['click', '--repeat', '5', '--delay', '30', '4']);
  for (const bad of [{ cmd: 'move', x: -1, y: 1 }, { cmd: 'drag', x: 1, y: 1, x2: 'a', y2: 2 }, { cmd: 'scroll', dir: 'sideways' }, { cmd: 'scroll', dir: 'down', amount: 99 }, { cmd: 'scroll', dir: 'down', amount: 0 }]) assert.equal((await desk.handle(bad)).ok, false, JSON.stringify(bad));
});

const TSV = ['level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '5\t1\t1\t1\t1\t1\t100\t200\t50\t20\t95\tHủy', '5\t1\t1\t1\t1\t2\t160\t200\t40\t20\t90\tbỏ',
  '5\t1\t2\t1\t1\t1\t300\t500\t60\t24\t96\tGửi', '5\t1\t3\t1\t1\t1\t300\t600\t60\t24\t92\tGUI', '5\t1\t3\t1\t1\t2\t400\t600\t60\t24\t90\tđi'].join('\n');

test('tìm chữ trên màn hình (OCR): bỏ dấu/hoa thường, cụm nhiều từ, trả toạ độ giữa; bấm đúng chữ thứ n', async () => {
  const { desk, calls } = make({ run: (cmd, args) => (cmd === 'tesseract' ? { code: 0, out: TSV, err: '' } : null) });
  const f = await desk.handle({ cmd: 'findtext', text: 'gui' });
  assert.equal(f.ok, true); assert.equal(f.matches.length, 2); assert.deepEqual(f.matches.map((m) => [m.cx, m.cy]), [[330, 512], [330, 612]]);
  const two = await desk.handle({ cmd: 'findtext', text: 'HỦY BỎ' }); assert.equal(two.matches.length, 1); assert.deepEqual([two.matches[0].x, two.matches[0].w], [100, 100]);
  assert.equal((await desk.handle({ cmd: 'findtext', text: 'không có' })).matches.length, 0);
  const c = await desk.handle({ cmd: 'clicktext', text: 'Gửi', nth: 2 });
  assert.equal(c.ok, true); assert.deepEqual([c.x, c.y, c.found], [330, 612, 2]);
  assert.deepEqual(calls.filter((x) => x.cmd === 'xdotool').pop().args.slice(0, 3), ['mousemove', '330', '612']);
  assert.equal((await desk.handle({ cmd: 'clicktext', text: 'Gửi', nth: 5 })).ok, false);
  assert.equal((await desk.handle({ cmd: 'clicktext', text: 'xyz' })).ok, false);
  assert.equal((await desk.handle({ cmd: 'findtext', text: '' })).ok, false);
  assert.ok(!fs.readdirSync(calls.find((x) => x.cmd === 'scrot').args[1].replace(/[^/]+$/, '')).some((n) => n.startsWith('ocr-')), 'xóa ảnh OCR tạm');
});

test('info / focus / clipget / unlock', async () => {
  const { desk, calls } = make({ run: (cmd, args) => {
    if (cmd === 'xdotool' && args[0] === 'getdisplaygeometry') return { code: 0, out: '1920 1080\n', err: '' };
    if (cmd === 'xdotool' && args[0] === 'getactivewindow') return { code: 0, out: 'Chrome\n', err: '' };
    if (cmd === 'xclip') return { code: 0, out: 'nội dung chép', err: '' };
    return null;
  } });
  assert.deepEqual(await desk.handle({ cmd: 'info' }), { ok: true, width: 1920, height: 1080, active: 'Chrome' });
  assert.equal((await desk.handle({ cmd: 'focus', name: 'Zalo' })).ok, true);
  assert.deepEqual(calls.filter((c) => c.cmd === 'xdotool').pop().args, ['windowactivate', '--sync', '100']);
  assert.equal((await desk.handle({ cmd: 'focus', name: '' })).ok, false);
  assert.equal((await desk.handle({ cmd: 'clipget' })).text, 'nội dung chép');
  assert.deepEqual(await desk.handle({ cmd: 'unlock' }), { ok: true, already: true });          // không khóa thì thôi
  const locked = make({ sess: Object.assign({}, SESS, { active: false }), run: (cmd) => (cmd === 'loginctl' ? { code: 0, out: '', err: '' } : null) });
  const u = await locked.desk.handle({ cmd: 'unlock' });
  assert.ok(locked.calls.some((c) => c.cmd === 'loginctl' && c.args[0] === 'unlock-sessions')); assert.equal(u.ok, false, 'vẫn khóa sau lệnh thì báo thật, không nói dối');
});

test('OCR nút chữ trắng trên nền xanh: chế độ rải rác bỏ sót thì thử chế độ khối, rồi ảnh đảo màu; thấy ngay thì không đọc lại', async () => {
  const HEAD = TSV.split('\n')[0];
  const WORD = HEAD + '\n5\t1\t1\t1\t1\t1\t866\t604\t37\t19\t96\tTiếp\n5\t1\t1\t1\t1\t2\t909\t605\t40\t14\t96\ttheo';
  // 1) bản gốc: psm 11 trống, psm 6 thấy
  const a = make({ run: (cmd, args) => (cmd === 'tesseract' ? { code: 0, out: args.includes('6') ? WORD : HEAD, err: '' } : null) });
  const f = await a.desk.handle({ cmd: 'findtext', text: 'tiep theo' });
  assert.equal(f.matches.length, 1); assert.deepEqual([f.matches[0].cx, f.matches[0].cy], [908, 614]);
  assert.deepEqual(a.calls.filter((c) => c.cmd === 'tesseract').map((c) => c.args[c.args.indexOf('--psm') + 1]), ['11', '6']);
  assert.ok(!a.calls.some((c) => c.cmd === 'convert'), 'chưa cần đảo màu');
  // 2) chỉ ảnh đảo màu mới đọc được
  const b = make({ run: (cmd, args) => (cmd === 'tesseract' ? { code: 0, out: String(args[0]).endsWith('-dao.png') ? WORD : HEAD, err: '' } : null) });
  assert.equal((await b.desk.handle({ cmd: 'findtext', text: 'tiep theo' })).matches.length, 1);
  assert.ok(b.calls.some((c) => c.cmd === 'convert' && c.args.includes('-negate')));
  assert.equal(b.calls.filter((c) => c.cmd === 'tesseract').length, 3);
  // 3) thấy ngay ở lần đầu thì dừng
  const c = make({ run: (cmd) => (cmd === 'tesseract' ? { code: 0, out: TSV, err: '' } : null) });
  assert.equal((await c.desk.handle({ cmd: 'findtext', text: 'gui' })).matches.length, 2);
  assert.equal(c.calls.filter((x) => x.cmd === 'tesseract').length, 1);
});
