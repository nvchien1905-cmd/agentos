'use strict';
const { runProcess, abnormal } = require('./proc');
const { classifyFailure, parseResetTime } = require('../limits');

// Đọc luồng JSONL của `codex exec --json`:
//   thread.started {thread_id} · item.completed {item:{type:'agent_message',text}} · turn.failed / error {message}
// CHƯA kiểm với Codex CLI thật (máy dev chưa cài) -> đối chiếu tài liệu, nên đọc khoan dung.
function parseEvents(stdout) {
  const r = { threadId: null, text: '', error: null, failed: false };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let ev; try { ev = JSON.parse(s); } catch (e) { continue; }
    if (ev.type === 'thread.started' && ev.thread_id) r.threadId = ev.thread_id;
    else if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') r.text = ev.item.text;
    else if (ev.type === 'turn.failed') { r.failed = true; r.error = (ev.error && ev.error.message) || ev.message || r.error || 'turn.failed'; }
    else if (ev.type === 'error') r.error = ev.message || (ev.error && ev.error.message) || r.error || 'error';
  }
  return r;
}

function startCodex(opts) {
  const args = [].concat(opts.binArgs || [], ['exec']);
  if (opts.resumeId) args.push('resume', opts.resumeId);
  args.push('--json', '--skip-git-repo-check');
  if (opts.extraArgs) args.push(...opts.extraArgs); // ví dụ -c mcp_servers... (chưa kiểm với Codex thật)
  if (!opts.resumeId && opts.sandbox) args.push('--sandbox', opts.sandbox);
  args.push('-'); // đọc prompt từ stdin

  const p = runProcess({ bin: opts.bin, args, cwd: opts.cwd, input: opts.prompt, timeoutMs: opts.timeoutMs, env: opts.env, wrap: opts.wrap });
  const done = p.done.then((r) => {
    const ab = abnormal(r, opts.bin);
    if (ab) return ab;
    const ev = parseEvents(r.out);
    const failed = ev.failed || r.code !== 0;
    const hay = (ev.error || '') + '\n' + r.err;
    const cls = failed ? classifyFailure(hay) : { limit: false, transient: false };
    const limit = cls.limit;
    return {
      ok: !failed,
      text: ev.text,
      sessionId: ev.threadId,
      costUsd: null,
      limit,
      transient: cls.transient,
      resetAt: limit ? parseResetTime(hay) : null,
      error: failed ? (ev.error || r.err.trim().slice(0, 1000) || 'Thoát với mã ' + r.code) : null,
    };
  });
  return { done, kill: p.kill };
}

module.exports = { startCodex, parseEvents };
