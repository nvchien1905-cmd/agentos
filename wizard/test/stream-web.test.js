'use strict';
// Các bài thử này dùng lại hàm dựng máy chủ Cài đặt của conn-web.test.js bằng cách nạp lại chính tệp đó là không được (không xuất hàm) — nên dựng gọn riêng.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSettings } = require('../settings/server');
const { createTrace } = require('../../orchestrator/src/trace');
const { createProjects } = require('../../orchestrator/src/projects');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));

async function boot() {
  const dir = tmp(); const traceDir = path.join(dir, 'trace');
  const s = createSettings({
    port: 0, host: '127.0.0.1', peerUid: () => 1000, allowedUids: () => new Set([1000]), pageFile: path.join(__dirname, '..', 'settings', 'index.html'), run: async () => ({ code: 0, out: '', err: '' }),
    versionFile: path.join(dir, 'VERSION'), backupDir: path.join(dir, 'bk'), onedriveConf: path.join(dir, 'oc'), onedriveDir: path.join(dir, 'od'), memFallback: path.join(dir, 'st'), exit: () => {}, fullAccessPaths: { sudoers: path.join(dir, 's'), dropin: path.join(dir, 'd') },
    connectorsFile: path.join(dir, 'c.json'), pluginsFile: path.join(dir, 'p.json'), pluginsDir: path.join(dir, 'plugins'), projects: createProjects({ baseDir: path.join(dir, 'odir') }), traceDir, journalDir: path.join(dir, 'journal'),
    streamTickMs: 15, approvalsFile: path.join(dir, 'approvals.json'), controlDir: path.join(dir, 'control'),
  });
  const port = await s.listen();
  const call = async (m, p, body) => { const r = await fetch('http://127.0.0.1:' + port + '/api/' + p, { method: m, headers: { 'content-type': 'application/json', 'x-agentos-settings': '1' }, body: m === 'GET' ? undefined : JSON.stringify(body || {}) }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* html */ } return { status: r.status, body: j, text }; };
  return { s, port, call, dir, traceDir, tr: createTrace({ dir: traceDir }) };
}
// Đọc luồng SSE: trả về mảng gói dữ liệu cho tới khi luồng đóng (hoặc hết giờ)
async function readStream(port, q, ms) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), ms || 5000); const out = [];
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/watch/stream?' + q, { signal: ac.signal }); assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^data: (.*)$/m.exec(blk); if (m) out.push(JSON.parse(m[1])); } }
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { clearTimeout(timer); }
  return out;
}

test('luồng trực tiếp (SSE): đẩy từng bước + từng chữ ngay khi ghi, đóng luồng khi việc xong; đọc tiếp từ vị trí `from`; việc không tồn tại trả exists=false', async () => {
  const S = await boot();
  try {
    const job = { id: 8, chat_id: 1, prompt: 'x' };
    S.tr.begin(job); S.tr.step(job, { kind: 'tool', name: 'Read', input: { file_path: '/a' } });
    const reading = readStream(S.port, 'id=8&from=0');
    await new Promise((r) => setTimeout(r, 120));
    S.tr.delta(job, 'Đang '); S.tr.delta(job, 'gõ'); await new Promise((r) => setTimeout(r, 400));
    S.tr.step(job, { kind: 'tool', name: 'TodoWrite', input: { todos: [{ content: 'Việc 1', status: 'in_progress', activeForm: 'Đang làm việc 1' }] } });
    await new Promise((r) => setTimeout(r, 100)); S.tr.end(job, { ok: true, secs: 3 });
    const pk = await reading; const all = pk.flatMap((p) => p.events);
    assert.deepEqual(all.map((e) => e.k), ['start', 'tool', 'delta', 'todo', 'end']); assert.equal(all[2].text, 'Đang gõ');
    assert.equal(pk[pk.length - 1].done, true); assert.equal(pk[pk.length - 1].todos[0].a, 'Đang làm việc 1');
    const again = await readStream(S.port, 'id=8&from=' + pk[pk.length - 1].next); assert.equal(again.flatMap((p) => p.events).length, 0, 'from = vị trí đã đọc → không lặp lại');
    const none = await readStream(S.port, 'id=999&from=0', 600); assert.equal(none[0].exists, false);
    const bad = await readStream(S.port, 'id=../x&from=0', 600); assert.equal(bad[0].exists, false);
  } finally { await S.s.close(); }
});

test('duyệt và điều khiển từ màn hình: đọc danh sách xin quyền; control approval.answer / job.submit ghi tệp yêu cầu (chủ agentos) với trường đã cắt gọn', async () => {
  const S = await boot();
  try {
    assert.deepEqual((await S.call('GET', 'watch/approvals')).body, { list: [] });
    fs.writeFileSync(path.join(S.dir, 'approvals.json'), JSON.stringify([{ id: 'ab12', jobId: 3, cls: 'exec', label: 'Chạy lệnh', summary: 'ls', canRemember: true, since: 1 }]));
    assert.equal((await S.call('GET', 'watch/approvals')).body.list[0].id, 'ab12');
    assert.equal((await S.call('POST', 'control', { action: 'approval.answer', approval: 'ab12', decision: 'yes-nhieu-chu' })).status, 200);
    assert.equal((await S.call('POST', 'control', { action: 'job.submit', text: 'Việc dài ' + 'x'.repeat(5000), project: 'p1' })).status, 200);
    assert.equal((await S.call('POST', 'control', { action: 'khong-co' })).status, 400);
    const reqs = fs.readdirSync(path.join(S.dir, 'control')).map((f) => JSON.parse(fs.readFileSync(path.join(S.dir, 'control', f), 'utf8')));
    assert.deepEqual(reqs.find((r) => r.action === 'approval.answer'), { action: 'approval.answer', approval: 'ab12', decision: 'y' });
    assert.equal(reqs.find((r) => r.action === 'job.submit').text.length, 4000);
  } finally { await S.s.close(); }
});

test('trang Màn hình AI có: luồng trực tiếp, chữ đang gõ, duyệt xin quyền, giao việc mới, dừng/chạy lại, chạy JavaScript trong khung cách ly không có mạng', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
  for (const k of ['new EventSource(', 'liveText', 'watch/approvals', "action: 'approval.answer'", "action: 'job.submit'", "action: 'job.cancel'", "action: 'job.rerun'", 'allow-scripts', "default-src \\'none\\'"]) assert.ok(html.includes(k), 'thiếu ' + k);
  assert.doesNotMatch(html, /sandbox="allow-scripts allow-same-origin"/, 'không bao giờ cho cùng nguồn');
});
