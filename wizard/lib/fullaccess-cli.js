'use strict';
// Chạy bằng ROOT bởi dịch vụ agentos-fullaccess (chỉ sau khi tập lệnh python đã kiểm: người gọi là TIẾN TRÌNH CHÍNH của bộ điều phối, không phải AI con):
//   node fullaccess-cli.js on|off|status
// on  = sudo không mật khẩu cho `agentos` + drop-in systemd gỡ NoNewPrivileges/ProtectSystem (dùng lại đúng wizard/lib/fullaccess.js như nút trong Cài đặt)
//       + FULL_ACCESS=1, JOB_TIMEOUT_SEC=3600 trong orchestrator.env, rồi KHỞI ĐỘNG LẠI bộ điều phối sau vài giây (drop-in chỉ có hiệu lực khi dịch vụ chạy lại).
// off = gỡ cả hai + FULL_ACCESS=0, JOB_TIMEOUT_SEC=900, khởi động lại.
const fs = require('fs');
const { execFile } = require('child_process');
const fa = require('./fullaccess');

const run = (cmd, args, o) => new Promise((resolve) => execFile(cmd, args, { timeout: (o && o.timeoutMs) || 30000 }, (err, out, e) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(e || (err && err.message) || '') })));

function setEnvLine(text, key, value) {
  const re = new RegExp('^' + key + '=.*$', 'm');
  return re.test(text) ? text.replace(re, key + '=' + value) : text.replace(/\n*$/, '\n') + key + '=' + value + '\n';
}

async function apply(mode, o) {
  o = o || {};
  const envFile = o.envFile || '/etc/agentos/orchestrator.env';
  const paths = o.paths;
  if (mode === 'status') return { enabled: fa.isEnabled(paths) };
  if (mode !== 'on' && mode !== 'off') throw new Error('lệnh không hợp lệ: ' + mode);
  const on = mode === 'on';
  const r = o.run || run;
  if (on) await fa.enable(r, paths); else if (fa.isEnabled(paths)) await fa.disable(r, paths);
  try {
    let t = fs.readFileSync(envFile, 'utf8');
    t = setEnvLine(t, 'FULL_ACCESS', on ? '1' : '0'); t = setEnvLine(t, 'JOB_TIMEOUT_SEC', on ? '3600' : '900');
    const st = fs.statSync(envFile); const tmp = envFile + '.fa.tmp';
    fs.writeFileSync(tmp, t, { mode: st.mode & 0o777 }); try { fs.chownSync(tmp, st.uid, st.gid); } catch (e) { /* thử nghiệm không phải root */ } fs.renameSync(tmp, envFile);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }                                   // chưa cấu hình xong: bỏ qua phần env
  if (!o.noRestart) await r('systemd-run', ['--on-active=5', '--unit=agentos-fullaccess-restart-' + Date.now(), 'systemctl', 'restart', 'agentos-orchestrator'], { timeoutMs: 15000 });
  return { enabled: on };
}

module.exports = { apply, setEnvLine };

if (require.main === module) {
  apply(process.argv[2]).then((r) => { console.log(JSON.stringify(r)); }, (e) => { console.error(e.message); process.exit(1); });
}
