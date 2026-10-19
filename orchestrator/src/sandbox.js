'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');

// Cô lập tiến trình AI (Claude/Codex và mọi tiến trình con: bash, trình duyệt, máy chủ MCP) bằng bubblewrap (bwrap), chỉ Linux.
// Trong sandbox AI:
//   - thấy toàn bộ hệ thống ở chế độ CHỈ ĐỌC (không sửa được hệ điều hành, không cài chạy ngầm);
//   - ghi được vào: thư mục home của người dùng agentos (đăng nhập CLI, phiên làm việc), thư mục làm việc, hồ sơ trình duyệt;
//   - KHÔNG thấy: thư mục dữ liệu của bộ điều phối (cơ sở dữ liệu, nhật ký, sao lưu, heartbeat) và /etc/agentos (token bot Telegram);
//   - không nhìn thấy/ gửi tín hiệu tới tiến trình khác (PID riêng), /tmp riêng, tự chết khi bộ điều phối chết.
// Vẫn dùng chung mạng (cần gọi API, duyệt web, nói chuyện với cổng duyệt 127.0.0.1).
// Giới hạn: file đăng nhập của chính CLI (~/.claude) nằm trong home nên tiến trình AI đọc được; cổng duyệt chặn đường dẫn đó
// (policy.js) nhưng sandbox không che được.
// Chế độ: 'off' (mặc định, không cô lập) | 'auto' (dùng nếu bwrap chạy được, không thì chạy KHÔNG cô lập và báo) |
//         'bwrap' (bắt buộc: không dùng được thì việc báo lỗi, không chạy).

function pathKind(p, statSync) {
  try { return statSync(p).isDirectory() ? 'dir' : 'file'; } catch (e) { return null; }
}

// paths: { home, workdir, dataDir, jobDir, rw:[thư mục ghi thêm], hide:[đường dẫn che đi] }
function buildArgs(paths, statSync) {
  statSync = statSync || fs.statSync;
  const a = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  const bind = (flag, p) => { if (p && pathKind(p, statSync)) a.push(flag, p, p); };
  bind('--bind', paths.home);
  if (paths.dataDir && pathKind(paths.dataDir, statSync)) a.push('--tmpfs', paths.dataDir);   // che dữ liệu bộ điều phối...
  bind('--bind', paths.workdir);                                                              // ...rồi mở lại đúng phần cần
  for (const p of paths.rw || []) bind('--bind', p);
  bind('--ro-bind', paths.jobDir);
  for (const h of paths.hide || []) {
    const k = pathKind(h, statSync);
    if (k === 'dir') a.push('--tmpfs', h);
    else if (k === 'file') a.push('--ro-bind', '/dev/null', h);
  }
  a.push('--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--die-with-parent', '--new-session');
  return a;
}

function createSandbox({ mode, paths, bwrapBin, platform, run, statSync, log }) {
  mode = mode || 'off';
  bwrapBin = bwrapBin || 'bwrap';
  platform = platform || process.platform;
  run = run || spawnSync;
  log = log || (() => {});
  const info = { mode, enabled: false, reason: '' };
  if (mode === 'off') { info.reason = 'tắt'; }
  else if (platform !== 'linux') { info.reason = 'chỉ hỗ trợ Linux'; }
  else {
    const t = run(bwrapBin, [...buildArgs(paths, statSync), '--', '/bin/true'], { timeout: 15000, encoding: 'utf8' });
    if (t && t.status === 0) { info.enabled = true; info.reason = 'bwrap hoạt động'; }
    else info.reason = 'bwrap không chạy được: ' + String((t && (t.stderr || (t.error && t.error.message))) || 'không rõ').trim().slice(0, 200);
  }
  if (!info.enabled && mode !== 'off') log('SANDBOX ' + mode + ': ' + info.reason);

  return {
    info,
    enabled: info.enabled,
    // Bọc lệnh { bin, args, cwd } thành lệnh chạy trong sandbox. Chế độ bắt buộc mà không dùng được -> ném lỗi (việc báo lỗi).
    wrap(spec) {
      if (info.enabled) {
        return { bin: bwrapBin, args: [...buildArgs(paths, statSync), '--chdir', spec.cwd, '--', spec.bin, ...spec.args], cwd: spec.cwd };
      }
      if (mode === 'bwrap') throw new Error('SANDBOX=bwrap nhưng không dùng được (' + info.reason + ')');
      return spec;
    },
  };
}

module.exports = { createSandbox, buildArgs };
