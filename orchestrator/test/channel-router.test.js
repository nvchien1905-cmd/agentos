'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createChannelRouter, mdToPlain, htmlToPlain, isZl } = require('../src/channelRouter');
const { createZaloBot } = require('../src/zaloBot');

function mkRouter(opts) {
  const tgLog = [], zl = [];
  const tg = {
    sendMessage: async (c, t) => { tgLog.push(['sendMessage', c, t]); }, sendRich: async (c, t) => { tgLog.push(['sendRich', c, t]); },
    sendHtml: async (c, t) => { tgLog.push(['sendHtml', c, t]); return 77; }, editHtml: async (c, m, t) => { tgLog.push(['editHtml', c, m]); },
    deleteMessage: async (c, m) => { tgLog.push(['deleteMessage', c, m]); }, sendChatAction: async (c, a) => { tgLog.push(['sendChatAction', c, a]); },
    sendButtons: async (c, t, b) => { tgLog.push(['sendButtons', c, t]); return 5; }, editMessage: async (c, m, t) => { tgLog.push(['editMessage', c, m, t]); },
    answerCallback: async (id) => { tgLog.push(['answerCallback', id]); }, sendFile: async (c, f) => { tgLog.push(['sendFile', c, f.name]); }, call: async (m, p) => { tgLog.push(['call', m]); return {}; },
    getUpdates: async () => [], getMe: async () => ({ username: 'tgbot' }),
  };
  const ref = { v: { send: async (id, t) => { if (opts && opts.failSend) throw new Error('mạng'); zl.push(['send', id, t]); }, typing: async (id) => { zl.push(['typing', id]); }, sendPhoto: async (id, p) => { zl.push(['photo', id, path.basename(p)]); }, sendFile: async (id, p, n) => { zl.push(['file', id, n]); } } };
  let t = 1000000; const logs = [];
  const r = createChannelRouter(tg, ref, { now: () => t, log: (m) => logs.push(m) });
  return { r, tgLog, zl, logs, adv: (ms) => { t += ms; } };
}

test('router: chat Telegram đi Telegram y như cũ, chat "zl:" đi Zalo (và không lọt sang Telegram)', async () => {
  const { r, tgLog, zl } = mkRouter();
  await r.sendMessage(123, 'chào'); await r.sendRich(123, '**đậm**'); await r.sendButtons(123, 'hỏi', [[{ text: 'A', data: 'a' }]]); await r.editMessage(123, 5, 'x'); await r.sendFile(123, { name: 'a.pdf', path: '/x', kind: 'document' });
  assert.deepEqual(tgLog.map((x) => x[0]), ['sendMessage', 'sendRich', 'sendButtons', 'editMessage', 'sendFile']);
  assert.equal(r.getUpdates.length, 0); assert.deepEqual(await r.getMe(), { username: 'tgbot' });
  tgLog.length = 0;
  await r.sendMessage('zl:u9', 'xin chào'); await r.sendRich('zl:u9', '## Tiêu đề\n**đậm** và `mã`');
  assert.deepEqual(tgLog, []); assert.deepEqual(zl, [['send', 'u9', 'xin chào'], ['send', 'u9', 'Tiêu đề\nđậm và mã']]);
  assert.ok(isZl('zl:1')); assert.ok(!isZl(123)); assert.ok(!isZl('sys:fp:1'));
});

test('router: tin trạng thái "Đang làm" gửi MỘT lần, sửa/xóa là không làm gì (Zalo không sửa được); typing không quá 1 lần/20 giây', async () => {
  const { r, zl, tgLog, adv } = mkRouter();
  const mid = await r.sendHtml('zl:u9', '⏳ <b>Đang làm…</b> <i>3 giây</i> &amp; xong');
  assert.ok(mid); await r.editHtml('zl:u9', mid, '<b>x</b>'); await r.deleteMessage('zl:u9', mid);
  assert.deepEqual(zl, [['send', 'u9', '⏳ Đang làm… 3 giây & xong']]); assert.deepEqual(tgLog, []);
  zl.length = 0; await r.sendChatAction('zl:u9', 'typing'); await r.sendChatAction('zl:u9', 'typing'); adv(21000); await r.sendChatAction('zl:u9', 'typing');
  assert.deepEqual(zl, [['typing', 'u9'], ['typing', 'u9']]);
  assert.equal(await r.answerCallback('zl-cb', ''), null); assert.deepEqual(tgLog, []);
});

test('router: nút bấm → tin chữ có số; trả lời "1"/"ok"/"huy"/số khác được hiểu là bấm nút; chat lạ không bị lẫn; hết hạn sau 1 giờ', async () => {
  const { r, zl, adv } = mkRouter();
  const mid = await r.sendButtons('zl:u9', '⚠️ Cho AI chạy lệnh rm?', [[{ text: '✅ Cho phép', data: 'ap:1:y' }, { text: '❌ Từ chối', data: 'ap:1:n' }]]);
  assert.ok(mid); assert.match(zl[0][2], /Cho AI chạy lệnh rm/); assert.match(zl[0][2], /1 = ✅ Cho phép/); assert.match(zl[0][2], /2 = ❌ Từ chối/); assert.match(zl[0][2], /"ok"/);
  assert.equal(r.takePending('zl:khac', 'ok'), null); assert.equal(r.takePending('zl:u9', 'doanh thu hôm nay'), null);
  assert.equal(r.takePending('zl:u9', 'OK.'), 'ap:1:y'); assert.equal(r.takePending('zl:u9', 'ok'), null, 'dùng một lần');
  await r.sendButtons('zl:u9', 'lại', [[{ text: 'A', data: 'a' }, { text: 'B', data: 'b' }]]);
  assert.equal(r.takePending('zl:u9', '2'), 'b'); await r.sendButtons('zl:u9', 'lại', [[{ text: 'A', data: 'a' }, { text: 'B', data: 'b' }]]);
  assert.equal(r.takePending('zl:u9', 'hủy'), 'b'); assert.equal(r.takePending('zl:u9', '9'), null);
  await r.sendButtons('zl:u9', 'lại', [[{ text: 'A', data: 'a' }]]); adv(3600001); assert.equal(r.takePending('zl:u9', 'ok'), null, 'hết hạn');
  await r.sendButtons('zl:u9', 'x', [[{ text: 'A', data: 'a' }]]); await r.editMessage('zl:u9', mid, '✅ Đã cho phép'); assert.equal(r.takePending('zl:u9', 'ok'), null, 'quyết xong thì bỏ chờ'); assert.equal(zl[zl.length - 1][2], '✅ Đã cho phép');
});

test('router: gửi tệp — ảnh JPEG/PNG/WebP đi sendPhoto, tệp khác đi sendFile; lỗi thì báo chữ, không ném', async () => {
  const { r, zl } = mkRouter();
  await r.sendFile('zl:u9', { path: '/tmp/a.jpg', name: 'a.jpg', kind: 'photo' }); await r.sendFile('zl:u9', { path: '/tmp/b.pdf', name: 'b.pdf', kind: 'document' }); await r.sendFile('zl:u9', { path: '/tmp/c.gif', name: 'c.gif', kind: 'photo' });
  assert.deepEqual(zl, [['photo', 'u9', 'a.jpg'], ['file', 'u9', 'b.pdf'], ['file', 'u9', 'c.gif']]);
  const ref = { v: { send: async (id, t) => { zl.push(['send', id, t]); }, sendFile: async () => { throw new Error('tệp quá lớn'); } } };
  const r2 = createChannelRouter({ sendFile: async () => {} }, ref, {}); zl.length = 0;
  await assert.doesNotReject(() => r2.sendFile('zl:u9', { path: '/big.zip', name: 'big.zip', kind: 'document' }));
  assert.match(zl[0][2], /chưa gửi được tệp "big.zip"/); assert.match(zl[0][2], /tệp quá lớn/);
});

test('router: gửi Zalo lỗi KHÔNG ném lên (nhiều nơi gọi không bắt lỗi); chưa có kênh Zalo thì im lặng', async () => {
  const { r, logs } = mkRouter({ failSend: true });
  await assert.doesNotReject(() => r.sendMessage('zl:u9', 'x')); await assert.doesNotReject(() => r.sendRich('zl:u9', 'x')); await assert.doesNotReject(() => r.sendButtons('zl:u9', 'x', [[{ text: 'A', data: 'a' }]]));
  assert.ok(logs.length >= 3 && /mạng/.test(logs[0]));
  const none = createChannelRouter({}, { v: null }, {}); await assert.doesNotReject(() => none.sendMessage('zl:u9', 'x'));
  assert.equal(htmlToPlain('a<br>b &lt;c&gt;'), 'a\nb <c>'); assert.equal(mdToPlain('**a** __b__ `c`'), 'a b c');
});

// ---------- zaloBot: chat RIÊNG của chủ máy chạy qua bộ não (core) ----------
const TK = '123456789:' + 'Z'.repeat(30);
function mkBot(extra) {
  extra = extra || {}; const core = [], sent = [], ai = []; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-'));
  const fetch = async (url, init) => { const m = url.split('/').pop(); if (m === 'sendMessage') sent.push(JSON.parse(init.body)); return { status: 200, json: async () => ({ ok: true, result: {} }) }; };
  const env = Object.assign({ ZALOBOT_TOKEN: TK, ZALOBOT_OWNERS: 'boss1' }, extra.env || {});
  const z = createZaloBot({ env, file: path.join(dir, 'z.json'), inboxDir: path.join(dir, 'inbox'), log: () => {}, fetch, imgFetch: extra.imgFetch, notify: async () => {}, runAI: async (k, p) => { ai.push({ k, p }); return { ok: true, text: 'q&a' }; },
    core: extra.noCore ? undefined : { handle: async (m) => { core.push(m); if (extra.throwCore) throw new Error('hỏng'); }, callback: async (cq) => { core.push({ cb: cq }); return 'Đã duyệt'; }, takePending: (c, t) => (extra.pending && /^ok$/i.test(t) ? extra.pending : null) } });
  return { z, core, sent, ai, dir };
};
const ev = (text, o) => ({ event_name: 'message.text.received', message: Object.assign({ message_id: 'm' + Math.random(), from: { id: 'boss1', display_name: 'Anh Chiến', is_bot: false }, chat: { id: 'boss1', chat_type: 'PRIVATE' }, text }, o || {}) });

test('chủ máy nhắn RIÊNG → chạy nguyên bộ não (như Telegram): tin gốc, mã chat "zl:<id>", KHÔNG qua nhánh hỏi-đáp giới hạn', async () => {
  const { z, core, ai } = mkBot();
  await z.onUpdate(ev('/trangthai'), true); await z.onUpdate(ev('kiểm tra doanh thu hôm nay giúp anh'), true);
  assert.equal(ai.length, 0); assert.equal(core.length, 2);
  assert.equal(core[0].text, '/trangthai'); assert.equal(core[0].chat.id, 'zl:boss1'); assert.equal(core[0].from.id, 'zl:boss1'); assert.equal(core[0].chat.type, 'private'); assert.ok(core[1].message_id > core[0].message_id);
});

test('chủ máy trả lời việc chờ duyệt bằng chữ → gọi callback đúng nút, KHÔNG gửi thành lệnh mới', async () => {
  const { z, core, sent } = mkBot({ pending: 'ap:7:y' });
  await z.onUpdate(ev('ok'), true);
  assert.equal(core.length, 1); assert.equal(core[0].cb.data, 'ap:7:y'); assert.equal(core[0].cb.from.id, 'zl:boss1'); assert.equal(core[0].cb.message.chat.id, 'zl:boss1');
  assert.equal(sent[0].text, 'Đã duyệt');
});

test('chủ máy gửi ẢNH riêng → lưu vào inbox/zl_<id>/ rồi đưa đường dẫn cho bộ não như ảnh Telegram', async () => {
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 2)]);
  const { z, core, dir } = mkBot({ imgFetch: async () => ({ status: 200, headers: { get: () => '104' }, arrayBuffer: async () => JPG.buffer.slice(JPG.byteOffset, JPG.byteOffset + JPG.length) }) });
  await z.onUpdate({ event_name: 'message.image.received', message: { message_id: 'i1', from: { id: 'boss1', display_name: 'A' }, chat: { id: 'boss1', chat_type: 'PRIVATE' }, photo_url: 'https://cdn.zalo.example/a.jpg', caption: 'đọc hóa đơn' } }, true);
  assert.equal(core.length, 1); assert.match(core[0].text, /^đọc hóa đơn\n\[Tệp đính kèm/); const m = /- Ảnh: (\S+\.jpg)/.exec(core[0].text); assert.ok(m);
  assert.ok(m[1].replace(/\\/g, '/').includes('/inbox/zl_boss1/')); assert.ok(fs.existsSync(m[1]));
});

test('chủ máy: core lỗi → báo lỗi lịch sự, không im lặng, không sập', async () => {
  const { z, sent } = mkBot({ throwCore: true });
  await assert.doesNotReject(() => z.onUpdate(ev('/lenh'), true));
  assert.match(sent[0].text, /Em gặp lỗi khi xử lý tin này/); assert.match(sent[0].text, /hỏng/);
});

test('chỉ chat RIÊNG của chủ máy mới vào bộ não: trong NHÓM, người lạ, hoặc tắt ZALOBOT_FULL vẫn là hỏi-đáp giới hạn', async () => {
  const g = mkBot(); await g.z.onUpdate(ev('/trangthai', { chat: { id: 'grp1', chat_type: 'GROUP' } }), true);
  assert.equal(g.core.length, 0); assert.equal(g.ai.length, 1); assert.equal(g.ai[0].k, 'sys:zb:grp1');
  const s = mkBot(); await s.z.onUpdate(ev('/trangthai', { from: { id: 'ke-la', display_name: 'Lạ' }, chat: { id: 'ke-la', chat_type: 'PRIVATE' } }), true);
  assert.equal(s.core.length, 0); assert.equal(s.ai.length, 0);
  const off = mkBot({ env: { ZALOBOT_FULL: '0' } }); await off.z.onUpdate(ev('/trangthai'), true);
  assert.equal(off.core.length, 0); assert.equal(off.ai.length, 1);
  const no = mkBot({ noCore: true }); await no.z.onUpdate(ev('/trangthai'), true); assert.equal(no.ai.length, 1);
  assert.equal(mkBot().z.status().full, true); assert.equal(off.z.status().full, false);
});
