'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { create, aiCommand } = require('../may-con-windows');
const { createFleet } = require('../../orchestrator/src/fleet');

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('máy con Windows: AI chỉ đọc (Claude: chỉ Read/Glob/Grep; Codex: read-only), không có AI thì báo rõ', () => {
  assert.deepEqual(aiCommand('claude', 'xin chào'), { bin: 'claude', args: ['-p', 'xin chào', '--allowedTools', 'Read,Glob,Grep', '--output-format', 'text'] });
  assert.deepEqual(aiCommand('codex', 'x'), { bin: 'codex', args: ['exec', '--skip-git-repo-check', '-s', 'read-only', 'x'] });
  assert.equal(aiCommand('none', 'x'), null);
  for (const a of [aiCommand('claude', 'x'), aiCommand('codex', 'x')]) assert.ok(!/dangerously|bypass|yolo|workspace-write|full-access/i.test(a.args.join(' ')), 'không có tùy chọn cho phép ghi/chạy lệnh');
});

test('máy con Windows: đầu não (cùng giao thức fleet.js) xem tình trạng, giao việc, lấy kết quả; việc lỗi báo rõ', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-')); const fleetFile = path.join(dir, 'fleet.json'); const port = await freePort();
  process.env.AGENTOS_WIN_DIR = dir; process.env.AGENTOS_WIN_CONF = path.join(dir, 'w.json'); fs.writeFileSync(process.env.AGENTOS_WIN_CONF, JSON.stringify({ ai: 'claude', workdir: path.join(dir, 'work') }));
  const f = createFleet({ file: fleetFile }); const a = f.enableAgent({ name: 'May Windows', port, host: '127.0.0.1' });
  // chương trình AI giả: in ra câu hỏi (viết bằng node để chạy trên mọi hệ điều hành)
  const runner = (prompt) => (/LOI/.test(prompt) ? { bin: process.execPath, args: ['-e', 'process.stderr.write("hỏng rồi");process.exit(3)'] } : { bin: process.execPath, args: ['-e', 'console.log("TRẢ LỜI:" + process.argv[1])', prompt] });
  const { agent } = create({ fleetFile, runner }); await agent.listen();
  const H = createFleet({ file: path.join(dir, 'head.json') });
  try {
    H.addMachine({ name: 'Win', url: 'http://127.0.0.1:' + port, key: a.key });
    const st = (await H.statusAll())[0]; assert.equal(st.online, true); assert.equal(st.platform, 'windows'); assert.match(st.version, /-win$/); assert.equal(st.queued, 0);
    const r = await H.sendTask('Win', 'Đếm tệp trong thư mục'); const wait = async (id) => { for (let i = 0; i < 100; i++) { const j = await H.jobResult('Win', id); if (j.status === 'done' || j.status === 'error') return j; await new Promise((x) => setTimeout(x, 50)); } throw new Error('quá giờ'); };
    const j = await wait(r.jobId); assert.equal(j.status, 'done'); assert.match(j.result, /TRẢ LỜI:\[VIỆC TỪ MÁY ĐẦU NÃO\] Đếm tệp/);
    const e = await wait((await H.sendTask('Win', 'gây LOI đi')).jobId); assert.equal(e.status, 'error'); assert.match(e.error, /hỏng rồi/);
    await assert.rejects(H.jobResult('Win', 99999), /không có việc này/);
    assert.match((await H.updateMachine('Win')).text, /thủ công/);
  } finally { await agent.close(); }
});

test('máy con Windows: nhận khóa SSH công khai chỉ khi chủ máy bật; chỉ 1 dòng khóa công khai, không trùng, không ghi chỗ khác', () => {
  const { installSshKey } = require('../may-con-windows');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winssh-')), conf = path.join(dir, 'w.json'), ssh = path.join(dir, '.ssh');
  process.env.AGENTOS_WIN_CONF = conf;
  const K = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SzG5k2xF0Tnb8EVkhrHk4Z7TFhqRlpPE agentos-dau-nao';
  fs.writeFileSync(conf, JSON.stringify({ ai: 'none', sshDir: ssh }));
  assert.throws(() => installSshKey(K), /chưa bật/, 'mặc định TẮT');
  assert.ok(!fs.existsSync(ssh));
  fs.writeFileSync(conf, JSON.stringify({ ai: 'none', sshDir: ssh, allowSshKey: true }));
  for (const bad of ['', 'rm -rf /', K + '\nssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC' + 'x'.repeat(30), '-----BEGIN OPENSSH PRIVATE KEY-----', 'command="x" ' + K]) assert.throws(() => installSshKey(bad), /không đúng dạng/);
  const r = installSshKey(K); assert.equal(r.added, true); assert.equal(r.ok, true); assert.ok(r.user);
  assert.equal(fs.readFileSync(path.join(ssh, 'authorized_keys'), 'utf8'), K + '\n');
  assert.equal(installSshKey(K).added, false, 'gửi lại không chép trùng');
  fs.appendFileSync(path.join(ssh, 'authorized_keys'), 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCkhac nguoikhac\n');
  installSshKey(K); assert.equal(fs.readFileSync(path.join(ssh, 'authorized_keys'), 'utf8').split('\n').filter((l) => l.startsWith('ssh-ed25519')).length, 1, 'giữ khóa cũ của người khác, không thêm trùng');
  delete process.env.AGENTOS_WIN_CONF;
});

test('máy con Windows: đọc được windows-agent.json có BOM (PowerShell 5.1 ghi UTF-8 kèm BOM) — trước đây bị bỏ qua nên "chưa bật nhận khóa"', () => {
  const { installSshKey } = require('../may-con-windows');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winbom-')), conf = path.join(dir, 'w.json');
  process.env.AGENTOS_WIN_CONF = conf;
  fs.writeFileSync(conf, '﻿' + JSON.stringify({ ai: 'none', sshDir: path.join(dir, 'ssh'), allowSshKey: true }));
  const K = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SzG5k2xF0Tnb8EVkhrHk4Z7TFhqRlpPE agentos-dau-nao';
  assert.equal(installSshKey(K).ok, true);
  delete process.env.AGENTOS_WIN_CONF;
});
