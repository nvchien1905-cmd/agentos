'use strict';
// Máy khách của trợ lý màn hình (deskd, chạy bằng root ở /run/agentos/desk.sock): gửi một lệnh cố định, nhận kết quả JSON.
const net = require('net');

function createDeskClient(sock, opts) {
  const agent = String((opts && opts.agent) || process.env.AGENT_ID || '');       // bot phụ (a1, a2…): trình duyệt đăng nhập mở bằng hồ sơ RIÊNG của bot đó
  const path = sock || process.env.DESK_SOCKET || '/run/agentos/desk.sock';
  return {
    call(req, timeoutMs) {
      if (agent && new RegExp('^a\\d{1,3}$').test(agent) && req && (req.cmd === 'open' || req.cmd === 'close') && req.agent === undefined) req = Object.assign({}, req, { agent });
      return new Promise((resolve) => {
        const c = net.connect(path);
        let buf = '', done = false;
        const fin = (r) => { if (!done) { done = true; clearTimeout(t); try { c.destroy(); } catch (e) { /* */ } resolve(r); } };
        const t = setTimeout(() => fin({ ok: false, error: 'Trợ lý màn hình không trả lời kịp.' }), timeoutMs || 60000);
        c.setEncoding('utf8');
        c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
        c.on('data', (d) => { buf += d; });
        c.on('end', () => { try { fin(JSON.parse(buf)); } catch (e) { fin({ ok: false, error: 'Trợ lý màn hình trả lời không đọc được.' }); } });
        c.on('error', (e) => fin({ ok: false, error: e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'Trợ lý màn hình (agentos-deskd) chưa chạy trên máy này.' : 'Lỗi trợ lý màn hình: ' + e.message }));
      });
    },
  };
}

module.exports = { createDeskClient };
