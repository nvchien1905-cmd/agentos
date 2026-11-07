'use strict';
// Máy chủ MCP giả để thử connectors.js: FAKE_MODE = ok | noisy | crash | hang | badinit
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'crash') { console.error('loi: token ' + (process.env.SECRET_TOKEN || '') + ' khong hop le'); process.exit(3); }
if (mode === 'hang') setInterval(() => {}, 1000);
else {
  const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      if (m.method === 'initialize') {
        if (mode === 'badinit') { console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -1, message: 'khong ho tro ' + (process.env.SECRET_TOKEN || '') } })); continue; }
        if (mode === 'noisy') console.log('dong nhat ky khong phai json');
        reply(m.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1' } });
      } else if (m.method === 'tools/list') {
        reply(m.id, { tools: [{ name: 'doc_trang' }, { name: 'gui_thu' }, { name: process.env.SECRET_TOKEN ? 'co_khoa' : 'khong_khoa' }] });
      }
    }
  });
}
