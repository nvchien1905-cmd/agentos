'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDongBo, pipeProcs } = require('../src/dongbo');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'db-'));
function mk(o) {
  o = o || {};
  const M = { name: 'May van phong', url: 'http://100.80.252.29:8433', key: 'k', ssh: o.noSsh ? undefined : { user: 'nguye' } };
  const fleet = { load: () => ({ machines: [M] }), findMachine: (n) => (String(n).toLowerCase() === M.name.toLowerCase() ? M : null), call: async () => { if (o.offline) throw new Error('offline'); return { platform: o.platform || 'windows' }; } };
  const dir = tmp(), baseDir = path.join(dir, 'saoluu'), home = path.join(dir, 'home'); fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.writeFileSync(path.join(home, '.claude', 'a.txt'), 'x');
  const runs = [], pipes = [], notes = []; let clock = 1800000000000;
  const d = createDongBo(Object.assign({
    fleet, baseDir, file: path.join(dir, 'dongbo.json'), keyDir: path.join(dir, 'ssh'), localHome: home, myName: 'chien', keep: 3, everyHours: 6, now: () => clock,
    notify: async (t) => { notes.push(t); },
    run: async (bin, args) => { runs.push([bin].concat(args)); const c = args[args.length - 1]; if (bin === 'tar') return { ok: !o.badTar, out: '', err: o.badTar ? 'not gzip' : '' }; if (/for %i in|for i in/.test(c)) return { ok: true, out: '.claude\r\n.codex\r\n.claude.json\r\n', err: '' }; return { ok: true, out: '', err: '' }; },
    pipe: async (src, dst) => { pipes.push({ src, dst }); if (o.failPipe) return { ok: false, bytes: 0, err: 'Permission denied' }; if (dst.file) fs.writeFileSync(dst.file, 'tarball'); return { ok: true, bytes: 2048576, err: '' }; },
  }, o.extra || {}));
  return { d, M, fleet, baseDir, home, runs, pipes, notes, tick: (ms) => { clock += ms; }, now: () => clock, dir };
}

test('dongbo: Windows — kéo về (tar qua SSH, loại tệp đăng nhập, kiểm tệp nén) và đẩy sang (giải nén vào thư mục theo giờ), giữ đúng số bản', async () => {
  const S = mk();
  const r = await S.d.syncOne('May van phong');
  assert.equal(r.ok, true); assert.match(r.text, /Kéo về từ May van phong: 2\.0 MB/); assert.match(r.text, /Đẩy sang May van phong: 2\.0 MB/);
  const pull = S.pipes[0], push = S.pipes[1];
  assert.equal(pull.src.bin, 'ssh'); assert.ok(pull.src.args.includes('nguye@100.80.252.29'));
  const pc = pull.src.args[pull.src.args.length - 1];
  assert.match(pc, /^tar -czf - -C "%USERPROFILE%" --exclude=\.credentials\.json --exclude=auth\.json \.claude \.codex \.claude\.json$/);
  assert.match(pull.dst.file, /saoluu[\\/]May-van-phong[\\/]\d{4}-\d\d-\d\d_\d{4}\.tar\.gz\.part$/);
  assert.ok(S.runs.some((a) => a[0] === 'tar' && a[1] === '-tzf'), 'kiểm tệp nén trước khi tính xong');
  const files = fs.readdirSync(path.join(S.baseDir, 'May-van-phong')); assert.equal(files.length, 1); assert.ok(!files[0].endsWith('.part'));
  assert.equal(push.src.bin, 'tar'); assert.deepEqual(push.src.args.slice(0, 4), ['-czf', '-', '-C', S.home]); assert.ok(push.src.args.includes('--exclude=.credentials.json') && push.src.args.includes('--exclude=auth.json'));
  assert.deepEqual(push.src.args.slice(-1), ['.claude'], 'chỉ gửi mục có thật trên máy này');
  const xc = push.dst.args[push.dst.args.length - 1];
  assert.match(xc, /^mkdir "%USERPROFILE%\\AgentOS-saoluu\\chien\\\d{4}-\d\d-\d\d_\d{4}" 2>nul & tar -xzf - -C "%USERPROFILE%\\AgentOS-saoluu\\chien\\\d{4}-\d\d-\d\d_\d{4}"$/);
  assert.ok(S.runs.some((a) => /Remove-Item -Recurse -Force/.test(a[a.length - 1]) && /Skip 3/.test(a[a.length - 1])), 'dọn bản cũ phía máy con');
  // giữ tối đa `keep` bản kéo về
  for (let i = 0; i < 5; i++) { S.tick(120000); await S.d.syncOne('May van phong'); }
  assert.equal(fs.readdirSync(path.join(S.baseDir, 'May-van-phong')).length, 3);
});

test('dongbo: Linux dùng sudo -n; máy chưa SSH/offline/pipe lỗi/tệp nén hỏng đều báo rõ và không để lại bản dở', async () => {
  const S = mk({ platform: 'linux' }); await S.d.syncOne('May van phong');
  assert.match(S.pipes[0].src.args.slice(-1)[0], /^sudo -n tar -czf - -C \/var\/lib\/agentos --exclude=\.credentials\.json --exclude=auth\.json \.claude \.codex \.claude\.json$/);
  assert.match(S.pipes[1].dst.args.slice(-1)[0], /^sudo -n sh -c 'mkdir -p \/var\/lib\/agentos-saoluu\/chien\/[\d_-]+ && tar -xzf - -C \/var\/lib\/agentos-saoluu\/chien\/[\d_-]+'$/);
  await assert.rejects(mk({ noSsh: true }).d.syncOne('May van phong'), /gõ \/ketnoi trước/);
  await assert.rejects(mk({ offline: true }).d.syncOne('May van phong'), /không trả lời/);
  await assert.rejects(mk().d.syncOne('Máy lạ'), /Không có máy/);
  const F = mk({ failPipe: true }); const r = await F.d.syncOne('May van phong');
  assert.equal(r.ok, false); assert.match(r.text, /❌ ⬇️ Kéo về[^\n]*Permission denied/); assert.match(r.text, /❌ ⬆️ Đẩy sang/);
  const B = mk({ badTar: true }); const rb = await B.d.syncOne('May van phong'); assert.match(rb.text, /bản kéo về bị hỏng/);
  const left = fs.existsSync(path.join(B.baseDir, 'May-van-phong')) ? fs.readdirSync(path.join(B.baseDir, 'May-van-phong')) : []; assert.equal(left.length, 0, 'không giữ bản hỏng/dở');
});

test('dongbo: /dongbo bat|tat|trạng thái; tự chạy đúng hạn, lỗi thử lại sau 30 phút, báo lần đầu và khi lỗi 3 lần', async () => {
  const S = mk();
  assert.match(S.d.status(), /⚪ May van phong · chưa bật tự động/);
  assert.match(await S.d.command('bat'), /BẬT cho "May van phong" \(mỗi 6 giờ/);
  assert.match(S.d.status(), /🟢 May van phong · tự động mỗi 6 giờ · xong gần nhất: chưa lần nào/);
  await S.d.tick(); assert.equal(S.pipes.length, 2, 'lần đầu chạy ngay'); assert.equal(S.notes.length, 1); assert.match(S.notes[0], /chạy được lần đầu/);
  S.tick(3600000); await S.d.tick(); assert.equal(S.pipes.length, 2, 'chưa tới 6 giờ');
  S.tick(6 * 3600000); await S.d.tick(); assert.equal(S.pipes.length, 4, 'đủ 6 giờ thì chạy'); assert.equal(S.notes.length, 1, 'chỉ báo lần đầu');
  assert.match(await S.d.command('tat May van phong'), /TẮT/); S.tick(24 * 3600000); await S.d.tick(); assert.equal(S.pipes.length, 4, 'tắt thì không chạy');
  assert.match(await S.d.command('bat May van phong 12'), /mỗi 12 giờ/);
  // máy lỗi: thử lại sau 30 phút, báo khi lỗi 3 lần liên tiếp
  const E = mk({ failPipe: true }); await E.d.command('bat'); const n0 = () => E.pipes.length;
  await E.d.tick(); assert.equal(n0(), 2); E.tick(600000); await E.d.tick(); assert.equal(n0(), 2, 'chưa đủ 30 phút');
  E.tick(1800000); await E.d.tick(); assert.equal(n0(), 4); E.tick(1900000); await E.d.tick(); assert.equal(n0(), 6);
  assert.equal(E.notes.length, 1); assert.match(E.notes[0], /lỗi 3 lần liên tiếp/);
  assert.match(E.d.status(), /⚠️ kéo về lỗi/);
});

test('pipeProcs thật: nối tiến trình với tệp / tiến trình khác, đếm byte, báo lỗi khi lệnh nguồn hoặc đích hỏng', async () => {
  const d = tmp(), out = path.join(d, 'o.bin');
  const gen = (n, code) => ({ bin: process.execPath, args: ['-e', 'process.stdout.write(Buffer.alloc(' + n + ',65),()=>process.exit(' + (code || 0) + '))'] });
  let r = await pipeProcs(gen(300000), { file: out }); assert.equal(r.ok, true); assert.equal(r.bytes, 300000); assert.equal(fs.statSync(out).size, 300000);
  r = await pipeProcs(gen(1000), { bin: process.execPath, args: ['-e', 'let n=0;process.stdin.on("data",d=>n+=d.length).on("end",()=>process.exit(n===1000?0:5))'] }); assert.equal(r.ok, true); assert.equal(r.bytes, 1000);
  r = await pipeProcs(gen(1000, 3), { file: out }); assert.equal(r.ok, false);
  r = await pipeProcs(gen(1000), { bin: process.execPath, args: ['-e', 'process.stdin.resume();process.stderr.write("đích lỗi");process.exit(2)'] }); assert.equal(r.ok, false); assert.match(r.err, /đích lỗi/);
  r = await pipeProcs({ bin: 'khong-co-lenh-nay-123', args: [] }, { file: out }); assert.equal(r.ok, false);
});

test('dongbo: tar THẬT — nén dữ liệu Claude/Codex, LOẠI tệp đăng nhập, giải nén đúng (giống đường đẩy sang máy con)', async () => {
  const d = tmp(), home = path.join(d, 'home'), dest = path.join(d, 'dest'); fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true }); fs.mkdirSync(path.join(home, '.codex'), { recursive: true }); fs.mkdirSync(dest);
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'phien.jsonl'), 'lich su tro chuyen'); fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), 'TOKEN-BI-MAT'); fs.writeFileSync(path.join(home, '.codex', 'auth.json'), 'TOKEN-CODEX'); fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model=x'); fs.writeFileSync(path.join(home, '.claude.json'), '{}');
  const { EXCLUDES, NAMES } = require('../src/dongbo');
  const r = await pipeProcs({ bin: 'tar', args: ['-czf', '-', '-C', home].concat(EXCLUDES.map((e) => '--exclude=' + e), NAMES) }, { bin: 'tar', args: ['-xzf', '-', '-C', dest] });
  assert.equal(r.ok, true, r.err); assert.ok(r.bytes > 0);
  assert.equal(fs.readFileSync(path.join(dest, '.claude', 'projects', 'phien.jsonl'), 'utf8'), 'lich su tro chuyen'); assert.ok(fs.existsSync(path.join(dest, '.codex', 'config.toml'))); assert.ok(fs.existsSync(path.join(dest, '.claude.json')));
  assert.ok(!fs.existsSync(path.join(dest, '.claude', '.credentials.json')), 'KHÔNG sao chép token Claude'); assert.ok(!fs.existsSync(path.join(dest, '.codex', 'auth.json')), 'KHÔNG sao chép token Codex');
});

test('dongbo: tar bỏ qua vài tệp đang bị chương trình khác giữ (thoát mã lỗi nhưng bản nén đọc được) vẫn tính là xong, có ghi chú; ngắt kết nối giữa chừng thì KHÔNG', async () => {
  const mkp = (err) => async (src, dst) => { if (dst.file) { fs.writeFileSync(dst.file, 'x'); return { ok: false, bytes: 5000, err }; } return { ok: true, bytes: 100, err: '' }; };
  const A = mk({ extra: { pipe: mkp('tar: Error exit delayed from previous errors.') } }); const ra = await A.d.syncOne('May van phong');
  assert.equal(ra.ok, true); assert.match(ra.text, /Kéo về[^\n]*\(có tệp đang mở nên bị bỏ qua\)/); assert.equal(fs.readdirSync(path.join(A.baseDir, 'May-van-phong')).length, 1);
  const B = mk({ extra: { pipe: mkp('client_loop: send disconnect: Connection reset') } }); const rb = await B.d.syncOne('May van phong');
  assert.equal(rb.ok, false); assert.match(rb.text, /❌ ⬇️ Kéo về[^\n]*Connection reset/);
  assert.equal((fs.existsSync(path.join(B.baseDir, 'May-van-phong')) ? fs.readdirSync(path.join(B.baseDir, 'May-van-phong')) : []).length, 0, 'không giữ bản dở');
});
