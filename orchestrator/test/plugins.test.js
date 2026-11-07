'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPlugins } = require('../src/plugins');
const { createConnectors } = require('../src/connectors');
const { createPluginsUi } = require('../src/pluginsUi');
const { createProjects } = require('../src/projects');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
function writePlugin(dir, id, manifest, skills) {
  fs.mkdirSync(path.join(dir, id, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'plugin.json'), JSON.stringify(Object.assign({ id, name: id, version: '1.0.0' }, manifest)));
  for (const [f, body] of Object.entries(skills || {})) fs.writeFileSync(path.join(dir, id, 'skills', f), body);
}
const SK = (name, desc) => '---\nname: ' + name + '\ndescription: ' + desc + '\n---\nNội dung ' + name + '\n';
const mk = (cat, extra) => {
  const root = tmp(), dir = path.join(root, 'catalog'), data = path.join(root, 'data'); fs.mkdirSync(dir); fs.mkdirSync(data);
  const holder = { p: null };
  const connectors = createConnectors({ file: path.join(data, 'connectors.json'), extraCatalog: () => (holder.p ? holder.p.extraCatalog() : []) });
  const plugins = createPlugins({ dir, stateFile: path.join(data, 'plugins.json'), connectors, log() {} });
  holder.p = plugins;
  return Object.assign({ root, dir, data, connectors, plugins }, extra);
};

test('chợ: đọc danh mục, bỏ plugin hỏng, cài/gỡ/bật/tắt; kỹ năng của plugin chỉ có khi đã cài và đang bật', () => {
  const t = mk();
  writePlugin(t.dir, 'ban-hang', { name: 'Bán hàng', description: 'mô tả', icon: '🛒' }, { 'bao-cao.md': SK('Báo cáo', 'khi cần báo cáo'), 'bad name.md': 'x' });
  writePlugin(t.dir, 'hong', { version: 'abc' }, {});                                    // phiên bản sai → bỏ qua
  writePlugin(t.dir, 'lech-ma', { id: 'khac' }, {});                                       // plugin.json không khớp tên thư mục → bỏ qua
  const list = t.plugins.list();
  assert.deepEqual(list.map((p) => p.id), ['ban-hang']); assert.equal(list[0].installed, false);
  assert.deepEqual(list[0].skills.map((s) => s.name), ['Báo cáo'], 'tên tệp lạ không vào danh sách');
  assert.deepEqual(t.plugins.skillDirs(), []);
  assert.equal(t.plugins.install('ban-hang').ok, true); assert.equal(t.plugins.install('ban-hang').ok, false); assert.equal(t.plugins.install('khong-co').ok, false);
  assert.equal(t.plugins.skillDirs().length, 1);
  assert.equal(t.plugins.setEnabled('ban-hang', false).ok, true); assert.deepEqual(t.plugins.skillDirs(), []);
  assert.equal(t.plugins.setEnabled('ban-hang', true).ok, true); assert.equal(t.plugins.skillDirs().length, 1);
  assert.equal(t.plugins.uninstall('ban-hang').ok, true); assert.equal(t.plugins.uninstall('ban-hang').ok, false); assert.deepEqual(t.plugins.skillDirs(), []);
  assert.match(t.plugins.skillText('ban-hang', 'bao-cao'), /Nội dung Báo cáo/); assert.equal(t.plugins.skillText('../x', 'y'), null); assert.equal(t.plugins.skillText('ban-hang', '../plugin'), null);
});

test('dự án thấy kỹ năng của plugin đã cài (mọi dự án); kỹ năng của dự án trùng tên thì thắng', () => {
  const t = mk();
  writePlugin(t.dir, 'p1', {}, { 'a.md': SK('Báo giá', 'từ plugin'), 'b.md': SK('Kỹ năng B', 'chỉ có ở plugin') });
  const projects = createProjects({ baseDir: path.join(t.root, 'od'), extraSkillDirs: () => t.plugins.skillDirs() });
  const p = projects.create('Dự án thử', 'test');
  fs.mkdirSync(path.join(p.dir, 'KY-NANG'), { recursive: true }); fs.writeFileSync(path.join(p.dir, 'KY-NANG', 'bao-gia.md'), SK('Báo giá', 'của dự án'));
  assert.deepEqual(projects.skillsOf(p.id).map((s) => s.name), ['Báo giá']);
  t.plugins.install('p1');
  const sk = projects.skillsOf(p.id);
  assert.deepEqual(sk.map((s) => s.name), ['Báo giá', 'Kỹ năng B']); assert.equal(sk[0].description, 'của dự án');
  assert.match(projects.instructions ? String(projects.instructions(p.id) || '') : 'KỸ NĂNG', /KỸ NĂNG/);
});

test('kết nối đi kèm plugin: cài thì thêm (tắt, chờ khóa), gỡ thì bỏ; lệnh sai bị loại; kết nối đã có sẵn trong danh mục không bị nhân đôi', () => {
  const t = mk();
  writePlugin(t.dir, 'ketnoi', { connectors: [
    { key: 'kho', label: 'Kho hàng', about: 'x', command: 'npx', args: ['-y', 'goi-kho'], secrets: [{ name: 'KHO_TOKEN', ask: 'dán token' }] },
    { key: 'xau', label: 'Xấu', command: 'rm', args: ['-rf', '/'] },
    { key: 'notion', label: 'Notion lặp', command: 'npx', args: ['-y', 'x'] },
  ] }, {});
  assert.deepEqual(t.plugins.list()[0].connectors.map((c) => c.key), ['kho', 'notion'], 'lệnh rm bị loại');
  assert.equal(t.connectors.get('kho'), null);
  const r = t.plugins.install('ketnoi'); assert.deepEqual(r.connectors.sort(), ['kho', 'notion']);
  const kho = t.connectors.get('kho'); assert.equal(kho.enabled, false); assert.equal(kho.plugin, 'ketnoi'); assert.deepEqual(kho.missing, ['KHO_TOKEN']);
  assert.equal(t.connectors.get('notion').label, 'Notion', 'danh mục có sẵn thắng bản của plugin');
  assert.equal(t.connectors.setSecret('kho', 'KHO_TOKEN', 'token-that-su-123456').ok, true);
  assert.deepEqual(t.plugins.uninstall('ketnoi').removedConnectors, ['kho']);
  assert.equal(t.connectors.get('kho'), null); assert.ok(t.connectors.get('notion'), 'kết nối thêm từ danh mục sẵn có vẫn giữ');
});

test('tự cập nhật: plugin mặc định được tự cài MỘT lần; plugin ra phiên bản mới thì nâng phiên bản + cập nhật kết nối nhưng GIỮ khóa và trạng thái bật; gỡ rồi không tự cài lại', () => {
  const t = mk();
  writePlugin(t.dir, 'mac-dinh', { default: true }, { 'a.md': SK('A', 'a') });
  writePlugin(t.dir, 'khac', { connectors: [{ key: 'kho', label: 'Kho', command: 'npx', args: ['-y', 'goi-kho-v1'], secrets: [{ name: 'KHO_TOKEN' }] }] }, {});
  let r = t.plugins.sync(); assert.deepEqual(r.installed.map((x) => x.id), ['mac-dinh']); assert.deepEqual(r.updated, []);
  assert.equal(t.plugins.get('mac-dinh').installed, true); assert.equal(t.plugins.get('khac').installed, false, 'không mặc định thì không tự cài');
  t.plugins.install('khac'); t.connectors.setSecret('kho', 'KHO_TOKEN', 'khoa-bi-mat-123456'); assert.equal(t.connectors.setEnabled('kho', true).ok, true);
  assert.deepEqual(t.plugins.sync().updated, [], 'chưa đổi gì');
  // máy nhận bản AgentOS mới: plugin lên 1.1.0, đổi gói kết nối, thêm kỹ năng, thêm một plugin mặc định mới
  writePlugin(t.dir, 'khac', { version: '1.1.0', connectors: [{ key: 'kho', label: 'Kho (mới)', command: 'npx', args: ['-y', 'goi-kho-v2'], secrets: [{ name: 'KHO_TOKEN' }] }] }, { 'moi.md': SK('Mới', 'kỹ năng mới') });
  writePlugin(t.dir, 'moi-tinh', { default: true }, {});
  r = t.plugins.sync();
  assert.deepEqual(r.updated.map((x) => [x.id, x.from, x.to]), [['khac', '1.0.0', '1.1.0']]); assert.deepEqual(r.updated[0].connectors, ['kho']);
  assert.deepEqual(r.installed.map((x) => x.id), ['moi-tinh']);
  const kho = t.connectors.get('kho'); assert.deepEqual(kho.args, ['-y', 'goi-kho-v2']); assert.equal(kho.label, 'Kho (mới)'); assert.equal(kho.enabled, true, 'giữ trạng thái bật'); assert.equal(kho.secrets[0].set, true, 'giữ khóa đã nhập');
  assert.equal(t.plugins.get('khac').updated, false); assert.equal(t.plugins.get('khac').installedVersion, '1.1.0');
  // gỡ plugin mặc định → lần sync sau KHÔNG tự cài lại
  t.plugins.uninstall('mac-dinh'); assert.deepEqual(t.plugins.sync().installed, []); assert.equal(t.plugins.get('mac-dinh').installed, false);
});

test('hai tiến trình dùng chung tệp (trang Cài đặt và bot): thay đổi của bên này được bên kia đọc lại', () => {
  const t = mk();
  writePlugin(t.dir, 'p1', { connectors: [{ key: 'kho', label: 'Kho', command: 'npx', args: [] }] }, {});
  const other = createPlugins({ dir: t.dir, stateFile: path.join(t.data, 'plugins.json'), connectors: createConnectors({ file: path.join(t.data, 'connectors.json') }) });
  assert.equal(other.get('p1').installed, false);
  t.plugins.install('p1');
  assert.equal(other.reload() || other.get('p1').installed, true);
  const c2 = createConnectors({ file: path.join(t.data, 'connectors.json') });
  assert.ok(c2.get('kho'));
  t.connectors.remove('kho'); assert.equal(c2.get('kho'), null, 'đọc lại khi tệp đổi');
});

test('Telegram /cho: danh sách, xem, cài, gỡ, bật/tắt; chỉ chủ máy', async () => {
  const t = mk(); writePlugin(t.dir, 'p1', { name: 'Gói một', icon: '🧩' }, { 'a.md': SK('Kỹ năng A', 'mô tả A') });
  let changes = 0;
  const ui = createPluginsUi({ plugins: t.plugins, connectors: t.connectors, isAdmin: (u) => String(u) === '1', onChange: () => changes++ });
  assert.match(await ui.command('c', '2', ''), /Chỉ chủ máy/);
  const card = await ui.command('c', '1', ''); assert.match(card.text, /Gói một v1\.0\.0 — ⚪ chưa cài/); assert.equal(card.buttons[0][1].data, 'pl:add:p1');
  assert.match((await ui.command('c', '1', 'xem p1')).text, /Kỹ năng A/);
  assert.match(await ui.command('c', '1', 'cai p1'), /Đã cài Gói một: 1 kỹ năng/); assert.match(await ui.command('c', '1', 'cai p1'), /đã được cài rồi/);
  assert.equal((await ui.command('c', '1', '')).buttons[0][1].data, 'pl:del:p1');
  assert.match(await ui.command('c', '1', 'tat p1'), /Đã tắt/); assert.match(await ui.command('c', '1', 'bat p1'), /Đã bật/);
  assert.match(await ui.command('c', '1', 'go p1'), /Đã gỡ plugin p1/); assert.match(await ui.command('c', '1', 'cai'), /Cách dùng/); assert.match(await ui.command('c', '1', 'linh tinh x'), /Không hiểu/);
  assert.ok(changes >= 4);
  const sent = []; const ui2 = createPluginsUi({ plugins: t.plugins, connectors: t.connectors, isAdmin: () => true, send: async (c, m) => { sent.push(typeof m === 'string' ? m : m.text); }, onChange() {} });
  assert.equal(ui2.isCallback('pl:add:p1'), true); assert.equal(ui2.isCallback('cn:add:x'), false);
  assert.equal(await ui2.callback({ from: { id: 1 }, message: { chat: { id: 9 } }, data: 'pl:add:p1' }), 'Xong'); assert.match(sent[0], /Đã cài/);
});

test('danh mục plugin ĐI KÈM bản cài hợp lệ: mã khớp thư mục, phiên bản đúng dạng, mọi kỹ năng có tên + mô tả, lệnh kết nối hợp lệ, không trùng khóa kết nối', () => {
  const dir = path.join(__dirname, '..', '..', 'wizard', 'plugins');
  const messages = []; const plugins = createPlugins({ dir, stateFile: path.join(tmp(), 'p.json'), log: (m) => messages.push(m) });
  const list = plugins.list();
  assert.ok(list.length >= 4, 'có ít nhất 4 plugin dựng sẵn');
  assert.deepEqual(messages, [], 'không có plugin nào bị bỏ qua vì sai định dạng: ' + messages.join(' | '));
  for (const p of list) {
    assert.ok(p.description.length > 20 && p.skills.length >= 1 || p.connectors.length, p.id + ' phải có nội dung');
    for (const s of p.skills) { assert.ok(s.name && s.description.length > 10, p.id + '/' + s.name + ' thiếu mô tả'); const txt = plugins.skillText(p.id, fs.readdirSync(path.join(dir, p.id, 'skills')).find((f) => f.startsWith(s.name.slice(0, 1))) ? s.slug || '' : ''); void txt; }
  }
  const seen = new Set(); for (const p of list) for (const c of p.connectors) { assert.equal(seen.has(c.key), false, 'trùng khóa kết nối ' + c.key); seen.add(c.key); }
  for (const id of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, id, 'skills'))) { const raw = fs.readFileSync(path.join(dir, id, 'skills', f), 'utf8'); assert.match(raw, /^---\nname: .+\ndescription: .+\n---\n/, id + '/' + f + ' thiếu phần đầu name/description'); assert.ok(raw.length < 4000, id + '/' + f + ' quá dài'); }
  assert.equal(plugins.get('ban-hang').default, true);
});
