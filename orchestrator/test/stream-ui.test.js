'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTrace } = require('../src/trace');
const { createApprovals } = require('../src/approvals');
const { createControl } = require('../src/control');
const { startClaude } = require('../src/engines/claude');
const openDb = (f) => require('../src/db').openDb(f);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'su-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('chạy chữ từng chữ: các mảnh chữ AI gõ được gom (~300 ms), che khóa, ghi TRƯỚC bước kế tiếp, vẫn đúng thứ tự; kết thúc thì ghi nốt', async () => {
  const tr = createTrace({ dir: tmp() }); const job = { id: 4, chat_id: 1, prompt: 'x' };
  tr.begin(job);
  tr.delta(job, 'Xin '); tr.delta(job, 'chào '); tr.delta(job, 'token=abcdef0123456789 ');
  assert.equal((await tr.read(4, 0)).events.filter((e) => e.k === 'delta').length, 0, 'chưa tới 300 ms thì chưa ghi');
  await wait(450);
  let ev = (await tr.read(4, 0)).events; const d = ev.filter((e) => e.k === 'delta'); assert.equal(d.length, 1, 'gom thành một dòng'); assert.match(d[0].text, /^Xin chào /); assert.doesNotMatch(d[0].text, /abcdef0123456789/);
  tr.delta(job, 'phần cuối'); tr.step(job, { kind: 'tool', name: 'Read', input: { file_path: '/a' } });       // bước mới → chữ đang gom phải được ghi trước nó
  ev = (await tr.read(4, 0)).events; assert.deepEqual(ev.map((e) => e.k), ['start', 'delta', 'delta', 'tool']); assert.equal(ev[2].text, 'phần cuối');
  tr.delta(job, 'dở dang'); tr.end(job, { ok: true }); ev = (await tr.read(4, 0)).events; assert.deepEqual(ev.slice(-2).map((e) => e.k), ['delta', 'end']);
  const big = createTrace({ dir: tmp() }); big.begin({ id: 5 }); big.delta({ id: 5 }, 'a'.repeat(7000)); assert.equal((await big.read(5, 0)).events.filter((e) => e.k === 'delta').length, 1, 'quá 6000 ký tự thì ghi ngay');
});

test('Claude: có onDelta thì bật --include-partial-messages và nhận từng đoạn chữ; không có thì không bật; lỗi trong onDelta không làm hỏng việc', async () => {
  const dir = tmp(), bin = path.join(dir, 'fake.sh'), out = path.join(dir, 'args.txt');
  const lines = [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Xin ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chào' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Xin chào' }] } },
    { type: 'result', result: 'Xin chào', is_error: false, session_id: 's1' },
  ].map((l) => JSON.stringify(l)).join('\n');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > ' + out + "\ncat >/dev/null\ncat <<'EOF'\n" + lines + '\nEOF\n', { mode: 0o755 });
  const got = [], steps = [];
  const r = await startClaude({ bin, cwd: dir, prompt: 'x', timeoutMs: 20000, onProgress: (e) => steps.push(e), onDelta: (t) => { got.push(t); if (t === 'Xin ') throw new Error('lỗi của bên nhận'); } }).done;
  assert.equal(r.ok, true); assert.equal(r.text, 'Xin chào'); assert.deepEqual(got, ['Xin ', 'chào'], 'chỉ nhận đoạn chữ, bỏ đoạn công cụ'); assert.deepEqual(steps.map((s) => s.kind), ['text']);
  assert.ok(fs.readFileSync(out, 'utf8').split('\n').includes('--include-partial-messages'));
  await startClaude({ bin, cwd: dir, prompt: 'x', timeoutMs: 20000, onProgress: () => {} }).done; assert.ok(!fs.readFileSync(out, 'utf8').split('\n').includes('--include-partial-messages'), 'không có onDelta thì không bật');
});

test('duyệt từ trang Cài đặt: bot ghi ảnh chụp các yêu cầu chờ; control approval.answer trả lời như bấm nút Telegram; chỉ nhận mã/quyết định hợp lệ', async () => {
  const dir = tmp(), file = path.join(dir, 'pending.json'); const asked = [];
  const approvals = createApprovals({ db: { addAudit() {} }, ask: async (c, t) => { asked.push(t); return 7; }, edit: async () => {}, timeoutMs: 60000, snapshotFile: file });
  const p = approvals.request({ id: 12, chat_id: 1 }, 'Bash', { cls: 'exec', summary: 'rm -rf /tmp/x', canRemember: true });
  await wait(20);
  const snap = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(snap.length, 1); assert.deepEqual([snap[0].jobId, snap[0].cls, snap[0].summary, snap[0].canRemember], [12, 'exec', 'rm -rf /tmp/x', true]);
  const control = createControl({ dir: path.join(dir, 'ctl'), db: openDb(':memory:'), approvals, adminId: '1', log() {} });
  assert.equal(control.apply({ action: 'approval.answer', approval: '../x', decision: 'y' }), false); assert.equal(control.apply({ action: 'approval.answer', approval: snap[0].id, decision: 'z' }), false);
  assert.equal(control.apply({ action: 'approval.answer', approval: snap[0].id, decision: 'y' }), true);
  const r = await p; assert.equal(r.allowed, true); assert.equal(r.source, 'user');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [], 'xong thì ảnh chụp rỗng');
  const p2 = approvals.request({ id: 13, chat_id: 1 }, 'Bash', { cls: 'exec', summary: 'x', canRemember: false }); await wait(20);
  const id2 = approvals.list()[0].id; assert.equal(control.apply({ action: 'approval.answer', approval: id2, decision: 'n' }), true); assert.equal((await p2).allowed, false);
  assert.equal(control.apply({ action: 'approval.answer', approval: 'khongco1', decision: 'y' }), true, 'mã đã hết hạn: gọi nhưng bị bỏ qua');
});

test('giao việc từ trang Cài đặt: control job.submit tạo việc cho chủ máy (có thể gắn dự án); trống/không có chủ máy/dự án lạ bị từ chối', () => {
  const db = openDb(':memory:'); const projects = { get: (id) => (id === 'p1' ? { id: 'p1' } : null) };
  const c = createControl({ dir: tmp(), db, projects, adminId: '99', log() {}, worker: { wake() {} } });
  assert.equal(c.apply({ action: 'job.submit', text: '  Làm báo cáo  ' }), true); assert.equal(c.apply({ action: 'job.submit', text: 'Việc trong dự án', project: 'p1' }), true);
  assert.equal(c.apply({ action: 'job.submit', text: '   ' }), false); assert.equal(c.apply({ action: 'job.submit', text: 'x', project: 'khong-co' }), false);
  assert.equal(createControl({ dir: tmp(), db, projects, log() {} }).apply({ action: 'job.submit', text: 'x' }), false, 'chưa biết chủ máy');
  const jobs = db.raw.prepare('select chat_id, prompt, project from jobs order by id').all(); assert.deepEqual(jobs.map((j) => [j.chat_id, j.prompt, j.project]), [['99', 'Làm báo cáo', null], ['99', 'Việc trong dự án', 'p1']]);
});

test('danh sách việc cần làm khi Claude chạy không tương tác (không có TodoWrite): máy chủ MCP agentos_todo + nhận diện tên công cụ ở trace/live + tự cho phép', async () => {
  const { handle, TOOL } = require('../src/todo-mcp');
  const { isTodoTool, describe } = require('../src/progress');
  const { createLive } = require('../src/live');
  assert.equal(handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }).result.serverInfo.name, 'agentos-todo');
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools.map((t) => t.name), ['todo_set']); assert.equal(TOOL.inputSchema.required[0], 'todos');
  assert.match(handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'todo_set', arguments: { todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] } } }).result.content[0].text, /2 việc/);
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(handle({ jsonrpc: '2.0', id: 4, method: 'khong-co' }).error.code, -32601);
  assert.equal(isTodoTool('TodoWrite'), true); assert.equal(isTodoTool('mcp__agentos_todo__todo_set'), true); assert.equal(isTodoTool('mcp__c_x__todo_set'), false);
  assert.equal(describe({ kind: 'tool', name: 'mcp__agentos_todo__todo_set', input: {} }), '', 'không hiện thành một "bước" riêng');
  const tr = createTrace({ dir: tmp() }); const job = { id: 20, chat_id: 1 };
  tr.step(job, { kind: 'tool', name: 'mcp__agentos_todo__todo_set', input: { todos: [{ content: 'Đọc', status: 'completed' }, { content: 'Viết', status: 'in_progress', activeForm: 'Đang viết' }] } });
  assert.deepEqual((await tr.read(20, 0)).todos.map((t) => t.s), ['completed', 'in_progress']);
  const edited = []; const tg = { sendChatAction: async () => {}, sendHtml: async (c, t) => { edited.push(t); return 1; }, editHtml: async (c, id, t) => { edited.push(t); }, deleteMessage: async () => {} };
  const live = createLive({ tg, throttleMs: 0, showAfterMs: 0, tickMs: 1e9, typingMs: 1e9 }); live.begin(job);
  live.step(job, { kind: 'tool', name: 'mcp__agentos_todo__todo_set', input: { todos: [{ content: 'Đọc', status: 'completed' }, { content: 'Viết', status: 'in_progress', activeForm: 'Đang viết' }] } });
  await wait(40); assert.match(edited[edited.length - 1], /Việc cần làm 1\/2[\s\S]*▶️ Đang viết/); assert.equal((await live.end(job)).steps, 0);
  const { classify } = require('../src/policy'); assert.equal(classify('mcp__agentos_todo__todo_set', {}), 'read');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(src, /tools\.servers\.agentos_todo = TODO_SERVER/); assert.match(src, /agentos_todo: TODO_SERVER/); assert.match(src, /BRAIN_HINT = THINK_HINT \+ ' ' \+ kiotvietHint\(KV_ON\) \+ ' ' \+ TODO_HINT/); assert.match(src, /fullHint\(!!gf\) \+ ' ' \+ TODO_HINT/);
});
