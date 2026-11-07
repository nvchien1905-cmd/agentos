'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createPlugins } = require('../src/plugins');
const { createConnectors } = require('../src/connectors');
const { createPluginsUi } = require('../src/pluginsUi');
const { createProjects } = require('../src/projects');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'px-'));
const MD = (name, desc, body, args) => '---\nname: ' + name + '\ndescription: ' + desc + (args ? '\nargs: ' + args : '') + '\n---\n' + body + '\n';
function mkPlugin(root, id, extra, files) {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'plugin.json'), JSON.stringify(Object.assign({ id, name: 'Gói ' + id, version: '1.0.0', description: 'mô tả đủ dài cho gói thử' }, extra)));
  for (const [f, body] of Object.entries(files || {})) { fs.mkdirSync(path.dirname(path.join(root, id, f)), { recursive: true }); fs.writeFileSync(path.join(root, id, f), body); }
}
const setup = () => {
  const root = tmp(), dir = path.join(root, 'cat'), user = path.join(root, 'user'), data = path.join(root, 'data'); fs.mkdirSync(dir); fs.mkdirSync(data);
  const holder = {}; const connectors = createConnectors({ file: path.join(data, 'c.json'), extraCatalog: () => (holder.p ? holder.p.extraCatalog() : []) });
  return { root, dir, user, data, connectors, mk: (extra) => { const p = createPlugins(Object.assign({ dir, userDir: user, stateFile: path.join(data, 'p.json'), connectors }, extra || {})); holder.p = p; return p; } };
};

test('plugin có LỆNH: chỉ hiện khi đã cài + bật; {args} được thay; không có {args} thì ghép "Yêu cầu của chủ máy"; tên lệnh lạ bị từ chối', () => {
  const t = setup(); mkPlugin(t.dir, 'ban', {}, { 'commands/bc.md': MD('Báo cáo', 'lập báo cáo', 'Lập báo cáo kỳ: {args}!', 'kỳ'), 'commands/tl.md': MD('Trả lời', 'trả lời', 'Soạn trả lời khách.') });
  const p = t.mk(); assert.deepEqual(p.commands(), []); assert.equal(p.commandPrompt('ban/bc', 'hôm qua'), null, 'chưa cài');
  p.install('ban'); assert.deepEqual(p.commands().map((c) => [c.name, c.args]), [['ban/bc', 'kỳ'], ['ban/tl', '']]);
  assert.equal(p.commandPrompt('ban/bc', ' hôm qua '), 'Lập báo cáo kỳ: hôm qua!'); assert.equal(p.commandPrompt('ban/tl', 'khách hỏi giá'), 'Soạn trả lời khách.\n\nYêu cầu của chủ máy: khách hỏi giá');
  assert.equal(p.commandPrompt('ban/../x', 'a'), null); assert.equal(p.commandPrompt('ban/khong', 'a'), null); assert.equal(p.commandPrompt('../ban/bc', 'a'), null);
  p.setEnabled('ban', false); assert.deepEqual(p.commands(), []); assert.equal(p.commandPrompt('ban/bc', 'x'), null, 'đang tắt');
  assert.equal(p.get('ban').commands.length, 2); assert.match(p.skillText('ban', 'bc', 'commands'), /Lập báo cáo/);
});

test('plugin có TÁC NHÂN: dự án thấy danh sách + đường dẫn tệp trong chỉ dẫn của AI khi plugin đã cài', () => {
  const t = setup(); mkPlugin(t.dir, 'ag', {}, { 'agents/kt.md': MD('Kiểm tra số liệu', 'rà soát bảng số', 'Bạn là người kiểm tra.') });
  const p = t.mk(); const projects = createProjects({ baseDir: path.join(t.root, 'od'), extraSkillDirs: () => p.skillDirs(), extraAgentDirs: () => p.agentDirs() });
  const pr = projects.create('Dự án', 'test');
  assert.doesNotMatch(projects.instructions(pr.id) || '', /TÁC NHÂN PHỤ/);
  p.install('ag'); const ins = projects.instructions(pr.id);
  assert.match(ins, /TÁC NHÂN PHỤ CÓ SẴN[\s\S]*Kiểm tra số liệu: rà soát bảng số \[[^\]]*kt\.md\]/);
});

// gói .tar.gz thật + fetch giả
function tgz(files) { const d = tmp(); for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); } const out = path.join(tmp(), 'p.tgz'); cp.execFileSync('tar', ['-czf', out, '-C', d, '.']); return fs.readFileSync(out); }
const fakeFetch = (buf, status) => async () => ({ ok: (status || 200) < 400, status: status || 200, url: 'https://github.com/x/y/archive/main.tar.gz', arrayBuffer: async () => buf });

test('thêm plugin từ liên kết: https công khai, cần xác nhận, chỉ giữ văn bản (bỏ mã chạy được), BỎ kết nối, không ghi đè plugin có sẵn, xóa hẳn được', async () => {
  const t = setup(); mkPlugin(t.dir, 'cosan', {}, { 'skills/a.md': MD('A', 'a', 'x') });
  const good = tgz({ 'repo-main/plugin.json': JSON.stringify({ id: 'ngoai', name: 'Gói ngoài', version: '2.0.0', description: 'plugin do bên thứ ba viết', connectors: [{ key: 'xau', label: 'Xấu', command: 'npx', args: ['-y', 'goi-doc-hai'] }] }),
    'repo-main/skills/s.md': MD('Kỹ năng ngoài', 'khi cần x', 'làm x'), 'repo-main/commands/c.md': MD('Lệnh', 'd', 'làm {args}'), 'repo-main/agents/a.md': MD('Tác nhân', 'd', 'vai trò'), 'repo-main/install.sh': 'rm -rf /', 'repo-main/skills/nhi-phan.bin': 'x' });
  const p = t.mk({ fetch: fakeFetch(good) });
  assert.match((await p.addFromUrl('http://github.com/x.tgz')).error, /https/); assert.match((await p.addFromUrl('https://127.0.0.1/x.tgz')).error, /công cộng/); assert.match((await p.addFromUrl('https://192.168.1.5/x.tgz')).error, /công cộng/); assert.match((await p.addFromUrl('khong-phai-url')).error, /không hợp lệ/);
  const pre = await p.addFromUrl('https://github.com/x/y/archive/main.tar.gz', {}); assert.equal(pre.needConfirm, true); assert.equal(pre.preview.skills.length, 1); assert.equal(pre.preview.droppedConnectors, true);
  assert.equal(fs.existsSync(path.join(t.user, 'ngoai')), false, 'chưa xác nhận thì chưa lưu gì');
  const r = await p.addFromUrl('https://github.com/x/y/archive/main.tar.gz', { confirm: true }); assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual([r.skills, r.commands, r.agents, r.connectors], [1, 1, 1, 0]);
  assert.deepEqual(fs.readdirSync(path.join(t.user, 'ngoai')).sort(), ['.agentos-trust.json', 'agents', 'commands', 'plugin.json', 'skills'], 'không có install.sh');
  assert.deepEqual(fs.readdirSync(path.join(t.user, 'ngoai', 'skills')), ['s.md']);
  const v = p.get('ngoai'); assert.equal(v.source, 'user'); assert.equal(v.connectors.length, 0); assert.equal(p.install('ngoai').ok, true); assert.equal(t.connectors.get('xau'), null, 'kết nối của nguồn ngoài không bao giờ được thêm');
  assert.equal(p.commandPrompt('ngoai/c', 'việc'), 'làm việc');
  const clash = createPlugins({ dir: t.dir, userDir: t.user, stateFile: path.join(t.data, 'q.json'), fetch: fakeFetch(tgz({ 'plugin.json': JSON.stringify({ id: 'cosan', name: 'x', version: '1.0.0' }), 'skills/a.md': MD('A', 'a', 'x') })) });
  assert.match((await clash.addFromUrl('https://github.com/x/y.tgz', { confirm: true })).error, /trùng plugin có sẵn/);
  assert.equal(p.removeUser('cosan').ok, false, 'plugin có sẵn không xóa được'); assert.equal(p.removeUser('ngoai').ok, true); assert.equal(fs.existsSync(path.join(t.user, 'ngoai')), false); assert.equal(p.get('ngoai'), null);
});

test('thêm plugin từ liên kết: gói hỏng/đường dẫn nguy hiểm/quá lớn/rỗng/lỗi mạng bị từ chối rõ ràng', async () => {
  const t = setup(); const mk = (buf, st) => createPlugins({ dir: t.dir, userDir: t.user, stateFile: path.join(t.data, 'z.json'), fetch: fakeFetch(buf, st) });
  const U = 'https://github.com/x/y.tgz';
  assert.match((await mk(Buffer.from('không phải tar'), 200).addFromUrl(U, { confirm: true })).error, /Không đọc được gói/);
  assert.match((await mk(Buffer.alloc(0), 200).addFromUrl(U, { confirm: true })).error, /rỗng/); assert.match((await mk(Buffer.alloc(6 * 1024 * 1024), 200).addFromUrl(U, { confirm: true })).error, /lớn hơn 5 MB/);
  assert.match((await mk(Buffer.from('x'), 404).addFromUrl(U, { confirm: true })).error, /404/);
  assert.match((await mk(tgz({ 'readme.txt': 'x' }), 200).addFromUrl(U, { confirm: true })).error, /plugin\.json/);
  assert.match((await mk(tgz({ 'plugin.json': JSON.stringify({ id: 'Sai Ma', version: '1.0.0' }) }), 200).addFromUrl(U, { confirm: true })).error, /Mã plugin/);
  assert.match((await mk(tgz({ 'plugin.json': JSON.stringify({ id: 'rong', name: 'r', version: '1.0.0' }) }), 200).addFromUrl(U, { confirm: true })).error, /rỗng/);
  const redir = createPlugins({ dir: t.dir, userDir: t.user, stateFile: path.join(t.data, 'w.json'), fetch: async () => ({ ok: true, status: 200, url: 'https://10.0.0.5/x', arrayBuffer: async () => Buffer.from('x') }) });
  assert.match((await redir.addFromUrl(U, { confirm: true })).error, /nội bộ/);
  assert.match((await createPlugins({ dir: t.dir, stateFile: path.join(t.data, 'n.json') }).addFromUrl(U, { confirm: true })).error, /chưa bật/);
});

test('Telegram /cho: lenh, dung (trả {run}), them <liên kết> cần bấm xác nhận, xoahan; người không phải chủ máy bị chặn', async () => {
  const t = setup(); mkPlugin(t.dir, 'ban', {}, { 'commands/bc.md': MD('Báo cáo', 'lập báo cáo', 'Báo cáo: {args}', 'kỳ') });
  const good = tgz({ 'plugin.json': JSON.stringify({ id: 'ngoai', name: 'Gói ngoài', version: '1.0.0', description: 'gói thử từ liên kết' }), 'skills/s.md': MD('KN', 'd', 'x') });
  const p = t.mk({ fetch: fakeFetch(good) }); const sent = [];
  const ui = createPluginsUi({ plugins: p, connectors: t.connectors, isAdmin: (u) => String(u) === '1', send: async (c, m) => { sent.push(typeof m === 'string' ? m : m.text); }, onChange() {} });
  assert.match(await ui.command('c', '2', 'lenh'), /Chỉ chủ máy/); assert.match(await ui.command('c', '1', 'lenh'), /Chưa có lệnh nào/);
  p.install('ban'); assert.match(await ui.command('c', '1', 'lenh'), /\/cho dung ban\/bc <kỳ>/);
  assert.deepEqual(await ui.command('c', '1', 'dung ban/bc hôm qua'), { run: 'Báo cáo: hôm qua' }); assert.match(await ui.command('c', '1', 'dung ban/khong x'), /Không có lệnh/); assert.match(await ui.command('c', '1', 'dung'), /Cách dùng/);
  const prev = await ui.command('c', '1', 'them https://github.com/x/y.tgz'); assert.match(prev.text, /Gói ngoài v1\.0\.0[\s\S]*LÀM THEO[\s\S]*chỉ thêm nếu anh tin/); assert.equal(prev.buttons[0][0].data, 'pl:url:yes');
  assert.equal(fs.existsSync(path.join(t.user, 'ngoai')), false, 'chưa bấm thì chưa thêm');
  const cq = (d) => ({ from: { id: 1 }, message: { chat: { id: 'c' } }, data: d });
  assert.match(await ui.callback(cq('pl:url:yes')), /Đã thêm/); assert.ok(fs.existsSync(path.join(t.user, 'ngoai'))); assert.match(sent.join('\n'), /Đã thêm plugin ngoai/);
  assert.match(await ui.callback(cq('pl:url:yes')), /Hết hạn/, 'bấm lại khi không còn phiên chờ');
  assert.match(await ui.command('c', '1', 'xoahan ngoai'), /Đã xóa hẳn/); assert.match(await ui.command('c', '1', 'xoahan ban'), /Chỉ xóa được plugin do chủ máy thêm/);
  assert.match((await ui.command('c', '1', 'them https://127.0.0.1/x.tgz')), /công cộng/);
});

test('danh mục có sẵn: mọi lệnh và tác nhân đều có tên + mô tả; lệnh chứa {args} hoặc là yêu cầu hoàn chỉnh', () => {
  const dir = path.join(__dirname, '..', '..', 'wizard', 'plugins'); const msgs = [];
  const p = createPlugins({ dir, stateFile: path.join(tmp(), 's.json'), log: (m) => msgs.push(m) }); const list = p.list(); assert.deepEqual(msgs, []);
  assert.ok(list.find((x) => x.id === 'ban-hang').commands.length >= 2); assert.ok(list.find((x) => x.id === 'ke-toan-co-ban').agents.length >= 1); assert.ok(list.find((x) => x.id === 'noi-dung-facebook').agents.length >= 1);
  for (const id of fs.readdirSync(dir)) for (const sub of ['commands', 'agents']) { const d = path.join(dir, id, sub); if (!fs.existsSync(d)) continue; for (const f of fs.readdirSync(d)) { const raw = fs.readFileSync(path.join(d, f), 'utf8'); assert.match(raw, /^---\nname: .+\ndescription: .+\n(args: .+\n)?---\n/, id + '/' + sub + '/' + f); assert.ok(raw.length < 3000); } }
});
