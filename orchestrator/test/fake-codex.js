'use strict';
// Giả lập `codex exec --json`: đọc prompt từ stdin, in luồng JSONL theo tài liệu Codex.
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const ev = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const resume = args[0] === 'exec' && args[1] === 'resume' ? args[2] : null;
  if (input.includes('LIMIT')) {
    ev({ type: 'thread.started', thread_id: 'thr-1' });
    ev({ type: 'error', message: "You've hit your usage limit. Try again in 2 hours." });
    ev({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 2 hours." } });
    process.exit(1);
  }
  if (input.includes('FAIL')) { process.stderr.write('codex boom'); process.exit(2); }
  ev({ type: 'thread.started', thread_id: 'thr-1' });
  ev({ type: 'turn.started' });
  ev({ type: 'item.completed', item: { type: 'reasoning', text: 'nghĩ' } });
  ev({ type: 'item.completed', item: { type: 'agent_message', text: 'codex:' + input.trim() + (resume ? '|resume=' + resume : '') + '|args=' + args.join(' ') } });
  ev({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
