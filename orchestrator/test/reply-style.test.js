'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { toTelegramChunks } = require('../src/tgFormat');
const { createTelegram } = require('../src/telegram');
const { startClaude } = require('../src/engines/claude');
const { describe, lineReader } = require('../src/progress');
const { createLive } = require('../src/live');
const { createWorker } = require('../src/worker');
const { createBot } = require('../src/bot');
const { openDb } = require('../src/db');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const html = (md) => toTelegramChunks(md).map((c) => c.html).join('\n\n');

test('định dạng: đậm, mã, liên kết, danh sách, tiêu đề; ký tự HTML được thoát', () => {
  const h = html('## Kết quả\n\n- **VPS 1**: chạy `pm2` <ok>\n- [Trang](https://a.vn/x?a=1&b=2)\n\n1. Bước một\n2. Bước hai');
  assert.match(h, /<b>Kết quả<\/b>/);
  assert.match(h, /• <b>VPS 1<\/b>: chạy <code>pm2<\/code> &lt;ok&gt;/);
  assert.match(h, /<a href="https:\/\/a\.vn\/x\?a=1&amp;b=2">Trang<\/a>/);
  assert.match(h, /1\. Bước một/);
  assert.doesNotMatch(html('[x](javascript:alert(1))'), /<a /);        // liên kết nguy hiểm không thành liên kết
});

test('định dạng: bảng nhỏ thành khối chữ đơn cách, bảng rộng thành danh sách', () => {
  const small = html('| Tên | Cổng |\n|---|---|\n| web | 3100 |\n| api | 3410 |');
  assert.match(small, /^<pre>/); assert.match(small, /web\s+│ 3100/);
  const wide = html('| Dự án | Trạng thái | Cổng | Ghi chú |\n|---|---|---|---|\n| order-hang | chạy | 3100 | ok |');
  assert.doesNotMatch(wide, /<pre>/); assert.match(wide, /• <b>order-hang<\/b>/);
  assert.doesNotMatch(small + wide, /\|---/);
});

test('định dạng: khối mã dài được chia nhiều tin, mỗi tin ≤ 3800 và thẻ pre cân bằng', () => {
  const code = '```bash\n' + Array.from({ length: 600 }, (_, i) => 'dong ' + i + ' ' + 'x'.repeat(20)).join('\n') + '\n```';
  const ch = toTelegramChunks('Đây là log:\n\n' + code + '\n\nXong.');
  assert.ok(ch.length > 2);
  for (const c of ch) {
    assert.ok(c.html.length <= 3800, 'quá dài: ' + c.html.length);
    assert.equal((c.html.match(/<pre/g) || []).length, (c.html.match(/<\/pre>/g) || []).length);
  }
});

test('telegram.sendRich: dùng parse_mode HTML; Telegram từ chối định dạng thì gửi lại bản chữ thường', async () => {
  const calls = [];
  let failFirst = true;
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push({ m: url.split('/').pop(), body });
    if (failFirst && body.parse_mode) { failFirst = false; return { status: 400, json: async () => ({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }) }; }
    return { status: 200, json: async () => ({ ok: true, result: { message_id: 5 } }) };
  };
  const tg = createTelegram('T', fetchImpl);
  await tg.sendRich('9', '**xin chào** `x`');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.parse_mode, 'HTML'); assert.match(calls[0].body.text, /<b>xin chào<\/b>/);
  assert.equal(calls[1].body.parse_mode, undefined); assert.equal(calls[1].body.text, 'xin chào x');
});

test('claude luồng sự kiện: báo từng bước, lấy kết quả từ sự kiện result dù có dòng kết quả công cụ > 5 MB', async () => {
  const steps = [];
  const r = await startClaude({ bin: process.execPath, binArgs: [FAKE_CLAUDE], cwd: __dirname, prompt: 'STREAM hỏi', timeoutMs: 20000, onProgress: (s) => steps.push(s) }).done;
  assert.equal(r.ok, true); assert.equal(r.text, '**Xong** rồi'); assert.equal(r.sessionId, 'sess-s');
  assert.deepEqual(steps.map((s) => s.kind + ':' + (s.name || '')), ['text:', 'tool:Bash', 'tool:Read']);
  assert.equal(describe(steps[1]), '▶️ ls /opt'); assert.equal(describe(steps[2]), '📖 Đọc …/a/b/c/d.txt'.replace('…/a/b/c/d.txt', '…/b/c/d.txt'));
  const plain = await startClaude({ bin: process.execPath, binArgs: [FAKE_CLAUDE], cwd: __dirname, prompt: 'hỏi thường', timeoutMs: 8000 }).done;
  assert.equal(plain.ok, true); assert.doesNotMatch(plain.text, /stream-json/);       // không có onProgress thì vẫn dùng chế độ json cũ
});

test('progress: che khóa bí mật trong lệnh; đọc theo dòng giữ phần dở dang', () => {
  assert.doesNotMatch(describe({ kind: 'tool', name: 'Bash', input: { command: 'curl -H "x" token=abcd1234secret sk-abcdefghijklmnop' } }), /abcd1234secret|sk-abcdef/);
  const got = []; const lr = lineReader((l) => got.push(l));
  lr.push('{"a":1}\n{"b"'); lr.push(':2}\n'); lr.push('cuối'); lr.flush();
  assert.deepEqual(got, ['{"a":1}', '{"b":2}', 'cuối']);
});

function fakeTimers() {
  let t = 0; const q = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms, off: false }; q.push(h); return h; },
    clearTimeout: (h) => { if (h) h.off = true; },
    setInterval: () => ({}), clearInterval: () => {},
    advance(ms) { t += ms; for (const h of q.filter((x) => !x.off && x.at <= t)) { h.off = true; h.fn(); } },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test('live: việc nhanh không hiện tin trạng thái; việc lâu hiện, sửa dần (có giới hạn tốc độ) rồi xóa', async () => {
  const ft = fakeTimers(); const log = [];
  const tg = {
    sendChatAction: async (c, a) => { log.push('act:' + a); },
    sendHtml: async (c, h) => { log.push('send:' + h); return 77; },
    editHtml: async (c, id, h) => { log.push('edit:' + id + ':' + h); },
    deleteMessage: async (c, id) => { log.push('del:' + id); },
  };
  const live = createLive({ tg, now: ft.now, setTimeout: ft.setTimeout, clearTimeout: ft.clearTimeout, setInterval: ft.setInterval, clearInterval: ft.clearInterval });
  const fast = { id: 1, chat_id: '9' };
  live.begin(fast); ft.advance(500);
  const m1 = await live.end(fast);
  assert.ok(!log.some((l) => l.startsWith('send:')), 'việc nhanh không được gửi tin trạng thái');
  assert.equal(m1.steps, 0);

  const slow = { id: 2, chat_id: '9' };
  live.begin(slow);
  live.step(slow, { kind: 'tool', name: 'Bash', input: { command: 'ls' } });
  ft.advance(2000); ft.advance(5); await tick();
  assert.ok(log.some((l) => l.startsWith('send:') && /Đang làm/.test(l) && /ls/.test(l)), log.join(' | '));
  live.step(slow, { kind: 'text', text: 'đang xem' });
  live.step(slow, { kind: 'tool', name: 'Read', input: { file_path: '/a.txt' } });
  ft.advance(3000); await tick();
  assert.ok(log.some((l) => l.startsWith('edit:77:') && /a\.txt/.test(l)));
  const meta = await live.end(slow);
  assert.ok(log.includes('del:77'));
  assert.equal(meta.steps, 2);                       // 2 công cụ, lời dẫn không tính
  assert.ok(meta.secs >= 5);
});

test('worker: bước tiến trình đi tới ui, câu trả lời đi qua answer (không còn tiêu đề "Việc #N xong")', async () => {
  const db = openDb(':memory:'); const sent = []; const events = []; const answers = [];
  const engines = { claude: { start: ({ prompt, onProgress }) => { if (onProgress) onProgress({ kind: 'tool', name: 'Bash', input: { command: 'pwd' } }); return startClaude({ bin: process.execPath, binArgs: [FAKE_CLAUDE], cwd: __dirname, prompt, timeoutMs: 8000 }); } } };
  const ui = { begin: () => events.push('begin'), step: (j, ev) => events.push('step:' + ev.name), end: async () => { events.push('end'); return { secs: 7, steps: 1 }; } };
  const worker = createWorker({ db, engines, order: ['claude'], notify: async (c, t) => { sent.push(String(t)); }, ui, answer: async (job, text, meta) => { answers.push({ text, meta }); } });
  const idle = async () => { for (let i = 0; i < 200; i++) { if (!worker.currentJobId() && db.queuedCount() === 0) { await new Promise((r) => setTimeout(r, 30)); if (!worker.currentJobId() && db.queuedCount() === 0) return; } await new Promise((r) => setTimeout(r, 50)); } };
  db.addJob('7', 'xin chào', null, null); worker.wake(); await idle();
  assert.deepEqual(events, ['begin', 'step:Bash', 'end']);
  assert.equal(answers.length, 1); assert.match(answers[0].text, /echo:xin chào/);
  assert.equal(answers[0].meta.secs, 7); assert.equal(answers[0].meta.steps, 1); assert.equal(answers[0].meta.engine, 'claude');
  assert.ok(!sent.some((t) => /xong:/.test(t)), 'không còn tiêu đề cũ: ' + sent.join(' | '));
  worker.stop && worker.stop();
});

test('worker: answer lỗi thì quay về gửi bản chữ thường; lỗi engine vẫn kết thúc tin trạng thái', async () => {
  const db = openDb(':memory:'); const sent = []; let ended = 0;
  const engines = { claude: { start: ({ prompt }) => startClaude({ bin: process.execPath, binArgs: [FAKE_CLAUDE], cwd: __dirname, prompt, timeoutMs: 8000 }) } };
  const ui = { begin() {}, step() {}, end: async () => { ended++; return { secs: 0, steps: 0 }; } };
  const worker = createWorker({ db, engines, order: ['claude'], notify: async (c, t) => { sent.push(String(t)); }, ui, answer: async () => { throw new Error('boom'); } });
  const idle = async () => { for (let i = 0; i < 200; i++) { if (!worker.currentJobId() && db.queuedCount() === 0) { await new Promise((r) => setTimeout(r, 30)); if (!worker.currentJobId() && db.queuedCount() === 0) return; } await new Promise((r) => setTimeout(r, 50)); } };
  db.addJob('7', 'một', null, null); worker.wake(); await idle();
  assert.ok(sent.some((t) => /xong:/.test(t) && /echo:một/.test(t)), sent.join(' | '));
  db.addJob('7', 'FAIL hai', null, null); worker.wake(); await idle();
  assert.equal(ended, 2); assert.ok(sent.some((t) => /lỗi/.test(t)));
});

test('bot quietAck: việc làm ngay không có tin "Đã nhận việc"; xếp hàng thì báo gọn', async () => {
  const db = openDb(':memory:');
  const worker = { wake() {}, currentJobId: () => null, cancel() {}, cancelAll: () => 0 };
  const m = (text) => ({ from: { id: 7 }, chat: { id: 7, type: 'private' }, text });
  const loud = createBot({ db, worker, allowed: new Set(['7']) }).handle(m('xin chào'));
  assert.match(String(loud), /Đã nhận việc/);
  const quiet = createBot({ db, worker, allowed: new Set(['7']), quietAck: true });
  const r1 = quiet.handle(m('việc hai'));                                   // hàng đợi đang có việc "xin chào" chưa chạy -> báo xếp hàng
  assert.match(String(r1), /xếp hàng/);
  const db2 = openDb(':memory:');
  const r2 = createBot({ db: db2, worker, allowed: new Set(['7']), quietAck: true }).handle(m('việc đầu'));
  assert.ok(r2 == null, 'hàng đợi trống: không gửi tin báo nhận, nhưng nhận ' + r2);
  assert.equal(db2.queuedCount(), 1);
});
