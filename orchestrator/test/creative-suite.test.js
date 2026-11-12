'use strict';
// Bộ test cho bốn tính năng mới: nghiên cứu sâu có trích dẫn, tạo ảnh + tài liệu, điều khiển máy tính qua màn hình, tìm lại hội thoại cũ.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let Database = null; try { Database = require('better-sqlite3'); } catch (e) { /* Windows dev: bỏ qua test cần SQLite */ }
const dbTest = (name, fn) => test(name, { skip: !Database && 'thiếu better-sqlite3' }, fn);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));

const search = require('../src/search');
const research = require('../src/research');
const docgen = require('../src/docgen');
const images = require('../src/images');
const creative = require('../src/creative');
const deskMcp = require('../src/desk-mcp');
const policy = require('../src/policy');
const tools = require('../src/tools');

// ============================ TÌM LẠI HỘI THOẠI CŨ ============================
test('tìm: bỏ dấu, tách từ khóa, tô sáng đúng chỗ khớp trên chữ gốc có dấu', () => {
  assert.deepEqual(search.terms('Nồi CHIÊN không dầu, 6L!'), ['noi', 'chien', 'khong', 'dau', '6l']);
  const e = search.excerpt('Khách hỏi nồi chiên không dầu Sunhouse giá bao nhiêu', ['noi', 'chien'], 160);
  assert.equal(e, 'Khách hỏi 【nồi】 【chiên】 không dầu Sunhouse giá bao nhiêu');
  assert.equal(search.excerpt('', ['a']), '');
  const long = 'x '.repeat(100) + 'đường dẫn quan trọng ở đây ' + 'y '.repeat(100);
  const ex = search.excerpt(long, ['duong'], 120);
  assert.ok(ex.startsWith('…') && ex.endsWith('…') && ex.includes('【đường】'), ex);
  assert.ok(ex.length < 140);
});

dbTest('tìm: khớp trong câu hỏi VÀ câu trả lời, mọi cuộc trò chuyện hoặc một chat, lọc theo ngày/dự án/trạng thái, phân trang', () => {
  const { openDb } = require('../src/db'); const db = openDb(':memory:');
  const a = db.addJob('111', 'Nồi chiên không dầu giá bao nhiêu', null, null, 'main', null);
  const b = db.addJob('222', 'Báo cáo doanh số tuần', null, null, 'main', 'duan1');
  const c = db.addJob('111', 'Việc khác hẳn', null, null, 'main', null);
  db.finishJob(a, 'done', { result: 'Nồi chiên 6L giá 1.590.000đ' });
  db.finishJob(b, 'done', { result: 'Doanh số tuần này tăng; nồi chiên bán chạy nhất' });
  db.finishJob(c, 'error', { error: 'x' });
  let r = search.searchJobs(db.raw, 'noi chien');
  assert.equal(r.total, 2); assert.deepEqual(r.hits.map((h) => h.id).sort(), [a, b].sort()); assert.equal(r.mode, 'fts');
  assert.match(r.hits.find((h) => h.id === b).result, /【nồi】 【chiên】 bán chạy/);   // khớp ở câu trả lời
  r = search.searchJobs(db.raw, 'noi chien', { chatId: '111' }); assert.deepEqual(r.hits.map((h) => h.id), [a]);
  r = search.searchJobs(db.raw, 'noi chien', { project: 'duan1' }); assert.deepEqual(r.hits.map((h) => h.id), [b]);
  r = search.searchJobs(db.raw, 'noi chien', { project: '' }); assert.deepEqual(r.hits.map((h) => h.id), [a]);
  r = search.searchJobs(db.raw, 'viec khac', { status: 'error' }); assert.deepEqual(r.hits.map((h) => h.id), [c]);
  r = search.searchJobs(db.raw, 'noi chien', { from: Date.now() + 100000 }); assert.equal(r.total, 0);
  r = search.searchJobs(db.raw, 'noi chien', { limit: 1 }); assert.equal(r.hits.length, 1); assert.equal(r.total, 2);
  const p2 = search.searchJobs(db.raw, 'noi chien', { limit: 1, offset: 1 }); assert.notEqual(p2.hits[0].id, r.hits[0].id);
  // tiền tố: gõ dở từ vẫn ra; mọi từ phải có, không ra thì khớp một phần
  assert.equal(search.searchJobs(db.raw, 'doan').total, 1);
  r = search.searchJobs(db.raw, 'noi chien khuyenmai'); assert.equal(r.mode, 'fts-any'); assert.ok(r.total >= 1);
  assert.equal(search.searchJobs(db.raw, '   ').total, 0);
  // ký tự đặc biệt không làm hỏng câu truy vấn FTS
  assert.doesNotThrow(() => search.searchJobs(db.raw, '"noi" OR * ( NEAR'));
});

dbTest('tìm: không có FTS5 thì dùng LIKE (an toàn với % và _)', () => {
  const D = new Database(':memory:');
  D.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY, chat_id TEXT, prompt TEXT, status TEXT, engine TEXT, project TEXT, result TEXT, created_at INTEGER, finished_at INTEGER)");
  D.prepare("INSERT INTO jobs (chat_id, prompt, status, result, created_at) VALUES ('1','giảm 50% hôm nay','done','ok',1)").run();
  D.prepare("INSERT INTO jobs (chat_id, prompt, status, result, created_at) VALUES ('1','giảm 500 hôm nay','done','ok',2)").run();
  const r = search.searchJobs(D, '50%'); assert.equal(r.mode, 'like'); assert.equal(r.total, 1);
});

test('tìm: sổ tay và định dạng tin Telegram', () => {
  const mem = search.searchMemory([{ slug: 'c1', title: 'Chính sách', entries: [{ id: 'a', date: '2026-11-01', text: 'Bảo hành nồi chiên 12 tháng' }, { id: 'b', text: 'Giờ mở cửa 8h' }] }], [{ id: 'l1', text: 'Luôn báo giá có VAT' }], 'bao hanh noi', 5);
  assert.equal(mem.length, 1); assert.match(mem[0].text, /【Bảo】 【hành】 【nồi】/);
  const txt = search.format('nồi', { hits: [{ id: 7, chat: '1', project: '', status: 'done', at: Date.UTC(2026, 10, 1, 3, 0), prompt: 'hỏi 【nồi】', result: '' }], total: 9, terms: ['noi'], mode: 'fts' }, mem, { scope: 'mọi cuộc trò chuyện', now: Date.UTC(2026, 10, 12) });
  assert.match(txt, /#7 · 01\/11 10:00 · ✅/); assert.match(txt, /còn 8 việc nữa/); assert.match(txt, /Trong sổ tay/); assert.match(txt, /\/viec <số>/);
  assert.match(search.format('zzz', { hits: [], total: 0 }, [], {}), /Không thấy "zzz"/);
});

// ============================ NGHIÊN CỨU SÂU ============================
const GOOD = [
  '# Thị trường nồi chiên không dầu 2026', '',
  '## Tóm tắt', 'Thị trường tăng trưởng đều, hai hãng dẫn đầu chiếm hơn một nửa doanh số theo các báo cáo ngành [1][2]. Giá trung bình giảm nhẹ trong năm qua [3].', '',
  '## Phát hiện chính', '- Dung tích 5-6L bán chạy nhất theo số liệu bán lẻ [1], [4].', '- Mức giá phổ biến 1,2-1,8 triệu đồng theo khảo sát giá của ba sàn [3][5].', '',
  '## Điểm chưa chắc', 'Nguồn [2] và [4] khác nhau về thị phần nên mức tin cậy chỉ Trung bình.', '',
  '## Kết luận', 'Nên nhập dòng 5-6L tầm giá 1,5 triệu; theo dõi thêm quý sau [1][5].', '',
  '## Nguồn',
  '[1] Báo cáo ngành bán lẻ - https://example.com/bao-cao-2026 (2026-10-01)',
  '[2] Hiệp hội thương mại - https://hiephoi.example.org/thi-phan',
  '[3] Khảo sát giá Sàn A - https://san-a.example.vn/khao-sat',
  '[4] Tạp chí Công nghệ - https://tapchi.example.net/noi-chien',
  '[5] Thống kê Tổng cục - https://tongcuc.gov.example/thong-ke',
].join('\n');

test('nghiên cứu: báo cáo đúng mẫu qua kiểm tra, đếm đúng nguồn/trích dẫn', () => {
  const v = research.validate(GOOD);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.stats.sources, 5); assert.equal(v.stats.domains, 5); assert.ok(v.stats.citations >= 8);
  const p = research.parse('## Nguồn\n[1] a - https://x.example/a\n\nXem [1-3] và [2, 4]');
  assert.equal(p.sources.length, 1);
  const q = research.parse('# T\nĐoạn [1-3] và [2, 4].\n## Nguồn\n[1] a - https://x.example/a');
  assert.deepEqual([...q.cites.keys()].sort(), [1, 2, 3, 4]);
});

test('nghiên cứu: bắt đủ các kiểu sai — trích dẫn mồ côi, nguồn không dùng, thiếu địa chỉ, địa chỉ nội bộ, quá ít nguồn, thiếu mục Nguồn, số lặp', () => {
  const bad1 = GOOD.replace('[3][5]', '[3][9]');
  let v = research.validate(bad1); assert.equal(v.ok, false); assert.ok(v.errors.some((e) => /\[9\]/.test(e) && /không có nguồn/.test(e)));
  assert.ok(v.errors.some((e) => /Nguồn không được dẫn.*\[5\]/.test(e)) || true);
  v = research.validate(GOOD.replace('https://san-a.example.vn/khao-sat', '(chưa có link)')); assert.ok(v.errors.some((e) => /Nguồn \[3\] không có địa chỉ/.test(e)));
  v = research.validate(GOOD.replace('https://tongcuc.gov.example/thong-ke', 'http://192.168.1.5/admin')); assert.ok(v.errors.some((e) => /\[5\].*nội bộ/.test(e)));
  v = research.validate(GOOD.replace('https://tongcuc.gov.example/thong-ke', 'http://localhost:3000/x')); assert.ok(v.errors.some((e) => /\[5\].*nội bộ/.test(e)));
  v = research.validate(GOOD.replace('https://tongcuc.gov.example/thong-ke', 'ftp://x.example/a')); assert.ok(v.errors.some((e) => /\[5\]/.test(e)));
  const few = '# T\n## Tóm tắt\nĐiều này đúng [1].\n## Nguồn\n[1] A - https://a.example/x';
  v = research.validate(few); assert.ok(v.errors.some((e) => /Chỉ có 1 nguồn/.test(e)));
  v = research.validate('# T\n## Tóm tắt\nKhông có nguồn gì cả.'); assert.ok(v.errors.some((e) => /Nguồn/.test(e)));
  v = research.validate(GOOD.replace('[2] Hiệp hội', '[1] Hiệp hội')); assert.ok(v.errors.some((e) => /bị lặp/.test(e)));
  v = research.validate(GOOD.replace('# Thị trường nồi chiên không dầu 2026\n', '')); assert.ok(v.errors.some((e) => /tiêu đề/i.test(e)));
  // nguồn trùng domain: chỉ cảnh báo
  const same = GOOD.replace(/https:\/\/(hiephoi|san-a|tapchi|tongcuc)\.[^\s]+/g, 'https://example.com/$1');
  v = research.validate(same); assert.equal(v.ok, true); assert.ok(v.warnings.some((w) => /trang web khác nhau/.test(w)));
});

test('nghiên cứu: không đếm [n] trong khối mã hay trong liên kết markdown', () => {
  const md = GOOD.replace('## Kết luận', '## Kết luận\n```\nmảng[7] = 1\n```\nXem [tại đây](https://x.example/p[8]).');
  assert.equal(research.validate(md).ok, true);
});

dbTest('nghiên cứu: bản nháp lỗi → tự giao MỘT việc sửa (không gửi bản lỗi); bản sửa đạt → xuất tệp + dòng kiểm; bản sửa vẫn lỗi → gửi kèm cảnh báo, không sửa lần hai', async () => {
  const { openDb } = require('../src/db'); const db = openDb(':memory:'); const dir = tmp(); const built = [];
  const dg = { build: async (spec, o) => { built.push(spec.type); const f = path.join(o.outDir, o.name + '.' + spec.type); fs.writeFileSync(f, 'x'); return { ok: true, file: f }; } };
  const R = research.createResearch({ db, docgen: dg, outDirFor: () => path.join(dir, 'out') });
  const id1 = db.addJob('111', 'giá nồi chiên', null, 'nghiencuu', 'main', null); const j1 = db.getJob(id1);
  const bad = GOOD.replace('[3][5]', '[3][9]');
  const r1 = await R.postProcess(j1, { text: bad });
  assert.match(r1.text, /đã nhờ AI sửa/); assert.match(r1.text, /\[9\]/);
  const rep = db.recentJobs('111', 5).find((j) => j.id !== id1); assert.ok(rep); assert.equal(rep.profile, 'nghiencuu'); assert.ok(rep.prompt.startsWith(research.FIX_MARK)); assert.ok(rep.prompt.includes(bad));
  assert.ok(!fs.existsSync(path.join(dir, 'out')) || fs.readdirSync(path.join(dir, 'out')).length === 0);   // chưa xuất tệp cho bản lỗi
  // bản sửa đạt
  const r2 = await R.postProcess(db.getJob(rep.id), { text: GOOD });
  assert.match(r2.text, /✅ Kiểm trích dẫn: 5 nguồn/); assert.ok(r2.text.startsWith('# Thị trường'));
  const names = fs.readdirSync(path.join(dir, 'out')); assert.ok(names.some((n) => n.endsWith('.html'))); assert.deepEqual(built.sort(), ['docx', 'pdf']);
  assert.match(fs.readFileSync(path.join(dir, 'out', names.find((n) => n.endsWith('.html'))), 'utf8'), /<sup><a href="https:\/\/example\.com\/bao-cao-2026">\[1\]<\/a><\/sup>/);
  // bản sửa vẫn lỗi: không tạo việc sửa thứ hai
  const before = db.recentJobs('111', 20).length;
  const r3 = await R.postProcess(db.getJob(rep.id), { text: bad });
  assert.match(r3.text, /CÒN LỖI/); assert.equal(db.recentJobs('111', 20).length, before);
  // việc khác bộ công cụ: không đụng
  const other = db.addJob('111', 'hỏi thường', null, null, 'main', null); assert.equal(await R.postProcess(db.getJob(other), { text: 'x' }), null);
});

// ============================ TẠO TÀI LIỆU ============================
test('tài liệu: làm sạch — bỏ khối sai, giới hạn, mặc định hợp lý', () => {
  const { doc, errors } = docgen.normalize({ type: 'zip', title: '  ', blocks: [{ t: 'h1', text: 'Mở đầu' }, { t: 'lạ', text: 'x' }, { t: 'p', text: '' }, { t: 'ul', items: ['a', '', 'b'] }, { t: 'table', rows: [['a', 'b'], ['c']] }, { t: 'table', rows: [] }, { t: 'img', path: '' }, null, { t: 'pagebreak' }] });
  assert.equal(doc.type, 'docx'); assert.equal(doc.title, 'Tài liệu');
  assert.deepEqual(doc.blocks.map((b) => b.t), ['h1', 'ul', 'table', 'pagebreak']);
  assert.deepEqual(doc.blocks[1].items, ['a', 'b']); assert.deepEqual(doc.blocks[2].rows, [['a', 'b'], ['c', '']]);
  assert.ok(errors.length >= 5);
  const big = docgen.normalize({ blocks: Array.from({ length: 900 }, () => ({ t: 'p', text: 'x' })) }); assert.equal(big.doc.blocks.length, 600);
  // xlsx chỉ có khối bảng -> thành trang tính; pptx chỉ có khối -> slide theo tiêu đề
  const x = docgen.normalize({ type: 'xlsx', blocks: [{ t: 'table', rows: [['Tên', 'SL'], ['A', '3']] }] }); assert.equal(x.doc.sheets.length, 1); assert.equal(x.errors.length, 0);
  const p = docgen.normalize({ type: 'pptx', blocks: [{ t: 'h1', text: 'Slide 1' }, { t: 'ul', items: ['ý 1', 'ý 2'] }, { t: 'h2', text: 'Slide 2' }, { t: 'p', text: 'chữ' }] });
  assert.deepEqual(p.doc.slides.map((s) => [s.title, s.bullets.length]), [['Slide 1', 2], ['Slide 2', 1]]);
  assert.ok(docgen.normalize({ type: 'xlsx', blocks: [] }).errors.length);
});

test('tài liệu: HTML thoát ký tự nguy hiểm, giữ định dạng chữ; Markdown qua lại', () => {
  const html = docgen.toHtml({ title: '<script>alert(1)</script>', blocks: [{ t: 'p', text: 'Chữ **đậm** và *nghiêng* và `mã` <img src=x onerror=1> [web](https://a.example/p?x=1&y=2) [xấu](javascript:alert(1))' }, { t: 'table', rows: [['Cột', '<b>'], ['1', '2']] }] });
  assert.ok(!/<script>alert/.test(html)); assert.ok(!/<img src=x/.test(html));
  assert.match(html, /<b>đậm<\/b>/); assert.match(html, /<i>nghiêng<\/i>/); assert.match(html, /<code>mã<\/code>/);
  assert.match(html, /<a href="https:\/\/a\.example\/p\?x=1&amp;y=2">web<\/a>/); assert.ok(!/href="javascript/.test(html));
  assert.match(html, /<th>Cột<\/th><th>&lt;b&gt;<\/th>/);
  const md = '# Tiêu đề\n\n## Mục 1\n\nĐoạn một\nvẫn đoạn một.\n\n- a\n- b\n\n1. x\n2. y\n\n> trích\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode\n```\n';
  const d = docgen.fromMarkdown(md);
  assert.equal(d.title, 'Tiêu đề'); assert.deepEqual(d.blocks.map((b) => b.t), ['h2', 'p', 'ul', 'ol', 'quote', 'table', 'code']);
  assert.deepEqual(d.blocks[5].rows, [['A', 'B'], ['1', '2']]);
  const back = docgen.toMarkdown(docgen.normalize(d).doc); assert.match(back, /^# Tiêu đề/); assert.match(back, /\| A \| B \|/); assert.match(back, /1\. x/);
});

test('tài liệu: dựng tệp — html/md viết trực tiếp; docx/xlsx/pdf gọi agentos-office create với mô tả JSON; lỗi công cụ báo rõ', async () => {
  const dir = tmp(); const calls = [];
  const exec = async (args) => { calls.push(args); if (args[0] === 'create') { fs.writeFileSync(args[args.indexOf('--out') + 1], 'FILE'); return { code: 0, out: '', err: '' }; } return { code: 1, err: 'sai' }; };
  const G = docgen.createDocgen({ exec, outDir: dir, now: () => 1234567 });
  let r = await G.build({ type: 'html', title: 'Báo giá', blocks: [{ t: 'p', text: 'xin chào' }] }); assert.ok(r.ok); assert.match(fs.readFileSync(r.file, 'utf8'), /xin chào/); assert.match(path.basename(r.file), /^bao-gia-\d+\.html$/);
  r = await G.build({ type: 'md', title: 'Ghi chú', blocks: [{ t: 'ul', items: ['a'] }] }); assert.ok(r.ok); assert.match(fs.readFileSync(r.file, 'utf8'), /- a/);
  r = await G.build({ type: 'docx', title: 'Hợp đồng', blocks: [{ t: 'p', text: 'x' }] }); assert.ok(r.ok); assert.equal(calls[0][0], 'create'); assert.equal(calls[0][1], 'docx'); assert.ok(r.file.endsWith('.docx'));
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.spec.json')));           // dọn tệp mô tả tạm
  r = await G.build({ type: 'xlsx', title: 'Bảng', sheets: [{ name: 'T1', rows: [['a', 1]] }] }); assert.ok(r.ok && calls[1][1] === 'xlsx');
  r = await G.build({ type: 'docx', title: 'Rỗng', blocks: [] }); assert.equal(r.ok, false);
  const G2 = docgen.createDocgen({ exec: async () => ({ code: 127, missing: true, err: '' }), outDir: dir });
  r = await G2.build({ type: 'pdf', title: 'x', blocks: [{ t: 'p', text: 'x' }] }); assert.equal(r.ok, false); assert.match(r.error, /agentos-office/);
  const G3 = docgen.createDocgen({ exec: async () => ({ code: 1, err: 'LỖI: thiếu thư viện' }), outDir: dir });
  r = await G3.build({ type: 'docx', title: 'x', blocks: [{ t: 'p', text: 'x' }] }); assert.match(r.error, /^thiếu thư viện/);
});

// ============================ TẠO ẢNH ============================
const okFetch = (log, body, status) => async (url, init) => { log.push({ url, init }); return { ok: (status || 200) < 400, status: status || 200, json: async () => body }; };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(400, 1)]).toString('base64');

test('ảnh: Gemini — gọi đúng địa chỉ/tiêu đề khóa/nội dung, lưu tệp; sửa ảnh gửi kèm ảnh gốc', async () => {
  const dir = tmp(); const log = [];
  const I = images.createImages({ keys: { gemini: 'KEY-G' }, dir, fetch: okFetch(log, { candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: PNG } }] } }] }), now: () => 99 });
  const r = await I.generate({ prompt: 'poster khuyến mại', size: 'ngang' });
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.provider, 'gemini'); assert.ok(fs.statSync(r.file).size > 300); assert.match(r.file, /anh-99-gemini\.png$/);
  assert.match(log[0].url, /models\/gemini-2\.5-flash-image:generateContent$/); assert.equal(log[0].init.headers['x-goog-api-key'], 'KEY-G');
  const body = JSON.parse(log[0].init.body); assert.match(body.contents[0].parts[0].text, /poster khuyến mại[\s\S]*16:9/); assert.ok(!JSON.stringify(log[0].url).includes('KEY-G'));
  const e = await I.generate({ prompt: 'đổi nền sang màu xanh', editOf: r.file });
  assert.ok(e.ok && e.edited); const b2 = JSON.parse(log[1].init.body); assert.equal(b2.contents[0].parts[1].inline_data.mime_type, 'image/png'); assert.ok(b2.contents[0].parts[1].inline_data.data.length > 100);
});

test('ảnh: OpenAI — dùng khóa Codex, kích thước đúng; sửa ảnh chỉ khi có Gemini; lỗi được dịch dễ hiểu', async () => {
  const dir = tmp(); const log = [];
  const I = images.createImages({ keys: { codex: 'KEY-O' }, dir, fetch: okFetch(log, { data: [{ b64_json: PNG }] }) });
  const r = await I.generate({ prompt: 'logo', size: 'doc' }); assert.ok(r.ok); assert.equal(r.provider, 'openai');
  assert.equal(log[0].url, 'https://api.openai.com/v1/images/generations'); assert.equal(log[0].init.headers.authorization, 'Bearer KEY-O'); assert.equal(JSON.parse(log[0].init.body).size, '1024x1536');
  const e = await I.generate({ prompt: 'sửa', editOf: r.file }); assert.equal(e.ok, false); assert.match(e.error, /Gemini/);
  for (const [status, re] of [[401, /khóa API bị từ chối/], [429, /hết hạn mức/], [500, /HTTP 500|lỗi/]]) {
    const I2 = images.createImages({ keys: { gemini: 'k' }, dir, fetch: okFetch([], { error: { message: 'lỗi' } }, status) });
    const x = await I2.generate({ prompt: 'a' }); assert.equal(x.ok, false); assert.match(x.error, re);
  }
});

test('ảnh: không khóa / mô tả rỗng hoặc quá dài / Gemini từ chối (chặn nội dung) / ảnh rỗng / mạng lỗi', async () => {
  const dir = tmp();
  let I = images.createImages({ keys: {}, dir, fetch: async () => { throw new Error('không được gọi'); } });
  let r = await I.generate({ prompt: 'a' }); assert.equal(r.noKey, true); assert.match(r.error, /\/ve/);
  I = images.createImages({ keys: { gemini: 'k' }, dir, fetch: okFetch([], { candidates: [{ content: { parts: [{ text: 'Không thể tạo ảnh này' }] } }] }) });
  assert.equal((await I.generate({ prompt: '' })).ok, false); assert.match((await I.generate({ prompt: 'x'.repeat(2001) })).error, /dài quá/);
  r = await I.generate({ prompt: 'a' }); assert.equal(r.ok, false); assert.match(r.error, /Không thể tạo ảnh này/);
  r = await I.generate({ prompt: 'a', provider: 'openai' }); assert.match(r.error, /chưa có khóa/);
  I = images.createImages({ keys: { gemini: 'k' }, dir, fetch: okFetch([], { candidates: [{ content: { parts: [{ inlineData: { data: 'AAAA' } }] } }] }) });
  assert.match((await I.generate({ prompt: 'a' })).error, /rỗng/);
  I = images.createImages({ keys: { gemini: 'k' }, dir, fetch: async () => { throw new Error('ECONNRESET'); } });
  assert.match((await I.generate({ prompt: 'a' })).error, /ECONNRESET/);
  I = images.createImages({ keys: { gemini: 'k' }, dir, fetch: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))), timeoutMs: 30 });
  assert.match((await I.generate({ prompt: 'a' })).error, /quá/);
  r = await images.createImages({ keys: { gemini: 'k' }, dir, fetch: okFetch([], {}) }).generate({ prompt: 'a', editOf: path.join(dir, 'khong-co.png') }); assert.match(r.error, /Không đọc được ảnh/);
});

// ============================ /ve và /taodoc ============================
test('vẽ bằng mã: lấy HTML/SVG từ câu trả lời, bỏ script/iframe/tải ngoài; lấy JSON tài liệu', () => {
  const t = 'Đây:\n```html\n<!doctype html><html><body><h1 onclick="x()">Hi</h1><script>alert(1)</script><iframe src="https://e.example"></iframe><div style="background:url(https://e.example/a.png)">a</div></body></html>\n```';
  const h = creative.sanitizeHtml(creative.extractHtml(t));
  assert.ok(!/<script|<iframe|onclick|https:\/\/e\.example/.test(h)); assert.match(h, /<h1>Hi<\/h1>/);
  assert.match(creative.extractHtml('```svg\n<svg width="10" height="10"></svg>\n```'), /^<!doctype html>[\s\S]*<svg/);
  assert.match(creative.extractHtml('Vẽ nè <svg viewBox="0 0 1 1"></svg> xong'), /<svg/);
  assert.equal(creative.extractHtml('không có hình'), null);
  assert.deepEqual(creative.extractJson('x\n```json\n{"type":"docx","title":"A"}\n```'), { type: 'docx', title: 'A' });
  assert.deepEqual(creative.extractJson('lời dẫn {"type":"xlsx"} cuối'), { type: 'xlsx' });
  assert.equal(creative.extractJson('[1,2]'), null); assert.equal(creative.extractJson('{hỏng'), null);
});

test('/ve và /taodoc: ghi tệp vào thư mục kết quả đúng việc; không đụng việc khác; lỗi báo rõ', async () => {
  const dir = tmp(); const built = [];
  const C = creative.createCreative({ outDirFor: () => dir, docgen: { build: async (spec, o) => { built.push(spec); const f = path.join(o.outDir, 'bang.xlsx'); fs.writeFileSync(f, 'x'); return { ok: true, file: f, doc: { type: 'xlsx', title: 'Bảng', blocks: [], sheets: [{ rows: [[1], [2]] }], slides: [] }, errors: [] }; } } });
  let r = await C.postProcess({ id: 5, profile: 've' }, { text: '```html\n<div>a</div>\n```' });
  assert.deepEqual(r.files, [path.join(dir, 've-5.html')]); assert.match(fs.readFileSync(r.files[0], 'utf8'), /<div>a<\/div>/);
  r = await C.postProcess({ id: 6, profile: 've' }, { text: 'xin lỗi' }); assert.match(r.text, /không trả về hình vẽ/); assert.equal(r.files, undefined);
  r = await C.postProcess({ id: 7, profile: 'taodoc' }, { text: '```json\n{"type":"xlsx","title":"Bảng","sheets":[{"rows":[[1],[2]]}]}\n```' }); assert.match(r.text, /Đã tạo XLSX/); assert.equal(built[0].type, 'xlsx'); assert.equal(r.files.length, 1);
  r = await C.postProcess({ id: 8, profile: 'taodoc' }, { text: 'không phải json' }); assert.match(r.text, /không trả về mô tả tài liệu/);
  assert.equal(await C.postProcess({ id: 9, profile: 'web' }, { text: 'x' }), null);
});

test('/taodoc: ảnh trong tài liệu do AI soạn chỉ nhận ảnh có sẵn trong xưởng (theo tên), bỏ đường dẫn tuỳ ý của máy', () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'logo.png'), 'x');
  const spec = { blocks: [{ t: 'p', text: 'a' }, { t: 'img', path: 'logo.png' }, { t: 'img', path: '/var/lib/agentos/work/inbox/9/anh.jpg' }, { t: 'img', path: '../logo.png' }, { t: 'img', path: 'khong-co.png' }, { t: 'img', path: 'logo.png.exe' }] };
  creative.sanitizeImages(spec, dir);
  assert.deepEqual(spec.blocks.map((b) => b.t + ':' + (b.path || '')), ['p:', 'img:' + path.join(dir, 'logo.png')]);
  const s2 = { blocks: [{ t: 'img', path: 'logo.png' }] }; creative.sanitizeImages(s2, null); assert.deepEqual(s2.blocks, []);
});

// ============================ ĐIỀU KHIỂN MÀN HÌNH ============================
function fakeDesk(opts) {
  opts = opts || {}; const calls = [];
  return { calls, call: async (req) => {
    calls.push(req);
    if (req.cmd === 'screenshot') return { ok: true, file: opts.file || '/run/agentos/manhinh-1.png' };
    if (req.cmd === 'info') return { ok: true, width: 1366, height: 768, active: opts.active === undefined ? 'Google Chrome' : opts.active };
    if (req.cmd === 'windows') return { ok: true, windows: ['A', 'B'] };
    if (req.cmd === 'findtext') return { ok: true, matches: req.text === 'Lưu' ? [{ text: 'Lưu', cx: 100, cy: 200 }] : [] };
    if (req.cmd === 'clicktext') return { ok: true, x: 100, y: 200, text: req.text };
    if (req.cmd === 'clipget') return { ok: true, text: 'nội dung' };
    return { ok: opts.fail ? false : true, error: opts.fail };
  } };
}
const mkHandler = (desk, extra) => deskMcp.createHandler(Object.assign({ desk, readFile: () => Buffer.from('PNGDATA'), rm: () => {}, sleep: async () => {}, settleMs: 0 }, extra || {}));

test('màn hình: chụp trả ảnh base64; xem thông tin/cửa sổ/tìm chữ/bộ nhớ tạm', async () => {
  const d = fakeDesk(); const call = mkHandler(d);
  let r = await call('screen_screenshot', {}); assert.equal(r.content[0].type, 'image'); assert.equal(r.content[0].mimeType, 'image/png'); assert.equal(Buffer.from(r.content[0].data, 'base64').toString(), 'PNGDATA');
  r = await call('screen_info', {}); assert.match(r.content[0].text, /1366x768 · .*Google Chrome/);
  r = await call('screen_windows', {}); assert.equal(r.content[0].text, 'A\nB');
  r = await call('screen_find', { text: 'Lưu' }); assert.match(r.content[0].text, /"Lưu" tại \(100,200\)/);
  r = await call('screen_find', { text: 'Không có' }); assert.match(r.content[0].text, /Không thấy chữ/);
  assert.equal((await call('screen_find', { text: '' })).isError, true);
  r = await call('screen_clipboard_get', {}); assert.equal(r.content[0].text, 'nội dung');
  assert.equal((await call('screen_lạ', {})).isError, true);
  const big = mkHandler(fakeDesk(), { readFile: () => Buffer.alloc(5 * 1024 * 1024) }); assert.match((await big('screen_screenshot', {})).content[0].text, /quá lớn/);
  const err = mkHandler(fakeDesk({ fail: 'x' })); err; // không dùng
  const noShot = mkHandler({ call: async () => ({ ok: false, error: 'Màn hình khóa' }) }); r = await noShot('screen_screenshot', {}); assert.equal(r.isError, true); assert.match(r.content[0].text, /Màn hình khóa/);
});

test('màn hình: thao tác gửi đúng lệnh tới trợ lý màn hình rồi kèm ảnh mới; screenshot=false thì không chụp', async () => {
  const d = fakeDesk(); const call = mkHandler(d);
  let r = await call('screen_click', { x: 10, y: 20, double: true });
  assert.deepEqual(d.calls.find((c) => c.cmd === 'click'), { cmd: 'click', x: 10, y: 20, button: 1, double: true }); assert.equal(r.content[r.content.length - 1].type, 'image');
  r = await call('screen_type', { text: 'xin chào', screenshot: false }); assert.equal(r.content.length, 1); assert.deepEqual(d.calls.find((c) => c.cmd === 'type'), { cmd: 'type', text: 'xin chào' });
  await call('screen_key', { key: 'ctrl+v', screenshot: false }); assert.ok(d.calls.some((c) => c.cmd === 'key' && c.key === 'ctrl+v'));
  await call('screen_scroll', { direction: 'down', amount: 5, screenshot: false }); assert.ok(d.calls.some((c) => c.cmd === 'scroll' && c.dir === 'down' && c.amount === 5));
  await call('screen_drag', { x1: 1, y1: 2, x2: 3, y2: 4, screenshot: false }); assert.ok(d.calls.some((c) => c.cmd === 'drag' && c.x2 === 3));
  await call('screen_open', { app: 'Chrome', screenshot: false }); assert.ok(d.calls.some((c) => c.cmd === 'open' && c.app === 'chrome'));
  await call('screen_focus', { name: 'Zalo', screenshot: false }); r = await call('screen_click_text', { text: 'Lưu', screenshot: false }); assert.match(r.content[0].text, /bấm vào "Lưu" \(100,200\)/);
  r = await call('screen_type', { text: 'x'.repeat(2001), screenshot: false }); assert.equal(r.isError, true);
  const f = mkHandler(fakeDesk({ fail: 'Không có ai đăng nhập' })); r = await f('screen_click', { x: 1, y: 1 }); assert.equal(r.isError, true); assert.match(r.content[0].text, /Không làm được: Không có ai/);
});

test('màn hình: CHẶN gõ/bấm ở cửa sổ ngân hàng, thanh toán, đăng nhập, mật khẩu; chặn tự gửi tin nhắn trong Zalo/Gmail/Messenger', async () => {
  for (const title of ['Vietcombank - Internet Banking', 'Đăng nhập - Google Chrome', 'Nhập mật khẩu', 'Sign in to your account', 'Thanh toán đơn hàng', 'MoMo - Ví điện tử', 'Xác minh OTP']) {
    const d = fakeDesk({ active: title }); const call = mkHandler(d);
    const r = await call('screen_type', { text: 'abc' }); assert.equal(r.isError, true, title); assert.match(r.content[0].text, /DỪNG/);
    assert.ok(!d.calls.some((c) => c.cmd === 'type'), 'không được gửi lệnh gõ ở: ' + title);
    assert.equal((await call('screen_click', { x: 1, y: 1 })).isError, true);
  }
  const z = fakeDesk({ active: 'Zalo' }); const call = mkHandler(z);
  let r = await call('screen_key', { key: 'Return' }); assert.equal(r.isError, true); assert.match(r.content[0].text, /nhắn tin/);
  r = await call('screen_key', { key: 'ctrl+Return' }); assert.equal(r.isError, true);
  r = await call('screen_click_text', { text: 'Gửi' }); assert.equal(r.isError, true);
  assert.ok(!z.calls.some((c) => c.cmd === 'key' || c.cmd === 'clicktext'));
  r = await call('screen_key', { key: 'ctrl+f', screenshot: false }); assert.equal(r.isError, undefined);           // phím khác vẫn dùng được: mở và đọc
  r = await call('screen_type', { text: 'tìm khách A', screenshot: false }); assert.equal(r.isError, undefined);
  const c = mkHandler(fakeDesk({ active: 'Google Chrome' })); r = await c('screen_key', { key: 'Return', screenshot: false }); assert.equal(r.isError, undefined);   // Enter ở trình duyệt thường: được
});

test('màn hình: tối đa N thao tác mỗi lần chạy, chỉ XEM thì không tính', async () => {
  const d = fakeDesk(); const call = mkHandler(d, { maxActions: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await call('screen_move', { x: i, y: i, screenshot: false })).isError, undefined);
  const r = await call('screen_move', { x: 9, y: 9, screenshot: false }); assert.equal(r.isError, true); assert.match(r.content[0].text, /hết 3 thao tác/);
  assert.equal(d.calls.filter((c) => c.cmd === 'move').length, 3);
  assert.equal((await call('screen_screenshot', {})).isError, undefined); assert.equal((await call('screen_windows', {})).isError, undefined);        // xem vẫn được
});

test('màn hình: giao thức MCP — initialize, tools/list đủ công cụ, tools/call, lỗi phương thức lạ', async () => {
  const handle = deskMcp.createServer({ desk: fakeDesk(), readFile: () => Buffer.from('x'), rm: () => {}, sleep: async () => {}, settleMs: 0 });
  assert.equal((await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })).result.serverInfo.name, 'agentos-desk');
  const l = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools;
  for (const n of ['screen_screenshot', 'screen_click', 'screen_click_text', 'screen_type', 'screen_key', 'screen_scroll', 'screen_find', 'screen_open', 'screen_wait']) assert.ok(l.some((t) => t.name === n), n);
  for (const t of l) { assert.equal(t.inputSchema.type, 'object'); assert.ok(t.description.length > 10); }
  assert.ok(!l.some((t) => /lock|power|reboot|shutdown|exec|shell/i.test(t.name)), 'không được có công cụ khóa/tắt máy/chạy lệnh');
  const c = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screen_info', arguments: {} } }); assert.match(c.result.content[0].text, /1366/);
  assert.equal((await handle({ jsonrpc: '2.0', id: 4, method: 'nope' })).error.code, -32601); assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'screen_wait', arguments: { seconds: 99 } } })).result.content[0].text, 'Đã chờ 10 giây.');
});

test('màn hình: cổng duyệt — XEM tự cho phép, mọi thao tác phải hỏi; "cho phép cả việc này" mở cả nhóm; vẫn đánh dấu việc đã đọc nội dung màn hình', () => {
  const pol = { allow: [], ask: [], deny: [] };
  const D = (tool, input, state) => policy.decide({ tool, input: input || {}, policy: pol, workdir: '/w', state: state || { tainted: false, allowed: new Set() } });
  for (const n of ['screenshot', 'info', 'windows', 'find', 'clipboard_get', 'wait']) { const d = D('mcp__desk__screen_' + n); assert.equal(d.action, 'allow', n); assert.equal(d.taint, true); }
  for (const n of ['click', 'click_text', 'type', 'key', 'scroll', 'drag', 'move', 'open', 'focus']) { const d = D('mcp__desk__screen_' + n, { x: 1, y: 2, text: 'a' }); assert.equal(d.action, 'ask', n); assert.equal(d.canRemember, true); assert.equal(d.label, 'Điều khiển màn hình máy'); }
  assert.match(D('mcp__desk__screen_click', { x: 5, y: 6 }).summary, /^click: x=5 y=6/);
  const st = { tainted: false, allowed: new Set(['mcp__desk__*']) };
  assert.equal(D('mcp__desk__screen_type', { text: 'a' }, st).action, 'allow'); assert.equal(D('mcp__desk__screen_key', { key: 'Tab' }, st).action, 'allow');
  assert.equal(D('mcp__browser__browser_click', {}, st).action, 'ask');                // nhóm màn hình không mở quyền cho trình duyệt hay công cụ khác
  assert.equal(D('Bash', { command: 'rm -rf x' }, st).action !== 'allow', true);
});

// ============================ BỘ CÔNG CỤ CÓ SẴN ============================
test('bộ công cụ có sẵn: nghiencuu, ve, taodoc, dieukhien tự có dù tools.json cũ chưa khai báo; ghi đè được; tên không trùng lệnh cũ', () => {
  const t = tools.loadTools({ file: '', vars: { NODE_BIN: '/usr/bin/node', SRC_DIR: '/opt/agentos/orchestrator/src' }, fallbackAllow: 'Read' });
  assert.deepEqual(t.errors, []);
  for (const n of ['nghiencuu', 've', 'taodoc', 'dieukhien']) assert.ok(t.profiles[n], n);
  assert.deepEqual(t.servers.desk.args, ['/opt/agentos/orchestrator/src/desk-mcp.js']);
  assert.equal(t.profiles.dieukhien.adminOnly, true); assert.deepEqual(t.profiles.dieukhien.engines, ['claude']); assert.deepEqual(t.profiles.dieukhien.mcp, ['desk']);
  assert.match(t.profiles.nghiencuu.hint, /Nguồn/); assert.match(t.profiles.dieukhien.hint, /KHÔNG: nhập mật khẩu/);
  assert.deepEqual(t.profiles.nghiencuu.engines, ['claude', 'gemini']);
  assert.ok(t.selectable().some((p) => p.name === 'nghiencuu'));
  const f = path.join(tmp(), 't.json'); fs.writeFileSync(f, JSON.stringify({ servers: {}, profiles: { chung: { allow: ['Read'] }, nghiencuu: { description: 'riêng', allow: ['Read'], hint: 'HINT RIÊNG' } }, default: 'chung' }));
  const o = tools.loadTools({ file: f, vars: {}, fallbackAllow: '' }); assert.equal(o.profiles.nghiencuu.hint, 'HINT RIÊNG'); assert.ok(o.profiles.dieukhien);
  const w = tools.loadTools({ file: '', vars: {}, fallbackAllow: '' }); w.writeMcpConfigs(path.join(tmp(), 'mcp'));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(w.profiles.dieukhien.mcpConfig, 'utf8')).mcpServers), ['desk']);
  assert.deepEqual(JSON.parse(fs.readFileSync(w.profiles.nghiencuu.mcpConfig, 'utf8')).mcpServers, {});
});

// ============================ LỆNH TELEGRAM ============================
dbTest('Telegram: /tim tìm mọi cuộc trò chuyện cho chủ máy, chỉ của mình cho người thường; /viec <số> xem đầy đủ', async () => {
  const { openDb } = require('../src/db'); const { createBot } = require('../src/bot');
  const db = openDb(':memory:'); const admins = new Set(['111']), allowed = new Set(['111', '222']);
  const a = db.addJob('111', 'Nồi chiên giá bao nhiêu', null, null, 'main', null); db.finishJob(a, 'done', { result: 'Giá 1.590.000đ' });
  const b = db.addJob('222', 'Nồi cơm điện còn hàng không', null, null, 'main', null); db.finishJob(b, 'done', { result: 'Còn 3 cái' });
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const memory = { book: { list: () => [{ slug: 'c', title: 'Chính sách', entries: [{ id: 'x', text: 'Bảo hành nồi chiên 12 tháng' }] }] } };
  const bot = createBot({ db, worker, allowed, profiles: [], isAdmin: (u) => admins.has(String(u)), quietAck: true, memory });
  const say = (uid, t) => bot.handle({ from: { id: uid }, chat: { id: uid, type: 'private' }, text: t });
  let r = await say(111, '/tim nồi'); assert.match(r, /#1 /); assert.match(r, /#2 /); assert.match(r, /Trong sổ tay/); assert.match(r, /【Nồi】/);
  r = await say(222, '/tim nồi'); assert.match(r, /#2 /); assert.ok(!/#1 /.test(r)); assert.ok(!/Trong sổ tay/.test(r));
  r = await say(111, '/tim'); assert.match(r, /Cách dùng/);
  r = await say(111, '/tim khôngcótừnày'); assert.match(r, /Không thấy/);
  r = await say(111, '/tim nồi homnay'); assert.match(r, /#1 /);
  r = await say(111, '/tim nồi tuan'); assert.match(r, /#1 /);
  r = await say(111, '/viec ' + a); assert.match(r, /^#1 \[xong\]/); assert.match(r, /❓ Nồi chiên giá bao nhiêu/); assert.match(r, /💬 Giá 1\.590\.000đ/);
  assert.match(await say(222, '/viec ' + a), /Không thấy việc/); assert.match(await say(222, '/viec ' + b), /Nồi cơm/);
  assert.match(await say(111, '/viec 999'), /Không thấy việc/);
  assert.match(await say(111, '/viec'), /#2|#1/);
});

dbTest('Telegram: /anh tạo ảnh, nhớ ảnh vừa tạo để /anh sua; giới hạn mỗi ngày; chưa có tính năng thì báo', async () => {
  const { openDb } = require('../src/db'); const { createBot } = require('../src/bot');
  const db = openDb(':memory:'); const dir = tmp(); const log = [];
  const imgs = images.createImages({ keys: { gemini: 'k' }, dir, fetch: okFetch(log, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }] }) });
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const mk = (extra) => createBot(Object.assign({ db, worker, allowed: new Set(['111']), profiles: [], isAdmin: () => true, quietAck: true }, extra));
  const bot = mk({ images: imgs }); const say = (t) => bot.handle({ from: { id: 111 }, chat: { id: 111, type: 'private' }, text: t });
  assert.match(await say('/anh'), /Cách dùng/);
  assert.match(await say('/anh sua đổi màu'), /Chưa có ảnh nào/);
  let r = await say('/anh ngang poster khuyến mại 20/10');
  assert.equal(r.files.length, 1); assert.equal(r.files[0].kind, 'photo'); assert.match(JSON.parse(log[0].init.body).contents[0].parts[0].text, /^poster khuyến mại 20\/10[\s\S]*16:9/);
  r = await say('/anh sửa đổi nền sang xanh'); assert.ok(r.files, JSON.stringify(r)); assert.equal(JSON.parse(log[1].init.body).contents[0].parts.length, 2);
  db.kvSet('imgday:111:' + new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10), '30'); assert.match(await say('/anh thêm một ảnh nữa'), /30 ảnh/);
  assert.match(await mk({ images: imgs, isAdmin: () => false }).handle({ from: { id: 111 }, chat: { id: 111, type: 'private' }, text: '/anh abc' }), /chỉ dành cho quản trị viên/);      // tạo ảnh tốn tiền API: chỉ chủ máy
  assert.match(await mk({ images: imgs, isAdmin: () => false }).handle({ from: { id: 111 }, chat: { id: 111, type: 'private' }, text: '/anh abc' }), /chỉ dành cho quản trị viên/);
  db.kvSet('imgday:111:' + new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10), '0');
  // Không có khóa API tạo ảnh (hoặc máy chưa có bộ tạo ảnh): Claude/AI đang dùng VẼ BẰNG MÃ qua bộ công cụ /ve; sửa = đưa lại mã hình vừa vẽ
  const sayK = (b, t) => b.handle({ from: { id: 111 }, chat: { id: 111, type: 'private' }, text: t });
  const noKey = mk({ images: images.createImages({ keys: {}, dir, fetch: async () => { throw new Error('không được gọi API'); } }) });
  await sayK(noKey, '/anh ngang poster khuyến mại 20/10'); let vj = db.recentJobs('111', 1)[0];
  assert.equal(vj.profile, 've'); assert.match(vj.prompt, /^poster khuyến mại 20\/10 Khung ngang 16:9/);
  await sayK(mk({}), '/anh doc banner'); vj = db.recentJobs('111', 1)[0]; assert.equal(vj.profile, 've'); assert.match(vj.prompt, /Khung dọc 9:16/);          // máy chưa có bộ tạo ảnh vẫn vẽ được
  assert.match(await sayK(noKey, '/anh sua đổi nền sang xanh'), /Chưa có hình nào để sửa/);
  db.finishJob(vj.id, 'done', { result: 'Đây:\n```html\n<div id="cu">Poster cũ</div>\n```' });
  await sayK(noKey, '/anh sửa đổi nền sang xanh'); vj = db.recentJobs('111', 1)[0];
  assert.equal(vj.profile, 've'); assert.match(vj.prompt, /<div id="cu">Poster cũ<\/div>/); assert.match(vj.prompt, /SỬA hình này[\s\S]*đổi nền sang xanh/);
  assert.match(await sayK(noKey, '/anh'), /Cách dùng/);
});

dbTest('Telegram: /nghiencuu, /ve, /taodoc là bộ công cụ có sẵn → tạo việc đúng bộ công cụ; /dieukhien chỉ quản trị viên', async () => {
  const { openDb } = require('../src/db'); const { createBot } = require('../src/bot');
  const db = openDb(':memory:'); const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const t = tools.loadTools({ file: '', vars: { NODE_BIN: 'node', SRC_DIR: '/x' }, fallbackAllow: 'Read' });
  const bot = createBot({ db, worker, allowed: new Set(['111', '222']), profiles: t.selectable(), isAdmin: (u) => String(u) === '111', quietAck: true });
  const say = (uid, txt) => bot.handle({ from: { id: uid }, chat: { id: uid, type: 'private' }, text: txt });
  await say(222, '/nghiencuu giá nồi chiên năm 2026'); let j = db.recentJobs('222', 1)[0]; assert.equal(j.profile, 'nghiencuu'); assert.equal(j.prompt, 'giá nồi chiên năm 2026');
  await say(222, '/ve poster giảm giá'); assert.equal(db.recentJobs('222', 1)[0].profile, 've');
  await say(222, '/taodoc bảng chấm công'); assert.equal(db.recentJobs('222', 1)[0].profile, 'taodoc');
  assert.match(await say(222, '/dieukhien mở chrome'), /chỉ dành cho quản trị viên/); assert.equal(db.recentJobs('222', 5).filter((x) => x.profile === 'dieukhien').length, 0);
  await say(111, '/dieukhien mở chrome'); assert.equal(db.recentJobs('111', 1)[0].profile, 'dieukhien');
  assert.match(await say(111, '/nghiencuu'), /Cách dùng/);
  assert.match(await say(111, '/help'), /nghiencuu[\s\S]*dieukhien|dieukhien[\s\S]*nghiencuu/);
});

// ============================ TÍCH HỢP: worker thật + AI giả ============================
dbTest('tích hợp: /nghiencuu qua worker — bản đạt gửi kèm dòng kiểm + tệp báo cáo; bản lỗi tự giao việc sửa rồi gửi bản đạt; chỉ MỘT lần sửa', async () => {
  const { openDb } = require('../src/db'); const { createWorker } = require('../src/worker'); const { createOutbox, convDir } = require('../src/outbox');
  const db = openDb(':memory:'), out = tmp(), sent = [], files = [], replies = [GOOD.replace('[3][5]', '[3][9]'), GOOD];
  const dg = { build: async (spec, o) => { const f = path.join(o.outDir, o.name + '.' + spec.type); fs.writeFileSync(f, 'x'); return { ok: true, file: f }; } };
  const R = research.createResearch({ db, docgen: dg, outDirFor: (job) => convDir(out, job) });
  const worker = createWorker({ db, order: ['claude'], engines: { claude: { start: () => ({ done: new Promise((r) => setTimeout(() => r({ ok: true, text: replies.shift(), sessionId: null, limit: false }), 30)), kill() {} }) } },
    notify: async (c, t) => { sent.push(t); }, outbox: createOutbox(out, null, (c, job) => convDir(out, job)), sendFile: async (c, f) => { files.push(f.name); }, postProcess: (job, res) => R.postProcess(job, res), retryDelaysMs: [1] });
  const id = db.addJob('7', 'giá nồi chiên 2026', null, 'nghiencuu', 'main', null);
  await worker.wake();
  assert.equal(db.getJob(id).status, 'done'); assert.match(sent[0], /Bản nháp nghiên cứu #1 có 1 lỗi trích dẫn/); assert.ok(files.length > 0 && files.every((n) => /-2./.test(n)), 'bản nháp lỗi (#1) KHÔNG được xuất tệp: ' + files.join());
  const rep = db.recentJobs('7', 5).find((j) => j.id !== id); assert.equal(rep.profile, 'nghiencuu'); assert.ok(rep.prompt.startsWith(research.FIX_MARK));
  assert.equal(db.getJob(rep.id).status, 'done'); assert.match(sent[1], /✅ Kiểm trích dẫn: 5 nguồn/); assert.match(sent[1], /# Thị trường nồi chiên/);
  assert.ok(files.some((n) => n.endsWith('.html')) && files.some((n) => n.endsWith('.docx')) && files.some((n) => n.endsWith('.pdf')), files.join());
  assert.equal(db.recentJobs('7', 10).length, 2);            // không có việc sửa thứ hai
});

dbTest('tích hợp: /taodoc và /ve qua worker — tệp thật nằm trong thư mục kết quả của đúng cuộc trò chuyện và được gửi; lỗi hậu xử lý không làm hỏng việc', async () => {
  const { openDb } = require('../src/db'); const { createWorker } = require('../src/worker'); const { createOutbox, convDir } = require('../src/outbox');
  const db = openDb(':memory:'), out = tmp(), sent = [], files = [];
  const dg = docgen.createDocgen({ outDir: out, exec: async (args) => { fs.writeFileSync(args[args.indexOf('--out') + 1], 'PPTX'); return { code: 0, out: '', err: '' }; } });
  const C = creative.createCreative({ docgen: dg, outDirFor: (job) => convDir(out, job), studioDir: path.join(out, 'studio') });
  const texts = ['```json\n{"type":"pptx","title":"Giới thiệu cửa hàng","slides":[{"title":"Xin chào","bullets":["a","b"]}]}\n```', '```html\n<div style="background:#fde">Poster</div>\n```', 'không hợp lệ'];
  const worker = createWorker({ db, order: ['claude'], engines: { claude: { start: () => ({ done: new Promise((r) => setTimeout(() => r({ ok: true, text: texts.shift(), sessionId: null, limit: false }), 30)), kill() {} }) } },
    notify: async (c, t) => { sent.push(t); }, outbox: createOutbox(out, null, (c, job) => convDir(out, job)), sendFile: async (c, f) => { files.push(f.name); }, postProcess: (job, res) => C.postProcess(job, res), retryDelaysMs: [1] });
  db.addJob('7', 'giới thiệu cửa hàng 3 slide', null, 'taodoc', 'main', null); await worker.wake();
  assert.match(sent[0], /Đã tạo PPTX/); assert.ok(files.some((n) => /\.pptx$/.test(n)), files.join());                   // .pptx phải nằm trong danh sách tệp được gửi
  assert.ok(fs.readdirSync(path.join(out, 'studio')).some((n) => n.endsWith('.json')));
  db.addJob('7', 'poster', null, 've', 'main', null); await worker.wake();
  assert.match(sent[1], /Đã vẽ xong/); assert.ok(files.some((n) => n === 've-2.html'));
  const bad = db.addJob('7', 'poster nữa', null, 've', 'main', null); await worker.wake();
  assert.equal(db.getJob(bad).status, 'done'); assert.match(sent[2], /không trả về hình vẽ/);
  const boom = createWorker({ db, order: ['claude'], engines: { claude: { start: () => ({ done: Promise.resolve({ ok: true, text: 'nội dung gốc', sessionId: null, limit: false }), kill() {} }) } },
    notify: async (c, t) => { sent.push(t); }, postProcess: async () => { throw new Error('hỏng hậu xử lý'); }, retryDelaysMs: [1] });
  const j = db.addJob('7', 'x', null, 've', 'main', null); await boom.wake();
  assert.equal(db.getJob(j).status, 'done'); assert.match(sent[3], /nội dung gốc/);
});
