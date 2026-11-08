'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createPlugins } = require('../src/plugins');
const { createConnectors } = require('../src/connectors');
const { createProjects } = require('../src/projects');
const { createSkillLayers } = require('../src/skillLayers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
const SK = (name, desc, body) => '---\nname: ' + name + '\ndescription: ' + desc + '\n---\n' + (body || 'Các bước của ' + name) + '\n';

function mk() {
  const root = tmp(), catalog = path.join(root, 'catalog'), data = path.join(root, 'data'), base = path.join(root, 'proj');
  for (const d of [catalog, data, base]) fs.mkdirSync(d);
  fs.mkdirSync(path.join(catalog, 'ban-hang', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'ban-hang', 'plugin.json'), JSON.stringify({ id: 'ban-hang', name: 'Bán hàng', version: '1.0.0' }));
  const put = (slug, text) => fs.writeFileSync(path.join(catalog, 'ban-hang', 'skills', slug + '.md'), text);
  put('bao-gia', SK('Báo giá', 'khi khách hỏi giá', 'Bản gốc v1'));
  put('chot-ca', SK('Chốt ca', 'cuối ca'));
  const connectors = createConnectors({ file: path.join(data, 'connectors.json'), log() {} });
  const plugins = createPlugins({ dir: catalog, stateFile: path.join(data, 'plugins.json'), connectors, log() {} });
  plugins.install('ban-hang');
  const notesDir = path.join(root, 'skill-notes');
  const holder = { l: null };
  const db = openDb(':memory:');
  const projects = createProjects({ db, baseDir: base, extraSkillDirs: () => plugins.skillDirs(), skillNote: (f) => (holder.l ? holder.l.noteFor(f) : null) });
  const layers = createSkillLayers({ plugins, projects, notesDir, stateFile: path.join(data, 'skill-layers.json') });
  holder.l = layers;
  const p = projects.create('Cửa hàng', '1');
  return { root, catalog, put, plugins, projects, layers, notesDir, pid: p && p.id };
}
const mineDir = (t) => path.join(t.projects.dirOf(t.pid), 'KY-NANG');

test('kỹ năng gốc của plugin hiện đúng lớp "official", chỉ đọc, kèm tên plugin', () => {
  const t = mk();
  assert.ok(t.pid, 'tạo được dự án thử');
  const a = t.layers.analyze(t.pid);
  assert.deepEqual(a.skills.map((s) => [s.name, s.layer, s.plugin]).sort(), [['Báo giá', 'official', 'ban-hang'], ['Chốt ca', 'official', 'ban-hang']]);
  assert.deepEqual(a.officialChanged, []);
});

test('ghi chú riêng: lưu ngoài bản gốc, AI được nhắc đọc kèm; xóa ghi chú = về đúng bản gốc; bản gốc không bị sửa', () => {
  const t = mk();
  const before = fs.readFileSync(path.join(t.catalog, 'ban-hang', 'skills', 'bao-gia.md'), 'utf8');
  assert.equal(t.layers.setNote('ban-hang', 'bao-gia', 'Khách sỉ giảm 5%, xưng "em" gọi "anh/chị".').ok, true);
  assert.equal(fs.readFileSync(path.join(t.catalog, 'ban-hang', 'skills', 'bao-gia.md'), 'utf8'), before, 'bản gốc nguyên vẹn');
  assert.match(t.layers.getNote('ban-hang', 'bao-gia').text, /giảm 5%/);
  const row = t.layers.analyze(t.pid).skills.find((s) => s.slug === 'bao-gia');
  assert.equal(row.hasNote, true);
  const extras = t.projects.instructions(t.pid);
  assert.match(extras, /CÓ GHI CHÚ RIÊNG/); assert.match(extras, /skill-notes/);
  const other = extras.split('\n').find((l) => /Chốt ca/.test(l)); assert.doesNotMatch(other, /GHI CHÚ RIÊNG/, 'chỉ kỹ năng có ghi chú mới được nhắc');
  assert.equal(t.layers.setNote('ban-hang', 'bao-gia', '   ').cleared, true);
  assert.equal(t.layers.analyze(t.pid).skills.find((s) => s.slug === 'bao-gia').hasNote, false);
  assert.doesNotMatch(t.projects.instructions(t.pid), /CÓ GHI CHÚ RIÊNG/);
});

test('ghi chú: chặn tên lạ (đi ra ngoài thư mục), kỹ năng không tồn tại, quá dài', () => {
  const t = mk();
  assert.equal(t.layers.setNote('ban-hang', '../../etc/passwd', 'x').ok, false);
  assert.equal(t.layers.setNote('../x', 'bao-gia', 'x').ok, false);
  assert.equal(t.layers.setNote('ban-hang', 'khong-co', 'x').ok, false);
  assert.equal(t.layers.setNote('ban-hang', 'bao-gia', 'a'.repeat(4001)).ok, false);
  assert.equal(t.layers.getNote('ban-hang', '../../x').text, '');
  assert.equal(fs.existsSync(t.notesDir), false, 'không tạo gì khi bị từ chối');
});

test('kỹ năng của dự án trùng tên bản gốc: được báo là ĐÈ; bản gốc đổi sau đó thì báo "đã cập nhật"', () => {
  const t = mk();
  fs.mkdirSync(mineDir(t), { recursive: true });
  fs.writeFileSync(path.join(mineDir(t), 'bao-gia-cua-toi.md'), SK('Báo giá', 'bản của chủ', 'Giá tôi tự đặt'));
  let a = t.layers.analyze(t.pid);
  const mine = a.skills.find((s) => s.layer === 'custom');
  assert.equal(mine.name, 'Báo giá'); assert.equal(mine.overrides.plugin, 'ban-hang'); assert.equal(mine.overrides.officialChanged, false);
  assert.deepEqual(a.hidden.map((h) => h.slug), ['bao-gia']);
  assert.equal(a.skills.filter((s) => s.name === 'Báo giá').length, 1, 'chỉ một bản có hiệu lực (của chủ)');
  // AgentOS cập nhật bản gốc
  t.put('bao-gia', SK('Báo giá', 'khi khách hỏi giá', 'Bản gốc v2 — có quy định mới'));
  a = t.layers.analyze(t.pid);
  assert.equal(a.skills.find((s) => s.layer === 'custom').overrides.officialChanged, true);
  assert.deepEqual(a.officialChanged, ['Báo giá']);
  assert.deepEqual(t.layers.staleOverrides().map((x) => x.names), [['Báo giá']]);
});

test('"Dùng bản gốc": cất bản của chủ vào .da-thay-the (không xóa), bản gốc có hiệu lực lại, hết cảnh báo', () => {
  const t = mk();
  fs.mkdirSync(mineDir(t), { recursive: true });
  const f = path.join(mineDir(t), 'bao-gia-cua-toi.md');
  fs.writeFileSync(f, SK('Báo giá', 'bản của chủ', 'Giá tôi tự đặt'));
  t.layers.analyze(t.pid);
  t.put('bao-gia', SK('Báo giá', 'khi khách hỏi giá', 'Bản gốc v2'));
  const r = t.layers.useOfficial(t.pid, 'Báo giá');
  assert.equal(r.ok, true); assert.equal(r.plugin, 'ban-hang');
  assert.equal(fs.existsSync(f), false);
  assert.match(fs.readFileSync(r.backup, 'utf8'), /Giá tôi tự đặt/, 'bản của chủ còn nguyên trong bản cất');
  assert.match(r.backup, /\.da-thay-the/);
  const a = t.layers.analyze(t.pid);
  const row = a.skills.find((s) => s.name === 'Báo giá');
  assert.equal(row.layer, 'official'); assert.deepEqual(a.officialChanged, []); assert.deepEqual(a.hidden, []);
  assert.equal(t.layers.useOfficial(t.pid, 'Báo giá').ok, false, 'không còn gì để chuyển');
  assert.equal(t.layers.useOfficial('khong-co', 'x').ok, false);
});

test('kỹ năng tự viết KHÔNG trùng tên bản gốc: là "của chủ", không đè, không cảnh báo', () => {
  const t = mk();
  fs.mkdirSync(mineDir(t), { recursive: true });
  fs.writeFileSync(path.join(mineDir(t), 'rieng.md'), SK('Việc riêng của tôi', 'x'));
  const a = t.layers.analyze(t.pid);
  const row = a.skills.find((s) => s.name === 'Việc riêng của tôi');
  assert.equal(row.layer, 'custom'); assert.equal(row.overrides, null); assert.deepEqual(a.officialChanged, []);
});

test('plugin bị tắt: kỹ năng gốc biến mất khỏi danh sách và không ghi chú được', () => {
  const t = mk();
  t.plugins.setEnabled('ban-hang', false);
  assert.deepEqual(t.layers.analyze(t.pid).skills, []);
  assert.equal(t.layers.setNote('ban-hang', 'bao-gia', 'x').ok, false);
});

// ----- Telegram: /kynang hiện lớp, ghichu, goc -----
const { createSkillsUi } = require('../src/skillsUi');
function mkUi() {
  const t = mk();
  t.projects.setActive ? t.projects.setActive('9', t.pid) : null;
  const ui = createSkillsUi({ projects: t.projects, isAdmin: (u) => String(u) === '1', layers: t.layers });
  return Object.assign(t, { ui });
}

test('Telegram /kynang: danh sách ghi rõ kỹ năng GỐC (🔒) và hướng dẫn ghi chú riêng', async () => {
  const t = mkUi();
  const c = await t.ui.command('9', '1', '');
  assert.match(c.text, /Báo giá.*🔒 gốc AgentOS/); assert.match(c.text, /\/kynang ghichu/);
});

test('Telegram /kynang ghichu: thêm / xem / xóa; chỉ chủ máy; kỹ năng không phải gốc bị từ chối', async () => {
  const t = mkUi();
  assert.match(await t.ui.command('9', '1', 'ghichu Báo giá | Khách sỉ giảm 5%'), /Đã lưu ghi chú/);
  assert.match((await t.ui.command('9', '1', '')).text, /📝 ghi chú của anh/);
  assert.match(await t.ui.command('9', '1', 'ghichu Báo giá'), /Khách sỉ giảm 5%/);
  assert.match(await t.ui.command('9', '1', 'ghichu xoa Báo giá'), /dùng đúng bản gốc/);
  assert.match(await t.ui.command('9', '1', 'ghichu Báo giá'), /Chưa có ghi chú/);
  assert.match(await t.ui.command('9', '1', 'ghichu Không có | x'), /Không có kỹ năng GỐC/);
  assert.match(await t.ui.command('9', '2', 'ghichu Báo giá | hack'), /Chỉ chủ máy|Chưa|Anh đang ở chế độ chung|chưa có quyền/);
  assert.equal(t.layers.getNote('ban-hang', 'bao-gia').text, '');
});

test('Telegram: kỹ năng của chủ đè bản gốc đã cập nhật -> cảnh báo trong danh sách; /kynang goc lấy bản gốc', async () => {
  const t = mkUi();
  fs.mkdirSync(mineDir(t), { recursive: true });
  fs.writeFileSync(path.join(mineDir(t), 'gia.md'), SK('Báo giá', 'bản của chủ'));
  await t.ui.command('9', '1', '');
  t.put('bao-gia', SK('Báo giá', 'khi khách hỏi giá', 'Bản gốc v2'));
  const c = await t.ui.command('9', '1', '');
  assert.match(c.text, /ĐÈ bản gốc/); assert.match(c.text, /bản gốc đã cập nhật/);
  assert.match(await t.ui.command('9', '1', 'goc Báo giá'), /Đã chuyển.*bản gốc/);
  assert.match((await t.ui.command('9', '1', '')).text, /Báo giá.*🔒 gốc AgentOS/);
  assert.match(await t.ui.command('9', '1', 'goc Báo giá'), /không đè/);
});
