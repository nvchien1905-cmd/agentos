'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConnectors, handshake } = require('../src/connectors');

const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cn-'));
const run = (env, ms) => handshake({ command: 'node', args: [FAKE], env, timeoutMs: ms || 15000, secrets: Object.values(env || {}) });

test('kết nối: bắt tay MCP thật — liệt kê công cụ, bỏ qua dòng nhật ký không phải JSON, báo rõ khi máy chủ chết/treo/từ chối/không có lệnh, che khóa trong thông báo lỗi', async () => {
  const ok = await run({}); assert.ok(ok.ok); assert.equal(ok.server, 'fake-mcp'); assert.deepEqual(ok.tools, ['doc_trang', 'gui_thu', 'khong_khoa']);
  const withKey = await run({ SECRET_TOKEN: 'abc12345' }); assert.deepEqual(withKey.tools.slice(-1), ['co_khoa'], 'biến môi trường được truyền cho máy chủ');
  const noisy = await run({ FAKE_MODE: 'noisy' }); assert.ok(noisy.ok);
  const crash = await run({ FAKE_MODE: 'crash', SECRET_TOKEN: 'sk-bi-mat-123456' });
  assert.equal(crash.ok, false); assert.match(crash.error, /dừng ngay \(mã 3\)/); assert.doesNotMatch(crash.error, /sk-bi-mat-123456/); assert.match(crash.error, /\*\*\*/);
  const bad = await run({ FAKE_MODE: 'badinit', SECRET_TOKEN: 'sk-bi-mat-123456' }); assert.equal(bad.ok, false); assert.match(bad.error, /từ chối khởi tạo/); assert.doesNotMatch(bad.error, /sk-bi-mat/);
  const hang = await run({ FAKE_MODE: 'hang' }, 700); assert.equal(hang.ok, false); assert.match(hang.error, /không trả lời/);
  const none = await handshake({ command: 'lenh-khong-ton-tai-xyz', args: [], timeoutMs: 5000 }); assert.equal(none.ok, false); assert.match(none.error, /không tìm thấy lệnh/);
});

test('kết nối: thêm từ danh mục / tự thêm, đặt khóa, bật/tắt, xóa; khóa không bao giờ lộ ra danh sách; tệp lưu 0600; khởi động lại vẫn còn', async () => {
  const f = path.join(tmp(), 'sub', 'connectors.json'); let t = 1000;
  const C = createConnectors({ file: f, now: () => (t += 10) });
  assert.deepEqual(C.list(), []); assert.ok(C.catalog().find((x) => x.key === 'notion' && !x.installed));
  assert.deepEqual(C.addFromCatalog('notion'), { ok: true, id: 'notion' }); assert.equal(C.addFromCatalog('notion').ok, false); assert.equal(C.addFromCatalog('khong-co').ok, false);
  assert.ok(C.catalog().find((x) => x.key === 'notion').installed);
  assert.match(C.setEnabled('notion', true).error, /Còn thiếu: NOTION_TOKEN/);
  assert.equal(C.setSecret('notion', 'khong hop le', 'x').ok, false); assert.equal(C.setSecret('notion', 'BIEN_LA', 'x').ok, false, 'mục danh mục chỉ nhận khóa đã khai');
  assert.equal(C.setSecret('notion', 'NOTION_TOKEN', '   ').ok, false);
  assert.deepEqual(C.setSecret('notion', 'NOTION_TOKEN', 'ntn_RAT_BI_MAT_9999'), { ok: true, missing: [] });
  assert.equal(C.setEnabled('notion', true).ok, true);
  assert.doesNotMatch(JSON.stringify(C.list()), /RAT_BI_MAT/, 'danh sách không chứa giá trị khóa');
  assert.equal(C.get('notion').secrets[0].set, true); assert.equal(C.get('notion').secrets[0].value, undefined);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(C.addFromCatalog('lich').ok); C.setSecret('lich', 'GOOGLE_OAUTH_CREDENTIALS', '/home/x/gcp-oauth.keys.json');
  assert.equal(C.get('lich').secrets[0].value, '/home/x/gcp-oauth.keys.json', 'giá trị không bí mật (đường dẫn) được hiện để kiểm tra');
  const a = C.addCustom({ label: 'Kế toán Lịch!', command: 'npx', args: ['-y', 'goi-nao-do'] }), b = C.addCustom({ label: 'Kế toán Lịch!', command: 'npx', args: [] }), c = C.addCustom({ label: '2FA', command: 'uvx', args: [] });
  assert.equal(a.id, 'ketoanlich'); assert.notEqual(b.id, a.id); assert.equal(c.id, 'x2fa');
  assert.equal(C.addCustom({ label: 'x', command: 'rm', args: ['-rf', '/'] }).ok, false); assert.equal(C.addCustom({ label: '', command: 'npx' }).ok, false);
  assert.equal(C.addCustom({ label: 'y', command: 'npx', args: ['a\nb'] }).ok, false); assert.equal(C.addCustom({ label: 'y', command: 'npx', args: new Array(21).fill('a') }).ok, false);
  assert.equal(C.setSecret(a.id, 'API_KEY', 'v').ok, true, 'kết nối tự thêm nhận biến bất kỳ'); assert.deepEqual(C.get(a.id).secrets.map((s) => s.name), ['API_KEY']);
  const again = createConnectors({ file: f });
  assert.equal(again.list().length, 5); assert.equal(again.get('notion').enabled, true); assert.equal(again.get('notion').ready, true);
  assert.equal(again.remove('notion').ok, true); assert.equal(again.remove('notion').ok, false); assert.equal(createConnectors({ file: f }).get('notion'), null);
  fs.writeFileSync(f, '{hỏng'); assert.deepEqual(createConnectors({ file: f }).list(), [], 'tệp hỏng: bắt đầu trống, không ném lỗi');
});

test('kết nối: Thử chạy máy chủ thật và nhớ kết quả; apply() chỉ đưa kết nối ĐANG BẬT và đủ khóa vào tools.servers (tiền tố c_), giữ nguyên máy chủ khác, gỡ khi tắt', async () => {
  const f = path.join(tmp(), 'c.json'), C = createConnectors({ file: f, testTimeoutMs: 15000 });
  const { id } = C.addCustom({ label: 'May thu', command: 'node', args: [FAKE] });
  assert.equal((await C.test(id)).ok, true); assert.equal(C.get(id).last.ok, true); assert.deepEqual(C.get(id).last.tools, ['doc_trang', 'gui_thu', 'khong_khoa']);
  C.setSecret(id, 'SECRET_TOKEN', 'k1-khoa-that-9876'); assert.equal(C.get(id).last, null, 'đổi khóa thì kết quả thử cũ không còn đúng');
  C.setSecret(id, 'FAKE_MODE', 'crash'); const bad = await C.test(id); assert.equal(bad.ok, false); assert.equal(C.get(id).last.ok, false); assert.doesNotMatch(C.get(id).last.error, /k1-khoa-that/);
  C.setSecret(id, 'FAKE_MODE', 'ok'); assert.equal((await C.test(id)).tools.slice(-1)[0], 'co_khoa');
  const tools = { servers: { browser: { command: 'x', args: [] }, c_cu: { command: 'cu', args: [] } } };
  assert.deepEqual(C.apply(tools), [], 'chưa bật thì không đưa vào'); assert.deepEqual(Object.keys(tools.servers), ['browser'], 'gỡ máy chủ c_ cũ, giữ browser');
  C.setEnabled(id, true); assert.deepEqual(C.apply(tools), ['c_' + id]);
  assert.deepEqual(tools.servers['c_' + id], { command: 'node', args: [FAKE], env: { SECRET_TOKEN: 'k1-khoa-that-9876', FAKE_MODE: 'ok' } }); assert.ok(tools.servers.browser);
  assert.ok(C.addFromCatalog('notion').ok); C.setEnabled('notion', true); assert.equal(C.apply(tools).includes('c_notion'), false, 'thiếu khóa thì không đưa vào');
  C.setEnabled(id, false); C.apply(tools); assert.equal(tools.servers['c_' + id], undefined);
  const noTools = {}; C.setEnabled(id, true); C.apply(noTools); assert.ok(noTools.servers['c_' + id], 'tools chưa có servers vẫn chạy được');
});

test('kết nối: chờ nhập khóa theo cuộc trò chuyện, hết hạn sau 10 phút', () => {
  let t = 1_000_000; const C = createConnectors({ file: path.join(tmp(), 'c.json'), now: () => t });
  assert.equal(C.pendingOf('9'), null); C.setPending('9', 'notion', 'NOTION_TOKEN');
  assert.deepEqual(C.pendingOf(9), { id: 'notion', name: 'NOTION_TOKEN', until: 1_600_000 }); assert.equal(C.pendingOf('8'), null);
  t += 9 * 60000; assert.ok(C.pendingOf('9')); t += 2 * 60000; assert.equal(C.pendingOf('9'), null, 'hết hạn');
  C.setPending('9', 'a', 'B_C'); C.clearPending('9'); assert.equal(C.pendingOf('9'), null);
});
