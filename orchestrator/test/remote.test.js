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

const linux = process.platform === 'linux';

test('lenh: chạy được, in kết quả, báo mã lỗi, dừng khi quá giờ; không toàn quyền thì từ chối', { skip: !linux }, async () => {
  const r = createRemote({ timeoutMs: 1500 });
  assert.match((await r.runShell('echo xin chao; echo loi >&2')).text, /✅ Xong[\s\S]*xin chao[\s\S]*loi/);
  assert.match((await r.runShell('exit 3')).text, /mã 3/);
  const slow = await r.runShell('sleep 10'); assert.match(slow.text, /Dừng vì quá/);
  assert.match((await r.runShell('')).text, /Cách dùng/);
  const big = (await r.runShell('head -c 20000 /dev/zero | tr "\\0" "a"')).text; assert.ok(big.length < 3800, 'cắt gọn: ' + big.length);
  assert.match((await createRemote({ isFull: () => false }).runShell('echo hi')).text, /TOÀN QUYỀN/);
});

test('lay: gửi tệp về (ảnh thành photo), từ chối thư mục / không có / quá lớn', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-'));
  fs.writeFileSync(path.join(d, 'a.txt'), 'abc'); fs.writeFileSync(path.join(d, 'b.png'), 'x');
  const r = createRemote({ cwd: d });
  const a = await r.getFile('a.txt'); assert.equal(a.files[0].kind, 'document'); assert.equal(a.files[0].path, path.join(d, 'a.txt'));
  assert.equal((await r.getFile(path.join(d, 'b.png'))).files[0].kind, 'photo');
  assert.match((await r.getFile(d)).text, /thư mục/); assert.match((await r.getFile('khong-co.txt')).text, /Không thấy/); assert.match((await r.getFile('')).text, /Cách dùng/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('quick: /go /phim /bam gọi đúng lệnh màn hình; /bam kiểm tra toạ độ; bot chỉ cho quản trị viên', async () => {
  const calls = [];
  const desk = { call: async (c) => { calls.push(c); return { ok: true }; } };
  const q = createQuick({ desk, remote: createRemote({}), shotWaitMs: 0 });
  assert.ok(q.has('lenh') && q.has('lay') && q.has('maytinh') && q.has('go') && q.has('phim') && q.has('bam'));
  assert.match(await q.run('go', 'xin chào'), /Đã gõ 8/);
  assert.match(await q.run('phim', 'ctrl+s'), /Đã bấm ctrl\+s/);
  assert.match(await q.run('bam', '640 360 dup'), /Đã bấm \(640, 360\)/);
  await q.run('bam', '10,20 phải');
  const acts = calls.filter((c) => c.cmd !== 'screenshot');
  assert.deepEqual(acts.map((c) => c.cmd), ['type', 'key', 'click', 'click']);
  assert.equal(calls.filter((c) => c.cmd === 'screenshot').length, 4, 'tự chụp lại sau mỗi thao tác');
  assert.equal(acts[2].double, true); assert.equal(acts[2].button, 1); assert.equal(acts[3].button, 3);
  assert.match(await q.run('bam', 'abc'), /Cách dùng/);
  const db = openDb(':memory:');
  const bot = createBot({ db, worker: { wake() {}, currentJobId: () => null, engineNames: () => ['claude'] }, allowed: new Set(['1', '2']), isAdmin: (u) => u === '1', quick: q });
  const m = (text, uid) => ({ from: { id: uid }, chat: { id: uid, type: 'private' }, text });
  assert.match(String(await bot.handle(m('/lenh ls', 2))), /chỉ dành cho quản trị viên/);
  assert.match(String(await bot.handle(m('/lay /etc/passwd', 2))), /chỉ dành cho quản trị viên/);
  assert.match(String(await bot.handle(m('/go abc', 1))), /Đã gõ 3/);
});
