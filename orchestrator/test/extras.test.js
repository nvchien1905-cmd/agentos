'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createBot } = require('../src/bot');
const { createQuick } = require('../src/quick');
const { createVoice, spoken } = require('../src/voice');
const { createSchedule, parseTime } = require('../src/schedule');
const { createTailscale } = require('../src/tailscale');
const { createPrinting } = require('../src/printing');
const { createKiotViet } = require('../src/kiotviet');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ex-'));
const worker = { engineNames: () => [], wake() {}, currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };

// ---------- giọng nói ----------
test('voice: cụm nói quen thuộc chạy lệnh nhanh, câu khác trả null (giao AI); lệnh nguy hiểm KHÔNG nói được', () => {
  assert.equal(spoken('Doanh số hôm nay'), '/doanhso hom nay');
  assert.equal(spoken('báo cáo doanh số tháng'), '/doanhso thang');
  assert.equal(spoken('tồn kho nồi chiên'), '/ton noi chien');
  assert.equal(spoken('Chụp màn hình.'), '/manhinh');
  assert.equal(spoken('khóa máy'), '/khoamay');
  assert.equal(spoken('báo cáo'), '/baocao');
  assert.equal(spoken('tắt máy'), null);
  assert.equal(spoken('khởi động lại máy'), null);
  assert.equal(spoken('bật toàn quyền'), null);
  assert.equal(spoken('viết giúp anh bài giới thiệu cửa hàng'), null);
});

test('voice: tải file, chạy nhận dạng, báo lỗi rõ ràng, luôn xóa file tạm', async () => {
  const dir = tmp(); const seen = [];
  const tg = { downloadFile: async (id, dest) => { fs.writeFileSync(dest, 'x'); seen.push(dest); return dest; } };
  const ok = createVoice({ tg, tmpDir: dir, run: async () => ({ code: 0, out: ' doanh số hôm nay \n', err: '' }) });
  assert.deepEqual(await ok.transcribe('F1'), { ok: true, text: 'doanh số hôm nay' });
  const empty = createVoice({ tg, tmpDir: dir, run: async () => ({ code: 0, out: '\n', err: '' }) });
  assert.equal((await empty.transcribe('F1')).ok, false);
  const offline = createVoice({ tg, tmpDir: dir, log() {}, run: async () => ({ code: 1, out: '', err: 'ConnectionError: Cannot reach huggingface' }) });
  const r = await offline.transcribe('F1');
  assert.equal(r.ok, false); assert.match(r.error, /cần mạng/);
  const broken = createVoice({ tg: { downloadFile: async () => { throw new Error('quá 20MB'); } }, tmpDir: dir });
  assert.match((await broken.transcribe('F1')).error, /quá 20MB/);
  await new Promise((r2) => setTimeout(r2, 30));
  for (const f of seen) assert.equal(fs.existsSync(f), false);
});

function botWith(voice, quick) {
  const db = openDb(':memory:');
  return { db, bot: createBot({ db, worker, allowed: new Set(['1', '2']), isAdmin: (u) => u === '1', voice, quick }) };
}
const voiceMsg = (uid, extra) => ({ from: { id: Number(uid) }, chat: { id: Number(uid), type: 'private' }, voice: Object.assign({ file_id: 'F', duration: 5 }, extra) });

test('bot: tin thoại -> nghe được chữ -> như gõ chữ (lệnh nhanh hoặc việc cho AI); người không phải admin bị từ chối', async () => {
  const quick = createQuick({ kiotviet: { configured: () => true, revenue: async (a) => 'DOANHSO:' + a } });
  const say = (t) => ({ transcribe: async () => ({ ok: true, text: t }), spoken });
  let { bot, db } = botWith(say('Doanh số hôm qua'), quick);
  const r1 = await bot.handle(voiceMsg(1));
  assert.match(r1, /Em nghe được: "Doanh số hôm qua"/); assert.match(r1, /DOANHSO:hom qua/);
  ({ bot, db } = botWith(say('Viết bài giới thiệu cửa hàng'), quick));
  const r2 = await bot.handle(voiceMsg(1));
  assert.match(r2, /Đã nhận việc #1/);
  assert.equal(db.recentJobs('1', 5)[0].prompt, 'Viết bài giới thiệu cửa hàng');
  // câu bắt đầu bằng "/" nghe được không thành lệnh
  ({ bot, db } = botWith(say('/tatmay co'), quick));
  const r3 = await bot.handle(voiceMsg(1));
  assert.match(r3, /Đã nhận việc/); assert.doesNotMatch(r3, /Máy sẽ tắt/);
  assert.equal(db.recentJobs('1', 5)[0].prompt, 'tatmay co');
  assert.match(await bot.handle(voiceMsg(2)), /chỉ dành cho quản trị viên/);
  assert.match(await bot.handle(voiceMsg(1, { duration: 400 })), /dài quá/);
  ({ bot } = botWith({ transcribe: async () => ({ ok: false, error: 'Không nghe rõ' }), spoken }, quick));
  assert.match(await bot.handle(voiceMsg(1)), /Không nghe rõ/);
  ({ bot } = botWith(null, quick));
  assert.match(await bot.handle(voiceMsg(1)), /chỉ nhận tin nhắn chữ/);
});

// ---------- hẹn giờ / báo cáo ----------
const vnMs = (iso) => Date.parse(iso + '+07:00');

test('schedule: parseTime hiểu 8, 8h30, 21:30 và từ chối giờ sai', () => {
  assert.equal(parseTime('8'), '08:00'); assert.equal(parseTime('8h30'), '08:30'); assert.equal(parseTime('21:30'), '21:30');
  assert.equal(parseTime('24:00'), null); assert.equal(parseTime('12:75'), null); assert.equal(parseTime('abc'), null);
});

test('schedule: báo cáo hằng ngày đúng giờ, không gửi lặp, chạy bù trong 2 giờ, không chạy bù sau đó', async () => {
  const db = openDb(':memory:'); const sent = []; let clock = vnMs('2026-10-20T21:00:00');
  const dir = tmp();
  const kv = { configured: () => true, revenue: async () => '📊 Doanh số hôm nay: 10đ', lowStock: async () => ({ total: 1, items: [{ name: 'Nồi', code: 'N1', onHand: 1, min: 5 }] }) };
  const s = createSchedule({ db, kiotviet: kv, now: () => clock, notify: async (c, t) => sent.push([c, t]), admins: ['1'], oneDriveDir: dir, diskFreeMb: () => 5000 });
  assert.equal(await s.tick(), 0);                                  // 21:00 < 21:30
  clock = vnMs('2026-10-20T21:31:00');
  assert.equal(await s.tick(), 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 1); assert.match(sent[0][1], /Doanh số hôm nay/); assert.match(sent[0][1], /Nồi \(N1\): còn 1/); assert.match(sent[0][1], /Ổ đĩa còn 4\.9 GB/);
  assert.equal(await s.tick(), 0);                                  // cùng ngày: không lặp
  assert.ok(fs.existsSync(path.join(dir, 'AgentOS', 'bao-cao', '2026-10-20.md')));
  clock = vnMs('2026-10-21T23:45:00');                              // trễ 2h15 so với 21:30: bỏ qua
  assert.equal(await s.tick(), 0);
  clock = vnMs('2026-10-22T22:10:00');                              // trễ 40 phút: chạy bù
  assert.equal(await s.tick(), 1);
});

test('schedule: /baocao đổi giờ/tắt/bật, /hen thêm-xem-xóa và giao việc đúng giờ cho AI', async () => {
  const db = openDb(':memory:'); const jobs = []; let clock = vnMs('2026-10-20T07:50:00');
  const s = createSchedule({ db, kiotviet: { configured: () => false }, now: () => clock, notify: async () => {}, admins: ['1'], submitJob: (c, t) => jobs.push([c, t]) });
  assert.match(await s.command('baocao', 'gio 6h', {}), /06:00/);
  assert.match(await s.command('baocao', 'gio 99', {}), /không hiểu/);
  assert.match(await s.command('baocao', 'tat', {}), /Đã tắt/);
  assert.match(await s.command('hen', '08:00 tóm tắt việc hôm nay', { chatId: '7' }), /Đã hẹn #1/);
  assert.match(await s.command('hen', '', {}), /#1 08:00 · tóm tắt/);
  assert.match(await s.command('hen', 'giờ nào đó', {}), /Cách dùng/);
  clock = vnMs('2026-10-20T08:01:00');
  assert.equal(await s.tick(), 1);
  assert.deepEqual(jobs, [['7', 'tóm tắt việc hôm nay']]);
  assert.equal(await s.tick(), 0);
  assert.match(await s.command('hen', 'xoa 1', {}), /Đã xóa/);
  assert.match(await s.command('hen', 'xoa 1', {}), /Không có/);
  const rep = await s.command('baocao', '', {});                    // chưa cấu hình KiotViet vẫn báo cáo được
  assert.match(rep, /chưa cấu hình KiotViet/);
});

test('kiotviet.lowStock: lọc sản phẩm có mức tối thiểu và tồn <= mức, sắp xếp thiếu nhiều nhất trước', async () => {
  const data = [
    { name: 'A', code: 'A', inventories: [{ onHand: 1, minQuantity: 5 }, { onHand: 0, minQuantity: 0 }] },
    { name: 'B', code: 'B', inventories: [{ onHand: 50, minQuantity: 5 }] },
    { name: 'C', code: 'C', inventories: [{ onHand: 0, minQuantity: 0 }] },
    { name: 'D', code: 'D', inventories: [{ onHand: 0, minQuantity: 10 }] },
  ];
  const f = async (url) => url.includes('connect/token')
    ? { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }
    : { ok: true, status: 200, json: async () => ({ total: 4, data }) };
  const kv = createKiotViet({ fetch: f, clientId: 'a', clientSecret: 'b', retailer: 'r' });
  const r = await kv.lowStock(10);
  assert.equal(r.total, 2); assert.deepEqual(r.items.map((i) => i.code), ['D', 'A']);
});

// ---------- Tailscale ----------
test('tailscale: tình trạng theo trạng thái dịch vụ; kết nối lấy đúng đường dẫn đăng nhập; đã kết nối thì không chạy lại', async () => {
  const state = { v: { BackendState: 'NeedsLogin' } };
  const run = async (args) => (args[0] === 'status' ? { code: 0, out: JSON.stringify(state.v), err: '' } : { code: 0, out: '', err: '' });
  const spawned = [];
  const spawn = (bin, args) => {
    spawned.push(args);
    let h;
    const c = { stdout: { on() {} }, stderr: { on: (e, fn) => { if (e === 'data') h = fn; } }, on() {}, kill() {}, exitCode: null };
    setTimeout(() => h && h('To authenticate, visit: https://login.tailscale.com/a/abc123def\n'), 20);
    return c;
  };
  const ts = createTailscale({ run, spawn, waitMs: 2000 });
  assert.match(await ts.status(), /chưa đăng nhập/);
  const r = await ts.connect();
  assert.equal(r.url, 'https://login.tailscale.com/a/abc123def');
  assert.deepEqual(spawned[0], ['up', '--ssh', '--timeout=600s']);
  state.v = { BackendState: 'Running', TailscaleIPs: ['100.64.0.9'], Self: { DNSName: 'may-ban-hang.tail1234.ts.net.' } };
  assert.match(await ts.status(), /100\.64\.0\.9 · may-ban-hang\.tail1234\.ts\.net/);
  assert.equal((await ts.connect()).already, true);
  assert.equal(spawned.length, 1);
  const missing = createTailscale({ run: async () => ({ code: 1, out: '', err: '', missing: true }) });
  assert.match(await missing.status(), /chưa cài Tailscale/);
});

test('quick: /tailscale, /in, /baocao, /hen đã đăng ký; /tailscale ngat cần xác nhận', async () => {
  const calls = [];
  const ts = { status: async () => 'TS-STATUS', connect: async () => ({ ok: true, url: 'https://login.tailscale.com/a/x' }), disconnect: async () => { calls.push('logout'); return { code: 0, out: '', err: '' }; } };
  const q = createQuick({ tailscale: ts, printing: { print: async (a) => 'IN:' + a }, schedule: { command: async (n, a) => n + ':' + a } });
  for (const n of ['tailscale', 'in', 'baocao', 'hen']) assert.ok(q.has(n), n);
  assert.equal(await q.run('tailscale', ''), 'TS-STATUS');
  assert.match(await q.run('tailscale', 'ketnoi'), /login\.tailscale\.com\/a\/x/);
  assert.match(await q.run('tailscale', 'ngat'), /Gõ \/tailscale ngat co/); assert.deepEqual(calls, []);
  assert.match(await q.run('tailscale', 'ngat co'), /Đã đăng xuất/); assert.deepEqual(calls, ['logout']);
  assert.equal(await q.run('in', 'a.pdf'), 'IN:a.pdf');
  assert.equal(await q.run('hen', '8h xin chào'), 'hen:8h xin chào');
});

// ---------- in ấn ----------
test('printing: chỉ in tệp trong thư mục OneDrive (chặn ../ và liên kết ra ngoài), Word/Excel đổi PDF trước, chọn máy in', async () => {
  const root = tmp(); const dir = path.join(root, 'od'); fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'a.pdf'), 'pdf'); fs.writeFileSync(path.join(dir, 'b.docx'), 'doc'); fs.writeFileSync(path.join(root, 'secret.pdf'), 's'); fs.writeFileSync(path.join(dir, 'c.exe'), 'x');
  try { fs.symlinkSync(path.join(root, 'secret.pdf'), path.join(dir, 'link.pdf')); } catch (e) { /* Windows không tạo được */ }
  const ran = [];
  const run = async (cmd, args) => {
    ran.push([cmd, ...args]);
    if (cmd === 'soffice') { fs.writeFileSync(path.join(args[args.indexOf('--outdir') + 1], 'b.pdf'), 'p'); return { code: 0, out: '', err: '' }; }
    if (cmd === 'lp') return { code: 0, out: 'request id is HP-7 (1 file(s))', err: '' };
    return { code: 0, out: 'printer HP is idle.\nsystem default destination: HP', err: '' };
  };
  const p = createPrinting({ dir, run, tmpDir: root });
  assert.match(await p.print(''), /printer HP is idle/);
  assert.match(await p.print('sub/a.pdf'), /Đã gửi lệnh in "a\.pdf" tới máy in mặc định/);
  assert.deepEqual(ran.at(-1).slice(0, 1), ['lp']);
  assert.match(await p.print('sub/a.pdf may HP'), /tới HP/); assert.deepEqual(ran.at(-1).slice(0, 3), ['lp', '-d', 'HP']);
  assert.match(await p.print('b.docx'), /Đã gửi lệnh in/); assert.ok(ran.some((r) => r[0] === 'soffice'));
  assert.match(await p.print('../secret.pdf'), /Chỉ in được tệp nằm trong/);
  if (fs.existsSync(path.join(dir, 'link.pdf'))) assert.match(await p.print('link.pdf'), /Chỉ in được tệp nằm trong/);
  assert.match(await p.print('c.exe'), /Không in được loại tệp/);
  assert.match(await p.print('khong-co.pdf'), /Không thấy tệp/);
  assert.match(await p.print('sub/a.pdf may $(rm)'), /Tên máy in không hợp lệ/);
});
