'use strict';
const { spawn } = require('child_process');

const MAX_OUT = 5 * 1024 * 1024;
const IS_WIN = process.platform === 'win32';

// Giết CẢ CÂY tiến trình (claude + máy chủ MCP + trình duyệt + lệnh bash con...), không chỉ tiến trình đầu.
// Linux: tiến trình chạy ở nhóm riêng (detached) nên giết cả nhóm; Windows: taskkill /T.
function killTree(child, sig) {
  if (!child.pid) return;
  if (IS_WIN) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch (e) { /* đã thoát */ }
    return;
  }
  const kids = descendants(child.pid);                 // máy chủ MCP/trình duyệt hay tự tách sang nhóm riêng nên giết theo CÂY cha-con, không chỉ theo nhóm
  try { process.kill(-child.pid, sig); } catch (e) { try { child.kill(sig); } catch (e2) { /* đã thoát */ } }
  for (const k of kids) { try { process.kill(k, sig); } catch (e) { /* đã thoát */ } }
}

// Mọi tiến trình con cháu của pid (Linux: đọc /proc). Không đọc được thì trả rỗng.
function descendants(pid) {
  const out = [];
  try {
    const parent = new Map();
    for (const d of require('fs').readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(d)) continue;
      try { const st = require('fs').readFileSync('/proc/' + d + '/stat', 'utf8'); const pp = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); (parent.get(pp) || parent.set(pp, []).get(pp)).push(Number(d)); } catch (e) { /* vừa thoát */ }
    }
    const stack = [pid];
    while (stack.length) { const x = stack.pop(); for (const k of parent.get(x) || []) { out.push(k); stack.push(k); } }
  } catch (e) { /* không có /proc */ }
  return out;
}

// Chạy một tiến trình, đưa `input` qua stdin. Trả { done, kill }.
// done -> { code, out, err, killedBy: null|'timeout'|'cancelled', spawnError }
// `wrap({bin,args,cwd})` (tùy chọn) bọc lệnh vào sandbox (xem sandbox.js).
function runProcess({ bin, args, cwd, input, timeoutMs, env, wrap, onStdout }) {
  let spec = { bin, args, cwd };
  let spawnError = null;
  try { if (wrap) spec = wrap(spec); } catch (e) { spawnError = e; }
  if (spawnError) {
    return { done: Promise.resolve({ code: null, out: '', err: '', killedBy: null, spawnError }), kill() {} };
  }
  const child = spawn(spec.bin, spec.args, {
    cwd, env: env ? Object.assign({}, process.env, env) : process.env,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !IS_WIN,
  });
  let out = '', err = '', killedBy = null;

  let finish = null;
  const kill = (why) => {
    if (killedBy) return;
    killedBy = why || 'cancelled';
    killTree(child, 'SIGTERM');
    setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref();
    // Nếu còn tiến trình con cháu giữ đường ống mở thì 'close' không bao giờ tới → việc treo vĩnh viễn, không hủy được. Quá 8 giây thì bỏ ống và coi như đã xong.
    setTimeout(() => { if (finish) { for (const st of [child.stdout, child.stderr]) { try { st.destroy(); } catch (e) { /* đã đóng */ } } finish(null); } }, 8000).unref();
  };
  const timer = timeoutMs ? setTimeout(() => kill('timeout'), timeoutMs) : null;

  child.stdout.on('data', (d) => { if (onStdout) { try { onStdout(String(d)); } catch (e) { /* bỏ qua */ } } if (out.length < MAX_OUT) out += d; });
  child.stderr.on('data', (d) => { if (err.length < MAX_OUT) err += d; });
  child.stdin.on('error', () => { /* tiến trình thoát sớm */ });
  child.stdin.end(input);

  const done = new Promise((resolve) => {
    child.on('error', (e) => { spawnError = e; });
    let ended = false;
    finish = (code) => {
      if (ended) return; ended = true;
      if (timer) clearTimeout(timer);
      // Dọn tiến trình mồ côi còn sót trong nhóm (ví dụ trình duyệt do máy chủ MCP bật) khi tiến trình chính đã thoát.
      if (!IS_WIN && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* không còn gì */ } }
      resolve({ code, out, err, killedBy, spawnError });
    };
    child.on('close', finish);
  });
  return { done, kill };
}

// Các kết quả chung cho mọi engine; trả null nếu tiến trình chạy bình thường.
function abnormal(r, bin) {
  if (r.spawnError) return { ok: false, limit: false, error: 'Không chạy được ' + bin + ': ' + r.spawnError.message };
  if (r.killedBy === 'timeout') return { ok: false, limit: false, timedOut: true, error: 'Quá thời gian cho phép' };
  if (r.killedBy) return { ok: false, limit: false, cancelled: true, error: 'Đã hủy' };
  return null;
}

module.exports = { runProcess, abnormal, killTree, descendants };
