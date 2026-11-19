'use strict';
// Zalo và Telegram có KHO DỰ ÁN RIÊNG: chat Zalo không bị hỏi "tin này thuộc dự án nào" bằng danh sách dự án của Telegram, không lộ tên dự án Telegram.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createProjects } = require('../src/projects');
const { createProjectFlow } = require('../src/projectFlow');

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-')); const kv = new Map(); const db = { kvGet: (k) => (kv.has(k) ? kv.get(k) : null), kvSet: (k, v) => { kv.set(k, String(v)); }, kvDel: (k) => { kv.delete(k); }, history: () => [] }; let t = 1700000000000;
  const projects = createProjects({ baseDir: dir, db, now: () => t, log: () => {} });
  const isAdmin = () => true;
  const flow = createProjectFlow({ db, projects, isAdmin, submit: () => null, now: () => t });
  return { projects, flow, db, adv: (ms) => { t += ms; } };
}

test('chat Zalo có dự án tổng riêng; không thấy dự án Telegram và ngược lại; không hỏi chọn dự án dù lâu không nhắn', () => {
  const { projects, flow, adv } = mk();
  const tg = projects.create('Chiến AgentOS', '12345'); projects.create('Phổ AgentOS', '12345');
  const zh = projects.homeOf('zl:chatA1'); assert.ok(zh, 'có dự án tổng cho chat Zalo'); assert.equal(zh.name, 'Tổng · Zalo'); assert.equal(zh.home, 'zl:chatA1');
  assert.equal(projects.active('zl:chatA1').id, zh.id);
  const th = projects.homeOf('12345'); assert.ok(th); assert.notEqual(th.id, zh.id);
  // đang "ở" dự án Telegram thì Zalo không dùng được: tự về dự án tổng Zalo
  projects.setActive('zl:chatA1', tg.id); assert.equal(projects.active('zl:chatA1').id, zh.id, 'không chui vào dự án Telegram');
  projects.setActive('12345', zh.id); assert.equal(projects.active('12345').id, th.id, 'Telegram không chui vào dự án Zalo');
  // danh sách chọn: Zalo không có tên dự án Telegram, Telegram không có dự án Zalo
  const nz = projects.newChat('zl:chatA1', 'zl:chatA1'); assert.equal(nz.chat, 'zl:chatA1');
  const rz = flow.list ? null : null; void rz;
  const picker = (chat) => { const g = flow.gate(chat, chat, 'xin chào', Date.now() - 1e9); return g; };
  adv(10 * 3600 * 1000);
  assert.equal(flow.gate('zl:chatA1', 'zl:chatA1', 'Em vào VPS kiểm tra', 1), null, 'Zalo không bị hỏi chọn dự án');
  const g = flow.gate('12345', '12345', 'Em vào VPS kiểm tra', 1); assert.ok(g && /thuộc dự án nào/.test(g.text), 'Telegram vẫn hỏi như cũ');
  const names = g.buttons.flat().map((b) => b.text).join('|'); assert.match(names, /Chiến AgentOS/); assert.doesNotMatch(names, /Cuộc trò chuyện|Zalo/, 'Telegram không thấy dự án Zalo');
  void picker;
});

test('không đặt TÊN dự án theo mã bí mật (token bot, khóa API) mà khách/chủ máy dán vào câu đầu tiên', () => {
  const { projects } = mk();
  const p = projects.newChat('7000', '7000');
  assert.equal(projects.titleFromPrompt(p.id, '9286154332:AAGXcJ7WJjqjGevveKC1q4abcdefghijklmn'), null);
  assert.equal(projects.titleFromPrompt(p.id, 'dán giúp em sk-abcdefghijklmnopqrstuv'), null);
  assert.ok(projects.titleFromPrompt(p.id, 'Kiểm tra tồn kho hôm nay'), 'câu bình thường vẫn đặt tên');
});
