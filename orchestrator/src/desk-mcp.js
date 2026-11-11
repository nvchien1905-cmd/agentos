#!/usr/bin/env node
'use strict';

// MÁY CHỦ MCP "desk": cho AI NHÌN và ĐIỀU KHIỂN MÀN HÌNH THẬT của máy (như "computer use" của app Claude): chụp màn hình, đọc chữ trên màn hình (OCR),
// bấm, gõ, phím tắt, cuộn, kéo thả, mở ứng dụng, đưa cửa sổ lên trước. Mọi thao tác đi qua trợ lý màn hình deskd (desk.js, socket /run/agentos/desk.sock),
// KHÔNG có lệnh chạy bất kỳ, KHÔNG có khóa/tắt/khởi động lại máy.
// Vòng "nhìn → nghĩ → làm": mỗi thao tác trả kèm ảnh chụp mới (trừ khi screenshot=false) để AI thấy kết quả ngay và bước tiếp.
// Hàng rào (ngoài cổng duyệt của bộ điều phối, policy.js: thao tác hỏi chủ máy, "cho phép cả việc này" thì cho cả nhóm):
//   - tối đa DESK_MAX_ACTIONS thao tác mỗi lần chạy (mặc định 80), hết thì dừng và báo;
//   - KHÔNG gõ/bấm/phím khi cửa sổ đang chọn là trang ngân hàng, thanh toán, đăng nhập, mật khẩu (chủ máy tự làm);
//   - KHÔNG tự gửi tin nhắn: phím Enter / nút "Gửi" bị chặn khi cửa sổ đang chọn là Zalo, Messenger, Telegram, Gmail... (mở và đọc thì được).
const fs = require('fs');
const { createDeskClient } = require('./desk');
const { MONEY_RE } = require('./policy');

const SENSITIVE_RE = new RegExp(MONEY_RE.source + '|momo|zalopay|ví điện tử|vi dien tu|ngân hàng|ngan hang|\\bbank|visa|mastercard|thẻ tín dụng|the tin dung|cvv|mật khẩu|mat khau|password|passcode|đăng nhập|dang nhap|sign.?in|log.?in|xác minh|xac minh|captcha|otp|2fa|two.factor', 'i');
const CHAT_RE = /zalo|messenger|telegram|whatsapp|viber|skype|gmail|outlook|thunderbird|mail|thư điện tử|slack|discord|facebook|instagram/i;
const SEND_KEY_RE = /^(return|kp_enter|enter|ctrl\+(return|enter))$/i;
const SEND_TEXT_RE = /^(gửi|gui|send|đăng|dang|post|chuyển|chuyen)$/i;
const MAX_IMAGE = 4 * 1024 * 1024;

const num = { type: 'number' };
const shot = { type: 'boolean', description: 'Có kèm ảnh chụp màn hình mới sau thao tác không (mặc định có).' };
const TOOLS = [
  { name: 'screen_screenshot', description: 'Chụp màn hình thật của máy và trả ảnh. Gọi đầu tiên để biết màn hình đang có gì. Toạ độ trong ảnh = toạ độ thật để bấm.', inputSchema: { type: 'object', properties: {} } },
  { name: 'screen_info', description: 'Kích thước màn hình và tên cửa sổ đang chọn.', inputSchema: { type: 'object', properties: {} } },
  { name: 'screen_windows', description: 'Danh sách tiêu đề các cửa sổ đang hiện.', inputSchema: { type: 'object', properties: {} } },
  { name: 'screen_find', description: 'Tìm chữ trên màn hình (OCR), trả toạ độ giữa của từng chỗ thấy. Dùng để bấm đúng nút/menu theo tên thay vì đoán toạ độ.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'screen_click', description: 'Bấm chuột tại toạ độ (x, y) trên màn hình. button: 1 trái, 2 giữa, 3 phải.', inputSchema: { type: 'object', properties: { x: num, y: num, button: num, double: { type: 'boolean' }, screenshot: shot }, required: ['x', 'y'] } },
  { name: 'screen_click_text', description: 'Bấm vào chữ thấy trên màn hình (OCR), chỗ thứ nth (mặc định 1). Chính xác hơn đoán toạ độ.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, nth: num, double: { type: 'boolean' }, screenshot: shot }, required: ['text'] } },
  { name: 'screen_type', description: 'Gõ chữ vào ô đang chọn (tối đa 2000 ký tự). Không gõ mật khẩu.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, screenshot: shot }, required: ['text'] } },
  { name: 'screen_key', description: 'Nhấn phím hoặc tổ hợp phím, theo tên xdotool: Return, Tab, Escape, ctrl+c, ctrl+v, alt+Tab, Page_Down...', inputSchema: { type: 'object', properties: { key: { type: 'string' }, screenshot: shot }, required: ['key'] } },
  { name: 'screen_scroll', description: 'Cuộn chuột: direction up|down|left|right, amount số nấc (mặc định 3), tại (x, y) nếu có.', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: num, x: num, y: num, screenshot: shot }, required: ['direction'] } },
  { name: 'screen_drag', description: 'Kéo thả từ (x1, y1) tới (x2, y2).', inputSchema: { type: 'object', properties: { x1: num, y1: num, x2: num, y2: num, screenshot: shot }, required: ['x1', 'y1', 'x2', 'y2'] } },
  { name: 'screen_move', description: 'Rê chuột tới (x, y) mà không bấm (để hiện tooltip, menu rê).', inputSchema: { type: 'object', properties: { x: num, y: num, screenshot: shot }, required: ['x', 'y'] } },
  { name: 'screen_open', description: 'Mở ứng dụng trong danh sách an toàn: zalo, chrome, rustdesk, deepseek, chatgpt, claudeweb.', inputSchema: { type: 'object', properties: { app: { type: 'string' }, screenshot: shot }, required: ['app'] } },
  { name: 'screen_focus', description: 'Đưa cửa sổ có tên chứa chữ này lên trước.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, screenshot: shot }, required: ['name'] } },
  { name: 'screen_wait', description: 'Chờ vài giây (tối đa 10) cho trang/ứng dụng tải xong.', inputSchema: { type: 'object', properties: { seconds: num } } },
  { name: 'screen_clipboard_get', description: 'Đọc chữ đang ở bộ nhớ tạm của máy.', inputSchema: { type: 'object', properties: {} } },
];
const ACTIONS = new Set(['screen_click', 'screen_click_text', 'screen_type', 'screen_key', 'screen_scroll', 'screen_drag', 'screen_move', 'screen_open', 'screen_focus']);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// deps: { desk, readFile, rm, sleep, maxActions, settleMs }. Trả { content:[{type:'text'|'image',...}], isError? }
function createHandler(deps) {
  const desk = deps.desk || createDeskClient();
  const readFile = deps.readFile || ((f) => fs.readFileSync(f));
  const rm = deps.rm || ((f) => { try { fs.rmSync(f, { force: true }); } catch (e) { /* deskd tự dọn sau 10 phút */ } });
  const sleep = deps.sleep || wait;
  const maxActions = deps.maxActions || Number(process.env.DESK_MAX_ACTIONS) || 80;
  const settleMs = deps.settleMs === undefined ? 700 : deps.settleMs;
  let actions = 0;

  const text = (t) => ({ type: 'text', text: String(t) });
  const err = (t) => ({ content: [text(t)], isError: true });

  async function snapshot() {
    const r = await desk.call({ cmd: 'screenshot' }, 30000);
    if (!r.ok) return { content: [text('Không chụp được màn hình: ' + r.error)], isError: true };
    let buf;
    try { buf = readFile(r.file); } catch (e) { return { content: [text('Không đọc được ảnh chụp: ' + e.message)], isError: true }; }
    rm(r.file);
    if (buf.length > MAX_IMAGE) return { content: [text('Ảnh chụp quá lớn (' + Math.round(buf.length / 1048576) + ' MB), hãy giảm độ phân giải màn hình.')], isError: true };
    return { content: [{ type: 'image', data: Buffer.from(buf).toString('base64'), mimeType: 'image/png' }] };
  }

  // Cửa sổ đang chọn: để chặn thao tác ở nơi nhạy cảm
  async function activeTitle() {
    const r = await desk.call({ cmd: 'info' }, 15000);
    return r && r.ok ? String(r.active || '') : '';
  }

  async function act(name, a) {
    const title = await activeTitle();
    if (SENSITIVE_RE.test(title)) return err('DỪNG: cửa sổ đang chọn ("' + title.slice(0, 80) + '") là trang ngân hàng/thanh toán/đăng nhập/mật khẩu. Không được gõ hay bấm ở đây — hãy báo chủ máy tự làm bước này, rồi dừng.');
    if (CHAT_RE.test(title)) {
      if (name === 'screen_key' && SEND_KEY_RE.test(String(a.key || '').trim())) return err('DỪNG: cửa sổ "' + title.slice(0, 80) + '" là ứng dụng nhắn tin/thư. Không tự nhấn Enter (có thể gửi tin). Chỉ được mở và đọc; việc gửi tin để chủ máy tự làm.');
      if (name === 'screen_click_text' && SEND_TEXT_RE.test(String(a.text || '').trim())) return err('DỪNG: không tự bấm "' + a.text + '" trong ứng dụng nhắn tin/thư. Việc gửi để chủ máy tự làm.');
    }
    let req;
    switch (name) {
      case 'screen_click': req = { cmd: 'click', x: a.x, y: a.y, button: a.button || 1, double: !!a.double }; break;
      case 'screen_click_text': req = { cmd: 'clicktext', text: String(a.text || ''), nth: a.nth || 1, double: !!a.double }; break;
      case 'screen_type': {
        const t = String(a.text == null ? '' : a.text);
        if (!t || t.length > 2000) return err('Chữ cần gõ phải dài 1-2000 ký tự.');
        req = { cmd: 'type', text: t }; break;
      }
      case 'screen_key': req = { cmd: 'key', key: String(a.key || '') }; break;
      case 'screen_scroll': req = { cmd: 'scroll', dir: a.direction, amount: a.amount || 3, x: a.x, y: a.y }; break;
      case 'screen_drag': req = { cmd: 'drag', x: a.x1, y: a.y1, x2: a.x2, y2: a.y2 }; break;
      case 'screen_move': req = { cmd: 'move', x: a.x, y: a.y }; break;
      case 'screen_open': req = { cmd: 'open', app: String(a.app || '').toLowerCase() }; break;
      case 'screen_focus': req = { cmd: 'focus', name: String(a.name || '') }; break;
      default: return err('Công cụ lạ: ' + name);
    }
    const r = await desk.call(req, 90000);
    if (!r.ok) return err('Không làm được: ' + r.error);
    const out = [text('Đã làm: ' + name.replace(/^screen_/, '') + (r.text ? ' · bấm vào "' + r.text + '" (' + r.x + ',' + r.y + ')' : '') + '.')];
    if (a.screenshot !== false) {
      await sleep(name === 'screen_open' ? 2500 : settleMs);
      const s = await snapshot();
      if (!s.isError) out.push(s.content[0]); else out.push(text('(Không chụp được ảnh sau thao tác: ' + s.content[0].text + ')'));
    }
    return { content: out };
  }

  return async function call(name, a) {
    a = a || {};
    try {
      if (!TOOLS.some((t) => t.name === name)) return err('Công cụ lạ: ' + name);
      if (ACTIONS.has(name)) {
        if (actions >= maxActions) return err('DỪNG: đã dùng hết ' + maxActions + ' thao tác cho lần này. Báo chủ máy kết quả đã làm được và những gì còn dở; chủ máy giao tiếp nếu muốn làm tiếp.');
        actions++;
        return await act(name, a);
      }
      switch (name) {
        case 'screen_screenshot': return await snapshot();
        case 'screen_info': {
          const r = await desk.call({ cmd: 'info' }, 15000);
          return r.ok ? { content: [text('Màn hình ' + r.width + 'x' + r.height + ' · cửa sổ đang chọn: ' + (r.active || '(không rõ)'))] } : err('Lỗi: ' + r.error);
        }
        case 'screen_windows': {
          const r = await desk.call({ cmd: 'windows' }, 30000);
          return r.ok ? { content: [text((r.windows || []).join('\n') || '(không có cửa sổ nào)')] } : err('Lỗi: ' + r.error);
        }
        case 'screen_find': {
          const q = String(a.text || '').trim();
          if (!q || q.length > 80) return err('Chữ cần tìm phải dài 1-80 ký tự.');
          const r = await desk.call({ cmd: 'findtext', text: q }, 90000);
          if (!r.ok) return err('Lỗi: ' + r.error);
          return { content: [text(r.matches.length ? r.matches.map((m, i) => (i + 1) + '. "' + m.text + '" tại (' + m.cx + ',' + m.cy + ')').join('\n') : 'Không thấy chữ "' + q + '" trên màn hình.')] };
        }
        case 'screen_wait': {
          const s = Math.max(0, Math.min(10, Number(a.seconds) || 2));
          await sleep(s * 1000);
          return { content: [text('Đã chờ ' + s + ' giây.')] };
        }
        case 'screen_clipboard_get': {
          const r = await desk.call({ cmd: 'clipget' }, 15000);
          return r.ok ? { content: [text(r.text ? String(r.text).slice(0, 4000) : '(bộ nhớ tạm trống)')] } : err('Lỗi: ' + r.error);
        }
        default: return err('Công cụ lạ: ' + name);
      }
    } catch (e) { return err('Lỗi: ' + (e && e.message || e)); }
  };
}

function createServer(deps) {
  const call = createHandler(deps || {});
  return async function handle(m) {
    if (!m || m.method === undefined) return null;
    const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agentos-desk', version: '1.0.0' } });
    if (m.method === 'ping') return reply({});
    if (m.method === 'tools/list') return reply({ tools: TOOLS });
    if (m.method === 'tools/call') return reply(await call(m.params && m.params.name, m.params && m.params.arguments));
    return m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Không hỗ trợ ' + m.method } };
  };
}

function main() {
  const handle = createServer();
  let buf = '', chain = Promise.resolve();
  process.stdin.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      chain = chain.then(() => handle(m)).then((r) => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); }).catch(() => {});      // tuần tự: không hai thao tác màn hình chồng nhau
    }
  });
  process.stdin.on('end', () => chain.then(() => process.exit(0)));
}

module.exports = { TOOLS, ACTIONS, createHandler, createServer, SENSITIVE_RE, CHAT_RE };
if (require.main === module) main();
