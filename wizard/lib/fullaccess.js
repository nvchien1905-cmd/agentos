'use strict';
const fs = require('fs');
const path = require('path');

// Chế độ TOÀN QUYỀN: chủ máy TỰ TÍCH ô "Cho bot toàn quyền" ở trình hướng dẫn thì mới cài (mặc định TẮT, ISO không có sẵn sudo cho bot).
// Gồm: (1) sudo không mật khẩu cho người dùng hệ thống `agentos` (bộ điều phối + AI chạy dưới người này),
//      (2) gỡ các giới hạn gia cố của systemd cho dịch vụ điều phối (NoNewPrivileges chặn sudo, ProtectSystem=strict chặn ghi hệ thống),
//      (3) FULL_ACCESS=1 trong orchestrator.env (do envfile.js ghi).
// Chủ máy đổi lúc đang chạy bằng /baove (AI hỏi trước + sandbox) và /toanquyen trong Telegram. Muốn gỡ hẳn: scripts/bat-toan-quyen.sh tat.
const SUDOERS = '/etc/sudoers.d/90-agentos-toan-quyen';
const DROPIN_DIR = '/etc/systemd/system/agentos-orchestrator.service.d';
const DROPIN = DROPIN_DIR + '/10-toan-quyen.conf';

const SUDOERS_TEXT =
  '# AgentOS - chế độ TOÀN QUYỀN: người dùng hệ thống `agentos` (chạy bộ điều phối + AI) dùng sudo không cần mật khẩu.\n' +
  '# Chủ máy tự bật ở trình hướng dẫn cài đặt. Chủ máy là người ra lệnh duy nhất (ID Telegram trong ALLOWED_USER_IDS).\n' +
  '# Gỡ: sudo bash bat-toan-quyen.sh tat (hoặc xóa tệp này).\n' +
  'agentos ALL=(ALL:ALL) NOPASSWD: ALL\n';

const DROPIN_TEXT =
  '# Chế độ TOÀN QUYỀN: gỡ giới hạn gia cố của systemd để AI dùng được sudo và sửa được cả hệ thống.\n' +
  '# Vẫn giữ MemoryMax/TasksMax của tệp chính để một việc chạy lỗi không kéo sập máy.\n' +
  '[Service]\nNoNewPrivileges=no\nProtectSystem=no\nRestrictSUIDSGID=no\nPrivateTmp=no\nProtectKernelTunables=no\nProtectControlGroups=no\n';

// Cài sudoers + drop-in. Tệp sudoers được kiểm bằng `visudo -cf` TRƯỚC khi vào chỗ (tệp hỏng làm hỏng sudo của cả máy).
async function enable(run, o) {
  o = o || {};
  const sudoers = o.sudoers || SUDOERS, dropin = o.dropin || DROPIN;
  const tmp = sudoers + '.tmp';                                 // tên có dấu chấm: sudo bỏ qua nên chưa có hiệu lực khi chưa kiểm
  fs.mkdirSync(path.dirname(sudoers), { recursive: true });
  fs.writeFileSync(tmp, SUDOERS_TEXT, { mode: 0o440 });
  const v = await run('visudo', ['-cf', tmp], { timeoutMs: 15000 });
  if (v.code !== 0) { fs.rmSync(tmp, { force: true }); throw new Error('Tệp sudo không hợp lệ, không cài: ' + String(v.err || v.out).trim().slice(0, 200)); }
  fs.renameSync(tmp, sudoers);
  try { fs.chmodSync(sudoers, 0o440); } catch (e) { /* hệ tệp không hỗ trợ */ }
  fs.mkdirSync(path.dirname(dropin), { recursive: true });
  fs.writeFileSync(dropin, DROPIN_TEXT, { mode: 0o644 });
  await run('systemctl', ['daemon-reload'], { timeoutMs: 30000 });
  return true;
}

async function disable(run, o) {
  o = o || {};
  for (const f of [o.sudoers || SUDOERS, o.dropin || DROPIN]) fs.rmSync(f, { force: true });
  await run('systemctl', ['daemon-reload'], { timeoutMs: 30000 });
  return true;
}

const isEnabled = (o) => fs.existsSync((o && o.sudoers) || SUDOERS);

module.exports = { enable, disable, isEnabled, SUDOERS, DROPIN, SUDOERS_TEXT, DROPIN_TEXT };
