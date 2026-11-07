'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTrace, summarize, todosOf } = require('../src/trace');
const { createLive } = require('../src/live');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));

test('dấu vết: ghi từng bước, che khóa, đọc tiếp từ vị trí đã đọc, nhận ra việc đã xong và danh sách việc cần làm mới nhất', async () => {
  let t = 1000;
  const tr = createTrace({ dir: tmp(), now: () => (t += 10) });
  const job = { id: 12, chat_id: 5, project: 'p1', lane: 'main', prompt: 'làm báo cáo' };
  assert.equal((await tr.read(12, 0)).exists, false);
  tr.begin(job);
  tr.step(job, { kind: 'tool', name: 'Bash', input: { command: 'curl -H "x" token=abcdef123456 http://a', description: 'Tải dữ liệu' } });
  tr.step(job, { kind: 'tool', name: 'Read', input: { file_path: '/srv/a/b.txt' } });
  tr.step(job, { kind: 'tool', name: 'TodoWrite', input: { todos: [{ content: 'Đọc', status: 'completed', activeForm: 'Đang đọc' }, { content: 'Viết', status: 'in_progress', activeForm: 'Đang viết' }, { content: 'Gửi', status: 'pending' }, { content: '', status: 'pending' }] } });
  tr.step(job, { kind: 'text', text: 'Đã đọc xong, em viết đây' });
  let r = await tr.read(12, 0);
  assert.equal(r.events.length, 5); assert.equal(r.events[0].k, 'start'); assert.equal(r.events[0].project, 'p1');
  assert.equal(r.events[1].i.desc, 'Tải dữ liệu'); assert.doesNotMatch(r.events[1].i.cmd, /abcdef123456/); assert.match(r.events[1].i.cmd, /\*\*\*/);
  assert.equal(r.events[2].i.file, '/srv/a/b.txt'); assert.match(r.events[2].l, /Đọc/);
  assert.deepEqual(r.todos.map((x) => x.s), ['completed', 'in_progress', 'pending'], 'bỏ mục rỗng');
  assert.equal(r.done, false);
  const next = r.next;
  tr.step(job, { kind: 'tool', name: 'Write', input: { file_path: '/srv/a/c.md', content: 'KHÔNG ĐƯỢC LƯU NỘI DUNG' } });
  tr.end(job, { ok: true, secs: 9, steps: 3 });
  r = await tr.read(12, next);
  assert.equal(r.events.length, 2); assert.equal(r.done, true); assert.equal(r.events[1].k, 'end'); assert.equal(r.events[1].secs, 9);
  assert.doesNotMatch(JSON.stringify(r.events), /KHÔNG ĐƯỢC LƯU/);
  assert.equal((await tr.read('../x', 0)).exists, false, 'mã việc lạ không bao giờ đọc ra ngoài thư mục dấu vết');
  assert.equal((await tr.read('12/../12', 0)).exists, false);
});

test('dấu vết: quá hạn mức dung lượng thì dừng ghi bước nhưng vẫn ghi kết thúc; gc giữ việc mới, bỏ việc cũ', async () => {
  const dir = tmp(); let t = 1800000000000;
  const tr = createTrace({ dir, now: () => t, limits: { maxBytes: 600, keep: 2, keepDays: 5 } });
  const job = { id: 1, chat_id: 5, prompt: 'x' };
  tr.begin(job); for (let i = 0; i < 30; i++) tr.step(job, { kind: 'tool', name: 'Bash', input: { command: 'echo ' + i } }); tr.end(job, { ok: true });
  const r = await tr.read(1, 0); assert.ok(r.events.length < 15); assert.equal(r.done, true, 'vẫn có dòng kết thúc');
  for (const id of [2, 3, 4]) { t += 1000; tr.begin({ id, chat_id: 5, prompt: '' }); fs.utimesSync(path.join(dir, id + '.jsonl'), new Date(t), new Date(t)); }
  await tr.gc(); assert.deepEqual(fs.readdirSync(dir).sort(), ['3.jsonl', '4.jsonl']);
  t += 6 * 86400000; fs.utimesSync(path.join(dir, '4.jsonl'), new Date(t), new Date(t)); await tr.gc();
  assert.deepEqual(fs.readdirSync(dir), ['4.jsonl'], 'quá 5 ngày thì dọn');
});

test('summarize/todosOf: chỉ lấy phần cần thiết, không lấy nội dung tệp', () => {
  assert.deepEqual(summarize('Edit', { file_path: '/a', old_string: 'BÍ MẬT', new_string: 'X' }), { file: '/a' });
  assert.deepEqual(summarize('Grep', { pattern: 'abc' }), { pattern: 'abc' });
  assert.equal(todosOf('Bash', {}), null); assert.equal(todosOf('TodoWrite', {}), null);
});

test('Telegram: tin "Đang làm…" hiện danh sách việc cần làm (☑ xong · ▶️ đang làm · ☐ chờ) và cập nhật khi AI đổi danh sách', async () => {
  const sent = [], edited = [];
  const tg = { sendChatAction: async () => {}, sendHtml: async (c, text) => { sent.push(text); return 77; }, editHtml: async (c, id, text) => { edited.push(text); }, deleteMessage: async () => {} };
  const live = createLive({ tg, throttleMs: 0, showAfterMs: 0, tickMs: 1e9, typingMs: 1e9 });
  const job = { id: 3, chat_id: 9 };
  live.begin(job);
  live.step(job, { kind: 'tool', name: 'TodoWrite', input: { todos: [{ content: 'Đọc dữ liệu', status: 'completed' }, { content: 'Viết báo cáo', status: 'in_progress', activeForm: 'Đang viết báo cáo' }, { content: 'Gửi <anh>', status: 'pending' }] } });
  await new Promise((r) => setTimeout(r, 40));
  const first = sent[0] || edited[edited.length - 1];
  assert.match(first, /📋 Việc cần làm 1\/3/); assert.match(first, /▶️ Đang viết báo cáo/); assert.match(first, /☐ Gửi &lt;anh&gt;/); assert.match(first, /☑ Đọc dữ liệu/);
  live.step(job, { kind: 'tool', name: 'TodoWrite', input: { todos: [{ content: 'Đọc dữ liệu', status: 'completed' }, { content: 'Viết báo cáo', status: 'completed' }, { content: 'Gửi', status: 'in_progress' }] } });
  await new Promise((r) => setTimeout(r, 40));
  assert.match(edited[edited.length - 1], /Việc cần làm 2\/3/);
  const r = await live.end(job); assert.equal(r.steps, 0, 'TodoWrite không tính là bước');
});
