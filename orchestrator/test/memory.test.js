'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createMemory } = require('../src/memory');
const { createSummarizer } = require('../src/summarizer');
const router = require('../src/router');
const { createMedia, listAttachments, imagePaths } = require('../src/media');
const { createBot } = require('../src/bot');
const { createQuick } = require('../src/quick');
const { createWorker } = require('../src/worker');
const { startCodex } = require('../src/engines/codex');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
const T0 = Date.parse('2026-10-21T10:00:00+07:00');
function addDone(db, chat, prompt, result) { const id = db.addJob(chat, prompt); db.claimNext(); db.finishJob(id, 'done', { result }); return id; }

function mk(extra) {
  const db = openDb(':memory:'), dir = tmp();
  const m = createMemory(Object.assign({ db, dir, now: () => T0, cfg: { recentTurns: 2, summarizeAfter: 3, rotateAfter: 4 } }, extra || {}));
  return { db, dir, m };
}

test('ghi nhớ lâu dài: thêm/trùng/quên (không phân biệt dấu), từ chối bí mật, tệp nằm ở OneDrive/AgentOS/GHI-NHO.md có bản .bak', () => {
  const { dir, m } = mk();
  assert.equal(m.addFact('Cửa hàng nghỉ chủ nhật').ok, true);
  assert.equal(m.addFact('cửa hàng nghỉ chủ nhật').duplicate, true);
  assert.equal(m.addFact('Khách quen ưa giao hàng buổi sáng').ok, true);
  const file = path.join(dir, 'AgentOS', 'GHI-NHO.md');
  const txt = fs.readFileSync(file, 'utf8');
  assert.match(txt, /^# Ghi nhớ của AgentOS/); assert.match(txt, /- \[2026-10-21\] Cửa hàng nghỉ chủ nhật/);
  for (const bad of ['mật khẩu: abc123', 'api key = sk-abcdefghijklmnopqrstuv', 'token: 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', 'x'.repeat(401), 'ab'])
    assert.equal(m.addFact(bad).ok, false, bad.slice(0, 20));
  assert.equal(m.addFact('Mật khẩu wifi là nhà-minh-2026').ok, false);
  const f = m.forgetFact('GIAO HANG'); assert.equal(f.removed, 1);
  assert.doesNotMatch(m.readFacts(), /giao hàng/); assert.match(m.readFacts(), /nghỉ chủ nhật/);
  assert.ok(fs.existsSync(file + '.bak')); assert.equal(m.forgetFact('khong co gi').removed, 0);
});

test('ghép ngữ cảnh: phiên mới có ghi nhớ + tóm tắt + việc gần nhất + việc cũ liên quan (FTS); có phiên thì chỉ gửi ghi nhớ khi đổi; /moi cắt', () => {
  const { db, m } = mk();
  m.addFact('Cửa hàng bán đồ gia dụng ở Hà Nội');
  const a = addDone(db, 'c1', 'Tra cứu giá nồi chiên không dầu Philips', 'Giá khoảng 2,9 triệu');
  for (let i = 0; i < 4; i++) addDone(db, 'c1', 'việc đệm số ' + i, 'xong ' + i);
  db.kvSet('sum:c1', 'Chủ máy đang so sánh giá nồi chiên.'); db.kvSet('sumupto:c1', String(a));
  const job = { id: 999, chat_id: 'c1', prompt: 'Nồi chiên Philips lúc nãy giá bao nhiêu nhỉ?' };
  const p = m.pack(job, false, 'claude');
  assert.match(p, /\[Ghi nhớ lâu dài[^\]]*\]\nCửa hàng bán đồ gia dụng|\[Ghi nhớ lâu dài[^\]]*\][\s\S]*Cửa hàng bán đồ gia dụng/);
  assert.match(p, /\[Tóm tắt cuộc trò chuyện trước đó\]\nChủ máy đang so sánh giá nồi chiên/);
  assert.match(p, /\[Các việc gần nhất[\s\S]*việc đệm số 3/); assert.doesNotMatch(p, /việc đệm số 0/);   // chỉ 2 việc gần nhất
  assert.match(p, /Yêu cầu mới:\nNồi chiên Philips/);
  // có phiên: lần 1 sau khi đổi ghi nhớ gửi CẬP NHẬT, lần sau chỉ gửi yêu cầu
  assert.equal(m.pack(job, true, 'claude'), job.prompt);                                   // ghi nhớ chưa đổi kể từ lần gửi trước: chỉ gửi yêu cầu
  m.addFact('Giờ mở cửa 8h đến 21h'); const s1 = m.pack(job, true, 'claude'); assert.match(s1, /CẬP NHẬT[\s\S]*Giờ mở cửa/);
  assert.equal(m.pack(job, true, 'claude'), job.prompt);
  // /moi: đặt mốc, xóa tóm tắt
  db.kvSet('ctxfrom:c1', db.lastJobId('c1')); m.resetChat('c1');
  const after = m.pack({ id: 1000, chat_id: 'c1', prompt: 'xin chào' }, false, 'codex');
  assert.doesNotMatch(after, /Tóm tắt cuộc trò chuyện|việc đệm/);
  assert.match(after, /Ghi nhớ lâu dài/);                         // ghi nhớ lâu dài vẫn giữ sau /moi
  // chat khác không thấy việc/tóm tắt của chat này
  assert.doesNotMatch(m.pack({ id: 5, chat_id: 'c2', prompt: 'nồi chiên Philips giá' }, false, 'claude'), /việc đệm|2,9 triệu/);
});

test('nén: mô hình rẻ tóm tắt việc cũ (giữ việc gần nhất nguyên văn), ghi tối đa 3 điều nhớ tự động, lọc bí mật; không có khóa thì cắt gọn', async () => {
  let calls = [];
  const summarizer = { available: () => true, provider: () => 'gemini', run: async (system, user) => { calls.push(user); return { via: 'gemini', text: JSON.stringify({ summary: 'Đã chốt: giao hàng thứ 3.', facts: ['Khách Lan thích màu xanh', 'mật khẩu: abc', 'điều 3', 'điều 4 bị cắt'] }) }; } };
  const { db, m } = mk({ summarizer });
  for (let i = 1; i <= 6; i++) addDone(db, 'c1', 'yêu cầu ' + i, 'kết quả ' + i);
  const r = await m.maybeSummarize('c1', false);
  assert.equal(r.done, true); assert.equal(r.compressed, 4);                       // 6 việc - 2 gần nhất = 4 việc được nén
  assert.equal(db.kvGet('sum:c1'), 'Đã chốt: giao hàng thứ 3.'); assert.equal(Number(db.kvGet('sumupto:c1')), 4);
  assert.match(calls[0], /Việc #1[\s\S]*Việc #4/); assert.doesNotMatch(calls[0], /Việc #5/);
  const facts = m.readFacts(); assert.match(facts, /Khách Lan thích màu xanh \(tự ghi\)/); assert.doesNotMatch(facts, /mật khẩu/); assert.doesNotMatch(facts, /điều 4/);
  // lần sau: chỉ nén phần mới, kèm tóm tắt cũ
  for (let i = 7; i <= 11; i++) addDone(db, 'c1', 'yêu cầu ' + i, 'kết quả ' + i);
  await m.maybeSummarize('c1', false); assert.match(calls[1], /TÓM TẮT CŨ:\nĐã chốt/); assert.equal(Number(db.kvGet('sumupto:c1')), 9);
  // không đủ việc cũ -> không nén (trừ khi ép)
  const { db: d2, m: m2 } = mk();
  addDone(d2, 'x', 'a', 'b'); addDone(d2, 'x', 'c', 'd'); addDone(d2, 'x', 'e', 'f');
  assert.equal((await m2.maybeSummarize('x', false)).done, false);
  // cắt gọn khi không có khóa
  for (let i = 1; i <= 5; i++) addDone(d2, 'x', 'câu hỏi dài ' + i, 'trả lời ' + i);
  const r2 = await m2.maybeSummarize('x', true); assert.equal(r2.via, 'cắt gọn'); assert.match(d2.kvGet('sum:x'), /• câu hỏi/);
});

test('xoay phiên: sau rotateAfter lượt thành công thì bỏ phiên (ngữ cảnh lấy từ tóm tắt); lượt lỗi không tính', async () => {
  const { db, m } = mk();
  const job = { id: 1, chat_id: 'c1', prompt: 'x' };
  assert.deepEqual(await m.afterJob(job, 'claude', { ok: false }), { rotate: false });
  for (let i = 0; i < 3; i++) assert.equal((await m.afterJob(job, 'claude', { ok: true })).rotate, false);
  assert.equal((await m.afterJob(job, 'claude', { ok: true })).rotate, true);
  assert.equal(db.kvGet('turns:c1:claude'), '0');
  assert.equal((await m.afterJob(job, 'codex', { ok: true })).rotate, false);   // đếm riêng từng AI
});

test('summarizer: Gemini (tự chọn mô hình flash còn dùng được, dùng khóa trong tiêu đề), DeepSeek, không khóa/lỗi trả null', async () => {
  const seen = [];
  const f = async (url, init) => {
    seen.push([String(url), init && init.method, init && init.headers]);
    if (/\/models\?pageSize/.test(url)) return { ok: true, json: async () => ({ models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] }) };
    if (/generateContent/.test(url)) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'TOM TAT' }] } }] }) };
    if (/deepseek/.test(url)) return { ok: true, json: async () => ({ choices: [{ message: { content: 'DS TOM TAT' } }] }) };
    return { ok: false, status: 500 };
  };
  const g = createSummarizer({ keys: { gemini: 'AIzaKEY' }, fetch: f });
  assert.equal(g.provider(), 'gemini'); const r = await g.run('sys', 'user');
  assert.deepEqual([r.text, r.via], ['TOM TAT', 'gemini']);
  assert.ok(seen.some((x) => /models\/gemini-2\.5-flash:generateContent/.test(x[0]) && x[2]['x-goog-api-key'] === 'AIzaKEY'));
  const d = createSummarizer({ keys: { deepseekapi: 'sk-ds' }, fetch: f }); assert.equal(d.provider(), 'deepseek');
  assert.equal((await d.run('s', 'u')).text, 'DS TOM TAT');
  assert.equal(createSummarizer({ keys: {}, fetch: f }).provider(), null); assert.equal(await createSummarizer({ keys: {}, fetch: f }).run('s', 'u'), null);
  assert.equal(createSummarizer({ keys: { gemini: 'k' }, provider: 'none', fetch: f }).provider(), null);
  assert.equal(createSummarizer({ keys: { gemini: 'k', deepseekapi: 'd' }, provider: 'deepseek', fetch: f }).provider(), 'deepseek');
  const bad = createSummarizer({ keys: { gemini: 'k' }, fetch: async () => ({ ok: false, status: 429 }), log() {} });
  assert.equal(await bad.run('s', 'u'), null);                                                   // lỗi -> null (bộ nhớ tự cắt gọn)
  const long = await createSummarizer({ keys: { deepseekapi: 'd' }, fetch: async (u, i) => { seen.push(JSON.parse(i.body).messages[1].content.length); return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }; } }).run('s', 'a'.repeat(50000));
  assert.equal(seen.at(-1), 14000);                                                              // đầu vào bị cắt để tiết kiệm token
});

test('định tuyến theo độ khó: câu hỏi nhẹ đi AI rẻ trước; việc nặng/có tệp/ép AI/bật-tắt giữ nguyên; ảnh loại DeepSeek', () => {
  const opts = { enabled: true, lightEngines: ['deepseekapi', 'gemini'] };
  const cands = ['claude', 'codex', 'gemini', 'deepseekapi'];
  assert.equal(router.classify({ prompt: 'Hôm nay thứ mấy?' }), 'light');
  assert.equal(router.classify({ prompt: 'Giải thích ngắn gọn thuế GTGT là gì' }), 'light');
  for (const heavy of ['Cài phần mềm VLC giúp anh', 'Tạo file excel báo cáo', 'chụp màn hình', 'x'.repeat(400), 'xem https://a.com', 'Viết script backup'])
    assert.equal(router.classify({ prompt: heavy }), 'heavy', heavy.slice(0, 20));
  assert.equal(router.classify({ prompt: 'ngắn', profile: 'web' }), 'heavy');
  assert.deepEqual(router.order({ prompt: 'Hôm nay thứ mấy?' }, cands, opts), ['deepseekapi', 'gemini', 'claude', 'codex']);
  assert.deepEqual(router.order({ prompt: 'Tạo file excel' }, cands, opts), cands);
  assert.deepEqual(router.order({ prompt: 'Hôm nay thứ mấy?', engine_pref: 'claude' }, ['claude'], opts), ['claude']);
  assert.deepEqual(router.order({ prompt: 'Hôm nay thứ mấy?' }, cands, { enabled: false, lightEngines: ['gemini'] }), cands);
  assert.deepEqual(router.order({ prompt: 'Hôm nay thứ mấy?' }, ['claude', 'codex'], opts), ['claude', 'codex']);     // không có AI rẻ nào -> giữ
  const img = { prompt: 'Xem giúp\n\n[Tệp đính kèm — ...]\n- Ảnh: /var/lib/agentos/work/inbox/a.jpg' };
  assert.deepEqual(router.order(img, cands, opts), ['claude', 'codex', 'gemini']);                                      // DeepSeek (chỉ chữ) bị loại
  assert.deepEqual(router.order(img, ['deepseekapi'], opts), ['deepseekapi']);                                         // chỉ còn nó thì vẫn giữ
});

test('db: tìm toàn văn FTS5 bỏ dấu tiếng Việt, theo chat, loại trừ id, giữ đúng sau khi sao lưu và xóa', () => {
  const db = openDb(':memory:');
  assert.equal(db.ftsAvailable(), true);
  const a = addDone(db, 'c1', 'Tra giá nồi chiên không dầu', 'Philips 2,9 triệu'); addDone(db, 'c1', 'Hôm nay thứ mấy', 'Thứ ba'); addDone(db, 'c2', 'nồi chiên của chat khác', 'x');
  assert.deepEqual(db.search('c1', 'NOI CHIEN gia bao nhieu', 3).map((r) => r.id), [a]);
  assert.deepEqual(db.search('c1', 'nồi chiên', 3, 0, [a]), []);
  assert.deepEqual(db.search('c1', 'nồi chiên', 3, a), []);                                         // minId (mốc /moi)
  assert.deepEqual(db.search('c1', 'ab', 3), []);
  const f = path.join(tmp(), 'b.db'); db.backupTo(f);
  const copy = openDb(f); assert.equal(copy.search('c1', 'nồi chiên', 3).length, 1); copy.close();
  db.pruneOld(Date.now() + 1000, Date.now() + 1000); assert.deepEqual(db.search('c1', 'nồi chiên', 3), []);
});

// ---------- ảnh / video ----------
test('media: nhận diện tệp đính kèm (ảnh lớn nhất, video, ghi hình tròn, tài liệu) và đường dẫn ảnh cho Codex/Gemini', () => {
  const a = listAttachments({ photo: [{ file_id: 's', file_size: 10 }, { file_id: 'L', file_size: 900 }, { file_id: 'm', file_size: 300 }] });
  assert.deepEqual(a.map((x) => [x.id, x.kind]), [['L', 'image']]);
  assert.deepEqual(listAttachments({ video: { file_id: 'v', mime_type: 'video/mp4' } }).map((x) => x.kind), ['video']);
  assert.deepEqual(listAttachments({ video_note: { file_id: 'n' } }).map((x) => x.kind), ['video']);
  assert.deepEqual(listAttachments({ document: { file_id: 'd', file_name: 'a.pdf', mime_type: 'application/pdf' } }).map((x) => x.kind), ['doc']);
  assert.deepEqual(listAttachments({ document: { file_id: 'd', mime_type: 'image/png' } }).map((x) => x.kind), ['image']);
  assert.deepEqual(listAttachments({ text: 'chữ' }), []);
  assert.deepEqual(imagePaths('xem /var/lib/agentos/work/inbox/a.jpg và /x/inbox/b.PNG, còn /etc/passwd.jpg'), ['/var/lib/agentos/work/inbox/a.jpg', '/x/inbox/b.PNG']);
});

function fakeTg(sizes) {
  const got = [];
  return { got, downloadFile: async (id, dest) => { if (id === 'FAIL') throw new Error('quá 20MB'); fs.writeFileSync(dest, 'data-' + id); got.push([id, dest]); return dest; } };
}

test('media.prepare: ảnh -> đường dẫn; video -> khung hình (ffmpeg) + lời nói (nhận dạng) + thời lượng; tài liệu; tệp quá 20 MB và lỗi tải báo rõ', async () => {
  const dir = path.join(tmp(), 'inbox'), runs = [];
  const run = async (cmd, args) => {
    runs.push([cmd].concat(args));
    if (cmd === 'ffprobe') return { code: 0, out: 'width=1280\nheight=720\nduration=42.5\n', err: '' };
    if (cmd === 'ffmpeg' && args.some((x) => /khung-%02d/.test(x))) { const out = args.at(-1); fs.mkdirSync(path.dirname(out), { recursive: true }); for (let i = 1; i <= 5; i++) fs.writeFileSync(out.replace('%02d', String(i).padStart(2, '0')), 'jpg'); return { code: 0, out: '', err: '' }; }
    if (cmd === 'ffmpeg') { fs.writeFileSync(args.at(-1), Buffer.alloc(8000)); return { code: 0, out: '', err: '' }; }
    return { code: 1, out: '', err: '' };
  };
  const tg = fakeTg(); const voice = { transcribePath: async () => ({ ok: true, text: 'xin chào các bạn đây là cửa hàng' }) };
  const md = createMedia({ tg, dir, run, voice, now: () => T0 });
  const p = await md.prepare([{ message_id: 7, photo: [{ file_id: 'P', file_size: 100 }] }, { message_id: 8, video: { file_id: 'V', file_name: 'clip.mp4', mime_type: 'video/mp4', file_size: 1000 } },
    { message_id: 9, document: { file_id: 'D', file_name: 'bang gia.xlsx', mime_type: 'application/vnd.ms-excel', file_size: 50 } }, { message_id: 10, video: { file_id: 'BIG', file_name: 'to.mp4', file_size: 30 * 1024 * 1024 } }, { message_id: 11, photo: [{ file_id: 'FAIL' }] }]);
  assert.match(p.block, /^\[Tệp đính kèm/); assert.match(p.block, /- Ảnh: \S+inbox\S*-7-1\.jpg/); assert.match(p.block, /- Video: \S+-8-2\.mp4 \(dài 43 giây, 1280x720\)/);
  assert.match(p.block, /Khung hình trích đều theo thời gian \(xem từng ảnh\): \S+khung-01\.jpg, \S+khung-02\.jpg/); assert.match(p.block, /Lời nói trong video[^"]*: "xin chào các bạn đây là cửa hàng"/);
  assert.match(p.block, /- Tài liệu "bang gia\.xlsx": \S+-9-3\.xlsx/);
  assert.equal(p.errors.length, 2); assert.match(p.errors[0], /"to\.mp4" nặng 30 MB.*20 MB/); assert.match(p.errors[1], /Không tải được.*quá 20MB/);
  assert.equal(p.files.length, 3);
  // thiếu ffmpeg: vẫn đưa tệp gốc
  const md2 = createMedia({ tg: fakeTg(), dir: tmp(), run: async () => ({ code: 127, out: '', err: '', missing: true }), now: () => T0 });
  const q = await md2.prepare([{ message_id: 1, video: { file_id: 'V2', file_name: 'a.mov', mime_type: 'video/quicktime' } }]);
  assert.match(q.block, /- Video: \S+-1-1\.mov$/m);
});

// ---------- bot: ảnh/album/lệnh nhớ ----------
function botEnv(extra) {
  const db = openDb(':memory:'), dir = tmp(), sent = [];
  const worker = { engineNames: () => ['claude', 'codex'], wake() {}, currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const memory = createMemory({ db, dir, now: () => T0 });
  const tg = fakeTg();
  const media = createMedia({ tg, dir: path.join(dir, 'inbox'), run: async () => ({ code: 127, out: '', err: '', missing: true }), now: () => T0 });
  const quick = createQuick({ memory });
  const bot = createBot(Object.assign({ db, worker, allowed: new Set(['1']), isAdmin: () => true, media, memory, quick, send: async (c, r) => sent.push([c, r]) }, extra || {}));
  return { db, bot, sent, memory, dir };
}
const m1 = (extra) => Object.assign({ from: { id: 1 }, chat: { id: 1, type: 'private' } }, extra);

test('bot: ảnh kèm chú thích -> MỘT việc có chú thích + đường dẫn ảnh; không chú thích -> yêu cầu mặc định; file quá lớn báo rõ', async () => {
  const E = botEnv();
  const r = await E.bot.handle(m1({ message_id: 5, photo: [{ file_id: 'P', file_size: 100 }], caption: 'Đây là hóa đơn gì?' }));
  assert.match(r, /Đã nhận việc #1/);
  const j = E.db.getJob(1); assert.match(j.prompt, /^Đây là hóa đơn gì\?\n\n\[Tệp đính kèm/); assert.match(j.prompt, /- Ảnh: \S+inbox\S+\.jpg/);
  const r2 = await E.bot.handle(m1({ message_id: 6, photo: [{ file_id: 'P2' }] }));
  assert.match(r2, /Đã nhận việc #2/); assert.match(E.db.getJob(2).prompt, /^Anh gửi tệp đính kèm\. Hãy xem và mô tả/);
  const r3 = await E.bot.handle(m1({ message_id: 7, video: { file_id: 'B', file_name: 'to.mp4', file_size: 40 * 1024 * 1024 } }));
  assert.match(r3, /^⚠️ "to\.mp4" nặng 40 MB/);
  assert.equal(E.bot && (await E.bot.handle({ from: { id: 99 }, chat: { id: 99, type: 'private' }, photo: [{ file_id: 'P' }] })), null);           // người lạ bị bỏ qua
  const cmd = await E.bot.handle(m1({ message_id: 8, photo: [{ file_id: 'P3' }], caption: '/claude xem ảnh này' }));
  assert.match(cmd, /Đã nhận việc #3/); assert.equal(E.db.getJob(3).engine_pref, 'claude');                                                     // lệnh trong chú thích vẫn hoạt động
});

test('bot: album nhiều ảnh gom thành MỘT việc sau khi đủ ảnh; tin trả lời gửi qua send', async () => {
  const E = botEnv();
  const g = { media_group_id: 'G1' };
  assert.equal(E.bot.handle(m1(Object.assign({ message_id: 10, photo: [{ file_id: 'A', file_size: 1 }], caption: 'So sánh 3 mẫu này' }, g))), null);
  assert.equal(E.bot.handle(m1(Object.assign({ message_id: 11, photo: [{ file_id: 'B', file_size: 1 }] }, g))), null);
  assert.equal(E.bot.handle(m1(Object.assign({ message_id: 12, photo: [{ file_id: 'C', file_size: 1 }] }, g))), null);
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(E.sent.length, 1); assert.match(E.sent[0][1], /Đã nhận việc #1/);
  const p = E.db.getJob(1).prompt; assert.match(p, /^So sánh 3 mẫu này/); assert.equal((p.match(/- Ảnh:/g) || []).length, 3); assert.equal(E.db.getJob(2), undefined);
});

test('lệnh /nho /quen /trinho dùng chung cho mọi AI; /moi xóa tóm tắt nhưng giữ ghi nhớ lâu dài', async () => {
  const E = botEnv();
  assert.match(await E.bot.handle(m1({ text: '/nho Giao hàng buổi sáng' })), /Đã ghi nhớ/);
  assert.match(await E.bot.handle(m1({ text: '/nho mật khẩu: 123' })), /KHÔNG ghi nhớ/);
  assert.match(await E.bot.handle(m1({ text: '/trinho' })), /Giao hàng buổi sáng[\s\S]*Nén ngữ cảnh bằng: cắt gọn/);
  E.db.kvSet('sum:1', 'tóm tắt cũ'); E.db.kvSet('sumupto:1', '3');
  await E.bot.handle(m1({ text: '/moi' }));
  assert.equal(E.db.kvGet('sum:1'), null); assert.match(E.memory.readFacts(), /Giao hàng buổi sáng/);
  assert.match(await E.bot.handle(m1({ text: '/quen giao hang' })), /Đã xóa 1 dòng/);
  assert.match(await E.bot.handle(m1({ text: '/quen giao hang' })), /Không có dòng ghi nhớ nào/);
});

// ---------- worker: ngữ cảnh + định tuyến + xoay phiên ----------
test('worker: câu lệnh ghép bộ nhớ khi AI chưa có phiên; câu hỏi nhẹ đi AI rẻ trước; xoay phiên bỏ session; chuyển AI vẫn có ngữ cảnh', async () => {
  const db = openDb(':memory:'), dir = tmp();
  const memory = createMemory({ db, dir, now: () => T0, cfg: { recentTurns: 2, summarizeAfter: 99, rotateAfter: 2 } });
  memory.addFact('Cửa hàng ở Hà Nội');
  const prompts = [];
  const eng = (name, limit) => ({ start: ({ prompt, resumeId }) => { prompts.push([name, prompt, resumeId]); return { kill() {}, done: Promise.resolve(limit ? { ok: false, limit: true, error: 'usage limit reached' } : { ok: true, text: 'xong ' + name, sessionId: 'S-' + name }) }; } });
  const w = createWorker({ db, engines: { claude: eng('claude'), deepseekapi: eng('deepseekapi', true), gemini: eng('gemini') }, order: ['claude', 'deepseekapi', 'gemini'], notify: async () => {}, context: memory,
    router: { order: (job, c) => router.order(job, c, { enabled: true, lightEngines: ['deepseekapi', 'gemini'] }) }, retryDelaysMs: [] });
  db.addJob('c1', 'Hôm nay thứ mấy?'); await w.wake();
  assert.deepEqual(prompts.map((p) => p[0]), ['deepseekapi', 'gemini']);                       // nhẹ: DeepSeek trước (hết hạn mức) -> Gemini
  assert.match(prompts[0][1], /Ghi nhớ lâu dài[\s\S]*Cửa hàng ở Hà Nội[\s\S]*Yêu cầu mới:\nHôm nay thứ mấy\?/);
  assert.equal(db.kvGet('session:c1:gemini'), 'S-gemini');
  db.addJob('c1', 'Tạo file excel báo cáo'); await w.wake();                                       // nặng: Claude (đầu danh sách), chưa có phiên Claude -> có ghép ngữ cảnh gồm việc trước
  const p3 = prompts.at(-1); assert.equal(p3[0], 'claude'); assert.match(p3[1], /Các việc gần nhất[\s\S]*Hôm nay thứ mấy\?/);
  db.addJob('c1', 'Tạo file excel nữa'); await w.wake();                                           // Claude đã có phiên: chỉ gửi yêu cầu mới
  assert.equal(prompts.at(-1)[1], 'Tạo file excel nữa'); assert.equal(prompts.at(-1)[2], 'S-claude');
  assert.equal(db.kvGet('session:c1:claude'), null);                                                // lượt thứ 2 của Claude chạm rotateAfter=2 -> bỏ phiên
  db.addJob('c1', 'Tạo file excel thứ ba'); await w.wake();
  assert.equal(prompts.at(-1)[2], null); assert.match(prompts.at(-1)[1], /Các việc gần nhất/);        // phiên mới: ngữ cảnh lấy lại từ bộ nhớ        // phiên mới: ngữ cảnh lấy lại từ bộ nhớ
});

test('codex: ảnh đính kèm truyền bằng -i (mỗi ảnh một cờ) và "--" trước prompt từ stdin', async () => {
  const f = path.join(tmp(), 'args.js');
  fs.writeFileSync(f, "console.log(JSON.stringify({type:'thread.started',thread_id:'T'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(process.argv.slice(2))}}));");
  const withImg = await startCodex({ bin: process.execPath, binArgs: [f], cwd: os.tmpdir(), prompt: 'hi', timeoutMs: 20000, images: ['/a/inbox/1.jpg', '/a/inbox/2.png'], sandbox: 'read-only' }).done;
  const a = JSON.parse(withImg.text); assert.equal(withImg.ok, true);
  assert.deepEqual(a.slice(a.indexOf('-i')), ['-i', '/a/inbox/1.jpg', '-i', '/a/inbox/2.png', '--sandbox', 'read-only', '--', '-']);
  const none = JSON.parse((await startCodex({ bin: process.execPath, binArgs: [f], cwd: os.tmpdir(), prompt: 'hi', timeoutMs: 20000, sandbox: 'read-only' }).done).text);
  assert.ok(!none.includes('-i') && !none.includes('--') && none.at(-1) === '-');
});
