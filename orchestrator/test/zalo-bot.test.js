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
  const z = createZaloBot({ env, file: path.join(dir, 'zb.json'), log: (m) => logs.push(m), fetch, notify: async (t) => { notes.push(t); }, runAI: async (key, prompt) => { ai.push({ key, prompt }); return (extra && extra.ai) ? extra.ai(key, prompt) : { ok: true, text: 'Trả lời mẫu' }; }, idleMs: 1, now: (extra && extra.now) });
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

test('zaloBot: người LẠ không được trả lời; chỉ báo chủ máy MỘT lần/ngày/người; không chạy AI', async () => {
  const { z, sent, ai, notes } = mk();
  const lạ = { from: { id: 'lalala', display_name: 'Kẻ Lạ', is_bot: false } };
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
