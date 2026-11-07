'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCheckpoints } = require('../src/checkpoints');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
const put = (root, rel, text) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const get = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const has = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));
const blobCount = (store, pid) => { let n = 0; const b = path.join(store, pid, 'blobs'); if (!fs.existsSync(b)) return 0; for (const d of fs.readdirSync(b)) n += fs.readdirSync(path.join(b, d)).length; return n; };
let clock = 1_700_000_000_000;
const mk = (store, limits) => createCheckpoints({ dir: store, now: () => (clock += 1000), limits });

test('mốc khôi phục: chụp → AI sửa/xóa/tạo tệp → xem thay đổi → quay về đúng như cũ; quay về cũng hoàn tác được', async () => {
  const store = tmp(), root = tmp(), ck = mk(store);
  put(root, 'bao-gia.txt', 'giá cũ 100'); put(root, 'sub/ghi-chu.md', 'ghi chú gốc'); put(root, 'xoa-di.txt', 'sẽ bị AI xóa');
  const s1 = await ck.snapshot('p1', root, { label: 'trước việc #1', jobId: 1 });
  assert.ok(s1.ok && !s1.unchanged && s1.files === 3);
  put(root, 'bao-gia.txt', 'AI sửa sai 999'); fs.rmSync(path.join(root, 'xoa-di.txt')); put(root, 'moi/ai-tao.txt', 'tệp AI tạo');
  const d = await ck.diff('p1', s1.id, root);
  assert.deepEqual(d.changed, ['bao-gia.txt']); assert.deepEqual(d.removed, ['xoa-di.txt']); assert.deepEqual(d.added, ['moi/ai-tao.txt']);
  const r = await ck.restore('p1', s1.id, root);
  assert.ok(r.ok); assert.equal(r.restored, 2); assert.equal(r.deleted, 1);
  assert.equal(get(root, 'bao-gia.txt'), 'giá cũ 100'); assert.equal(get(root, 'xoa-di.txt'), 'sẽ bị AI xóa'); assert.equal(get(root, 'sub/ghi-chu.md'), 'ghi chú gốc');
  assert.equal(has(root, 'moi/ai-tao.txt'), false); assert.equal(has(root, 'moi'), false, 'thư mục rỗng do tệp mới tạo cũng được dọn');
  const list = await ck.list('p1'); assert.equal(list[0].label, 'Trước khi khôi phục'); assert.equal(list.length, 2);
  const undo = await ck.restore('p1', list[0].id, root);                          // hoàn tác việc quay về
  assert.ok(undo.ok); assert.equal(get(root, 'bao-gia.txt'), 'AI sửa sai 999'); assert.equal(has(root, 'xoa-di.txt'), false); assert.equal(get(root, 'moi/ai-tao.txt'), 'tệp AI tạo');
});

test('mốc khôi phục: không đổi gì thì dùng lại mốc cũ; tệp giống nhau chỉ lưu một bản; khôi phục khi không có gì khác thì báo "không cần"', async () => {
  const store = tmp(), root = tmp(), ck = mk(store);
  put(root, 'a.txt', 'cùng nội dung'); put(root, 'b.txt', 'cùng nội dung'); put(root, 'c.txt', 'khác');
  const s1 = await ck.snapshot('p', root, {}), s2 = await ck.snapshot('p', root, {});
  assert.equal(s2.unchanged, true); assert.equal(s2.id, s1.id); assert.equal((await ck.list('p')).length, 1);
  assert.equal(blobCount(store, 'p'), 2, '3 tệp, 2 nội dung → 2 bản');
  const r = await ck.restore('p', s1.id, root); assert.ok(r.ok && r.nothing);
  assert.equal((await ck.list('p')).length, 1, 'không tạo mốc thừa khi không có gì để khôi phục');
});

test('mốc khôi phục: bỏ qua node_modules/.git, tệp quá lớn, liên kết tắt; quá nhiều tệp thì chụp một phần và khôi phục không đụng tệp ngoài phạm vi', async () => {
  const store = tmp(), root = tmp(), ck = mk(store, { maxFiles: 3, maxFileBytes: 20 });
  put(root, 'node_modules/x/index.js', 'thư viện'); put(root, '.git/config', 'git'); put(root, 'lon.bin', 'x'.repeat(100));
  put(root, 'a.txt', '1'); put(root, 'b.txt', '2'); put(root, 'c.txt', '3'); put(root, 'd.txt', '4');
  try { fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'tat.lnk')); } catch (e) { /* Windows không cấp quyền: bỏ qua phần này */ }
  const s = await ck.snapshot('p', root, {});
  assert.equal(s.files, 3); assert.equal(s.partial, true);
  const meta = (await ck.list('p'))[0]; assert.ok(meta.skipped >= 1);
  const wide = mk(tmp(), { maxFileBytes: 20 }), sw = await wide.snapshot('q', root, {});          // không giới hạn số tệp: tệp quá lớn (lon.bin) bị bỏ, node_modules/.git không vào
  assert.equal(sw.files, 4); assert.equal(sw.partial, false); assert.equal((await wide.list('q'))[0].skipped, 1);
  put(root, 'node_modules/x/index.js', 'AI sửa thư viện'); put(root, 'lon.bin', 'y'.repeat(100));
  put(root, 'a.txt', 'sửa');
  const r = await ck.restore('p', s.id, root);
  assert.ok(r.ok); assert.equal(get(root, 'a.txt'), '1');
  assert.equal(get(root, 'node_modules/x/index.js'), 'AI sửa thư viện', 'ngoài phạm vi chụp: không bị đụng');
  assert.equal(get(root, 'lon.bin'), 'y'.repeat(100)); assert.equal(get(root, '.git/config'), 'git');
});

test('mốc khôi phục: chỉ giữ N mốc gần nhất, dọn bản nội dung không còn dùng; quay về mốc cũ nhất vẫn đủ dữ liệu', async () => {
  const store = tmp(), root = tmp(), ck = mk(store, { keep: 3 });
  const ids = [];
  for (let i = 1; i <= 5; i++) { put(root, 'f.txt', 'phiên bản ' + i); put(root, 'only' + i + '.txt', 'riêng ' + i); ids.push((await ck.snapshot('p', root, { label: 'v' + i })).id); }
  const list = await ck.list('p'); assert.equal(list.length, 3); assert.deepEqual(list.map((x) => x.label), ['v5', 'v4', 'v3']);
  assert.equal(await ck.diff('p', ids[0], root).then((x) => x.ok), false, 'mốc đã dọn thì báo không còn');
  const oldest = ids[2];                                                         // v3 là mốc cũ nhất còn lại
  assert.equal(blobCount(store, 'p'), 8, 'f.txt: 3 bản (v3–v5; v1, v2 đã dọn) + only1..only5: 5 bản');
  const r = await ck.restore('p', oldest, root);
  assert.ok(r.ok); assert.equal(get(root, 'f.txt'), 'phiên bản 3'); assert.equal(has(root, 'only4.txt'), false); assert.equal(has(root, 'only3.txt'), true);
  assert.equal((await ck.list('p'))[0].label, 'Trước khi khôi phục');
});

test('mốc khôi phục: an toàn — mốc bị sửa đường dẫn "../" hoặc thiếu dữ liệu thì từ chối và KHÔNG đụng tệp nào; mã dự án lạ không ném lỗi', async () => {
  const store = tmp(), root = tmp(), outside = tmp(), ck = mk(store);
  put(root, 'a.txt', 'gốc'); put(root, 'b.txt', 'gốc b');
  const s = await ck.snapshot('p', root, {});
  const mf = path.join(store, 'p', 'snap-' + s.id + '.json'), m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  put(root, 'a.txt', 'đã sửa');
  const evil = Object.assign({}, m, { '../thoat.txt': m['a.txt'] }); fs.writeFileSync(mf, JSON.stringify(evil));
  fs.rmSync(path.join(root, 'b.txt'));
  const r1 = await ck.restore('p', s.id, root); assert.equal(r1.ok, false); assert.match(r1.error, /không hợp lệ|ra ngoài/);
  assert.equal(get(root, 'a.txt'), 'đã sửa'); assert.equal(has(root, 'b.txt'), false); assert.equal(fs.existsSync(path.join(root, '..', 'thoat.txt')), false);
  fs.writeFileSync(mf, JSON.stringify(m));
  const bd = path.join(store, 'p', 'blobs'); for (const d of fs.readdirSync(bd)) for (const n of fs.readdirSync(path.join(bd, d))) if (n === m['b.txt'][0]) fs.rmSync(path.join(bd, d, n));
  const r2 = await ck.restore('p', s.id, root); assert.equal(r2.ok, false); assert.match(r2.error, /Thiếu dữ liệu/);
  assert.equal(get(root, 'a.txt'), 'đã sửa', 'thiếu dữ liệu: dừng trước khi ghi bất cứ thứ gì');
  const bad = await ck.snapshot('../hack', root, {}); assert.equal(bad.ok, false);
  assert.deepEqual(await ck.list('../hack'), []);
  assert.equal((await ck.restore('p', 'khong-co', root)).ok, false);
});

test('mốc khôi phục: nhiều yêu cầu cùng một dự án chạy lần lượt (không hỏng chỉ mục)', async () => {
  const store = tmp(), root = tmp(), ck = mk(store);
  put(root, 'a.txt', '0');
  const jobs = []; for (let i = 1; i <= 6; i++) { put(root, 'a.txt', 'v' + i); jobs.push(ck.snapshot('p', root, { label: 'v' + i })); await new Promise((r) => setImmediate(r)); }
  const res = await Promise.all(jobs);
  assert.ok(res.every((x) => x.ok));
  const list = await ck.list('p'); assert.equal(new Set(list.map((x) => x.id)).size, list.length, 'mã mốc không trùng');
  for (const s of list) assert.ok(fs.existsSync(path.join(store, 'p', 'snap-' + s.id + '.json')));
});
