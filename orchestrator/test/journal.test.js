'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJournal, targetsOfBash, targetsOf } = require('../src/journal');
const { createGate } = require('../src/gate');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jr-'));
const ps = (cmd) => targetsOfBash(cmd, '/w', 0).paths.map((x) => x.p + (x.recursive ? '*' : '') + (x.meta ? '#' : ''));

test('phân tích lệnh Bash: rm/mv/cp/sed -i/tee/dd/chmod/find -delete/chuyển hướng, kể cả trong bash -c, bỏ qua /dev/null và 2>&1', () => {
  assert.deepEqual(ps('rm -rf /tmp/a b.txt && echo hi > out.log 2>&1'), ['/tmp/a*', 'b.txt*', 'out.log']);
  assert.deepEqual(ps('echo x >> a.log 2>/dev/null; cat y | tee -a z.txt'), ['a.log', 'z.txt']);
  assert.deepEqual(ps("sed -i 's/a/b/' f.txt"), ['f.txt']);
  assert.deepEqual(ps('sed -n s/a/b/p f.txt'), [], 'sed không -i thì không sửa tệp');
  assert.deepEqual(ps('mv x y'), ['x*', 'y*']);
  assert.deepEqual(ps('sudo cp -r src dest'), ['dest*']);
  assert.deepEqual(ps('dd if=/dev/zero of=/tmp/big bs=1M count=1'), ['/tmp/big']);
  assert.deepEqual(ps('chmod -R 700 secret; chown a:b f'), ['secret*#', 'f#']);
  assert.deepEqual(ps('find . -name "*.tmp" -delete'), ['.*']);
  assert.deepEqual(ps('find . -name x -print'), [], 'find chỉ liệt kê thì không đụng gì');
  assert.deepEqual(ps('bash -c "rm -f z; cat > w.txt <<EOF\nhello\nEOF"'), ['z', 'w.txt']);
  assert.deepEqual(ps('FOO=1 nohup rm a'), ['a*'.replace('*', '')]);
  assert.deepEqual(ps('curl -sSL -o a.zip http://x/y'), ['a.zip']);
  assert.deepEqual(ps('truncate -s 0 log.txt'), ['log.txt']);
});

test('lệnh đổi trạng thái hệ thống / tên tệp có biến → ghi cảnh báo "không hoàn tác được", không đoán bừa', () => {
  const t = (c) => targetsOfBash(c, '/w', 0).unsafe;
  assert.ok(t('sudo apt-get install -y vlc').some((x) => /apt-get/.test(x)));
  assert.ok(t('systemctl restart nginx').some((x) => /systemctl/.test(x)));
  assert.ok(t('git checkout main').some((x) => /git checkout/.test(x)));
  assert.ok(t('rm -rf $DIR').some((x) => /biến/.test(x)));
  assert.ok(t('echo a > $F').some((x) => /biến/.test(x)));
  assert.deepEqual(t('npm install'), [], 'npm trong dự án: đã có mốc của dự án');
  assert.ok(t('npm i -g x').length === 1);
  assert.deepEqual(t('ls -la; cat a; grep x y'), []);
  assert.deepEqual(targetsOf('Read', { file_path: '/a' }, '/w'), { paths: [], unsafe: [] });
  assert.deepEqual(targetsOf('Write', { file_path: '/a/b' }, '/w').paths, [{ p: '/a/b', recursive: false, meta: false }]);
});

test('lưu bản gốc rồi quay lại: tệp bị sửa, tệp bị xóa, tệp mới tạo, thư mục bị xóa cả cây', async () => {
  const root = tmp(), work = path.join(root, 'w'), jd = path.join(root, 'journal'); fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'gia.txt'), 'giá đúng 100'); fs.writeFileSync(path.join(work, 'ghi-chu.md'), 'ghi chú gốc');
  fs.mkdirSync(path.join(work, 'cu', 'sau'), { recursive: true }); fs.writeFileSync(path.join(work, 'cu', 'a.txt'), 'AAA'); fs.writeFileSync(path.join(work, 'cu', 'sau', 'b.txt'), 'BBB');
  const j = createJournal({ dir: jd, cwdOf: () => work });
  const job = { id: 31, prompt: 'thử' };
  await j.before(job, 'Write', { file_path: path.join(work, 'gia.txt') });
  fs.writeFileSync(path.join(work, 'gia.txt'), 'AI làm hỏng 999');
  await j.before(job, 'Bash', { command: 'rm ghi-chu.md && rm -rf cu && echo rac > rac.txt' });
  fs.rmSync(path.join(work, 'ghi-chu.md')); fs.rmSync(path.join(work, 'cu'), { recursive: true }); fs.writeFileSync(path.join(work, 'rac.txt'), 'rác');
  const plan = await j.plan(31);
  assert.ok(plan.some((x) => /gia\.txt$/.test(x.p)) && plan.some((x) => /rac\.txt$/.test(x.p) && /xóa/.test(x.act)) && plan.some((x) => /b\.txt$/.test(x.p)));
  const r = await j.restore(31);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(work, 'gia.txt'), 'utf8'), 'giá đúng 100');
  assert.equal(fs.readFileSync(path.join(work, 'ghi-chu.md'), 'utf8'), 'ghi chú gốc');
  assert.equal(fs.readFileSync(path.join(work, 'cu', 'sau', 'b.txt'), 'utf8'), 'BBB');
  assert.equal(fs.existsSync(path.join(work, 'rac.txt')), false);
  // quay lại cũng hoàn tác được: nhật ký "u…" giữ trạng thái trước khi quay lại
  assert.ok(r.undoId && (await j.get(r.undoId)));
  const r2 = await j.restore(r.undoId);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(fs.readFileSync(path.join(work, 'gia.txt'), 'utf8'), 'AI làm hỏng 999');
  assert.equal(fs.existsSync(path.join(work, 'ghi-chu.md')), false);
  assert.equal(fs.existsSync(path.join(work, 'rac.txt')), true);
});

test('chỉ giữ trạng thái TRƯỚC LẦN SỬA ĐẦU TIÊN; ngoài thư mục dự án vẫn lưu được; glob; cp vào thư mục', async () => {
  const root = tmp(), work = path.join(root, 'w'), outside = path.join(root, 'ngoai'); fs.mkdirSync(work); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'cfg.conf'), 'v1'); fs.writeFileSync(path.join(outside, 'a.log'), 'L1'); fs.writeFileSync(path.join(outside, 'b.log'), 'L2');
  fs.writeFileSync(path.join(work, 'x.txt'), 'X'); fs.mkdirSync(path.join(work, 'dich')); fs.writeFileSync(path.join(work, 'dich', 'x.txt'), 'CU');
  const j = createJournal({ dir: path.join(root, 'j'), cwdOf: () => work });
  const job = { id: 7, prompt: '' };
  await j.before(job, 'Edit', { file_path: path.join(outside, 'cfg.conf') }); fs.writeFileSync(path.join(outside, 'cfg.conf'), 'v2');
  await j.before(job, 'Edit', { file_path: path.join(outside, 'cfg.conf') }); fs.writeFileSync(path.join(outside, 'cfg.conf'), 'v3');
  await j.before(job, 'Bash', { command: 'rm ' + path.join(outside, '*.log') });
  await j.before(job, 'Bash', { command: 'cp x.txt dich/' });
  fs.rmSync(path.join(outside, 'a.log')); fs.rmSync(path.join(outside, 'b.log')); fs.writeFileSync(path.join(work, 'dich', 'x.txt'), 'X');
  const r = await j.restore(7);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(outside, 'cfg.conf'), 'utf8'), 'v1', 'về bản gốc, không phải v2');
  assert.equal(fs.readFileSync(path.join(outside, 'a.log'), 'utf8'), 'L1'); assert.equal(fs.readFileSync(path.join(outside, 'b.log'), 'utf8'), 'L2');
  assert.equal(fs.readFileSync(path.join(work, 'dich', 'x.txt'), 'utf8'), 'CU');
});

test('quyền truy cập (chmod) được trả lại; lệnh không hiểu được ghi cảnh báo vào danh sách', async () => {
  const root = tmp(), work = path.join(root, 'w'); fs.mkdirSync(work);
  const f = path.join(work, 's.sh'); fs.writeFileSync(f, 'echo'); fs.chmodSync(f, 0o640);
  const j = createJournal({ dir: path.join(root, 'j'), cwdOf: () => work });
  await j.before({ id: 9, prompt: 'p' }, 'Bash', { command: 'chmod 777 s.sh; apt-get remove -y foo' });
  fs.chmodSync(f, 0o777);
  const l = await j.list(); assert.equal(l.length, 1); assert.ok(l[0].unsafe.some((x) => /apt-get/.test(x)));
  assert.equal((await j.restore(9)).ok, true);
  assert.equal(fs.statSync(f).mode & 0o777, 0o640);
});

test('hạn mức: tệp lớn hơn giới hạn / vượt hạn mức một việc KHÔNG chép nhưng báo thật; không đụng thư mục bot / hệ thống', async () => {
  const root = tmp(), work = path.join(root, 'w'), botData = path.join(root, 'bot'); fs.mkdirSync(work); fs.mkdirSync(botData);
  fs.writeFileSync(path.join(work, 'to.bin'), Buffer.alloc(5000, 1)); fs.writeFileSync(path.join(work, 'nho.txt'), 'n'); fs.writeFileSync(path.join(botData, 'db'), 'DB');
  const j = createJournal({ dir: path.join(root, 'j'), cwdOf: () => work, exclude: [botData], limits: { maxFileBytes: 4000 } });
  await j.before({ id: 1, prompt: '' }, 'Write', { file_path: path.join(work, 'to.bin') });
  await j.before({ id: 1, prompt: '' }, 'Write', { file_path: path.join(work, 'nho.txt') });
  await j.before({ id: 1, prompt: '' }, 'Write', { file_path: path.join(botData, 'db') });
  await j.before({ id: 1, prompt: '' }, 'Write', { file_path: '/proc/self/x' });
  const m = await j.get(1); assert.equal(m.partial, true); assert.ok(m.unsafe.some((x) => /quá lớn/.test(x)));
  const es = await j.entries(1); assert.equal(es.length, 2); assert.equal(es.find((e) => /to\.bin/.test(e.p)).skipped, 'big');
  const j2 = createJournal({ dir: path.join(root, 'j2'), cwdOf: () => work, limits: { maxJobBytes: 100 } });
  await j2.before({ id: 2, prompt: '' }, 'Write', { file_path: path.join(work, 'to.bin') });
  assert.ok((await j2.get(2)).unsafe.some((x) => /hạn mức/.test(x)));
});

test('dọn nhật ký: quá hạn / quá số lượng bị xóa, mới giữ lại', async () => {
  const root = tmp(), work = path.join(root, 'w'); fs.mkdirSync(work); fs.writeFileSync(path.join(work, 'a'), '1');
  let t = 1800000000000;
  const j = createJournal({ dir: path.join(root, 'j'), cwdOf: () => work, now: () => t, limits: { keepJobs: 2, keepDays: 10 } });
  for (const id of [1, 2, 3]) { t += 1000; await j.before({ id, prompt: '' }, 'Write', { file_path: path.join(work, 'a') }); }
  await j.gc(); assert.deepEqual((await j.list()).map((x) => x.id).sort(), ['2', '3']);
  t += 11 * 86400000; await j.gc(); assert.deepEqual(await j.list(), []);
});

test('cổng duyệt: chỉ ghi nhật ký khi được cho phép (bị chặn thì không), kể cả chế độ hàng rào tắt (journalOnly)', async () => {
  const calls = [];
  const db = { addAudit() {} };
  const gate = createGate({ db, approvals: { request: async () => ({ allowed: false, source: 'user' }), cancelJob() {} }, workdir: '/w', log() {}, journal: { before: async (job, tool, input) => { calls.push([job.id, tool, input.file_path || input.command]); } } });
  gate.begin({ id: 5, chat_id: 1 }, { policy: {} }, { guard: true, journalOnly: true });
  const port = await gate.listen(0);
  const post = (body) => fetch('http://127.0.0.1:' + port + '/gate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': gate.token }, body: JSON.stringify(body) }).then((r) => r.json());
  assert.equal((await post({ jobId: 5, tool: 'Write', input: { file_path: '/x/y' } })).behavior, 'allow');
  assert.equal((await post({ jobId: 5, tool: 'Bash', input: { command: 'rm -rf /x/y' } })).behavior, 'allow', 'journalOnly: không hỏi/chặn');
  assert.deepEqual(calls, [[5, 'Write', '/x/y'], [5, 'Bash', 'rm -rf /x/y']]);
  gate.end(5); await gate.close();
});

// Thử thật với tệp 5,5 GB (chỉ chạy khi đặt BIG_FILE_TEST=1 và BIG_DIR=<thư mục trên đĩa thật>; cần ~25 GB trống)
test('tệp 5,5 GB: nhật ký trước-khi-sửa và mốc dự án đều lưu + khôi phục đúng nội dung', { skip: !process.env.BIG_FILE_TEST, timeout: 1800000 }, async () => {
  const { createCheckpoints } = require('../src/checkpoints');
  const crypto = require('crypto');
  const root = fs.mkdtempSync(path.join(process.env.BIG_DIR || os.tmpdir(), 'big-')), work = path.join(root, 'w'); fs.mkdirSync(work);
  const big = path.join(work, 'lon.bin'), size = Math.round(5.5 * 1024 * 1024 * 1024);
  const fd = fs.openSync(big, 'w'); const chunk = crypto.randomBytes(8 * 1024 * 1024);
  for (let w = 0; w < size; w += chunk.length) fs.writeSync(fd, chunk, 0, Math.min(chunk.length, size - w), w);
  fs.closeSync(fd);
  const sha = (f) => new Promise((res) => { const h = crypto.createHash('sha1'); fs.createReadStream(f).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))); });
  const before = await sha(big);
  const t0 = Date.now();
  const j = createJournal({ dir: path.join(root, 'j'), cwdOf: () => work });
  await j.before({ id: 1, prompt: '' }, 'Bash', { command: 'rm lon.bin' }); fs.rmSync(big);
  assert.equal((await j.restore(1)).ok, true); assert.equal(await sha(big), before, 'nhật ký: nội dung 5,5 GB đúng từng byte');
  const ck = createCheckpoints({ dir: path.join(root, 'c') });
  const s = await ck.snapshot('p', work, { label: 'to' }); assert.equal(s.ok, true); assert.equal(s.partial, false);
  fs.writeFileSync(big, 'hỏng');
  const r = await ck.restore('p', s.id, work); assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await sha(big), before, 'mốc dự án: nội dung 5,5 GB đúng từng byte');
  console.log('TEP-5GB-OK ' + Math.round((Date.now() - t0) / 1000) + 's');
  fs.rmSync(root, { recursive: true, force: true });
});
