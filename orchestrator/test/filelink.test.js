'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLinks } = require('../src/filelink');
const { createRemote } = require('../src/remote');
const { createQuick } = require('../src/quick');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fl-'));
const mk = (extra) => createLinks(Object.assign({ port: 0, bind: '127.0.0.1', host: async () => ({ host: '127.0.0.1', via: 'mạng nhà' }), dir: tmp() }, extra || {}));
const urlOf = (r) => r.text.match(/http:\/\/\S+/)[0];

test('link tải về: tải đủ, tải tiếp theo Range, mã sai 404, hết hạn thì đóng, cổng đóng khi hết link', async () => {
  const d = tmp(); const f = path.join(d, 'bao cao.bin'); const data = Buffer.alloc(100000, 7); data[0] = 1; data[99999] = 9; fs.writeFileSync(f, data);
  let t = Date.now();
  const L = mk({ now: () => t, ttlMs: 60000 });
  const r = await L.downloadLink(f); const url = urlOf(r);
  const full = await fetch(url); assert.equal(full.status, 200); assert.equal(Buffer.compare(Buffer.from(await full.arrayBuffer()), data), 0);
  assert.match(full.headers.get('content-disposition'), /bao%20cao\.bin/);
  const part = await fetch(url, { headers: { range: 'bytes=99990-' } }); assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 99990-99999/100000'); assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal((await fetch(url.replace(/[0-9a-f]{48}$/, 'a'.repeat(48)))).status, 404);
  assert.equal((await fetch(url.replace('/d/', '/u/'))).status, 404, 'mã tải không dùng để gửi lên');
  t += 61000;
  assert.equal((await fetch(url)).status, 404, 'hết hạn');
  assert.equal(L.active(), 0); L.stop();
  assert.match((await L.downloadLink(path.join(d, 'khong-co'))).text, /Không thấy/);
  L.stop();
});

test('link gửi lên: nhận tệp lớn dạng luồng, tên bị làm sạch (không thoát thư mục), báo cho chat, nhiều lần dùng được', async () => {
  const got = []; const dir = tmp();
  const L = mk({ dir, onUpload: (f) => got.push(f) });
  const url = urlOf({ text: await L.uploadLink('42') });
  const page = await fetch(url); assert.equal(page.status, 200); assert.match(await page.text(), /Gửi tệp lên máy/);
  const body = Buffer.alloc(3 * 1024 * 1024, 5);
  const ok = await fetch(url + '/' + encodeURIComponent('../../etc/hoa don.pdf'), { method: 'PUT', body });
  assert.equal(ok.status, 200);
  assert.equal(got.length, 1); assert.equal(got[0].chat, '42'); assert.equal(got[0].size, body.length);
  assert.ok(got[0].path.startsWith(dir + path.sep) && !got[0].name.includes('/'), got[0].path);
  assert.equal(fs.statSync(got[0].path).size, body.length);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.part')).length, 0);
  assert.equal((await fetch(url + '/b.txt', { method: 'PUT', body: 'x' })).status, 200);           // dùng lại link
  assert.equal((await fetch(url.replace('/u/', '/d/') + '/x', { method: 'PUT', body: 'x' })).status, 404);
  L.stop();
});

test('/lay: tệp > 49 MB tự đổi sang link tải; /guilen và /tuxa chạy được; /keo /cuon /re gọi deskd và tự chụp', async () => {
  const d = tmp(); const big = path.join(d, 'lon.bin');
  const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 60 * 1024 * 1024); fs.closeSync(fd);          // tệp thưa 60 MB
  const L = mk();
  const calls = []; const desk = { call: async (c) => { calls.push(c); return c.cmd === 'screenshot' ? { ok: true, file: '/tmp/x.png' } : { ok: true }; } };
  const q = createQuick({ desk, remote: createRemote({ cwd: d, tailscale: { info: async () => ({ state: 'Running', ips: ['100.64.0.9'], dns: 'may.ts.net' }) } }), links: L, shotWaitMs: 0 });
  const r = await q.run('lay', big); assert.match(r.text, /quá lớn[\s\S]*http:\/\/127\.0\.0\.1:/); assert.equal(r.files, undefined);
  assert.match(await q.run('guilen', '', { chatId: '9' }), /http:\/\/127\.0\.0\.1:\d+\/u\//);
  const t = await q.run('tuxa', ''); assert.match(t.text, /100\.64\.0\.9/);
  const k = await q.run('keo', '10 20 300 400'); assert.ok(k.files && k.files[0].kind === 'photo');
  await q.run('cuon', 'len 3 100 200'); await q.run('cuon', 'xuong'); await q.run('re', '5 6');
  assert.deepEqual(calls.filter((c) => c.cmd !== 'screenshot'), [
    { cmd: 'drag', x: 10, y: 20, x2: 300, y2: 400 },
    { cmd: 'scroll', dir: 'up', amount: 3, x: 100, y: 200 },
    { cmd: 'scroll', dir: 'down', amount: 5 },
    { cmd: 'move', x: 5, y: 6 },
  ]);
  assert.match(await q.run('keo', '1 2'), /Cách dùng/); assert.match(await q.run('cuon', 'lung tung'), /Cách dùng/); assert.match(await q.run('re', 'a'), /Cách dùng/);
  L.stop();
});
