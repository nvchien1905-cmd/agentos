'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSandbox } = require('../src/sandbox');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-'));
const PATHS = { home: tmp, workdir: tmp, dataDir: null, jobDir: tmp, rw: [], hide: [] };
const stat = () => ({ isDirectory: () => true, isFile: () => false });
const SPEC = { bin: 'echo', args: ['hi'], cwd: tmp };

test('giới hạn mạng: chỉ bọc python3 landlock-net.py khi có isolate.netPorts và nhân hỗ trợ; chủ máy (không isolate) và NET_GUARD=0 thì giữ nguyên', () => {
  const calls = [];
  const run = (bin, args) => { calls.push([bin, ...args]); return { status: 0 }; };
  const sb = createSandbox({ mode: 'auto', paths: PATHS, platform: 'linux', statSync: stat, run, log() {} });
  const w = sb.wrap(Object.assign({}, SPEC, { isolate: { hide: [], bind: [], netPorts: [53, 80, 443, 40123] } }));
  const i = w.args.indexOf('--'); assert.deepEqual(w.args.slice(i + 1, i + 3).map((x, k) => (k ? path.basename(x) : x)), ['python3', 'landlock-net.py']);
  assert.deepEqual(w.args.slice(i + 3), ['--ports', '53,80,443,40123', '--', 'echo', 'hi']);
  assert.equal(calls.filter((c) => c[1] && /landlock-net/.test(c[1])).length, 1, 'kiểm nhân một lần rồi nhớ');
  sb.wrap(Object.assign({}, SPEC, { isolate: { hide: [], bind: [], netPorts: [80] } })); assert.equal(calls.filter((c) => c[1] && /landlock-net/.test(c[1])).length, 1);
  const adm = sb.wrap(SPEC); assert.deepEqual(adm.args.slice(adm.args.indexOf('--') + 1), ['echo', 'hi'], 'chủ máy: không giới hạn mạng');
  const noPorts = sb.wrap(Object.assign({}, SPEC, { isolate: { hide: [], bind: [] } })); assert.deepEqual(noPorts.args.slice(noPorts.args.indexOf('--') + 1), ['echo', 'hi']);
  const off = createSandbox({ mode: 'auto', paths: PATHS, platform: 'linux', statSync: stat, run, log() {}, netGuard: false });
  const wo = off.wrap(Object.assign({}, SPEC, { isolate: { hide: [], bind: [], netPorts: [80] } })); assert.deepEqual(wo.args.slice(wo.args.indexOf('--') + 1), ['echo', 'hi']);
  const old = createSandbox({ mode: 'auto', paths: PATHS, platform: 'linux', statSync: stat, run: (b, a) => ({ status: a && /landlock-net/.test(a[0] || '') ? 1 : 0 }), log() {} });
  const wd = old.wrap(Object.assign({}, SPEC, { isolate: { hide: [], bind: [], netPorts: [80] } })); assert.deepEqual(wd.args.slice(wd.args.indexOf('--') + 1), ['echo', 'hi'], 'nhân cũ: bỏ qua, không làm hỏng việc');
  assert.match(old.info.net, /KHÔNG bật/);
});

// Thử THẬT (chỉ khi máy có bwrap + python3 + nhân Landlock ABI 4+): trong hộp cô lập, cổng không liệt kê bị chặn, cổng liệt kê vẫn nối được
const hasLandlock = process.platform === 'linux' && spawnSync('python3', [path.join(__dirname, '..', 'src', 'landlock-net.py'), '--check']).status === 0 && spawnSync('bwrap', ['--ro-bind', '/', '/', '--', '/bin/true']).status === 0;
test('giới hạn mạng THẬT: AI của ID thường không nối được tới cổng nội bộ lạ (VD Chrome của chủ máy) nhưng nối được cổng được phép', { skip: !hasLandlock && 'máy này không có bwrap/Landlock' }, async () => {
  const mk = () => new Promise((res) => { const s = net.createServer((c) => c.end('ok')); s.listen(0, '127.0.0.1', () => res(s)); });
  const secret = await mk(), allowed = await mk();   // "Chrome của chủ máy" và "Chrome riêng của ID"
  const script = path.join(tmp, 'landlock-net.py'); fs.copyFileSync(path.join(__dirname, '..', 'src', 'landlock-net.py'), script);   // /tmp trong hộp cô lập là tmpfs trống: để bản sao ở thư mục nhà được mở lại
  const sb = createSandbox({ mode: 'bwrap', paths: PATHS, log() {}, netScript: script });
  const code = 'import socket,sys\ns=socket.socket();s.settimeout(3)\ntry:\n  s.connect(("127.0.0.1",int(sys.argv[1])));print("NOI-DUOC")\nexcept Exception as e:\n  print("CHAN",getattr(e,"errno",None))\n';
  const tryPort = (port, ports) => { const w = sb.wrap({ bin: 'python3', args: ['-c', code, String(port)], cwd: tmp, isolate: { hide: [], bind: [], netPorts: ports } }); const r = spawnSync(w.bin, w.args, { encoding: 'utf8', timeout: 20000 }); return r.stdout.trim() + '|' + String(r.stderr).slice(0, 200); };
  try {
    const pS = secret.address().port, pA = allowed.address().port;
    assert.match(tryPort(pS, [53, 80, 443, pA]), /^CHAN 13/, 'cổng lạ phải bị chặn (EACCES)');
    assert.match(tryPort(pA, [53, 80, 443, pA]), /^NOI-DUOC/, 'cổng được liệt kê vẫn nối được');
    assert.match(tryPort(pS, [pS]), /^NOI-DUOC/, 'liệt kê thì nối được (bộ luật đúng theo danh sách)');
    const direct = spawnSync('python3', ['-c', code, String(pS)], { encoding: 'utf8' }); assert.match(direct.stdout, /NOI-DUOC/, 'ngoài hộp cô lập (chủ máy) không bị giới hạn');
  } finally { secret.close(); allowed.close(); }
});
