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

test('/lay: tệp > 49 MB tự đổi sang link tải; /guilen chạy được', async () => {
  const d = tmp(); const big = path.join(d, 'lon.bin');
  const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 60 * 1024 * 1024); fs.closeSync(fd);          // tệp thưa 60 MB
  const L = mk();
  const q = createQuick({ desk: { call: async () => ({ ok: true }) }, remote: createRemote({ cwd: d }), links: L, shotWaitMs: 0 });
  const r = await q.run('lay', big); assert.match(r.text, /quá lớn[\s\S]*http:\/\/127\.0\.0\.1:/); assert.equal(r.files, undefined);
  assert.match(await q.run('guilen', '', { chatId: '9' }), /http:\/\/127\.0\.0\.1:\d+\/u\//);
  L.stop();
});

function fakeSudo(opts) {
  opts = opts || {};
  const calls = [];
  const exec = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === '--password') return { code: 0, out: 'Done!', err: '' };
    if (args[0] === 'rustdesk' && args[1] === '--password') return { code: opts.failPw ? 1 : 0, out: 'Done!', err: '' };
    if (args[0] === 'rustdesk' && args[1] === '--get-id') return { code: 0, out: opts.noId ? '' : '123456789', err: '' };
    return { code: 0, out: '', err: '' };
  };
  return { exec, calls };
}

test('/tuxa: bật RustDesk, đặt mật khẩu tạm ngẫu nhiên, trả ID + mật khẩu; /tuxa dong ngắt phiên và đổi mật khẩu', async () => {
  const fs2 = fakeSudo(); const desk = []; let until = null;
  const r = createRemote({ exec: fs2.exec, idWaitMs: 0, remoteTtlMs: 7200000, state: { get: () => until, set: (v) => { until = v; } } });
  const q = createQuick({ desk: { call: async (c) => { desk.push(c); return { ok: true }; } }, remote: r, shotWaitMs: 0 });
  const t = await q.run('tuxa', '');
  const pw = t.text.match(/Mật khẩu: (\S+)/)[1];
  assert.match(t.text, /ID: 123456789/); assert.ok(pw.length >= 12, 'mật khẩu đủ dài');
  assert.ok(fs2.calls.includes('systemctl enable --now rustdesk')); assert.ok(fs2.calls.some((c) => c === 'rustdesk --password ' + pw));
  assert.ok(fs2.calls.includes('rustdesk --option approve-mode password'));
  assert.deepEqual(desk, [{ cmd: 'open', app: 'rustdesk' }]); assert.ok(until > Date.now(), 'nhớ hạn mật khẩu tạm');
  const t2 = await q.run('tuxa', ''); assert.notEqual(t2.text.match(/Mật khẩu: (\S+)/)[1], pw, 'mỗi lần một mật khẩu mới');
  const stop = await q.run('tuxa', 'đóng');
  assert.match(stop.text, /Đã đóng/); assert.equal(until, null);
  assert.ok(fs2.calls.includes('systemctl stop rustdesk'));
  const last = fs2.calls.filter((c) => c.startsWith('rustdesk --password ')).pop();
  assert.notEqual(last.split(' ')[2], pw, 'mật khẩu cũ không còn dùng được');
  assert.deepEqual(desk[desk.length - 1], { cmd: 'close', app: 'rustdesk' });
});

test('/tuxa: không lấy được ID hoặc không đặt được mật khẩu thì nói rõ, không bịa; còn phiên cũ lúc khởi động thì tự đổi mật khẩu', async () => {
  const noId = createRemote({ exec: fakeSudo({ noId: true }).exec, idWaitMs: 0, idTries: 2 });
  assert.match((await noId.remoteStart()).text, /Chưa lấy được ID/);
  const noPw = await createRemote({ exec: fakeSudo({ failPw: true }).exec, idWaitMs: 0 }).remoteStart();
  assert.match(noPw.text, /ID RustDesk của máy: 123456789/); assert.doesNotMatch(noPw.text, /Mật khẩu: /);
  const fs3 = fakeSudo(); let until = Date.now() + 1000;
  createRemote({ exec: fs3.exec, state: { get: () => until, set: (v) => { until = v; } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(until, null); assert.ok(fs3.calls.some((c) => c.startsWith('rustdesk --password ')), 'khởi động lại còn phiên cũ -> đổi mật khẩu');
});
