'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createUpdateWatcher, cmpVersion } = require('../src/update');
const { createQuick } = require('../src/quick');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ow-'));
const vn = (iso) => Date.parse(iso + '+07:00');

function make(extra) {
  const dir = tmp();
  const o = Object.assign({
    db: openDb(':memory:'), log() {}, admins: ['1'], sent: [],
    versionFile: path.join(dir, 'VERSION'), requestFile: path.join(dir, 'req'), resultFile: path.join(dir, 'res.json'),
  }, extra || {});
  fs.writeFileSync(o.versionFile, (o.installed || '1.0') + '\n');
  let manifest = o.manifest || { version: '2.0', notes: 'Thêm tính năng X', date: '2026-10-21' };
  o.fetch = async () => (o.fail ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => manifest });
  o.notify = async (c, t) => o.sent.push([c, t]);
  const w = createUpdateWatcher(o);
  return { w, o, setManifest: (m) => { manifest = m; } };
}

test('cmpVersion', () => { assert.equal(cmpVersion('2026.10.21.1', '2026.10.20.5'), 1); assert.equal(cmpVersion('1.0', '1.0.0'), 0); assert.equal(cmpVersion('1.2', '1.10'), -1); });

test('/capnhat: hiện phiên bản đang cài + mới nhất + nội dung; đã mới nhất; lỗi mạng', async () => {
  const { w, setManifest } = make();
  const s = await w.command('');
  assert.match(s, /Đang cài: 1\.0/); assert.match(s, /Mới nhất: 2\.0 \(2026-10-21\)  → CÓ BẢN MỚI/); assert.match(s, /Thêm tính năng X/); assert.match(s, /Tự cập nhật: tắt/);
  setManifest({ version: '1.0' });
  assert.match(await w.command(''), /đã mới nhất/);
  const bad = make({ fail: true });
  assert.match(await bad.w.command(''), /Không hỏi được phiên bản mới \(HTTP 503\)/);
  const weird = make({ manifest: { version: 'abc' } });
  assert.match(await weird.w.command(''), /manifest không hợp lệ/);
});

test('/capnhat co: ghi tệp yêu cầu khi rảnh; từ chối khi đang có việc (trừ khi "ep"); không yêu cầu khi đã mới nhất', async () => {
  let busy = false;
  const { w, o, setManifest } = make({ idle: () => !busy });
  assert.match(await w.command('co'), /Đã yêu cầu cập nhật 1\.0 → 2\.0/);
  assert.ok(fs.existsSync(o.requestFile)); fs.rmSync(o.requestFile);
  busy = true;
  assert.match(await w.command('co'), /Đang có việc AI/); assert.equal(fs.existsSync(o.requestFile), false);
  assert.match(await w.command('co ep'), /Đã yêu cầu cập nhật/); assert.ok(fs.existsSync(o.requestFile)); fs.rmSync(o.requestFile);
  setManifest({ version: '1.0' });
  assert.match(await w.command('co'), /Đã là bản mới nhất/); assert.equal(fs.existsSync(o.requestFile), false);
});

test('tick: hỏi tối đa mỗi 3 giờ, báo MỘT lần cho mỗi phiên bản mới, không báo khi đã mới nhất', async () => {
  let clock = vn('2026-10-21T10:00:00');
  const { w, o, setManifest } = make({ now: () => clock });
  assert.equal(await w.tick(), 'notified');
  assert.equal(o.sent.length, 1); assert.match(o.sent[0][1], /Có phiên bản AgentOS mới: 2\.0 \(đang cài 1\.0\)/); assert.match(o.sent[0][1], /\/capnhat co/);
  assert.equal(await w.tick(), null);                                   // chưa đủ 3 giờ
  clock += 4 * 3600 * 1000; assert.equal(await w.tick(), null);          // đã hỏi lại nhưng cùng phiên bản: không báo lại
  assert.equal(o.sent.length, 1);
  setManifest({ version: '2.1', notes: '' }); clock += 4 * 3600 * 1000;
  assert.equal(await w.tick(), 'notified'); assert.equal(o.sent.length, 2);
  setManifest({ version: '1.0' }); clock += 4 * 3600 * 1000; assert.equal(await w.tick(), null);
});

test('tự cập nhật: mặc định TẮT; bật thì chỉ trong 02:00-05:00 giờ VN, khi rảnh, mỗi phiên bản không thử lại trong 6 giờ', async () => {
  let clock = vn('2026-10-21T10:00:00'), busy = false;
  const { w, o } = make({ now: () => clock, idle: () => !busy });
  assert.equal(await w.autoTick(), false);
  assert.match(await w.command('tudong bat'), /Đã bật tự cập nhật/);
  assert.equal(await w.autoTick(), false);                                // 10:00: ngoài khung
  clock = vn('2026-10-22T03:00:00'); busy = true; assert.equal(await w.autoTick(), false);   // bận
  busy = false; assert.equal(await w.autoTick(), true); assert.ok(fs.existsSync(o.requestFile)); fs.rmSync(o.requestFile);
  clock += 3600 * 1000; assert.equal(await w.autoTick(), false);          // vừa thử
  clock = vn('2026-10-22T04:59:00'); assert.equal(await w.autoTick(), false);   // vẫn chưa quá 6 giờ
  assert.match(await w.command('tudong tat'), /Đã tắt/);
});

test('announceResult: báo kết quả cập nhật đúng một lần (thành công hoặc lỗi + đã khôi phục)', async () => {
  const { w, o } = make();
  assert.equal(await w.announceResult(), null);                          // chưa có kết quả
  fs.writeFileSync(o.resultFile, JSON.stringify({ ok: true, from: '1.0', to: '2.0', notes: 'Thêm X', at: '2026-10-21T10:00:00Z' }));
  assert.ok(await w.announceResult()); assert.match(o.sent[0][1], /Đã cập nhật AgentOS 1\.0 → 2\.0/); assert.match(o.sent[0][1], /Thêm X/);
  assert.equal(await w.announceResult(), null); assert.equal(o.sent.length, 1);
  fs.writeFileSync(o.resultFile, JSON.stringify({ ok: false, from: '1.0', to: '3.0', code: 'health', error: 'Dịch vụ lỗi', rolledBack: true, at: '2026-10-22T10:00:00Z' }));
  await w.announceResult(); assert.match(o.sent[1][1], /KHÔNG thành công: Dịch vụ lỗi/); assert.match(o.sent[1][1], /Đã khôi phục bản cũ/);
});

test('quick: /capnhat đã đăng ký và chuyển lệnh cho bộ cập nhật', async () => {
  const q = createQuick({ update: { command: async (a) => 'UPD:' + a } });
  assert.ok(q.has('capnhat')); assert.equal(await q.run('capnhat', 'co ep'), 'UPD:co ep');
  assert.match(await createQuick({}).run('capnhat', ''), /chưa có tính năng cập nhật/);
});
