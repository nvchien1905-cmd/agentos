'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRemote } = require('../src/remote');
const { createQuick } = require('../src/quick');
const { createBot } = require('../src/bot');
const { openDb } = require('../src/db');
const { createSnapshot } = require('../src/snapshot');
const wol = require('../src/wol');

const linux = process.platform === 'linux';

test('lenh: lệnh nguy hiểm đòi xác nhận, xác nhận thì tạo điểm khôi phục trước rồi mới chạy', { skip: !linux }, async () => {
  const snaps = [];
  const r = createRemote({ timeoutMs: 3000, snapshot: async (l) => { snaps.push(l); return { ok: true, file: '/x/snap-1.tar.gz' }; } });
  for (const bad of ['rm -rf /tmp/abc', 'sudo rm -r -f x', 'dd if=/dev/zero of=/dev/sda', 'mkfs.ext4 /dev/sdb1', 'sudo reboot', 'apt-get purge firefox', 'chown -R a:b /srv']) {
    const t = (await r.runShell(bad)).text; assert.match(t, /MẤT DỮ LIỆU/, bad); assert.match(t, /xacnhan/);
  }
  assert.equal(snaps.length, 0, 'chưa xác nhận thì không chạy, không tạo gì');
  for (const ok of ['ls -la', 'df -h', 'cat /etc/os-release', 'echo an-toan']) assert.doesNotMatch((await r.runShell(ok)).text, /MẤT DỮ LIỆU/, ok);
  const out = (await r.runShell('xacnhan echo da-chay')).text;
  assert.deepEqual(snaps, ['truoc-lenh']); assert.match(out, /điểm khôi phục[\s\S]*da-chay/);
});

test('snapshot: tạo bản nén quyền 600, giữ tối đa N bản mới nhất, liệt kê', { skip: !linux }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-')); const src = path.join(dir, 'cfg'); fs.mkdirSync(src); fs.writeFileSync(path.join(src, 'a.conf'), 'x');
  const S = createSnapshot({ dir: path.join(dir, 'out'), keep: 2, paths: [src], sudo: false });
  for (const l of ['Một', 'hai', 'ba']) { const r = await S.create(l); assert.equal(r.ok, true); assert.equal(fs.statSync(r.file).mode & 0o777, 0o600); await new Promise((x) => setTimeout(x, 1100)); }
  const ls = S.list(); assert.equal(ls.length, 2); assert.match(ls[0].name, /hai/); assert.match(ls[1].name, /ba/);
});

test('wol: gói magic đúng định dạng, MAC sai bị từ chối; /bat lưu máy và bật máy', async () => {
  assert.equal(wol.parseMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff'); assert.equal(wol.parseMac('aabbccddeeff'), 'aa:bb:cc:dd:ee:ff'); assert.equal(wol.parseMac('xx'), null);
  const p = wol.magic('aa:bb:cc:dd:ee:ff'); assert.equal(p.length, 102); assert.equal(p.slice(0, 6).toString('hex'), 'ffffffffffff'); assert.equal(p.slice(96).toString('hex'), 'aabbccddeeff');
  assert.equal((await wol.send('sai')).ok, false);
  const store = {}; const sent = [];
  const q = createQuick({ desk: { call: async () => ({ ok: true }) }, wol: { parseMac: wol.parseMac, send: async (m) => { sent.push(m); return { ok: true }; } }, devices: { get: () => store, set: (v) => Object.assign(store, v) }, shotWaitMs: 0 });
  assert.match(await q.run('bat', 'them MayChinh AA:BB:CC:DD:EE:FF'), /Đã lưu/);
  assert.match(await q.run('bat', 'ds'), /maychinh — aa:bb:cc:dd:ee:ff/);
  assert.match(await q.run('bat', 'maychinh'), /Đã gửi tín hiệu/); assert.deepEqual(sent, ['aa:bb:cc:dd:ee:ff']);
  assert.match(await q.run('bat', 'khongco'), /Không biết máy/);
});

test('quick: /timchu /bamchu /chuyen /dan /mokhoa; /dung hủy việc và đóng điều khiển từ xa; /nhatky ghi lệnh điều khiển (che chữ gõ)', async () => {
  const calls = [];
  const desk = { call: async (c) => {
    calls.push(c);
    if (c.cmd === 'findtext') return { ok: true, matches: [{ cx: 10, cy: 20, text: 'Gửi' }] };
    if (c.cmd === 'clicktext') return { ok: true, x: 10, y: 20, text: 'Gửi', found: 1 };
    if (c.cmd === 'clipget') return { ok: true, text: 'abc' };
    return { ok: true, file: c.cmd === 'screenshot' ? '/tmp/s.png' : undefined };
  } };
  const q = createQuick({ desk, shotWaitMs: 0 });
  assert.match(await q.run('timchu', 'Gửi'), /\(10, 20\) "Gửi"/);
  const b = await q.run('bamchu', 'Gửi lan 2'); assert.ok(b.files);
  assert.deepEqual(calls.find((c) => c.cmd === 'clicktext'), { cmd: 'clicktext', text: 'Gửi', nth: 2, double: false });
  assert.ok((await q.run('chuyen', 'Chrome')).files); assert.match(await q.run('dan', ''), /abc/); assert.match(await q.run('dan', 'xin chào'), /Đã chép 8/);
  assert.match((await q.run('mokhoa', '')).text, /Đã mở khóa/); assert.match(await q.run('bamchu', ''), /Cách dùng/);

  const db = openDb(':memory:'); let cancelled = 0;
  const worker = { wake() {}, currentJobId: () => null, engineNames: () => ['claude'], cancelRunning: () => { cancelled++; return true; } };
  const quick = { has: (n) => q.has(n), run: async (n, a) => (n === 'tuxa' ? { text: '🔒 Đã đóng điều khiển từ xa' } : q.run(n, a)) };
  const bot = createBot({ db, worker, allowed: new Set(['1', '2']), isAdmin: (u) => u === '1', quick });
  const m = (text, uid) => ({ from: { id: uid || 1 }, chat: { id: uid || 1, type: 'private' }, text });
  const d = await bot.handle(m('/dung')); assert.match(d, /DỪNG[\s\S]*Đã đóng điều khiển/); assert.equal(cancelled, 1);
  assert.doesNotMatch(await bot.handle(m('/dung', 2)), /Đã đóng/);                                   // người không phải admin: chỉ hủy việc
  await bot.handle(m('/go mat-khau-bi-mat-123'));
  const log = await bot.handle(m('/nhatky'));
  assert.match(log, /\/go[^\n]*\(19 ký tự\)/); assert.doesNotMatch(log, /mat-khau-bi-mat/);
});
