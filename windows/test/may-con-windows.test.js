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

test('máy con Windows: TOÀN QUYỀN (allowFull) mới cho ghi tệp + chạy lệnh; mặc định vẫn chỉ đọc; việc Chrome không bị ảnh hưởng', () => {
  const { FULL_TOOLS, CHROME_TOOLS } = require('../may-con-windows');
  const a = aiCommand('claude', 'x', false, true); const tools = a.args[a.args.indexOf('--allowedTools') + 1].split(',');
  assert.deepEqual(tools, FULL_TOOLS); for (const t of ['Edit', 'Write', 'Bash', 'PowerShell']) assert.ok(tools.includes(t));
  assert.deepEqual(aiCommand('codex', 'x', false, true).args, ['exec', '--skip-git-repo-check', '-s', 'danger-full-access', 'x']);
  assert.equal(aiCommand('none', 'x', false, true), null);
  assert.deepEqual(aiCommand('claude', 'x', false, false).args.slice(2, 4), ['--allowedTools', 'Read,Glob,Grep'], 'không bật thì vẫn chỉ đọc');
  assert.deepEqual(aiCommand('claude', 'x', true, true).args[aiCommand('claude', 'x', true, true).args.indexOf('--allowedTools') + 1].split(','), CHROME_TOOLS, 'việc Chrome luôn chỉ có công cụ trình duyệt');
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

test('máy con Windows: chế độ CHROME chỉ gồm công cụ xem/bấm/gõ trong trình duyệt (không chạy mã trang, không tải tệp, không đọc/ghi tệp, không lệnh); chỉ Claude; việc thường vẫn chỉ đọc', () => {
  const { CHROME_TOOLS } = require('../may-con-windows');
  const a = aiCommand('claude', 'trực tin', true); assert.equal(a.bin, 'claude'); assert.ok(a.args.includes('--chrome'));
  const tools = a.args[a.args.indexOf('--allowedTools') + 1].split(','); assert.deepEqual(tools, CHROME_TOOLS);
  for (const bad of ['javascript_tool', 'file_upload', 'upload_image', 'tabs_close_mcp', 'shortcuts_execute', 'gif_creator', 'read_network_requests', 'read_console_messages']) assert.ok(!tools.some((t) => t.endsWith(bad)), bad + ' không được cho phép');
  assert.ok(!tools.some((t) => /^(Bash|Write|Edit|Read)$/i.test(t)), 'không có công cụ hệ thống tệp/lệnh');
  assert.equal(aiCommand('codex', 'x', true), null); assert.equal(aiCommand('none', 'x', true), null);
  assert.ok(!aiCommand('claude', 'x').args.includes('--chrome'), 'việc thường không mở Chrome');
});

test('máy con Windows: kiểm nhanh Messenger đọc TIÊU ĐỀ cửa sổ Chrome (không AI); việc Chrome bị từ chối nếu chủ máy chưa bật allowChrome; đường /fleet/probe chỉ máy đã ghép (ký) gọi được', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winc-')); const fleetFile = path.join(dir, 'fleet.json'); const port = await freePort();
  process.env.AGENTOS_WIN_DIR = dir; process.env.AGENTOS_WIN_CONF = path.join(dir, 'w.json');
  const writeConf = (extra) => fs.writeFileSync(process.env.AGENTOS_WIN_CONF, JSON.stringify(Object.assign({ ai: 'claude', workdir: path.join(dir, 'work'), timeoutSec: 20 }, extra)));
  writeConf({}); let titles = ['(3) Messenger | Facebook - Google Chrome', 'Claude'];
  const f = createFleet({ file: fleetFile }); const a = f.enableAgent({ name: 'May Windows', port, host: '127.0.0.1' });
  const ran = []; const runner = (prompt, c, chrome) => { ran.push({ prompt, chrome }); return { bin: process.execPath, args: ['-e', 'console.log("xong")'] }; };
  const { agent } = create({ fleetFile, runner, windowTitles: () => titles }); await agent.listen();
  const H = createFleet({ file: path.join(dir, 'head.json') });
  try {
    H.addMachine({ name: 'Win', url: 'http://127.0.0.1:' + port, key: a.key }); const m = H.findMachine('Win');
    assert.deepEqual(await H.call(m, 'GET', '/fleet/probe', undefined, 15000), { found: true, unread: 3, title: '(3) Messenger | Facebook - Google Chrome', chromeReady: false }, 'chưa bật allowChrome → chromeReady=false');
    writeConf({ allowChrome: true }); assert.equal((await H.call(m, 'GET', '/fleet/probe')).chromeReady, true);
    titles = ['Messenger | Facebook - Google Chrome']; assert.equal((await H.call(m, 'GET', '/fleet/probe')).unread, 0);
    titles = ['(12) Messenger - Google Chrome', '(2) Messenger - Google Chrome']; assert.equal((await H.call(m, 'GET', '/fleet/probe')).unread, 12, 'nhiều cửa sổ: lấy số lớn nhất');
    titles = ['Facebook – log in or sign up - Google Chrome']; assert.equal((await H.call(m, 'GET', '/fleet/probe')).login, true);
    titles = ['Đăng nhập Messenger']; assert.equal((await H.call(m, 'GET', '/fleet/probe')).login, true);
    titles = ['Gmail - Google Chrome', 'Claude']; assert.deepEqual(await H.call(m, 'GET', '/fleet/probe'), { found: false, unread: null, chromeReady: true });
    // sai khóa → bị từ chối
    await assert.rejects(H.call({ url: 'http://127.0.0.1:' + port, key: 'sai' }, 'GET', '/fleet/probe'), /chữ ký sai/);
    // việc Chrome: bị từ chối khi chưa bật; chạy với cờ chrome khi đã bật; việc thường không có cờ
    const wait = async (id) => { for (let i = 0; i < 100; i++) { const j = await H.jobResult('Win', id); if (j.status === 'done' || j.status === 'error') return j; await new Promise((r) => setTimeout(r, 50)); } throw new Error('quá lâu'); };
    writeConf({}); const e = await wait((await H.sendTask('Win', 'xem tin', { chrome: true })).jobId); assert.equal(e.status, 'error'); assert.match(e.error, /allowChrome/); assert.equal(ran.length, 0, 'chưa bật thì AI không được chạy');
    writeConf({ allowChrome: true }); assert.equal((await wait((await H.sendTask('Win', 'xem tin', { chrome: true })).jobId)).status, 'done'); assert.equal(ran[0].chrome, true);
    assert.equal((await wait((await H.sendTask('Win', 'đếm tệp')).jobId)).status, 'done'); assert.equal(ran[1].chrome, false);
  } finally { await agent.close(); }
});
