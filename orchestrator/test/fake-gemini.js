'use strict';
// Giả lập `gemini -p "" --output-format json ...`: đọc prompt từ stdin, in một đối tượng JSON như Gemini CLI.
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
  const at = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  if (input.includes('NOAUTH')) {
    out({ session_id: 'g-1', error: { type: 'Error', message: 'Please set an Auth method in your /var/lib/agentos/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA', code: 41 } });
    process.exit(41);
  }
  if (input.includes('LIMIT')) {
    out({ session_id: 'g-1', error: { type: 'ApiError', message: 'You have exhausted your capacity on this model. Your quota will reset after 2h30m. (429 RESOURCE_EXHAUSTED)', code: 429 } });
    process.exit(1);
  }
  if (input.includes('BUSY')) { out({ session_id: 'g-1', error: { type: 'ApiError', message: 'The model is overloaded. Please try again later. (503)', code: 503 } }); process.exit(1); }
  if (input.includes('FAIL')) { process.stderr.write('gemini boom'); process.exit(2); }
  if (input.includes('NOSESSION') && at('--resume')) { out({ session_id: 'g-2', error: { type: 'Error', message: 'No conversation found with session ID ' + at('--resume'), code: 1 } }); process.exit(1); }
  if (input.includes('WARN')) process.stdout.write('(!) Warning: basic terminal\n');
  out({ session_id: 'g-1', response: 'gemini:' + input.trim() + (at('--resume') ? '|resume=' + at('--resume') : '') + '|args=' + args.join(' '), stats: { models: {} } });
});
