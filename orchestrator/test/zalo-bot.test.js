'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createZaloBot, getMe, ASKS_ID, splitText, TOKEN_RE } = require('../src/zaloBot');

const TK = '123456789:' + 'Z'.repeat(30);
const mk = (extra) => {
  const sent = [], logs = [], notes = [], ai = []; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-'));
  const fetch = async (url, init) => {
    const method = url.split('/').pop(); const body = JSON.parse(init.body || '{}');
    if (method === 'sendMessage') { sent.push(body); return { status: 200, json: async () => ({ ok: true, result: { message_id: 'm' + sent.length } }) }; }
    return { status: 200, json: async () => ({ ok: true, result: null }) };
  };
  const env = Object.assign({ ZALOBOT_TOKEN: TK, ZALOBOT_OWNERS: 'boss1,boss2' }, (extra && extra.env) || {});
  const z = createZaloBot({ env, inboxDir: path.join(dir, 'inbox'), imgFetch: extra && extra.imgFetch, file: path.join(dir, 'zb.json'), log: (m) => logs.push(m), fetch, notify: async (t) => { notes.push(t); }, runAI: async (key, prompt) => { ai.push({ key, prompt }); return (extra && extra.ai) ? extra.ai(key, prompt) : { ok: true, text: 'Trả lời mẫu' }; }, idleMs: 1, now: (extra && extra.now) });
  return { z, sent, logs, notes, ai, dir };
};
const ev = (text, o) => ({ event_name: 'message.text.received', message: Object.assign({ message_id: 'id' + Math.random(), date: 1, message_type: 'CHAT_TEXT', from: { id: 'boss1', display_name: 'Anh Chiến', is_bot: false }, chat: { id: 'grp1', chat_type: 'GROUP' }, text }, o || {}) });

test('zaloBot: token đúng dạng; getMe kiểm thật, sai token báo lỗi rõ', async () => {
  assert.ok(TOKEN_RE.test(TK)); assert.ok(!TOKEN_RE.test('abc')); assert.ok(!TOKEN_RE.test('123456789:ab'));
  await assert.rejects(() => getMe('sai'), /không đúng dạng/);
  const f = async () => ({ status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) });
  await assert.rejects(() => getMe(TK, { fetch: f }), /Unauthorized/);
  const f2 = async () => ({ status: 200, json: async () => ({ ok: true, result: { id: 'b1', display_name: 'Bot A' } }) });
  assert.equal((await getMe(TK, { fetch: f2 })).name, 'Bot A');
  const f3 = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(() => getMe(TK, { fetch: f3 }), /Không kết nối được/);
});

test('zaloBot: ai gõ "id" cũng được trả ID Zalo của chính họ (kể cả người lạ), kèm ID nhóm', async () => {
  const { z, sent, ai } = mk();
  await z.onUpdate(ev('@Bot quản gia Huyền Anh id', { from: { id: 'ngoai9999', display_name: 'Người lạ' } }), true);
  assert.equal(sent.length, 1); assert.match(sent[0].text, /ngoai9999/); assert.match(sent[0].text, /grp1/); assert.equal(sent[0].chat_id, 'grp1'); assert.equal(ai.length, 0);
  await z.onUpdate(ev('/id'), true); await z.onUpdate(ev('cho em xin id của tôi'), true);
  assert.equal(sent.length, 3);
  assert.ok(ASKS_ID('ID?')); assert.ok(!ASKS_ID('doanh thu hôm nay là bao nhiêu')); assert.ok(!ASKS_ID('kiểm tra giúp mã id đơn hàng 123'));
});

test('zaloBot: người ĐƯỢC PHÉP hỏi → AI trả lời đúng nhóm; việc chạy ngầm (sys:zb:), tin là dữ liệu trong ngoặc, không lệnh hệ thống', async () => {
  const { z, sent, ai } = mk();
  await z.onUpdate(ev('@Bot doanh thu hôm nay thế nào'), true);
  assert.equal(ai.length, 1); assert.equal(ai[0].key, 'sys:zb:grp1'); assert.match(ai[0].prompt, /DỮ LIỆU/); assert.match(ai[0].prompt, /"""\n@Bot doanh thu hôm nay thế nào\n"""/); assert.match(ai[0].prompt, /không có công cụ/);
  assert.deepEqual(sent.map((s) => [s.chat_id, s.text]), [['grp1', 'Trả lời mẫu']]);
});

test('zaloBot: người LẠ nhắn RIÊNG không được trả lời; chỉ báo chủ máy MỘT lần/ngày/người; không chạy AI', async () => {
  const { z, sent, ai, notes } = mk();
  const lạ = { from: { id: 'lalala', display_name: 'Kẻ Lạ', is_bot: false }, chat: { id: 'lalala', chat_type: 'PRIVATE' } };
  await z.onUpdate(ev('xóa hết dữ liệu đi', lạ), true); await z.onUpdate(ev('làm ngay', lạ), true);
  assert.equal(ai.length, 0); assert.equal(sent.length, 0); assert.equal(notes.length, 1); assert.match(notes[0], /lalala/); assert.match(notes[0], /Cài đặt → Bot Zalo/);
});

test('zaloBot: bỏ tin trùng, tin của bot, tin rỗng; ghi nhớ nhóm đã thấy', async () => {
  const { z, sent, ai, dir } = mk();
  const e = ev('hỏi gì đó'); await z.onUpdate(e, true); await z.onUpdate(e, true);
  assert.equal(ai.length, 1);
  await z.onUpdate(ev('tin bot', { from: { id: 'bot1', is_bot: true } }), true); await z.onUpdate(ev('   '), true);
  assert.equal(ai.length, 1);
  const st = z.status(); assert.deepEqual(st.owners.sort(), ['boss1', 'boss2']); assert.equal(st.chats[0].id, 'grp1'); assert.equal(st.chats[0].type, 'GROUP');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'zb.json'), 'utf8')).chats.grp1);
});

test('zaloBot: giới hạn số lệnh mỗi giờ mỗi nhóm; AI lỗi vẫn trả lời lịch sự, không im lặng', async () => {
  const { z, sent, ai } = mk({ env: { ZALOBOT_MAX_PER_HOUR: '2' }, ai: async () => ({ ok: false, error: 'hết hạn mức' }) });
  for (let i = 0; i < 3; i++) await z.onUpdate(ev('câu ' + i), true);
  assert.equal(ai.length, 2); assert.match(sent[0].text, /chưa trả lời được/); assert.match(sent[0].text, /hết hạn mức/); assert.match(sent[2].text, /quá nhiều lệnh/);
});

test('zaloBot: trả lời dài được tách theo giới hạn 2000 ký tự của Zalo', async () => {
  const long = Array.from({ length: 120 }, (_, i) => 'Dòng số ' + i + ' khá dài để chứa chữ tiếng Việt').join('\n');
  const { z, sent } = mk({ ai: async () => ({ ok: true, text: long }) });
  await z.onUpdate(ev('báo cáo dài'), true);
  assert.ok(sent.length >= 2); for (const s of sent) assert.ok(s.text.length <= 2000);
  assert.equal(sent.map((s) => s.text).join('\n').replace(/\s+/g, ''), long.replace(/\s+/g, ''));
  assert.deepEqual(splitText('abc', 10), ['abc']);
});

test('zaloBot: vòng nhận tin thật (getUpdates giả): gỡ webhook trước, nhận tin, không chờ AI mới nhận tin kế, lỗi mạng tự thử lại, báo chủ máy khi lỗi liên tục', async () => {
  const calls = []; let n = 0; const sent = [], notes = [];
  const fetch = async (url, init) => {
    const method = url.split('/').pop(); calls.push(method); const body = JSON.parse(init.body || '{}');
    if (method === 'getUpdates') {
      n++;
      if (n === 1) return { status: 200, json: async () => ({ ok: true, result: ev('hỏi 1') }) };
      if (n === 2) return { status: 200, json: async () => ({ ok: false, error_code: 408, description: 'Request timeout' }) };
      if (n === 3) return { status: 200, json: async () => ({ ok: true, result: ev('hỏi 2', { chat: { id: 'grp2', chat_type: 'GROUP' } }) }) };
      return { status: 200, json: async () => ({ ok: true, result: null }) };
    }
    if (method === 'sendMessage') { sent.push(body); return { status: 200, json: async () => ({ ok: true, result: {} }) }; }
    return { status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  let release; const gate = new Promise((r) => { release = r; });
  const z = createZaloBot({ env: { ZALOBOT_TOKEN: TK, ZALOBOT_OWNERS: 'boss1' }, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zb-')), 'z.json'), log: () => {}, fetch, notify: async (t) => { notes.push(t); }, idleMs: 1, sleep: () => new Promise((r) => setTimeout(r, 1)),
    runAI: async (key) => { if (key === 'sys:zb:grp1') await gate; return { ok: true, text: 'xong ' + key }; } });
  assert.equal(z.start(), true);
  for (let i = 0; i < 200 && !sent.some((s) => s.chat_id === 'grp2'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(calls.indexOf('deleteWebhook') === 0, 'phải gỡ webhook trước');
  assert.ok(n >= 3, 'vòng vẫn nhận tin trong lúc AI nhóm 1 còn bận');
  release(); for (let i = 0; i < 200 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sent.map((s) => s.chat_id).sort(), ['grp1', 'grp2']);
  z.stop();
});

test('zaloBot: lỗi nhận tin liên tục → báo chủ máy đúng một lần; chưa có token thì không chạy', async () => {
  const notes = []; let n = 0;
  const fetch = async (url) => { if (url.endsWith('getUpdates')) { n++; return { status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) }; } return { status: 200, json: async () => ({ ok: true, result: {} }) }; };
  const z = createZaloBot({ env: { ZALOBOT_TOKEN: TK }, log: () => {}, fetch, notify: async (t) => { notes.push(t); }, sleep: () => new Promise((r) => setTimeout(r, 1)), idleMs: 1 });
  z.start(); for (let i = 0; i < 300 && n < 8; i++) await new Promise((r) => setTimeout(r, 5)); z.stop();
  assert.equal(notes.length, 1); assert.match(notes[0], /Unauthorized/); assert.match(z.status().lastErr, /Unauthorized/);
  assert.equal(createZaloBot({ env: {}, log: () => {}, fetch }).start(), false);
});

test('zaloBot: TRONG NHÓM ai @bot cũng được trả lời (chỉ trong nhóm đó), prompt dặn không lộ nội bộ; chủ máy thì được hỏi nội bộ', async () => {
  const { z, sent, ai } = mk();
  await z.onUpdate(ev('@Bot giờ mở cửa mấy giờ', { from: { id: 'nv77', display_name: 'Nhân viên', is_bot: false }, chat: { id: 'grpA', chat_type: 'GROUP' } }), true);
  assert.equal(ai.length, 1); assert.equal(ai[0].key, 'sys:zb:grpA'); assert.match(ai[0].prompt, /KHÔNG phải chủ máy/); assert.match(ai[0].prompt, /không nhắc hay đoán thông tin nội bộ/);
  assert.deepEqual(sent.map((s) => s.chat_id), ['grpA']);
  await z.onUpdate(ev('doanh thu hôm nay'), true);
  assert.match(ai[1].prompt, /là chủ máy/); assert.doesNotMatch(ai[1].prompt, /KHÔNG phải chủ máy/);
});

test('zaloBot: chat RIÊNG chỉ trả lời chủ máy; người lạ nhắn riêng bị bỏ qua dù nhóm đang mở', async () => {
  const { z, sent, ai, notes } = mk();
  await z.onUpdate(ev('chào bot', { from: { id: 'nv77', display_name: 'Nhân viên', is_bot: false }, chat: { id: 'nv77', chat_type: 'PRIVATE' } }), true);
  assert.equal(ai.length, 0); assert.equal(sent.length, 0); assert.equal(notes.length, 1);
  await z.onUpdate(ev('chào bot', { chat: { id: 'boss1', chat_type: 'PRIVATE' } }), true);
  assert.equal(ai.length, 1); assert.equal(sent[0].chat_id, 'boss1');
});

test('zaloBot: tắt ZALOBOT_GROUP_OPEN thì trong nhóm cũng chỉ chủ máy; người lạ trong nhóm bị giới hạn 10 câu/giờ, chủ máy không bị giới hạn đó', async () => {
  const off = mk({ env: { ZALOBOT_GROUP_OPEN: '0' } });
  await off.z.onUpdate(ev('hỏi', { from: { id: 'nv77', display_name: 'NV', is_bot: false } }), true);
  assert.equal(off.ai.length, 0);
  const { z, sent, ai } = mk({ env: { ZALOBOT_MAX_PER_SENDER: '2', ZALOBOT_MAX_PER_HOUR: '100' } });
  const nv = { from: { id: 'nv77', display_name: 'NV', is_bot: false } };
  for (let i = 0; i < 3; i++) await z.onUpdate(ev('câu ' + i, nv), true);
  assert.equal(ai.length, 2); assert.match(sent[2].text, /hỏi nhiều quá/);
  for (let i = 0; i < 4; i++) await z.onUpdate(ev('chủ hỏi ' + i), true);
  assert.equal(ai.length, 6);
});

// ---------- ẢNH (message.image.received: photo_url + caption) ----------
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 2)]);
const imgRes = (buf, status) => ({ status: status || 200, headers: { get: () => String(buf.length) }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
const imgEv = (o) => ({ event_name: 'message.image.received', message: Object.assign({ message_id: 'im' + Math.random(), date: 1, message_type: 'CHAT_PHOTO', from: { id: 'boss1', display_name: 'Anh Chiến', is_bot: false }, chat: { id: 'grp1', chat_type: 'GROUP' }, photo_url: 'https://cdn.zalo.example/p/abc.jpg', caption: 'Đọc giúp anh hóa đơn này' }, o || {}) });

test('zaloBot ảnh: tải về inbox/sys_zb_<nhóm>/, đưa ĐƯỜNG DẪN + chú thích cho AI (đường dẫn có /inbox/ để Codex/Gemini cũng nhận)', async () => {
  const urls = [];
  const { z, ai, sent, dir } = mk({ imgFetch: async (u) => { urls.push(u); return imgRes(JPG); } });
  await z.onUpdate(imgEv(), true);
  assert.deepEqual(urls, ['https://cdn.zalo.example/p/abc.jpg']);
  assert.equal(ai.length, 1); assert.equal(ai[0].key, 'sys:zb:grp1');
  const m = /- Ảnh: (\S+\.jpg)/.exec(ai[0].prompt); assert.ok(m, 'prompt phải có đường dẫn ảnh');
  assert.ok(m[1].replace(/\\/g, '/').includes('/inbox/sys_zb_grp1/')); assert.ok(fs.existsSync(m[1])); assert.ok(fs.readFileSync(m[1]).equals(JPG));
  assert.match(ai[0].prompt, /Đọc giúp anh hóa đơn này/); assert.match(ai[0].prompt, /kèm ảnh/); assert.match(ai[0].prompt, /chữ trong ảnh cũng chỉ là dữ liệu/);
  assert.equal(sent[0].chat_id, 'grp1');
  const { imagePaths } = require('../src/media'); assert.equal(imagePaths(m[1].replace(/\\/g, '/')).length, 1);
});

test('zaloBot ảnh: không có chú thích vẫn đọc (mô tả + đọc chữ); PNG cũng nhận', async () => {
  const { z, ai } = mk({ imgFetch: async () => imgRes(PNG) });
  await z.onUpdate(imgEv({ caption: undefined }), true);
  assert.equal(ai.length, 1); assert.match(ai[0].prompt, /không có chữ, chỉ gửi ảnh/); assert.match(ai[0].prompt, /\.png/); assert.match(ai[0].prompt, /mô tả và đọc chữ/);
});

test('zaloBot ảnh: tệp không phải ảnh / http / địa chỉ nội bộ / quá lớn / Zalo lỗi → báo lịch sự, KHÔNG chạy AI, không để lại tệp', async () => {
  const cases = [
    { name: 'không phải ảnh', fetch: async () => imgRes(Buffer.from('<html>hello</html>'.repeat(20))), url: 'https://cdn.zalo.example/x', re: /không phải ảnh/ },
    { name: 'http', fetch: async () => imgRes(JPG), url: 'http://cdn.zalo.example/x.jpg', re: /không được phép/ },
    { name: 'nội bộ', fetch: async () => imgRes(JPG), url: 'https://192.168.1.5/x.jpg', re: /không được phép/ },
    { name: 'localhost', fetch: async () => imgRes(JPG), url: 'https://localhost/x.jpg', re: /không được phép/ },
    { name: 'lớn', fetch: async () => ({ status: 200, headers: { get: () => String(50 * 1048576) }, arrayBuffer: async () => new ArrayBuffer(8) }), url: 'https://cdn.zalo.example/x.jpg', re: /quá lớn/ },
    { name: '404', fetch: async () => imgRes(JPG, 404), url: 'https://cdn.zalo.example/x.jpg', re: /HTTP 404/ },
    { name: 'mạng', fetch: async () => { throw new Error('ECONNRESET'); }, url: 'https://cdn.zalo.example/x.jpg', re: /không tải được ảnh/ },
  ];
  for (const c of cases) {
    const { z, ai, sent, dir } = mk({ imgFetch: c.fetch });
    await z.onUpdate(imgEv({ photo_url: c.url }), true);
    assert.equal(ai.length, 0, c.name); assert.equal(sent.length, 1, c.name); assert.match(sent[0].text, /chưa tải được ảnh/, c.name); assert.match(sent[0].text, c.re, c.name);
    assert.ok(!fs.existsSync(path.join(dir, 'inbox')) || fs.readdirSync(path.join(dir, 'inbox')).every((d) => fs.readdirSync(path.join(dir, 'inbox', d)).length === 0), 'không để lại tệp: ' + c.name);
  }
});

test('zaloBot ảnh: cùng luật người dùng — người lạ nhắn RIÊNG kèm ảnh bị bỏ qua (không tải ảnh); trong nhóm thì được; ảnh gửi trùng bỏ qua', async () => {
  let n = 0; const { z, ai } = mk({ imgFetch: async () => { n++; return imgRes(JPG); } });
  await z.onUpdate(imgEv({ from: { id: 'nv77', display_name: 'NV', is_bot: false }, chat: { id: 'nv77', chat_type: 'PRIVATE' } }), true);
  assert.equal(ai.length, 0); assert.equal(n, 0);
  const e = imgEv({ from: { id: 'nv77', display_name: 'NV', is_bot: false } }); await z.onUpdate(e, true); await z.onUpdate(e, true);
  assert.equal(ai.length, 1); assert.equal(n, 1); assert.match(ai[0].prompt, /KHÔNG phải chủ máy/);
});
