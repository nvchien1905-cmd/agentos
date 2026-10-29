'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { createFullAccessCtl } = require('../src/fullaccessctl');
const { createBot } = require('../src/bot');
const { openDb } = require('../src/db');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-'));

test('fullaccessctl.osState: sudo bị chặn bởi NoNewPrivileges hoặc chưa có sudo thì báo rõ; đủ quyền thì ok', async () => {
  const d = tmp(), st = path.join(d, 'status');
  fs.writeFileSync(st, 'Name:\tnode\nNoNewPrivs:\t1\n');
  let c = createFullAccessCtl({ statusFile: st, run: async () => ({ ok: true }) });
  let r = await c.osState(); assert.equal(r.ok, false); assert.equal(r.noNewPrivs, true); assert.match(r.why, /NoNewPrivileges/);
  fs.writeFileSync(st, 'Name:\tnode\nNoNewPrivs:\t0\n');
  c = createFullAccessCtl({ statusFile: st, run: async () => ({ ok: false }) });
  r = await c.osState(); assert.equal(r.ok, false); assert.match(r.why, /chưa có sudo/);
  c = createFullAccessCtl({ statusFile: st, run: async () => ({ ok: true }) });
  r = await c.osState(); assert.equal(r.ok, true); assert.equal(r.why, '');
});

test('fullaccessctl.request: nói chuyện với dịch vụ qua socket; thiếu dịch vụ / bị từ chối / treo đều báo rõ', async () => {
  const d = tmp(), sock = path.join(d, 's.sock'); const got = [];
  const srv = net.createServer((c) => { c.on('data', (b) => { got.push(String(b).trim()); const m = String(b).trim(); c.end(m === 'on' ? '{"ok":true,"result":{"enabled":true}}\n' : m === 'off' ? '{"ok":false,"error":"chỉ tiến trình chính của bộ điều phối được gọi"}\n' : ''); }); });
  await new Promise((r) => srv.listen(sock, r));
  const c = createFullAccessCtl({ sock });
  let r = await c.request('on'); assert.equal(r.ok, true); assert.equal(r.result.enabled, true); assert.deepEqual(got, ['on']);
  r = await c.request('off'); assert.equal(r.ok, false); assert.match(r.error, /tiến trình chính/);
  r = await c.request('status'); assert.equal(r.ok, false); assert.match(r.error, /không trả lời|đóng kết nối/);
  await new Promise((x) => srv.close(x));
  r = await createFullAccessCtl({ sock: path.join(d, 'khong-co.sock') }).request('on'); assert.equal(r.ok, false); assert.match(r.error, /chưa có dịch vụ cấp quyền/);
  const hang = net.createServer(() => {}); const hs = path.join(d, 'h.sock'); await new Promise((x) => hang.listen(hs, x));
  r = await createFullAccessCtl({ sock: hs }).request('on', 150); assert.equal(r.ok, false); assert.match(r.error, /không trả lời/);
  hang.close();
});

function botWith(st, calls, admin) {
  let on = false;
  const fullAccess = { get: () => on, set: (v) => { on = v; calls.push('set:' + v); }, os: async () => st.value, grant: async (v) => { calls.push('grant:' + v); return st.grant || { ok: true }; } };
  const bot = createBot({ db: openDb(':memory:'), worker: { engineNames: () => [], wake() {}, currentJobId: () => null, engineStatus: () => [] }, allowed: new Set(['1', '2']), profiles: [], isAdmin: (u) => u === (admin || '1'), fullAccess });
  return { say: (uid, text) => bot.handle({ from: { id: uid }, chat: { id: uid, type: 'private' }, text }) };
}

test('/toanquyen: chưa đủ quyền hệ điều hành thì NÓI RÕ và chỉ cấp khi gõ "co"; đủ rồi thì không động tới hệ điều hành; chỉ chủ máy', async () => {
  const st = { value: { ok: false, why: 'dịch vụ bot đang bị khóa "NoNewPrivileges"' } }, calls = []; const B = botWith(st, calls);
  let r = await B.say(1, '/toanquyen');
  assert.match(r, /hệ điều hành chưa cấp sudo/); assert.match(r, /\/toanquyen co/); assert.deepEqual(calls, ['set:true'], 'chưa gõ "co" thì chưa cấp');
  calls.length = 0; r = await B.say(1, '/toanquyen co');
  assert.match(r, /Đang cấp TOÀN QUYỀN/); assert.deepEqual(calls, ['set:true', 'grant:true']);
  calls.length = 0; st.grant = { ok: false, error: 'chưa có dịch vụ cấp quyền' }; r = await B.say(1, '/toanquyen co'); assert.match(r, /Chưa cấp được[^]*chưa có dịch vụ/);
  calls.length = 0; st.value = { ok: true, why: '' }; r = await B.say(1, '/toanquyen'); assert.match(r, /ĐÃ có sudo/); assert.deepEqual(calls, ['set:true'], 'đã đủ thì không cấp lại');
  calls.length = 0; assert.match(await B.say(2, '/toanquyen co'), /Chỉ quản trị viên/); assert.deepEqual(calls, [], 'người khác không cấp được');
});

test('/baove: thu hồi sudo ở hệ điều hành nếu đang có; chưa có thì chỉ đổi chế độ; /trangthai cảnh báo khi bot báo toàn quyền mà hệ điều hành chưa cấp', async () => {
  const st = { value: { ok: true, why: '' } }, calls = []; const B = botWith(st, calls);
  await B.say(1, '/toanquyen'); calls.length = 0;
  let r = await B.say(1, '/baove'); assert.match(r, /THU HỒI sudo/); assert.deepEqual(calls, ['set:false', 'grant:false']);
  calls.length = 0; st.value = { ok: false, why: 'x' }; r = await B.say(1, '/baove'); assert.match(r, /chế độ bảo vệ/); assert.deepEqual(calls, ['set:false'], 'chưa có sudo thì không gọi cấp quyền');
  await B.say(1, '/toanquyen'); st.value = { ok: false, why: 'dịch vụ bot đang bị khóa' };
  assert.match(await B.say(1, '/trangthai'), /⚠️ TOÀN QUYỀN trong bot nhưng hệ điều hành CHƯA cấp sudo/);
  st.value = { ok: true, why: '' }; assert.match(await B.say(1, '/trangthai'), /ĐÃ có sudo/);
});

// Dịch vụ root (python): kiểm người gọi bằng SO_PEERCRED. Thử THẬT trên Linux với socketpair; MAINPID/CLI được đặt bằng biến môi trường chỉ dành cho thử nghiệm.
const HELPER = path.join(__dirname, '..', '..', 'iso', 'config', 'includes.chroot', 'usr', 'local', 'sbin', 'agentos-fullaccess');
const PY = `
import os, sys, socket, subprocess, json
script, mainpid, user, cli, node, cmd = sys.argv[1:7]
a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
env = dict(os.environ, AGENTOS_FA_MAINPID=mainpid if mainpid != 'SELF' else str(os.getpid()), AGENTOS_FA_USER=user, AGENTOS_FA_CLI=cli, AGENTOS_FA_NODE=node)
p = subprocess.Popen([sys.executable, script], stdin=b, stdout=subprocess.DEVNULL, env=env)
b.close(); a.sendall((cmd + '\\n').encode()); a.shutdown(socket.SHUT_WR)
out = b''
while True:
    d = a.recv(4096)
    if not d: break
    out += d
p.wait(); print(out.decode().strip().splitlines()[-1] if out else '')
`;
const helper = (mainpid, user, cmd, cli) => spawnSync('python3', ['-c', PY, HELPER, mainpid, user, cli, process.execPath, cmd], { encoding: 'utf8', timeout: 30000 });

test('agentos-fullaccess (python, thật): chỉ nhận khi người gọi là tiến trình chính; pid khác (AI con) hoặc người dùng khác bị từ chối; chỉ nhận on|off|status', { skip: process.platform !== 'linux' }, () => {
  const d = tmp(), marker = path.join(d, 'da-chay.txt'), cli = path.join(d, 'cli.js');
  fs.writeFileSync(cli, "require('fs').appendFileSync(" + JSON.stringify(marker) + ", process.argv[2] + '\\n'); console.log(JSON.stringify({ enabled: process.argv[2] === 'on' }));");
  const me = os.userInfo().username;
  let r = helper('SELF', me, 'on', cli); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout.trim()).ok, true); assert.equal(JSON.parse(r.stdout.trim()).result.enabled, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'on\n');
  r = helper('SELF', me, 'off', cli); assert.equal(JSON.parse(r.stdout.trim()).result.enabled, false);
  fs.rmSync(marker); r = helper('1', me, 'on', cli);                                                        // pid chính khác (như AI con gọi)
  assert.equal(JSON.parse(r.stdout.trim()).ok, false); assert.match(r.stdout, /tiến trình chính/); assert.ok(!fs.existsSync(marker), 'từ chối thì KHÔNG chạy cấp quyền');
  r = helper('SELF', 'root' === me ? 'nobody' : 'root', 'on', cli); assert.equal(JSON.parse(r.stdout.trim()).ok, false); assert.ok(!fs.existsSync(marker), 'khác người dùng bị từ chối');
  r = helper('0', me, 'on', cli); assert.equal(JSON.parse(r.stdout.trim()).ok, false, 'không biết pid chính thì từ chối'); assert.ok(!fs.existsSync(marker));
  r = helper('SELF', me, 'rm -rf /', cli); assert.match(r.stdout, /lệnh không hợp lệ/); assert.ok(!fs.existsSync(marker));
  r = helper('SELF', me, 'status', cli); assert.equal(JSON.parse(r.stdout.trim()).ok, true);
});
