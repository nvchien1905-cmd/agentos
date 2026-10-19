'use strict';
const { runProcess, abnormal } = require('./proc');
const { classifyFailure, parseResetTime } = require('../limits');

// Lấy đối tượng JSON kiểu {"type":"result",...} từ đầu ra của `claude -p --output-format json`.
function parseOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  let v = tryParse(text);
  if (!v) {
    const lines = text.split(/\r?\n/).reverse();
    for (const l of lines) { v = tryParse(l.trim()); if (v) break; }
  }
  if (Array.isArray(v)) v = v.slice().reverse().find((x) => x && x.type === 'result') || null;
  return v && typeof v === 'object' ? v : null;
}

// Chạy một việc bằng Claude Code. Trả { done: Promise<kết quả>, kill() }.
// Kết quả: { ok, text, sessionId, costUsd, limit, resetAt, cancelled, timedOut, error }
function startClaude(opts) {
  const args = [].concat(opts.binArgs || [], ['-p', '--output-format', 'json']);
  if (opts.allowedTools) args.push('--allowedTools', opts.allowedTools);
  // Công cụ MCP trả lời mọi câu hỏi xin quyền (cổng duyệt của AgentOS), ví dụ mcp__agentos_gate__approve
  if (opts.permissionPromptTool) args.push('--permission-prompt-tool', opts.permissionPromptTool);
  // File settings chứa hook PreToolUse (cổng duyệt chạy trước MỌI công cụ, kể cả lệnh Claude tự coi là an toàn)
  if (opts.settings) args.push('--settings', opts.settings);
  // Chỉ dùng đúng máy chủ MCP của bộ công cụ này, bỏ qua mọi cấu hình MCP khác trên máy.
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig, '--strict-mcp-config');
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.resumeId) args.push('--resume', opts.resumeId);

  const p = runProcess({ bin: opts.bin, args, cwd: opts.cwd, input: opts.prompt, timeoutMs: opts.timeoutMs, env: opts.env, wrap: opts.wrap });
  const done = p.done.then((r) => {
    const ab = abnormal(r, opts.bin);
    if (ab) return ab;
    const j = parseOutput(r.out);
    const text = j && typeof j.result === 'string' ? j.result : '';
    const isError = !j || j.is_error === true || r.code !== 0;
    const hay = text + '\n' + r.err;
    const cls = isError ? classifyFailure(hay) : { limit: false, transient: false };
    const limit = cls.limit;
    return {
      ok: !isError,
      text,
      sessionId: j && j.session_id ? j.session_id : null,
      costUsd: j && typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
      limit,
      transient: cls.transient,
      resetAt: limit ? parseResetTime(hay) : null,
      error: isError ? (text || r.err.trim().slice(0, 1000) || 'Thoát với mã ' + r.code) : null,
    };
  });
  return { done, kill: p.kill };
}

module.exports = { startClaude, parseOutput };
