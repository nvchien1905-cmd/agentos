#!/usr/bin/env node
'use strict';
// agentos-desk: nhìn / điều khiển MÀN HÌNH THẬT của máy qua trợ lý màn hình (deskd). Dành cho AI và cho quản trị viên.
//   agentos-desk screenshot              chụp màn hình, in đường dẫn ảnh .png (xem bằng công cụ đọc ảnh)
//   agentos-desk windows                 liệt kê tiêu đề các cửa sổ đang hiện
//   agentos-desk open <ứng dụng>         zalo | kiotviet | deepseek | chrome | rustdesk | claude | codex | gemini
//   agentos-desk close <ứng dụng>
//   agentos-desk click <x> <y> [nút] [double]
//   agentos-desk info                    kích thước màn hình + cửa sổ đang chọn (toạ độ ảnh chụp = toạ độ thật)
//   agentos-desk focus <tên cửa sổ>      đưa cửa sổ có tên chứa chữ đó lên trước
//   agentos-desk find "chữ"              tìm chữ trên màn hình (OCR): in toạ độ giữa (cx,cy) của từng chỗ thấy
//   agentos-desk clicktext "chữ" [--nth=2] [--double]   bấm đúng vào chữ đó (nút, menu, ô theo tên) thay vì đoán toạ độ
//   agentos-desk clipget                 đọc chữ đang ở bộ nhớ tạm
//   agentos-desk move <x> <y>            rê chuột tới điểm (không bấm)
//   agentos-desk drag <x1> <y1> <x2> <y2>   kéo thả
//   agentos-desk scroll <up|down|left|right> [số nấc] [x y]   cuộn chuột
//   agentos-desk type "<chữ>"            gõ chữ vào ô đang chọn
//   agentos-desk key <phím>              VD: Return, ctrl+v, alt+F4
//   agentos-desk clip "<chữ>"            chép chữ vào bộ nhớ tạm (người dùng bấm Ctrl+V)
//   agentos-desk lock                    khóa màn hình
// Quy tắc: không tự gửi tin nhắn Zalo/chat cho người khác bằng cách gõ và bấm Gửi (Zalo có thể khóa tài khoản); chỉ mở và đọc.
const net = require('net');
const SOCK = process.env.DESK_SOCKET || '/run/agentos/desk.sock';

function call(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    const c = net.connect(SOCK);
    let buf = '';
    const t = setTimeout(() => { c.destroy(); reject(new Error('quá thời gian chờ trợ lý màn hình')); }, timeoutMs || 90000);
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
    c.on('data', (d) => { buf += d; });
    c.on('end', () => { clearTimeout(t); try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('trả lời không đọc được')); } });
    c.on('error', (e) => { clearTimeout(t); reject(new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'Trợ lý màn hình (agentos-deskd) chưa chạy' : e.message)); });
  });
}

module.exports = { call };

if (require.main === module) {
  const a = process.argv.slice(2);
  const cmd = a[0];
  const map = {
    screenshot: () => ({ cmd: 'screenshot' }), windows: () => ({ cmd: 'windows' }), who: () => ({ cmd: 'who' }), lock: () => ({ cmd: 'lock' }),
    open: () => ({ cmd: 'open', app: a[1] }), close: () => ({ cmd: 'close', app: a[1] }),
    click: () => ({ cmd: 'click', x: a[1], y: a[2], button: /^[1-5]$/.test(a[3] || '') ? a[3] : 1, double: a.includes('double') }),
    type: () => ({ cmd: 'type', text: a.slice(1).join(' ') }), key: () => ({ cmd: 'key', key: a.slice(1).join(' ') }),
    clip: () => ({ cmd: 'clip', text: a.slice(1).join(' ') }),
    move: () => ({ cmd: 'move', x: a[1], y: a[2] }), drag: () => ({ cmd: 'drag', x: a[1], y: a[2], x2: a[3], y2: a[4] }),
    scroll: () => ({ cmd: 'scroll', dir: a[1], amount: a[2], x: a[3], y: a[4] }),
    info: () => ({ cmd: 'info' }), focus: () => ({ cmd: 'focus', name: a.slice(1).join(' ') }),
    find: () => ({ cmd: 'findtext', text: a.slice(1).join(' ') }), clicktext: () => ({ cmd: 'clicktext', text: a.slice(1).filter((x) => !/^--(nth=\d+|double)$/.test(x)).join(' '), nth: (a.find((x) => /^--nth=\d+$/.test(x)) || '').slice(6) || 1, double: a.includes('--double') }),
    clipget: () => ({ cmd: 'clipget' }), unlock: () => ({ cmd: 'unlock' }),
  };
  if (!map[cmd]) { console.error(require('fs').readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(2); }
  call(map[cmd]()).then((r) => {
    if (!r.ok) { console.error('LỖI: ' + r.error); process.exit(1); }
    if (r.file) console.log(r.file);
    else if (r.windows) console.log(r.windows.join('\n') || '(không có cửa sổ nào)');
    else console.log(JSON.stringify(r));
  }).catch((e) => { console.error('LỖI: ' + e.message); process.exit(1); });
}
