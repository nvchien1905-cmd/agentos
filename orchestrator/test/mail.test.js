'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMail } = require('../src/mail');
const { startMailWorker, startMailCollector } = require('../src/mailLoop');
const { createAgentsUi } = require('../src/agentsUi');
const { unitText, envText } = require('../src/agentctl');

function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-'));
  for (const id of ['a1', 'a2']) for (const s of ['in', 'out']) fs.mkdirSync(path.join(root, id, s), { recursive: true });
  return { root, mail: createMail({ root }) };
}

test('hộp thư: giao việc -> bot nhận -> trả kết quả -> bot quản lý đọc (mỗi tệp chỉ dùng một lần)', () => {
  const { mail } = box();
  const jid = mail.send('a1', { from: '7', chat: '7', text: 'Lập báo cáo' });
  assert.match(jid, /^[a-f0-9]{16}$/); assert.equal(mail.pendingIn('a1'), 1);
  const got = mail.take('a1', new Set(['7']));
  assert.equal(got.length, 1); assert.equal(got[0].text, 'Lập báo cáo'); assert.equal(mail.pendingIn('a1'), 0);
  assert.equal(mail.take('a1', new Set(['7'])).length, 0, 'đã lấy thì hết');
  mail.finish('a1', { jid, chat: got[0].chat, task: got[0].text, status: 'done', text: 'Xong rồi' });
  const r = mail.collect('a1'); assert.equal(r.length, 1); assert.equal(r[0].status, 'done'); assert.equal(r[0].text, 'Xong rồi'); assert.equal(r[0].chat, '7');
  assert.equal(mail.collect('a1').length, 0);
});

test('hộp thư: ID không được phép bị từ chối (có báo lại), tệp hỏng/lạ bị bỏ, đầu vào sai bị chặn', () => {
  const { mail, root } = box();
  mail.send('a1', { from: '99', chat: '7', text: 'việc lạ' });
  assert.equal(mail.take('a1', new Set(['7'])).length, 0);
  const r = mail.collect('a1'); assert.equal(r.length, 1); assert.equal(r[0].status, 'rejected'); assert.match(r[0].text, /99/);
  fs.writeFileSync(path.join(root, 'a1', 'in', 'aaaaaaaaaaaaaaaa.json'), '{không phải json');
  fs.writeFileSync(path.join(root, 'a1', 'in', 'bbbbbbbbbbbbbbbb.json'), JSON.stringify({ jid: 'cccccccccccccccc', from: '7', chat: '7', text: 'x' }));   // tên tệp ≠ mã
  assert.equal(mail.take('a1', new Set(['7'])).length, 0);
  fs.writeFileSync(path.join(root, 'a1', 'out', 'dddddddddddddddd.json'), JSON.stringify({ jid: 'dddddddddddddddd', chat: '../../x', status: 'done', text: 'a' }));
  assert.equal(mail.collect('a1').length, 0, 'chat không phải số');
  assert.throws(() => mail.send('../x', { from: '7', chat: '7', text: 'a' }), /Mã bot/);
  assert.throws(() => mail.send('a1', { from: 'x', chat: '7', text: 'a' }), /ID/);
  assert.throws(() => mail.send('a1', { from: '7', chat: '7', text: '  ' }), /trống/);
  assert.throws(() => mail.send('a9', { from: '7', chat: '7', text: 'a' }), /hộp thư/);
  if (process.platform !== 'win32') {
    fs.symlinkSync('/etc/passwd', path.join(root, 'a1', 'out', 'eeeeeeeeeeeeeeee.json'));
    assert.equal(mail.collect('a1').length, 0, 'không theo liên kết tượng trưng');
  }
});

test('bot thường: việc nhận xong -> xếp hàng như chủ nhắn; xong thì trả kết quả; lỗi/ngắt cũng được báo; nhớ qua lần khởi động lại', () => {
  const { mail } = box();
  const kv = {}, jobs = new Map(); let nextId = 1;
  const db = { kvGet: (k) => kv[k] || null, kvSet: (k, v) => { kv[k] = v; }, addJob: (chat, prompt, e, p, lane) => { const id = nextId++; jobs.set(id, { status: 'queued', chat, prompt, lane }); return id; }, getJob: (id) => jobs.get(id) || null };
  const cfg = { agentId: 'a1', allowedUserIds: new Set(['7']) };
  const logs = [];
  const w = startMailWorker({ mail, db, crew: { wake() {} }, cfg, log: (m) => logs.push(m), intervalMs: 3600000 });
  const j1 = mail.send('a1', { from: '7', chat: '7', text: 'Việc một' }), j2 = mail.send('a1', { from: '7', chat: '7', text: 'Việc hai' });
  w.tick();
  assert.equal(jobs.size, 2); assert.equal(jobs.get(1).chat, '7'); assert.equal(jobs.get(1).lane, 'main'); assert.match(jobs.get(1).prompt, /Việc một/);
  assert.equal(mail.collect('a1').length, 0, 'chưa xong thì chưa trả');
  jobs.get(1).status = 'done'; jobs.get(1).result = 'KQ một';
  jobs.get(2).status = 'limit';
  w.tick();
  const r = mail.collect('a1').sort((a, b) => a.text.localeCompare(b.text));
  assert.equal(r.length, 2);
  const m = Object.fromEntries(r.map((x) => [x.jid, x]));
  assert.equal(m[j1].status, 'done'); assert.equal(m[j1].text, 'KQ một');
  assert.equal(m[j2].status, 'error'); assert.match(m[j2].text, /hạn mức/);
  assert.equal(JSON.parse(kv.mail_pending).length === undefined, true); assert.deepEqual(JSON.parse(kv.mail_pending), {});
  // khởi động lại: việc chờ được nhớ
  const j3 = mail.send('a1', { from: '7', chat: '7', text: 'Việc ba' }); w.tick();
  const w2 = startMailWorker({ mail, db, crew: { wake() {} }, cfg, log() {}, intervalMs: 3600000 });
  jobs.get(3).status = 'done'; jobs.get(3).result = 'KQ ba'; w2.tick();
  assert.equal(mail.collect('a1')[0].text, 'KQ ba');
  // việc bị mất khỏi hàng đợi -> báo lỗi
  const j4 = mail.send('a1', { from: '7', chat: '7', text: 'Việc bốn' }); w2.tick(); jobs.delete(4); w2.tick();
  assert.equal(mail.collect('a1')[0].status, 'error'); w.stop(); w2.stop();
  void j3; void j4;
});

test('bot quản lý: đọc kết quả của mọi bot thường rồi nhắn lại đúng người giao', async () => {
  const { mail } = box();
  const sent = [];
  const c = startMailCollector({ mail, agents: { all: () => [{ id: 'a1', name: 'Bán hàng', bot: { username: 'ban_hang_bot' } }, { id: 'a2', name: 'Kế toán' }] }, send: async (chat, text) => { sent.push([chat, text]); }, log() {}, intervalMs: 3600000 });
  mail.finish('a1', { jid: 'a'.repeat(16), chat: '7', task: 'Báo cáo', status: 'done', text: 'Doanh số 5 triệu' });
  mail.finish('a2', { jid: 'b'.repeat(16), chat: '8', task: 'Sổ', status: 'error', text: 'Lỗi mạng' });
  await c.tick();
  assert.equal(sent.length, 2);
  assert.match(sent[0][1], /✅ Bán hàng \(@ban_hang_bot\) đã xong việc "Báo cáo"/); assert.match(sent[0][1], /Doanh số 5 triệu/); assert.equal(sent[0][0], '7');
  assert.match(sent[1][1], /⚠️ Kế toán báo lỗi/); assert.equal(sent[1][0], '8');
  await c.tick(); assert.equal(sent.length, 2); c.stop();
});

test('giao việc bằng lệnh /giao và câu thường; "giao hàng" không bị hiểu nhầm; chỉ chủ máy; bot dừng thì báo', async () => {
  const { mail } = box();
  const list = [
    { id: 'a1', name: 'Bán hàng', owners: ['7'], bot: { id: 1, username: 'ban_hang_bot' } },
    { id: 'a2', name: 'Kế toán', owners: ['8'], bot: { id: 2, username: 'ke_toan_bot' } },
  ];
  let active = true;
  const agents = { all: () => list, status: async () => ({ active }) };
  const ui = createAgentsUi({ agents, mail, isAdmin: (u) => String(u) === '7' || String(u) === '8', send: async () => {} });
  let p = ui.parseAssign('Giao cho bot Bán hàng làm: lập báo cáo doanh số'); assert.equal(p.agent.id, 'a1'); assert.equal(p.task, 'lập báo cáo doanh số');
  p = ui.parseAssign('giao việc cho kế toán đối chiếu sổ quỹ'); assert.equal(p.agent.id, 'a2'); assert.equal(p.task, 'đối chiếu sổ quỹ');
  p = ui.parseAssign('hãy giao cho @ban_hang_bot nhắn khách A'); assert.equal(p.agent.id, 'a1'); assert.equal(p.task, 'nhắn khách A');
  p = ui.parseAssign('giao a2 làm kiểm kê'); assert.equal(p.agent.id, 'a2'); assert.equal(p.task, 'kiểm kê');
  assert.equal(ui.parseAssign('giao hàng cho khách A'), null);
  assert.equal(ui.parseAssign('giao cho bot Bán hàng'), null, 'không có việc');
  assert.equal(ui.parseAssign('giao cho bot lạ làm gì đó'), null);
  assert.equal(ui.parseAssign('xin chào'), null);
  assert.equal(ui.tryAssign('9', '9', 'giao cho Bán hàng làm x'), null, 'không phải chủ máy -> đi tiếp thành câu thường');
  const ok = await ui.tryAssign('7', '7', 'giao cho bot Bán hàng làm: lập báo cáo');
  assert.match(ok, /Đã giao cho "Bán hàng"/); assert.equal(mail.pendingIn('a1'), 1);
  assert.match(await ui.assignCommand('7', '7', 'a1 việc khác'), /Đã giao/); assert.equal(mail.pendingIn('a1'), 2);
  assert.match(await ui.assignCommand('7', '7', ''), /\/giao <tên bot> <việc>/);
  assert.match(await ui.tryAssign('7', '7', 'giao cho kế toán làm sổ'), /chưa nằm trong danh sách/, 'ID của anh chưa được phép với bot Kế toán');
  active = false; assert.match(await ui.assignCommand('7', '7', 'a1 y'), /đang dừng/);
  assert.match(ui.assignCommand('9', '9', 'a1 y'), /Chỉ chủ máy/);
});

test('agentctl: dịch vụ agent được ghi vào hộp thư của mình; cấu hình có MAIL_ROOT; unit bot quản lý ghi được hộp thư', () => {
  const meta = { name: 'X', ramMb: 1536, cpuPct: 100, owners: ['7'], settings: {} };
  assert.match(unitText('a1', meta), /ReadWritePaths=-\/var\/lib\/agentos-agents\/\.mail\/a1/);
  assert.match(envText('a1', meta, '123456789:' + 'A'.repeat(35), '').text, /^MAIL_ROOT=\/var\/lib\/agentos-agents\/\.mail$/m);
  const svc = fs.readFileSync(path.join(__dirname, '../../iso/config/includes.chroot/etc/systemd/system/agentos-orchestrator.service'), 'utf8');
  assert.match(svc, /ReadWritePaths=-\/var\/lib\/agentos-agents\/\.mail/);
});
