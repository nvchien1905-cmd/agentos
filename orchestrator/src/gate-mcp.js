'use strict';
// Máy chủ MCP (stdio) tối giản, chỉ có một công cụ `approve`, dùng làm --permission-prompt-tool của Claude Code.
// Nó chuyển yêu cầu sang cổng duyệt của bộ điều phối (HTTP 127.0.0.1) rồi trả quyết định.
// Biến môi trường: AGENTOS_GATE_URL, AGENTOS_GATE_TOKEN, AGENTOS_JOB_ID. Mọi lỗi -> TỪ CHỐI.
const readline = require('readline');

const URL_ = process.env.AGENTOS_GATE_URL;
const TOKEN = process.env.AGENTOS_GATE_TOKEN;
const JOB = Number(process.env.AGENTOS_JOB_ID);
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

async function approve(args) {
  const deny = (message) => ({ behavior: 'deny', message });
  if (!URL_ || !TOKEN || !JOB) return deny('Cổng duyệt chưa được cấu hình.');
  try {
    const r = await fetch(URL_ + '/gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gate-token': TOKEN },
      body: JSON.stringify({ jobId: JOB, tool: args.tool_name, input: args.input || {} }),
    });
    if (!r.ok) return deny('Cổng duyệt trả lỗi ' + r.status + '.');
    const j = await r.json();
    return j && (j.behavior === 'allow' || j.behavior === 'deny') ? j : deny('Cổng duyệt trả dữ liệu lạ.');
  } catch (e) {
    return deny('Không liên lạc được cổng duyệt: ' + e.message);
  }
}

const TOOL = {
  name: 'approve',
  description: 'Xin quyền dùng một công cụ (do bộ điều phối AgentOS quyết định).',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

const rl = readline.createInterface({ input: process.stdin });
let inflight = 0, closed = false;
const maybeExit = () => { if (closed && inflight === 0) process.exit(0); };
rl.on('line', async (line) => {
  inflight++;
  try { await handle(line); } finally { inflight--; maybeExit(); }
});
rl.on('close', () => { closed = true; maybeExit(); });   // đóng stdin: trả lời nốt các yêu cầu đang chờ rồi mới thoát

async function handle(line) {
  let m; try { m = JSON.parse(line); } catch (e) { return; }
  if (m.id === undefined) return;                       // thông báo (initialized...) không cần trả lời
  switch (m.method) {
    case 'initialize': {
      const want = m.params && m.params.protocolVersion;
      return reply(m.id, {
        protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'agentos-gate', version: '1.0.0' },
      });
    }
    case 'ping': return reply(m.id, {});
    case 'tools/list': return reply(m.id, { tools: [TOOL] });
    case 'tools/call': {
      if (!m.params || m.params.name !== 'approve') return fail(m.id, -32602, 'Công cụ không có');
      const decision = await approve(m.params.arguments || {});
      return reply(m.id, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
    }
    default: return fail(m.id, -32601, 'Không hỗ trợ: ' + m.method);
  }
}
