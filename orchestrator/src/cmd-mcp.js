#!/usr/bin/env node
'use strict';

// MÁY CHỦ MCP "agentos_cmd": cho AI chạy LỆNH CỦA BOT thay chủ máy khi họ nhờ bằng lời (xem cmdTool.js): `bot_command` chạy một lệnh, `bot_help` liệt kê lệnh.
// Mọi lệnh đi qua cổng duyệt của bộ điều phối (HTTP 127.0.0.1, gate.js /cmd): cổng kiểm chủ máy, hỏi bằng nút bấm với lệnh nhạy cảm, rồi chạy đúng đường như khi chủ máy tự gõ.
// Biến môi trường: AGENTOS_GATE_URL, AGENTOS_GATE_TOKEN, AGENTOS_JOB_ID. Mọi lỗi -> báo lỗi cho AI (không bao giờ im lặng làm như thành công).
const { TOOLS_HELP } = require('./cmdTool');

const TOOLS = [
  { name: 'bot_command', description: TOOLS_HELP, inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'Lệnh đầy đủ bắt đầu bằng "/", ví dụ "/doanhso hôm nay"' } }, required: ['command'] } },
  { name: 'bot_help', description: 'Xem danh sách mọi lệnh của bot và cách dùng (để biết cú pháp trước khi gọi bot_command).', inputSchema: { type: 'object', properties: {} } },
];

// deps: { url, token, jobId, fetch }
function createHandler(deps) {
  const doFetch = deps.fetch || ((...a) => fetch(...a));
  const text = (t, isError) => ({ content: [{ type: 'text', text: String(t) }], isError: !!isError });
  return async function call(name, args) {
    if (name !== 'bot_command' && name !== 'bot_help') return text('Công cụ lạ: ' + name, true);
    if (!deps.url || !deps.token || !deps.jobId) return text('Cổng lệnh chưa được cấu hình.', true);
    const command = name === 'bot_help' ? '/help' : String((args && args.command) || '');
    try {
      const r = await doFetch(deps.url + '/cmd', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': deps.token }, body: JSON.stringify({ jobId: deps.jobId, command, help: name === 'bot_help' }) });
      if (!r.ok) return text('Cổng lệnh trả lỗi ' + r.status + '.', true);
      const j = await r.json();
      if (!j || typeof j !== 'object') return text('Cổng lệnh trả dữ liệu lạ.', true);
      if (!j.ok) return text(j.error || 'Không chạy được lệnh.', true);
      return text((j.text || '(đã chạy xong, lệnh không trả chữ)') + (j.files ? '\n(Đã gửi ' + j.files + ' tệp/ảnh cho chủ máy trong Telegram.)' : ''));
    } catch (e) { return text('Không liên lạc được cổng lệnh: ' + e.message, true); }
  };
}

function createServer(deps) {
  const call = createHandler(deps);
  return async function handle(m) {
    if (!m || m.method === undefined) return null;
    const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agentos-cmd', version: '1.0.0' } });
    if (m.method === 'ping') return reply({});
    if (m.method === 'tools/list') return reply({ tools: TOOLS });
    if (m.method === 'tools/call') return reply(await call(m.params && m.params.name, m.params && m.params.arguments));
    return m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Không hỗ trợ ' + m.method } };
  };
}

function main() {
  const handle = createServer({ url: process.env.AGENTOS_GATE_URL, token: process.env.AGENTOS_GATE_TOKEN, jobId: Number(process.env.AGENTOS_JOB_ID) });
  let buf = '', chain = Promise.resolve();
  process.stdin.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      chain = chain.then(() => handle(m)).then((r) => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); }).catch(() => {});
    }
  });
  process.stdin.on('end', () => chain.then(() => process.exit(0)));
}

module.exports = { TOOLS, createHandler, createServer };
if (require.main === module) main();
