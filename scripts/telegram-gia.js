// Telegram GIẢ để thử bộ điều phối trên máy ảo (KHÔNG dùng khi chạy thật). Nạp bằng: node -r ./telegram-gia.js src/index.js
//  - Chặn mọi gọi tới api.telegram.org, các URL khác đi thật.
//  - Tin của "chủ máy": ghi mỗi dòng vào $GIA_DIR/tg-vao.txt (mặc định /tmp) (dòng bắt đầu bằng "@duyet" = bấm nút đầu tiên của lời hỏi duyệt gần nhất).
//  - Mọi thứ bot gửi ra được ghi vào $GIA_DIR/tg-ra.log.
const fs = require('fs');
const DIR = process.env.GIA_DIR || '/tmp';
const IN = DIR + '/tg-vao.txt', OUT = DIR + '/tg-ra.log';
const OWNER = Number(process.env.GIA_OWNER || 111111);
let uid = 1000, mid = 5000, buttons = [], lastBtnMsg = null;
const log = (s) => fs.appendFileSync(OUT, new Date().toISOString().slice(11, 19) + ' ' + s + '\n');
const real = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (result) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });

function takeInput() {
  let t = ''; try { t = fs.readFileSync(IN, 'utf8'); fs.writeFileSync(IN, ''); } catch (e) { return []; }
  const ups = [];
  for (const line of t.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith('@duyet')) {
      if (lastBtnMsg) { ups.push({ update_id: ++uid, callback_query: { id: 'cb' + uid, from: { id: OWNER, first_name: 'Chu' }, message: { message_id: lastBtnMsg.mid, chat: { id: OWNER, type: 'private' } }, data: lastBtnMsg.btns[0].callback_data } }); log('[CHU bam nut] ' + lastBtnMsg.btns[0].text); }
      else log('[CHU] không có lời hỏi duyệt nào để bấm');
    } else {
      ups.push({ update_id: ++uid, message: { message_id: ++mid, from: { id: OWNER, first_name: 'Chu', is_bot: false }, chat: { id: OWNER, type: 'private' }, date: Math.floor(Date.now() / 1000), text: line } });
      log('[CHU] ' + line);
    }
  }
  return ups;
}

globalThis.fetch = async function (url, opts) {
  const u = String(url);
  if (!u.startsWith('https://api.telegram.org/')) return real(url, opts);
  const method = u.split('/').pop();
  let body = {};
  try { if (opts && typeof opts.body === 'string') body = JSON.parse(opts.body); } catch (e) { /* form */ }
  if (method === 'getMe') return ok({ id: 1, is_bot: true, username: 'bot_gia', first_name: 'Bot gia' });
  if (method === 'getUpdates') {
    for (let i = 0; i < 20; i++) { const ups = takeInput(); if (ups.length) return ok(ups); await sleep(500); }
    return ok([]);
  }
  if (method === 'sendMessage') {
    const m = ++mid;
    if (body.reply_markup && body.reply_markup.inline_keyboard) { lastBtnMsg = { mid: m, btns: body.reply_markup.inline_keyboard.flat() }; log('[BOT hỏi duyệt #' + m + '] ' + String(body.text).slice(0, 400).replace(/\n/g, ' | ') + '  NÚT: ' + lastBtnMsg.btns.map((b) => b.text).join(' / ')); }
    else log('[BOT] ' + String(body.text).slice(0, 1500).replace(/\n/g, ' ⏎ '));
    return ok({ message_id: m, chat: { id: body.chat_id } });
  }
  if (method === 'editMessageText') { log('[BOT sửa #' + body.message_id + '] ' + String(body.text).slice(0, 300).replace(/\n/g, ' | ')); return ok({ message_id: body.message_id }); }
  if (method === 'sendPhoto' || method === 'sendDocument') {
    let info = ''; try { const f = opts.body.get(method === 'sendPhoto' ? 'photo' : 'document'); info = (f && f.name) + ' ' + (f && f.size) + ' byte'; } catch (e) { /* */ }
    log('[BOT gửi ' + (method === 'sendPhoto' ? 'ẢNH' : 'FILE') + '] ' + info);
    return ok({ message_id: ++mid });
  }
  if (method === 'answerCallbackQuery') return ok(true);
  log('[?] ' + method + ' ' + JSON.stringify(body).slice(0, 200));
  return ok(true);
};
log('--- Telegram giả bắt đầu');
