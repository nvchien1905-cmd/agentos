'use strict';
const fs = require('fs');
const path = require('path');

// Tạo /etc/agentos/orchestrator.env cho bộ điều phối từ kết quả của trình hướng dẫn.
const NUM = /^\d+$/;
const SAFE = /^[^\r\n\0]*$/;

function build(cfg) {
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(cfg.token || '')) throw new Error('Thiếu hoặc sai token bot');
  const owners = (cfg.ownerIds || []).map(String);
  if (!owners.length || !owners.every((x) => NUM.test(x))) throw new Error('Thiếu ID Telegram của chủ máy');
  const engines = (cfg.engines || []).filter((e) => ['claude', 'codex'].includes(e));
  if (!engines.length) throw new Error('Chưa có AI nào đăng nhập được');
  const paths = cfg.paths || {};
  const lines = [
    '# Tạo bởi trình hướng dẫn AgentOS ' + new Date().toISOString() + '. Sửa tay được; khởi động lại: systemctl restart agentos-orchestrator',
    'TELEGRAM_TOKEN=' + cfg.token,
    'ALLOWED_USER_IDS=' + owners.join(','),
    'ADMIN_USER_IDS=' + owners.join(','),
    'ENGINE_ORDER=' + engines.join(','),
    'WORKDIR=' + (paths.workdir || '/var/lib/agentos/work'),
    'DB_PATH=' + (paths.db || '/var/lib/agentos/data/agentos.db'),
    'TOOLS_FILE=' + (paths.tools || '/opt/agentos/orchestrator/tools.json'),
    'CLAUDE_BIN=' + (paths.claude || '/var/lib/agentos/.local/bin/claude'),
    'CODEX_BIN=' + (paths.codex || '/var/lib/agentos/.local/bin/codex'),
    'CODEX_SANDBOX=read-only',
    'SANDBOX=auto',
    'MIN_FREE_MB=500',
    // Chế độ TOÀN QUYỀN chỉ BẬT khi chủ máy đã tự tích ô ở trình hướng dẫn (cfg.fullAccess === true); mặc định TẮT.
    // Chủ đổi lúc đang chạy bằng /toanquyen và /baove trong Telegram.
    'FULL_ACCESS=' + (cfg.fullAccess === true ? '1' : '0'),
    'JOB_TIMEOUT_SEC=' + (cfg.fullAccess === true ? '3600' : '900'),
  ];
  // Token dài hạn của Claude (claude setup-token) nếu người dùng đăng nhập qua điện thoại; Codex tự lưu đăng nhập trong thư mục của agentos.
  if (cfg.claudeToken) {
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(cfg.claudeToken)) throw new Error('Token Claude không đúng dạng');
    lines.push('CLAUDE_CODE_OAUTH_TOKEN=' + cfg.claudeToken);
  }
  for (const l of lines) if (!SAFE.test(l)) throw new Error('Giá trị cấu hình chứa ký tự không hợp lệ');
  return lines.join('\n') + '\n';
}

// Ghi file quyền 600 (chứa token bot), qua file tạm rồi đổi tên để không bao giờ có file nửa vời.
function writeSecure(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows */ }
}

module.exports = { build, writeSecure };
