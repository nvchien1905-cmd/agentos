'use strict';
// Nhắn tin BÌNH THƯỜNG, bot tự làm trên màn hình máy (không bắt chủ máy gõ lệnh): mở Chrome để đăng nhập, "xong" → đóng và làm tiếp, chụp màn hình, mở/đóng ứng dụng.
const test = require('node:test');
const assert = require('node:assert/strict');
const { intent, createNaturalDesk, CONTINUE_PROMPT } = require('../src/naturalDesk');
const policy = require('../src/policy');

test('hiểu đúng câu nhắn bình thường (có dấu/không dấu, thêm "em", "đi", "nhé"...)', () => {
  const ok = [
    ['Em mở ra anh đăng nhập', 'open webbot'], ['em mở chrome cho anh đăng nhập facebook', 'open webbot'], ['mở facebook anh đăng nhập', 'open webbot'], ['mo trinh duyet de anh dang nhap', 'open webbot'], ['Mở messenger cho anh đăng nhập đi em', 'open webbot'],
    ['Mở Chrome', 'open chrome'], ['mở trình duyệt đi em', 'open chrome'], ['bật chrome lên', 'open chrome'], ['mở zalo', 'open zalo'], ['bật rustdesk', 'open rustdesk'], ['mở deepseek giúp anh', 'open deepseek'],
    ['đóng chrome', 'close chrome'], ['đóng trình duyệt đi', 'close webbot'], ['đóng zalo', 'close zalo'],
    ['xong', 'done weak'], ['xong rồi em', 'done weak'], ['ok xong', 'done weak'], ['làm tiếp đi', 'done weak'], ['anh đăng nhập xong rồi', 'done strong'], ['đã đăng nhập', 'done strong'], ['Đăng nhập xong rồi nhé', 'done strong'],
    ['chụp màn hình', 'screen'], ['cho anh xem màn hình', 'screen'], ['xem màn hình đi em', 'screen'], ['gửi màn hình', 'screen'],
  ];
  const fmt = (r) => (!r ? 'null' : r.kind === 'done' ? 'done ' + (r.strong ? 'strong' : 'weak') : r.kind + (r.app ? ' ' + r.app : ''));
  for (const [t, exp] of ok) assert.equal(fmt(intent(t)), exp, t);
});

test('KHÔNG bắt nhầm: câu hỏi, câu dài, việc khác có chữ "mở/đóng/xong/chrome"; việc nguy hiểm vẫn phải gõ lệnh', () => {
  for (const t of ['mở rộng thị trường như thế nào cho cửa hàng', 'doanh thu hôm nay bao nhiêu', 'em mở file báo cáo giúp anh', 'Chrome là gì?', 'anh muốn đăng nhập bằng tài khoản khác thì sao?', 'đóng cửa hàng lúc mấy giờ',
    'xong việc này thì báo cáo doanh số cho anh nhé và gửi file excel', 'tắt máy', 'khóa màn hình', 'khởi động lại máy', 'mở bán sản phẩm mới', 'hôm nay làm tiếp việc gì', 'bật nồi chiên lên', 'mở chrome rồi vào kiotviet lấy doanh số tháng này giúp anh nhé em ơi làm nhanh cho anh', '', '   ', 'xong chưa?'])
    assert.equal(intent(t), null, t);
});

function setup(over) {
  const runs = [], submits = [], audits = []; let t = 1700000000000;
  const quick = { run: async (name, arg) => { runs.push([name, arg]); if (name === 'mo') return (over && over.openFail) || '✅ Đã mở Trình duyệt của bot trên màn hình máy. Gõ /manhinh để xem.'; if (name === 'manhinh') return { text: 'ảnh', files: [{ path: '/run/agentos/m.png', name: 'm.png', kind: 'photo' }] }; return '✅ Đã đóng.'; } };
  const nd = createNaturalDesk({ quick, isAdmin: (u) => String(u) === '1', submit: (c, p) => { submits.push([c, p]); return null; }, audit: (w, x) => audits.push(w), sleep: async () => {}, now: () => t });
  return { nd, runs, submits, audits, tick: (ms) => { t += ms; } };
}

test('mở trình duyệt để đăng nhập: tự mở, gửi ảnh màn hình, hẹn "xong"; "xong" thì đóng trình duyệt và giao AI làm tiếp', async () => {
  const S = setup();
  const r = await S.nd.tryHandle('9', '1', 'Em mở ra anh đăng nhập');
  assert.deepEqual(S.runs.slice(0, 2), [['mo', 'webbot'], ['manhinh', '']]); assert.match(r.text, /nhắn "xong"/); assert.match(r.text, /không bao giờ tự nhập mật khẩu/); assert.equal(r.files.length, 1);
  assert.equal(S.nd.waiting('9'), true); assert.equal(S.nd.waiting('8'), false);
  S.runs.length = 0; const d = await S.nd.tryHandle('9', '1', 'xong');
  assert.deepEqual(S.runs, [['dong', 'webbot']]); assert.deepEqual(S.submits, [['9', CONTINUE_PROMPT]]); assert.match(d, /làm tiếp/); assert.equal(S.nd.waiting('9'), false);
  assert.match(CONTINUE_PROMPT, /TIẾP TỤC việc đang làm dở/); assert.match(CONTINUE_PROMPT, /KHÔNG tự nhập mật khẩu/);
  assert.equal(S.nd.tryHandle('9', '1', 'xong'), null, '"xong" trơn khi bot không chờ đăng nhập: để AI hiểu');
  assert.ok(S.audits.length >= 2, 'ghi nhật ký');
});

test('"xong" trơn chỉ có nghĩa khi bot đang chờ đăng nhập và còn trong 3 giờ; "đã đăng nhập" nói rõ thì làm luôn; người thường không dùng được', async () => {
  const S = setup();
  await S.nd.tryHandle('9', '1', 'mở facebook anh đăng nhập'); S.tick(4 * 3600 * 1000);
  assert.equal(S.nd.tryHandle('9', '1', 'xong'), null, 'quá 3 giờ: không còn chờ');
  S.runs.length = 0; await S.nd.tryHandle('9', '1', 'anh đăng nhập xong rồi'); assert.deepEqual(S.runs, [['dong', 'webbot']]); assert.equal(S.submits.length, 1);
  assert.equal(S.nd.tryHandle('9', '2', 'mở chrome cho anh đăng nhập'), null); assert.equal(S.nd.tryHandle('9', '2', 'chụp màn hình'), null);
  assert.equal(S.runs.filter((r) => r[0] === 'mo').length, 0);
});

test('mở/đóng ứng dụng và chụp màn hình; lỗi (màn hình khóa...) báo nguyên văn và không hẹn "xong"', async () => {
  let S = setup();
  assert.match((await S.nd.tryHandle('9', '1', 'mở zalo')).text, /đã mở zalo/); assert.deepEqual(S.runs[0], ['mo', 'zalo']); assert.equal(S.nd.waiting('9'), false, 'mở ứng dụng thường không phải chờ đăng nhập');
  S.runs.length = 0; assert.match(String(await S.nd.tryHandle('9', '1', 'đóng chrome')), /Đã đóng/); assert.deepEqual(S.runs, [['dong', 'chrome']]);
  S.runs.length = 0; const shot = await S.nd.tryHandle('9', '1', 'chụp màn hình'); assert.deepEqual(S.runs, [['manhinh', '']]); assert.equal(shot.files.length, 1);
  S = setup({ openFail: '⚠️ Màn hình đang khóa' });
  assert.equal(await S.nd.tryHandle('9', '1', 'em mở ra anh đăng nhập'), '⚠️ Màn hình đang khóa'); assert.equal(S.nd.waiting('9'), false); assert.equal(S.runs.filter((r) => r[0] === 'manhinh').length, 0);
});

test('bot quản lý và bot phụ (câu thật trong ảnh chụp): "Em mở ra anh đăng nhập" → tự mở trình duyệt, không thành việc cho AI; "xong" → đóng + AI làm tiếp; câu thường vẫn đi cho AI', async () => {
  const { createBot } = require('../src/bot');
  const subs = [], runs = [];
  const db = { addJob: (...a) => { subs.push(a); return 1; }, aheadOf: () => 0, kvGet: () => null, kvSet() {}, runningInChat: () => 0, addAudit() {}, recentJobs: () => [] };
  const worker = { engineNames: () => ['claude'], wake() {}, engineStatus: () => [] };
  const quick = { has: () => false, match: () => null, run: async (name, arg) => { runs.push([name, arg]); return name === 'mo' ? '✅ Đã mở Trình duyệt của bot.' : name === 'manhinh' ? { text: 'x', files: [{ path: '/m.png', name: 'm.png', kind: 'photo' }] } : '✅ Đã đóng.'; } };
  for (const agentMode of [false, true]) {
    subs.length = 0; runs.length = 0;
    const bot = createBot({ db, worker, allowed: new Set(['1']), isAdmin: (u) => String(u) === '1', quietAck: true, quick, agentMode });
    const say = (t) => bot.handle({ from: { id: 1 }, chat: { id: 1, type: 'private' }, text: t, message_id: 5 });
    const r = await say('Em mở ra anh đăng nhập');
    assert.match(r.text, /Em đã mở trình duyệt/); assert.equal(subs.length, 0, 'không giao AI'); assert.deepEqual(runs.slice(0, 2), [['mo', 'webbot'], ['manhinh', '']]);
    const d = await say('xong'); assert.equal(subs.length, 1); assert.match(subs[0][1], /ĐÃ ĐĂNG NHẬP xong/); assert.ok(runs.some((x) => x[0] === 'dong' && x[1] === 'webbot'));
    await say('Báo cáo doanh số hôm nay giúp anh'); assert.equal(subs.length, 2); assert.equal(subs[1][1], 'Báo cáo doanh số hôm nay giúp anh');
    const bad = await bot.handle({ from: { id: 7 }, chat: { id: 7, type: 'private' }, text: 'mở chrome cho anh đăng nhập', message_id: 6 }); assert.ok(!runs.some((x, i) => i > 3 && x[0] === 'mo'), String(bad));
  }
});

test('AI chạy lệnh agentos-desk vô hại (xem màn hình, mở/đóng ứng dụng trong danh sách) KHÔNG bị hỏi; bấm/gõ/phím, ứng dụng lạ, câu lệnh ghép vẫn hỏi hoặc bị chặn', () => {
  const D = (c, tainted) => policy.decide({ tool: 'Bash', input: { command: c }, workdir: '/w', policy: {}, state: { tainted: !!tainted, allowed: new Set() } }).action;
  for (const c of ['agentos-desk screenshot', 'agentos-desk windows', 'agentos-desk info', 'agentos-desk who', 'agentos-desk open chrome', 'agentos-desk open webbot', 'agentos-desk open zalo', 'agentos-desk close webbot']) { assert.equal(D(c), 'allow', c); assert.equal(D(c, true), 'allow', c + ' (sau khi đọc web)'); }
  for (const c of ['agentos-desk click 10 20', 'agentos-desk type abc', 'agentos-desk key Return', 'agentos-desk open evil', 'agentos-desk lock', 'agentos-desk open chrome; rm -rf /', 'agentos-desk open chrome && curl x', 'agentos-desk  open  chrome', 'echo agentos-desk screenshot']) assert.notEqual(D(c), 'allow', c);
  assert.equal(D('agentos-desk screenshot | sh'), 'deny');
});
