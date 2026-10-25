'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TASKS } = require('./tasks');

// Chạy bộ bài đo trên một AI. startFn(taskDir, prompt, env) -> { done: Promise<{ok,text,error}>, kill() }.
// Trả { engine, passed, total, percent, results:[{id,name,pass,secs,answer,error}] }.
async function runEval({ tasks, startFn, engine, timeoutMs, log }) {
  tasks = tasks || TASKS; log = log || (() => {}); timeoutMs = timeoutMs || 300000;
  const results = [];
  for (const t of tasks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-' + t.id + '-'));
    const t0 = Date.now();
    let res = { ok: false, text: '', error: '' };
    try {
      t.setup(dir);
      const h = startFn(dir, t.prompt, t.env || {});
      const guard = new Promise((r) => setTimeout(() => { try { h.kill('timeout'); } catch (e) { /* đã dừng */ } r({ ok: false, text: '', error: 'quá ' + Math.round(timeoutMs / 1000) + ' giây' }); }, timeoutMs).unref());
      res = await Promise.race([h.done, guard]);
    } catch (e) { res = { ok: false, text: '', error: e.message }; }
    let pass = false;
    try { pass = !!t.check(dir, res.text); } catch (e) { pass = false; }
    results.push({ id: t.id, name: t.name, pass, secs: Math.round((Date.now() - t0) / 1000), answer: String(res.text || '').slice(0, 200), error: res.ok ? '' : String(res.error || '').slice(0, 200) });
    log((pass ? '✅ ' : '❌ ') + t.name);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const passed = results.filter((x) => x.pass).length;
  return { engine, passed, total: results.length, percent: results.length ? Math.round(100 * passed / results.length) : 0, results };
}

function format(rep) {
  return '📊 ' + rep.engine + ': ' + rep.passed + '/' + rep.total + ' bài đúng (' + rep.percent + '%)\n' +
    rep.results.map((r) => (r.pass ? '✅ ' : '❌ ') + r.name + ' (' + r.secs + ' giây)' + (r.pass ? '' : r.error ? ' — ' + r.error : ' — trả lời: ' + r.answer.replace(/\s+/g, ' ').slice(0, 80))).join('\n');
}

module.exports = { runEval, format };

// node src/eval/run.js claude|codex|gemini [--task id]   (chạy trên máy đã đăng nhập sẵn AI; tốn hạn mức)
if (require.main === module) {
  const eng = process.argv[2];
  const only = process.argv.includes('--task') ? process.argv[process.argv.indexOf('--task') + 1] : null;
  const cfg = require('../config');
  const env = process.env;
  const make = {
    claude: (dir, prompt, e) => require('../engines/claude').startClaude({ bin: env.CLAUDE_BIN || 'claude', cwd: dir, prompt, skipPermissions: true, timeoutMs: 280000, env: Object.assign({}, env, e) }),
    codex: (dir, prompt, e) => require('../engines/codex').startCodex({ bin: env.CODEX_BIN || 'codex', cwd: dir, prompt, sandbox: 'workspace-write', timeoutMs: 280000, env: Object.assign({}, env, e) }),
    gemini: (dir, prompt, e) => require('../engines/gemini').startGemini({ bin: env.GEMINI_BIN || 'gemini', cwd: dir, prompt, mode: 'yolo', timeoutMs: 280000, env: Object.assign({}, env, e) }),
  }[eng];
  if (!make) { console.error('Cách dùng: node src/eval/run.js <claude|codex|gemini> [--task <mã bài>]'); process.exit(2); }
  void cfg;
  runEval({ tasks: only ? TASKS.filter((t) => t.id === only) : TASKS, startFn: make, engine: eng, log: console.log }).then((rep) => { console.log('\n' + format(rep)); process.exit(rep.passed === rep.total ? 0 : 1); });
}
