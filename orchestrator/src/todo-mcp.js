#!/usr/bin/env node
'use strict';

// MÁY CHỦ MCP "agentos_todo": công cụ lập DANH SÁCH VIỆC CẦN LÀM cho AI (thay công cụ TodoWrite của Claude Code — bản Claude Code chạy không tương tác (-p) KHÔNG có công cụ này).
// AI gọi todo_set({todos:[{content,status,activeForm}]}) mỗi khi lập/cập nhật danh sách; công cụ KHÔNG làm gì khác ngoài trả lời "đã ghi" — bộ điều phối đọc đối số của lệnh gọi (progress.js)
// để hiện ☑ xong · ▶️ đang làm · ☐ chờ trên Telegram và trong màn hình Việc AI. Không đọc/ghi tệp, không mạng → an toàn, tự cho phép (policy.js).
const TOOL = {
  name: 'todo_set',
  description: 'Lập hoặc cập nhật DANH SÁCH VIỆC CẦN LÀM của việc đang làm (dùng cho việc từ 3 bước trở lên). Luôn gửi TOÀN BỘ danh sách mỗi lần: mỗi mục có content (việc, câu mệnh lệnh ngắn), status (pending | in_progress | completed) và activeForm (cách nói lúc đang làm, vd "Đang đọc dữ liệu"). Chỉ MỘT mục in_progress tại một thời điểm; đánh dấu completed ngay khi xong từng việc.',
  inputSchema: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { type: 'string' } }, required: ['content', 'status'] } } }, required: ['todos'] },
};

function handle(m) {
  if (!m || m.method === undefined) return null;
  const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agentos-todo', version: '1.0.0' } });
  if (m.method === 'ping') return reply({});
  if (m.method === 'tools/list') return reply({ tools: [TOOL] });
  if (m.method === 'tools/call') {
    const n = m.params && m.params.arguments && Array.isArray(m.params.arguments.todos) ? m.params.arguments.todos.length : 0;
    return reply({ content: [{ type: 'text', text: 'Đã ghi danh sách việc cần làm (' + n + ' việc). Tiếp tục làm theo danh sách.' }] });
  }
  return m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Không hỗ trợ ' + m.method } };
}

function main() {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      const r = handle(m); if (r) process.stdout.write(JSON.stringify(r) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

module.exports = { handle, TOOL };
if (require.main === module) main();
