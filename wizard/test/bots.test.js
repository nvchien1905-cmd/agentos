'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBots, spec } = require('../lib/bots');

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function make() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-'));
  const calls = [];
  const ctl = { handle: async (req) => { calls.push(req); if (req.action === 'create') return { ok: true, msg: 'ok', warn: '' }; if (req.action === 'remove') return { ok: true, kept: '/x/da-xoa' }; if (req.action === 'logs') return { ok: true, text: 'nhật ký' }; return { ok: true, msg: 'xong ' + req.action }; } };
  const tidy = [];
  const bots = createBots({ ctl, file: path.join(d, 'agents.json'), mainToken: () => '555555555:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', owners: () => ['7'], getMe: async () => ({ id: 1, username: 'bot_a', first_name: 'Bot A' }), show: async () => ({ ActiveState: 'active', SubState: 'running' }), afterSave: (p) => tidy.push(p) });
  return { bots, calls, tidy };
}

test('trang Cài đặt: mô tả quyền hạn có đủ mục và nhãn tiếng Việt', () => {
  const s = spec();
  for (const k of ['full', 'sandbox', 'tools', 'jobTimeoutMin', 'approvalTimeoutMin', 'parallel', 'subagents', 'checkpoints', 'memory', 'netGuard']) assert.ok(s[k] && s[k].label && s[k].kind, k);
  assert.deepEqual(s.sandbox.values, ['auto', 'off', 'bwrap']);
});

test('thêm / chỉnh quyền hạn / dừng / nhật ký / xóa bot phụ qua trang Cài đặt (gọi thẳng agentctl, sổ dùng chung với /daily)', async () => {
  const { bots, calls, tidy } = make();
  const r = await bots.add({ token: TOKEN, name: 'Bán hàng', settings: { parallel: 3 } });
  assert.equal(r.agent.id, 'a1');
  const create = calls.find((c) => c.action === 'create');
  assert.deepEqual(create.owners, ['7']); assert.deepEqual(create.settings, { parallel: 3 }); assert.match(create.rid, /^[a-f0-9]{16}$/);
  assert.ok(tidy.length >= 1, 'chown sổ cho agentos');
  let l = await bots.list(); assert.equal(l.agents.length, 1); assert.equal(l.agents[0].status.active, true); assert.equal(l.agents[0].settings.parallel, 3); assert.ok(l.spec.full);
  await bots.update({ id: 'a1', settings: { full: true, parallel: null } });
  l = await bots.list(); assert.equal(l.agents[0].settings.full, true); assert.equal(l.agents[0].settings.parallel, undefined);
  await assert.rejects(() => bots.update({ id: 'a1', settings: { rm: 1 } }), /lạ/);
  await bots.update({ id: 'a1', name: 'Tên mới', owners: '7, 8', ramMb: 2048, cpuPct: 150 });
  l = await bots.list(); assert.equal(l.agents[0].name, 'Tên mới'); assert.deepEqual(l.agents[0].owners, ['7', '8']); assert.equal(l.agents[0].ramMb, 2048);
  assert.match((await bots.control({ id: 'a1', verb: 'stop' })).msg, /xong stop/);
  await assert.rejects(() => bots.control({ id: 'a1', verb: 'rm' }), /không hợp lệ/);
  assert.equal((await bots.logs({ id: 'a1' })).text, 'nhật ký');
  await assert.rejects(() => bots.remove({ id: 'a1' }), /xác nhận/);
  assert.equal((await bots.remove({ id: 'a1', confirm: true })).kept, '/x/da-xoa');
  assert.equal((await bots.list()).agents.length, 0);
  await assert.rejects(() => bots.add({ token: '555555555:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' }), /bot quản lý/);
});

test('giao diện Cài đặt: tab Bot Telegram có bảng bot phụ với nút chỉnh quyền hạn; máy chủ có đủ đường API; chỉ dẫn AI cấm bỏ cuộc', () => {
  const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
  for (const k of ['renderAgents', 'bots/agent/update', 'bots/agent/control', 'Lưu quyền hạn và khởi động lại bot', 'data-do="perm"']) assert.ok(html.includes(k), k);
  const srv = fs.readFileSync(path.join(__dirname, '../settings/server.js'), 'utf8');
  for (const k of ["'GET /api/bots'", "'POST /api/bots/agent/add'", "'POST /api/bots/agent/update'", "'POST /api/bots/agent/control'", "'POST /api/bots/agent/remove'", "'POST /api/bots/agent/logs'"]) assert.ok(srv.includes(k), k);
  const { THINK_HINT } = require('../../orchestrator/src/thinking');
  for (const k of ['KAIZEN', 'TUYỆT ĐỐI không trả lời', 'hết hạn mức/token', 'TỰ SỬA', 'cách KHÁC HẲN']) assert.ok(THINK_HINT.includes(k), k);
});
