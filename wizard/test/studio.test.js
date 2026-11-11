'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createStudio } = require('../lib/studio');
const { createSettings } = require('../settings/server');

let Database = null; try { Database = require('better-sqlite3'); } catch (e) { try { Database = require('../../orchestrator/node_modules/better-sqlite3'); } catch (e2) { /* Windows dev */ } }
const dbTest = (name, fn) => test(name, { skip: !Database && 'thiếu better-sqlite3' }, fn);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-'));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500, 7)]).toString('base64');
const geminiFetch = (log) => async (url, init) => { log.push({ url, init }); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }] }) }; };
const officeExec = (calls) => async (args) => { calls.push(args); const out = args[args.indexOf('--out') + 1]; fs.writeFileSync(out, 'FILE'); return { code: 0, out: '', err: '' }; };

test('xưởng: tạo ảnh lưu vào thư mục xưởng, liệt kê, xem, sửa ảnh gửi ảnh gốc, xóa; tên tệp thoát thư mục bị chặn', async () => {
  const dir = tmp(), log = [];
  const S = createStudio({ dir, keys: () => ({ gemini: 'KEY' }), fetch: geminiFetch(log), now: () => 1700000000000 });
  let l = S.list(); assert.equal(l.providers.find((p) => p.id === 'gemini').ready, true); assert.equal(l.providers.find((p) => p.id === 'openai').ready, false); assert.equal(l.images.length, 0);
  const r = await S.image({ prompt: 'poster khuyến mại', size: 'ngang', provider: 'auto' });
  assert.match(r.name, /^anh-1700000000000-gemini\.png$/); l = S.list(); assert.deepEqual(l.images.map((x) => x.name), [r.name]);
  const f = S.fileData(r.name); assert.equal(f.kind, 'image'); assert.match(f.dataUrl, /^data:image\/png;base64,/);
  assert.ok(S.fileData(r.name, true).base64.length > 100);
  const e = await S.image({ prompt: 'đổi nền xanh', editOf: r.name }); assert.equal(e.edited, true); assert.equal(JSON.parse(log[1].init.body).contents[0].parts.length, 2);
  for (const bad of ['../etc/passwd', '..\\x', '/etc/passwd', '.hidden', 'a/b.png', '']) { assert.throws(() => S.fileData(bad), /không hợp lệ/, bad); assert.throws(() => S.remove(bad), /không hợp lệ/, bad); }
  await assert.rejects(() => S.image({ prompt: 'x', editOf: '../x.png' }), /không hợp lệ/);
  assert.deepEqual(S.remove(r.name), { removed: true }); assert.deepEqual(S.remove(r.name), { removed: false });
  const none = createStudio({ dir, keys: () => ({}), fetch: geminiFetch([]) }); await assert.rejects(() => none.image({ prompt: 'a' }), /Chưa có khóa API/);
});

test('xưởng: thư mục và mọi tệp tạo ra đều được chuyển cho người dùng agentos (trang Cài đặt chạy bằng root, bot cần ghi chung vào đó)', async () => {
  const dir = path.join(tmp(), 'studio'), owned = [];
  const S = createStudio({ dir, keys: () => ({ gemini: 'K' }), fetch: geminiFetch([]), exec: officeExec([]), chown: (p) => owned.push(p) });
  assert.deepEqual(owned, [dir]);
  const img = await S.image({ prompt: 'a' }); const d = S.saveDraft(null, { title: 'x', blocks: [{ t: 'p', text: 'y' }] }); const f = await S.build({ title: 'x', blocks: [{ t: 'p', text: 'y' }] });
  for (const n of [img.name, d.name, f.name]) assert.ok(owned.includes(path.join(dir, n)), n);
});

test('xưởng: soạn tài liệu — mẫu, lưu/mở bản nháp, xem trước (ảnh nhúng, chữ nguy hiểm bị thoát), tạo tệp, Markdown', async () => {
  const dir = tmp(), calls = [];
  const S = createStudio({ dir, keys: () => ({ gemini: 'K' }), fetch: geminiFetch([]), exec: officeExec(calls), now: () => 1700000000123 });
  const img = await S.image({ prompt: 'logo' });
  for (const t of S.TEMPLATES) { const d = S.template(t.id); assert.ok(d.title); assert.equal(require('../../orchestrator/src/docgen').normalize(d).errors.length, 0, t.id); }
  assert.throws(() => S.template('khong-co'), /Không có mẫu/);
  const doc = { type: 'docx', title: 'Báo giá <b>tháng 11</b>', blocks: [{ t: 'h2', text: 'Mục 1' }, { t: 'p', text: 'Xin chào **quý khách**' }, { t: 'img', path: img.name, caption: 'Logo' }, { t: 'img', path: '../../etc/passwd' }] };
  const html = S.preview(doc);
  assert.match(html, /<img src="data:image\/png;base64,/); assert.ok(!/etc\/passwd/.test(html)); assert.ok(!/<b>tháng 11<\/b>/.test(html)); assert.match(html, /&lt;b&gt;tháng 11/);
  const saved = S.saveDraft(null, doc); assert.match(saved.name, /^bao-gia-b-thang-11-b-\d{6}\.json$/); assert.equal(saved.type, 'docx');
  const back = S.getDraft(saved.name); assert.equal(back.title, doc.title); assert.equal(back.blocks.find((b) => b.t === 'img').path, img.name);       // ảnh giữ theo tên, không lộ đường dẫn đầy đủ
  assert.equal(S.saveDraft(saved.name, Object.assign({}, doc, { title: 'Đổi tên' })).name, saved.name);                                                      // lưu đè đúng bản nháp
  assert.equal(S.getDraft(saved.name).title, 'Đổi tên'); assert.throws(() => S.getDraft(img.name), /Không phải bản nháp/);
  assert.ok(S.list().drafts.some((d) => d.name === saved.name && d.title === 'Đổi tên'));
  const b = await S.build(doc, saved.name);
  assert.match(b.name, /\.docx$/); assert.ok(fs.existsSync(path.join(dir, b.name))); const spec = calls[0]; assert.equal(spec[0], 'create'); assert.equal(spec[1], 'docx');
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.spec.json')));
  assert.ok(S.list().files.some((f) => f.name === b.name));
  const md = S.fromMarkdown('# Tiêu đề\n\n## Mục\n\n- a\n- b\n', 'pdf'); assert.equal(md.type, 'pdf'); assert.equal(md.title, 'Tiêu đề'); assert.deepEqual(md.blocks.map((x) => x.t), ['h2', 'ul']);
  assert.throws(() => S.fromMarkdown('x'.repeat(200001)), /dài quá/);
  const x = await S.build({ type: 'xlsx', title: 'Bảng', sheets: [{ name: 'T', rows: [['a', 'b'], [1, 2]] }] }); assert.match(x.name, /\.xlsx$/);
  await assert.rejects(() => S.build({ type: 'docx', title: 'Rỗng', blocks: [] }), /chưa có nội dung/);
  const fail = createStudio({ dir, keys: () => ({}), exec: async () => ({ code: 1, err: 'LỖI: thiếu python-docx' }) }); await assert.rejects(() => fail.build({ type: 'docx', title: 'a', blocks: [{ t: 'p', text: 'x' }] }), /thiếu python-docx/);
});

// ---- qua máy chủ Cài đặt ----
async function boot(dir, extra) {
  const envFile = path.join(dir, 'orchestrator.env');
  fs.writeFileSync(envFile, 'TELEGRAM_TOKEN=123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw\nALLOWED_USER_IDS=5\nADMIN_USER_IDS=5\nAGENTOS_KEY_GEMINI=KEY-ENV\n');
  fs.writeFileSync(path.join(dir, 'VERSION'), '1\n');
  const s = createSettings(Object.assign({ port: 0, host: '127.0.0.1', envFile, versionFile: path.join(dir, 'VERSION'), backupDir: path.join(dir, 'bk'), onedriveConf: path.join(dir, 'od'), onedriveDir: path.join(dir, 'odir'), memFallback: path.join(dir, 'so-tay'), peerUid: () => 1000, allowedUids: () => new Set([1000, 0]), pageFile: path.join(__dirname, '..', 'settings', 'index.html'), exit: () => {}, run: async () => ({ code: 0, out: 'active\n', err: '' }), spawn: () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; setImmediate(() => c.emit('close', 0)); return c; } }, extra || {}));
  const port = await s.listen();
  const call = async (method, p, body) => { const r = await fetch('http://127.0.0.1:' + port + '/api/' + p, { method, headers: { 'content-type': 'application/json', 'x-agentos-settings': '1' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* html */ } return { status: r.status, body: j, text }; };
  return { s, call };
}

test('Cài đặt: các đường /api/studio/* — lấy khóa Gemini từ tệp cấu hình, tạo ảnh, soạn và xuất tài liệu, xóa; tên xấu bị từ chối', async () => {
  const dir = tmp(), log = [], calls = [];
  const S = await boot(dir, { boardMainDir: dir, fetch: geminiFetch(log), officeExec: officeExec(calls) });
  try {
    let r = await S.call('GET', 'studio'); assert.equal(r.status, 200); assert.equal(r.body.providers.find((p) => p.id === 'gemini').ready, true); assert.ok(r.body.templates.length >= 5);
    r = await S.call('POST', 'studio/image', { prompt: 'banner', size: 'doc' }); assert.equal(r.status, 200, r.text); const name = r.body.name; assert.equal(log[0].init.headers['x-goog-api-key'], 'KEY-ENV');
    r = await S.call('GET', 'studio/file?name=' + name); assert.equal(r.status, 200); assert.match(r.body.dataUrl, /^data:image\/png/);
    r = await S.call('GET', 'studio/file?name=' + encodeURIComponent('../orchestrator.env')); assert.equal(r.status >= 400, true);
    r = await S.call('GET', 'studio/template?id=chamcong'); assert.equal(r.body.doc.type, 'xlsx');
    const doc = r.body.doc;
    r = await S.call('POST', 'studio/preview', { doc }); assert.equal(r.status, 200); assert.match(r.body.html, /<table>/);
    r = await S.call('POST', 'studio/draft', { doc }); assert.equal(r.status, 200); const dn = r.body.name;
    r = await S.call('GET', 'studio/draft?name=' + dn); assert.equal(r.body.doc.sheets[0].rows[3][1], '=SUM(B2:B3)');
    r = await S.call('POST', 'studio/build', { doc, draft: dn }); assert.equal(r.status, 200, r.text); assert.match(r.body.name, /\.xlsx$/);
    r = await S.call('POST', 'studio/from-md', { md: '# Tên\n\nĐoạn', type: 'docx' }); assert.equal(r.body.doc.title, 'Tên');
    r = await S.call('POST', 'studio/image', { prompt: '' }); assert.equal(r.status >= 400, true);
    r = await S.call('POST', 'studio/delete', { name: name }); assert.equal(r.body.removed, true);
    // tài liệu dài hơn 64 KB vẫn nhận được trên đường studio
    r = await S.call('POST', 'studio/preview', { doc: { title: 'dài', blocks: [{ t: 'p', text: 'x'.repeat(19000) }, { t: 'p', text: 'y'.repeat(19000) }, { t: 'p', text: 'z'.repeat(19000) }, { t: 'p', text: 'w'.repeat(19000) }] } }); assert.equal(r.status, 200);
  } finally { await S.s.close(); }
});

test('Cài đặt: trang có tab Xưởng sáng tạo và ô tìm kiếm, mã trang chạy được và viết kiểu ES5', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
  assert.match(html, /\['studio', '🎨', 'Xưởng sáng tạo'\]/); assert.match(html, /data-tab="find">🔎 Tìm kiếm/); assert.match(html, /board\/search\?bot=/);
  const code = html.match(/<script>([\s\S]*)<\/script>/)[1]; new Function(code);
  const parts = [code.slice(code.indexOf('studio: function'), code.indexOf('// ===== Bảng điều khiển từng bot')), code.slice(code.indexOf('function findTab'), code.indexOf('function memTab'))];
  for (const seg of parts) { assert.ok(seg.length > 2000); assert.ok(!/=>/.test(seg), 'không dùng mũi tên'); assert.ok(!/\b(let|const)\b/.test(seg), 'không let/const'); assert.ok(!/`/.test(seg), 'không template'); assert.ok(!/\?\./.test(seg) && !/\?\?/.test(seg)); assert.ok(!/\b(alert|prompt)\(/.test(seg.replace(/placeholder/g, ''))); }
});

// ---- tìm trong cơ sở dữ liệu của bot (đọc thôi) ----
function seedBot(root, key, rows) {
  const dataDir = key === 'main' ? path.join(root, 'main-data') : path.join(root, 'agents', key, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const { openDb } = require('../../orchestrator/src/db'); const db = openDb(path.join(dataDir, 'agentos.db'));
  for (const r of rows) { const id = db.addJob(r.chat, r.prompt, null, null, 'main', r.project || null); db.finishJob(id, r.status || 'done', { result: r.result || null, error: r.error || null }); }
  db.close();
}
dbTest('bảng điều khiển: tìm trong MỘT bot hoặc TẤT CẢ bot, kèm sổ tay và bài học; lọc theo trạng thái; không có dữ liệu thì không lỗi', async () => {
  const { createBotBoard } = require('../lib/botboard');
  const root = tmp();
  seedBot(root, 'main', [{ chat: '1', prompt: 'Nồi chiên giá bao nhiêu', result: 'Giá 1.590.000đ' }, { chat: '1', prompt: 'Việc lỗi nồi', status: 'error', error: 'x' }]);
  seedBot(root, 'a1', [{ chat: '9', prompt: 'Khách hỏi nồi cơm điện', result: 'Còn 3 cái nồi' }]);
  const so = path.join(root, 'od', 'AgentOS', 'SO-TAY'); fs.mkdirSync(so, { recursive: true });
  const B = createBotBoard({ mainDataDir: path.join(root, 'main-data'), agentsHome: path.join(root, 'agents'), onedriveDir: path.join(root, 'od'), mainWorkdir: () => path.join(root, 'work') });
  fs.writeFileSync(path.join(root, 'main-data', 'lessons.json'), JSON.stringify({ lessons: [{ id: 'l1', text: 'Báo giá nồi chiên luôn kèm VAT', at: 1 }] }));
  let r = B.search('main', 'noi chien'); assert.equal(r.exists, true); assert.equal(r.total, 1); assert.match(r.hits[0].prompt, /【Nồi】 【chiên】/); assert.ok(r.memory.some((m) => m.kind === 'lesson'));
  assert.equal(B.search('main', 'noi').total, 2); r = B.search('main', 'noi', { status: 'error' }); assert.equal(r.total, 1);
  r = B.search('a1', 'noi'); assert.equal(r.total, 1); assert.equal(r.hits[0].chat, '9');
  r = B.searchAll('noi', { limit: 10 }, [{ id: 'a1', name: 'Bán hàng' }, { id: 'a2', name: 'Chưa có dữ liệu' }]);
  assert.equal(r.total, 3); assert.deepEqual([...new Set(r.hits.map((h) => h.bot))].sort(), ['a1', 'main']); assert.ok(r.hits.every((h) => h.botName)); assert.ok(r.hits[0].at >= r.hits[r.hits.length - 1].at);
  assert.equal(B.search('a2', 'noi').exists, false);
  assert.throws(() => B.search('../x', 'noi'), /không hợp lệ/);
  const p = B.searchAll('noi', { limit: 2, offset: 2 }, [{ id: 'a1', name: 'B' }]); assert.equal(p.hits.length, 1);
});

dbTest('Cài đặt: /api/board/search kiểm đầu vào (rỗng, quá dài) và trả kết quả', async () => {
  const root = tmp(); seedBot(root, 'main', [{ chat: '1', prompt: 'Hỏi về nồi chiên', result: 'ok' }]);
  const S = await boot(root, { boardMainDir: path.join(root, 'main-data'), boardAgentsHome: path.join(root, 'agents') });
  try {
  let r = await S.call('GET', 'board/search?bot=main&q=' + encodeURIComponent('noi chien')); assert.equal(r.status, 200, r.text); assert.equal(r.body.total, 1);
  r = await S.call('GET', 'board/search?bot=all&q=' + encodeURIComponent('nồi')); assert.equal(r.status, 200, r.text); assert.equal(r.body.bot, 'all');
  r = await S.call('GET', 'board/search?bot=main&q='); assert.equal(r.status >= 400, true);
  r = await S.call('GET', 'board/search?bot=main&q=' + 'x'.repeat(200)); assert.equal(r.status >= 400, true);
  r = await S.call('GET', 'board/search?bot=main&q=nồi&days=1'); assert.equal(r.body.total, 1);
  } finally { await S.s.close(); }
});
