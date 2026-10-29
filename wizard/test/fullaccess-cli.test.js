'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { apply, setEnvLine } = require('../lib/fullaccess-cli');
const fa = require('../lib/fullaccess');

test('fullaccess-cli: on cài sudoers (kiểm visudo trước) + drop-in + FULL_ACCESS=1 và hẹn khởi động lại; off gỡ hết, giữ nguyên quyền tệp env', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'facli-'));
  const paths = { sudoers: path.join(d, 'sudoers.d', '90-tq'), dropin: path.join(d, 'drop', '10-tq.conf') };
  const envFile = path.join(d, 'orchestrator.env'); fs.writeFileSync(envFile, 'TELEGRAM_TOKEN=abc\nFULL_ACCESS=0\nJOB_TIMEOUT_SEC=900\n', { mode: 0o640 });
  const calls = []; const run = async (cmd, args) => { calls.push([cmd].concat(args).join(' ')); return { code: 0, out: '', err: '' }; };
  let r = await apply('on', { run, paths, envFile });
  assert.equal(r.enabled, true); assert.ok(fa.isEnabled(paths));
  assert.equal(fs.readFileSync(paths.sudoers, 'utf8'), fa.SUDOERS_TEXT); assert.equal(fs.readFileSync(paths.dropin, 'utf8'), fa.DROPIN_TEXT); assert.match(fa.DROPIN_TEXT, /NoNewPrivileges=no/);
  const t = fs.readFileSync(envFile, 'utf8'); assert.match(t, /^FULL_ACCESS=1$/m); assert.match(t, /^JOB_TIMEOUT_SEC=3600$/m); assert.match(t, /^TELEGRAM_TOKEN=abc$/m);
  assert.ok(calls.some((c) => /^visudo -cf /.test(c)), 'kiểm cú pháp sudoers'); assert.ok(calls.some((c) => c === 'systemctl daemon-reload'));
  assert.ok(calls.some((c) => /^systemd-run --on-active=5 .*systemctl restart agentos-orchestrator/.test(c)), 'hẹn khởi động lại bộ điều phối');
  if (process.platform !== 'win32') assert.equal(fs.statSync(envFile).mode & 0o777, 0o640);
  calls.length = 0; r = await apply('off', { run, paths, envFile });
  assert.equal(r.enabled, false); assert.ok(!fa.isEnabled(paths)); assert.ok(!fs.existsSync(paths.dropin));
  assert.match(fs.readFileSync(envFile, 'utf8'), /^FULL_ACCESS=0$/m); assert.match(fs.readFileSync(envFile, 'utf8'), /^JOB_TIMEOUT_SEC=900$/m);
  assert.deepEqual(await apply('status', { run, paths, envFile }), { enabled: false });
  await assert.rejects(apply('rm -rf', { run, paths, envFile }), /không hợp lệ/);
  // sudoers hỏng thì KHÔNG cài
  const bad = async (cmd) => (cmd === 'visudo' ? { code: 1, out: '', err: 'syntax error' } : { code: 0, out: '', err: '' });
  await assert.rejects(apply('on', { run: bad, paths, envFile, noRestart: true }), /không hợp lệ/); assert.ok(!fa.isEnabled(paths));
  // chưa có env: vẫn cài được phần hệ điều hành
  fs.rmSync(envFile); r = await apply('on', { run, paths, envFile, noRestart: true }); assert.equal(r.enabled, true);
  assert.equal(setEnvLine('A=1', 'B', '2'), 'A=1\nB=2\n'); assert.equal(setEnvLine('A=1\nB=0\n', 'B', '2'), 'A=1\nB=2\n');
});
