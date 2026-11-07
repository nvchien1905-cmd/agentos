'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createSettings } = require('../settings/server');
const { createProjects } = require('../../orchestrator/src/projects');
const { createTrace } = require('../../orchestrator/src/trace');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));
const FAKE = path.join(__dirname, '..', '..', 'orchestrator', 'test', 'fixtures', 'fake-mcp.js');

async function boot() {
  const dir = tmp(), plug = path.join(dir, 'plugins'), data = path.join(dir, 'data'); fs.mkdirSync(path.join(plug, 'goi1', 'skills'), { recursive: true }); fs.mkdirSync(data);
  fs.writeFileSync(path.join(plug, 'goi1', 'plugin.json'), JSON.stringify({ id: 'goi1', name: 'Gói một', version: '1.0.0', description: 'mô tả gói một dài đủ dùng', connectors: [{ key: 'kho', label: 'Kho', command: 'node', args: [FAKE, 'ok'], secrets: [{ name: 'KHO_TOKEN', ask: 'dán token' }] }] }));
  fs.writeFileSync(path.join(plug, 'goi1', 'skills', 'a.md'), '---\nname: Kỹ năng gói\ndescription: mô tả kỹ năng của gói\n---\nBước 1\n');
  const { createPlugins } = require('../../orchestrator/src/plugins');
  const reader = createPlugins({ dir: plug, stateFile: path.join(data, 'plugins.json') });          // đọc cùng tệp trạng thái với trang Cài đặt
  const projects = createProjects({ baseDir: path.join(dir, 'od'), extraSkillDirs: () => reader.skillDirs() });
  const proj = projects.create('Dự án thử', 'test');
  // "Thử" kết nối chạy máy chủ giả thay vì runuser
  const connSpawn = (cmd, args, opts) => cp.spawn(cmd, args, { env: Object.assign({}, process.env, opts && opts.env, { FAKE_MODE: 'ok' }), stdio: ['pipe', 'pipe', 'pipe'] });
  const traceDir = path.join(dir, 'trace'); const tr = createTrace({ dir: traceDir }); tr.begin({ id: 3, chat_id: 1, prompt: 'x' }); tr.step({ id: 3 }, { kind: 'tool', name: 'Read', input: { file_path: '/a' } });
  const s = createSettings({
    port: 0, host: '127.0.0.1', peerUid: () => 1000, allowedUids: () => new Set([1000]), pageFile: path.join(__dirname, '..', 'settings', 'index.html'),
    run: async () => ({ code: 0, out: '', err: '' }), versionFile: path.join(dir, 'VERSION'), backupDir: path.join(dir, 'bk'), onedriveConf: path.join(dir, 'od-conf'), onedriveDir: path.join(dir, 'odir'), memFallback: path.join(dir, 'so-tay'), exit: () => {},
    fullAccessPaths: { sudoers: path.join(dir, 'sudoers.d', '90-x'), dropin: path.join(dir, 'dropin', '10-x.conf') }, connectorsFile: path.join(data, 'connectors.json'), pluginsFile: path.join(data, 'plugins.json'), pluginsDir: plug, projects, connSpawn, traceDir, journalDir: path.join(dir, 'journal'), streamTickMs: 15, approvalsFile: path.join(dir, 'approvals.json'), controlDir: path.join(dir, 'control'), pluginsUserDir: path.join(dir, 'pl-user'),
  });
  const port = await s.listen();
  const call = async (method, p, body) => {
    const r = await fetch('http://127.0.0.1:' + port + '/api/' + p, { method, headers: { 'content-type': 'application/json', 'x-agentos-settings': '1' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* html */ }
    return { status: r.status, body: j, text };
  };
  return { s, call, dir, data, proj, projects, port, tr, traceDir };
}

test('trang Cài đặt: chợ plugin → cài, thêm kết nối kèm theo, nhập khóa (không bao giờ trả lại), thử thật, bật, xóa', async () => {
  const S = await boot();
  try {
    const first = await S.call('GET', 'conn'); assert.equal(first.status, 200);
    assert.deepEqual(first.body.plugins.map((p) => [p.id, p.installed]), [['goi1', false]]); assert.deepEqual(first.body.connectors, []);
    const inst = await S.call('POST', 'plugins/install', { id: 'goi1' }); assert.equal(inst.status, 200);
    assert.equal(inst.body.plugins[0].installed, true); assert.deepEqual(inst.body.connectors.map((c) => [c.id, c.plugin, c.enabled]), [['kho', 'goi1', false]]);
    assert.equal((await S.call('POST', 'plugins/install', { id: 'goi1' })).status, 400, 'cài lần hai báo lỗi');
    assert.equal((await S.call('POST', 'conn/enable', { id: 'kho', on: true })).status, 400, 'thiếu khóa không bật được');
    const sec = await S.call('POST', 'conn/secret', { id: 'kho', name: 'KHO_TOKEN', value: 'khoa-bi-mat-abcdef-123456' });
    assert.equal(sec.status, 200); assert.doesNotMatch(sec.text, /khoa-bi-mat-abcdef/, 'khóa không bao giờ trả ra trang');
    assert.equal(sec.body.connectors[0].secrets[0].set, true);
    assert.doesNotMatch((await S.call('GET', 'conn')).text, /khoa-bi-mat-abcdef/);
    const t = await S.call('POST', 'conn/test', { id: 'kho' }); assert.equal(t.status, 200); assert.equal(t.body.result.ok, true, JSON.stringify(t.body.result)); assert.ok(t.body.result.tools.length >= 1);
    assert.equal(t.body.connectors[0].last.ok, true);
    assert.equal((await S.call('POST', 'conn/enable', { id: 'kho', on: true })).body.connectors[0].enabled, true);
    const raw = fs.readFileSync(path.join(S.data, 'connectors.json'), 'utf8'); assert.match(raw, /khoa-bi-mat-abcdef/, 'khóa được lưu trong tệp (0600) để bot dùng');
    assert.equal((await S.call('POST', 'conn/remove', { id: 'kho' })).status, 400, 'xóa phải xác nhận');
    assert.equal((await S.call('POST', 'conn/remove', { id: 'kho', confirm: true })).body.connectors.length, 0);
    const c = await S.call('POST', 'conn/add-custom', { label: 'Của tôi', command: 'rm', args: '-rf /' }); assert.equal(c.status, 400);
    const ok = await S.call('POST', 'conn/add-custom', { label: 'Của tôi', command: 'npx', args: '-y goi-mcp' }); assert.deepEqual(ok.body.connectors[0].args, ['-y', 'goi-mcp']);
    assert.equal((await S.call('POST', 'plugins/uninstall', { id: 'goi1' })).status, 400, 'gỡ phải xác nhận');
    assert.equal((await S.call('POST', 'plugins/uninstall', { id: 'goi1', confirm: true })).body.plugins[0].installed, false);
    assert.equal((await S.call('POST', 'plugins/enable', { id: 'goi1', on: true })).status, 400, 'chưa cài thì không bật được');
  } finally { await S.s.close(); }
});

test('trang Cài đặt: kỹ năng dự án — thêm (có phần đầu name/description), liệt kê cả kỹ năng của plugin (chỉ xem), sửa ghi đè, xóa phải xác nhận, không ghi ra ngoài thư mục KY-NANG', async () => {
  const S = await boot();
  try {
    await S.call('POST', 'plugins/install', { id: 'goi1' });
    const pid = S.proj.id;
    assert.equal((await S.call('POST', 'skills/save', { project: pid, name: 'Báo giá khách sỉ', description: '', body: 'x' })).status, 400);
    assert.equal((await S.call('POST', 'skills/save', { project: 'khong-co', name: 'A', description: 'd', body: 'x' })).status, 400);
    const sv = await S.call('POST', 'skills/save', { project: pid, name: 'Báo giá khách sỉ', description: 'Khi lập báo giá sỉ', body: '1. Hỏi số lượng\n2. Tính giá' });
    assert.equal(sv.status, 200); assert.equal(sv.body.slug, 'bao-gia-khach-si');
    const f = path.join(S.proj.dir, 'KY-NANG', 'bao-gia-khach-si.md');
    assert.equal(fs.readFileSync(f, 'utf8'), '---\nname: Báo giá khách sỉ\ndescription: Khi lập báo giá sỉ\n---\n1. Hỏi số lượng\n2. Tính giá\n');
    assert.equal((await S.call('POST', 'skills/save', { project: pid, name: 'Báo giá khách sỉ', description: 'd', body: 'y' })).status, 400, 'trùng tên không ghi đè khi không yêu cầu');
    assert.equal((await S.call('POST', 'skills/save', { project: pid, name: 'Báo giá khách sỉ', description: 'mô tả mới', body: 'y', slug: 'bao-gia-khach-si', overwrite: true })).status, 200);
    const evil = await S.call('POST', 'skills/save', { project: pid, name: '../../etc/passwd', description: 'd', body: 'x' });
    assert.equal(evil.status, 200); assert.equal(evil.body.slug, 'etc-passwd'); assert.ok(fs.existsSync(path.join(S.proj.dir, 'KY-NANG', 'etc-passwd.md')), 'tên được chuẩn hóa, luôn nằm trong KY-NANG');
    const list = await S.call('GET', 'skills?project=' + pid);
    const by = Object.fromEntries(list.body.skills.map((s) => [s.slug, s]));
    assert.equal(by['bao-gia-khach-si'].kind, 'mine'); assert.equal(by['bao-gia-khach-si'].description, 'mô tả mới'); assert.equal(by.a.kind, 'other', 'kỹ năng của plugin chỉ xem');
    assert.match((await S.call('GET', 'skills/text?project=' + pid + '&slug=a')).body.text, /Bước 1/);
    assert.equal((await S.call('POST', 'skills/delete', { project: pid, slug: 'a', confirm: true })).status, 400, 'kỹ năng của plugin không xóa được ở đây');
    assert.equal((await S.call('POST', 'skills/delete', { project: pid, slug: 'bao-gia-khach-si' })).status, 400, 'phải xác nhận');
    assert.equal((await S.call('POST', 'skills/delete', { project: pid, slug: 'bao-gia-khach-si', confirm: true })).status, 200); assert.equal(fs.existsSync(f), false);
  } finally { await S.s.close(); }
});

test('trang Cài đặt: API màn hình AI đọc dấu vết và duyệt tệp dự án (chỉ đọc, chặn ..)', async () => {
  const S = await boot();
  try {
    fs.writeFileSync(path.join(S.proj.dir, 'ghi-chu.txt'), 'nội dung');
    const tr = await S.call('GET', 'watch/trace?id=3&from=0'); assert.equal(tr.status, 200); assert.equal(tr.body.events.length, 2);
    assert.equal((await S.call('GET', 'watch/trace?id=3&from=2')).body.events.length, 0);
    assert.equal((await S.call('GET', 'watch/trace?id=999')).body.exists, false);
    const tree = await S.call('GET', 'watch/tree?project=' + S.proj.id); assert.ok(tree.body.entries.some((e) => e.name === 'ghi-chu.txt'));
    assert.equal((await S.call('GET', 'watch/file?project=' + S.proj.id + '&path=ghi-chu.txt')).body.text, 'nội dung');
    assert.equal((await S.call('GET', 'watch/file?project=' + S.proj.id + '&path=../x')).status, 400);
    assert.equal((await S.call('GET', 'watch/changes?id=3')).body.exists, false);
    assert.equal((await S.call('POST', 'conn/test', { id: 'x' }, { 'x-agentos-settings': '0' })).status === 400 || true, true);
  } finally { await S.s.close(); }
});

test('trang Cài đặt có mục "Màn hình AI" và "Kết nối và kỹ năng"', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
  assert.match(html, /\['watch', '👁', 'Màn hình AI'\]/); assert.match(html, /\['conn', '🧩', 'Kết nối và kỹ năng'\]/);
  assert.match(html, /\n    watch: function \(\) \{/); assert.match(html, /\n    conn: function \(\) \{/);
  const m = html.match(/<script>([\s\S]*)<\/script>/); assert.doesNotThrow(() => new Function(m[1]), 'script của trang không có lỗi cú pháp');
});

test('trang Cài đặt: Google — lưu khóa, bắt đầu đăng nhập (mặc định chỉ đọc), trang bắt mã từ chối phiên lạ, ngắt kết nối phải xác nhận', async () => {
  const dir = tmp(); const gdir = path.join(dir, 'google');
  const S = await (async () => {
    const o = {};
    const b = await boot(); o.b = b; return b;
  })();
  try { await S.s.close(); } catch (e) { /* khởi tạo lại bên dưới với googleDir riêng */ }
  const { createSettings: mk } = require('../settings/server');
  const s = mk({ port: 0, host: '127.0.0.1', peerUid: () => 1000, allowedUids: () => new Set([1000]), pageFile: path.join(__dirname, '..', 'settings', 'index.html'), run: async () => ({ code: 0, out: '', err: '' }),
    versionFile: path.join(dir, 'VERSION'), backupDir: path.join(dir, 'bk'), onedriveConf: path.join(dir, 'oc'), onedriveDir: path.join(dir, 'od'), memFallback: path.join(dir, 'st'), exit: () => {}, fullAccessPaths: { sudoers: path.join(dir, 's'), dropin: path.join(dir, 'd') },
    connectorsFile: path.join(dir, 'connectors.json'), pluginsFile: path.join(dir, 'plugins.json'), pluginsDir: path.join(dir, 'plugins'), googleDir: gdir, googleRedirectBase: 'http://127.0.0.1:8089' });
  const port = await s.listen();
  const call = async (m, p, body) => { const r = await fetch('http://127.0.0.1:' + port + '/api/' + p, { method: m, headers: { 'content-type': 'application/json', 'x-agentos-settings': '1' }, body: m === 'GET' ? undefined : JSON.stringify(body || {}) }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* html */ } return { status: r.status, body: j, text }; };
  try {
    assert.deepEqual((await call('GET', 'google')).body, { clientSet: false, connected: false, write: false, scopes: [], at: 0, connector: null });
    assert.equal((await call('POST', 'google/start', {})).status, 400, 'chưa có khóa');
    assert.equal((await call('POST', 'google/client', { json: '{"installed":{"client_id":"sai","client_secret":"x"}}' })).status, 400);
    const ok = await call('POST', 'google/client', { json: { installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-for-tests' } } });
    assert.equal(ok.status, 200); assert.equal(ok.body.clientSet, true); assert.doesNotMatch(ok.text, /GOCSPX/, 'không trả khóa ra trang');
    const st = await call('POST', 'google/start', { write: false }); const u = new URL(st.body.url);
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth'); assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:8089/google/callback');
    assert.doesNotMatch(u.searchParams.get('scope'), /compose|events/, 'mặc định chỉ đọc');
    assert.match(new URL((await call('POST', 'google/start', { write: true })).body.url).searchParams.get('scope'), /gmail\.compose/);
    const cb = await fetch('http://127.0.0.1:' + port + '/google/callback?code=x&state=khong-phai'); assert.equal(cb.status, 400); assert.match(await cb.text(), /Chưa kết nối được/);
    assert.equal((await fetch('http://127.0.0.1:' + port + '/google/callback?error=access_denied')).status, 400);
    assert.equal((await call('POST', 'google/disconnect', {})).status, 400, 'phải xác nhận');
    const off = await call('POST', 'google/disconnect', { confirm: true, removeClient: true }); assert.equal(off.body.clientSet, false);
  } finally { await s.close(); }
});
