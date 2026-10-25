'use strict';
// Giả lập `claude -p --output-format json`: đọc prompt từ stdin, hành vi theo nội dung prompt.
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
  const out = (o) => process.stdout.write(JSON.stringify(Object.assign({ type: 'result', session_id: 'sess-1', total_cost_usd: 0.01 }, o)));
  if (args.includes('stream-json') && input.includes('STREAM')) {
    const w = (o) => process.stdout.write(JSON.stringify(o) + '\n');
    w({ type: 'system', subtype: 'init' });
    w({ type: 'assistant', message: { content: [{ type: 'text', text: 'Để em xem thử' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls /opt' } }] } });
    w({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(6 * 1024 * 1024) }] } });
    w({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/opt/a/b/c/d.txt' } }] } });
    w({ type: 'result', is_error: false, result: '**Xong** rồi', session_id: 'sess-s', total_cost_usd: 0.01 });
    return;
  }
  if (input.includes('LIMIT')) { out({ is_error: true, result: 'Claude usage limit reached. Your limit will reset at 5pm.' }); process.exit(1); }
  if (input.includes('OVERLOAD')) { out({ is_error: true, result: 'API Error: 529 Overloaded. Please try again in a moment.' }); process.exit(1); }
  if (input.includes('FAIL')) { process.stderr.write('boom'); process.exit(2); }
  if (input.includes('SLOW')) { setTimeout(() => out({ is_error: false, result: 'late' }), 10000); return; }
  if (input.includes('NOSESSION') && resume) { out({ is_error: true, result: 'No conversation found with session ID ' + resume }); process.exit(1); }
  out({ is_error: false, result: 'echo:' + input.trim() + (resume ? '|resume=' + resume : '') + '|args=' + args.join(' ') });
});
