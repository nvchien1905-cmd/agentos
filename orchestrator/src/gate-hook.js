'use strict';
// Hook PreToolUse của Claude Code: chạy TRƯỚC MỌI lần dùng công cụ (kể cả lệnh Claude tự coi là an toàn như echo/ls/cat,
// vốn không bao giờ hỏi quyền). Hỏi cổng duyệt của bộ điều phối rồi trả quyết định. Mọi lỗi -> TỪ CHỐI (fail closed).
// Biến môi trường (do bộ điều phối đặt cho tiến trình claude): AGENTOS_GATE_URL, AGENTOS_GATE_TOKEN, AGENTOS_JOB_ID.
const URL_ = process.env.AGENTOS_GATE_URL;
const TOKEN = process.env.AGENTOS_GATE_TOKEN;
const JOB = Number(process.env.AGENTOS_JOB_ID);
const WAIT_MS = (Number(process.env.AGENTOS_GATE_WAIT_SEC) || 330) * 1000;

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
}

async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let ev; try { ev = JSON.parse(raw); } catch (e) { return emit('deny', 'AgentOS: không đọc được yêu cầu của hook.'); }
  if (!URL_ || !TOKEN || !JOB) return emit('deny', 'AgentOS: cổng duyệt chưa được cấu hình.');
  try {
    const r = await fetch(URL_ + '/gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gate-token': TOKEN },
      body: JSON.stringify({ jobId: JOB, tool: ev.tool_name, input: ev.tool_input || {} }),
      signal: AbortSignal.timeout(WAIT_MS),
    });
    if (!r.ok) return emit('deny', 'AgentOS: cổng duyệt trả lỗi ' + r.status + '.');
    const j = await r.json();
    if (j && j.behavior === 'allow') return emit('allow', 'AgentOS: được phép.');
    return emit('deny', (j && j.message) || 'AgentOS: bị từ chối.');
  } catch (e) {
    return emit('deny', 'AgentOS: không liên lạc được cổng duyệt (' + e.message + ').');
  }
}
main();
