'use strict';
const fs = require('fs');
const path = require('path');

const KNOWN_ENGINES = ['claude', 'codex'];

// Đọc .env đơn giản (không thêm thư viện). Biến đã có trong môi trường được ưu tiên.
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

function load(env) {
  env = env || process.env;
  return {
    token: env.TELEGRAM_TOKEN || '',
    allowedUserIds: new Set(list(env.ALLOWED_USER_IDS)),
    // Quản trị viên: dùng được bộ công cụ adminOnly và duyệt lệnh/ghi file. Không đặt -> mọi người được phép đều là admin.
    adminUserIds: new Set(list(env.ADMIN_USER_IDS === undefined ? env.ALLOWED_USER_IDS : env.ADMIN_USER_IDS)),
    approvalTimeoutMs: (Number(env.APPROVAL_TIMEOUT_SEC) || 300) * 1000,
    engineOrder: list(env.ENGINE_ORDER === undefined ? 'claude' : env.ENGINE_ORDER).map((s) => s.toLowerCase()),
    claudeBin: env.CLAUDE_BIN || 'claude',
    codexBin: env.CODEX_BIN || 'codex',
    claudeBinArgs: [],
    codexBinArgs: [],
    workdir: path.resolve(env.WORKDIR || './work'),
    allowedTools: env.CLAUDE_ALLOWED_TOOLS === undefined ? 'Read,Glob,Grep' : env.CLAUDE_ALLOWED_TOOLS,
    codexSandbox: env.CODEX_SANDBOX || 'read-only',
    jobTimeoutMs: (Number(env.JOB_TIMEOUT_SEC) || 900) * 1000,
    limitCooldownMs: (Number(env.LIMIT_COOLDOWN_MIN) || 60) * 60 * 1000,
    dbPath: path.resolve(env.DB_PATH || './data/agentos.db'),
    // Độ bền (GĐ 5)
    // Chế độ TOÀN QUYỀN (máy cá nhân của chủ): AI chạy không hỏi xin phép, không sandbox, có sudo. Chủ đổi lúc đang chạy bằng /toanquyen và /baove (lưu trong cơ sở dữ liệu, ưu tiên hơn giá trị này).
    fullAccess: ['1', 'true', 'yes', 'on'].includes(String(env.FULL_ACCESS || '').toLowerCase()),
    sandboxMode: (env.SANDBOX || 'off').toLowerCase(),                 // off | auto | bwrap (xem sandbox.js)
    sandboxHide: list(env.SANDBOX_HIDE === undefined ? '/etc/agentos' : env.SANDBOX_HIDE),
    minFreeMb: env.MIN_FREE_MB === undefined ? 300 : Number(env.MIN_FREE_MB),
    bootNotice: String(env.BOOT_NOTICE === undefined ? 'true' : env.BOOT_NOTICE).toLowerCase() !== 'false',
    jobRetentionDays: Number(env.JOB_RETENTION_DAYS) || 90,
    auditRetentionDays: Number(env.AUDIT_RETENTION_DAYS) || 180,
    outRetentionDays: Number(env.OUT_RETENTION_DAYS) || 14,
    backupKeep: Number(env.BACKUP_KEEP) || 7,
    retryDelaysMs: list(env.TRANSIENT_RETRY_SEC === undefined ? '15,60,180' : env.TRANSIENT_RETRY_SEC).map((s) => Number(s) * 1000).filter((n) => n >= 0),
    // Cấu hình công cụ (MCP + bộ công cụ). Không đặt -> chỉ dùng CLAUDE_ALLOWED_TOOLS.
    toolsFile: env.TOOLS_FILE ? path.resolve(env.TOOLS_FILE) : '',
    chromePath: env.CHROME_PATH || '',
    display: env.DISPLAY || ':99',
  };
}

function validate(cfg) {
  const errs = [];
  if (!cfg.token) errs.push('Thiếu TELEGRAM_TOKEN');
  if (cfg.allowedUserIds.size === 0) errs.push('Thiếu ALLOWED_USER_IDS (không có ID nào được phép -> từ chối chạy)');
  for (const id of cfg.allowedUserIds) if (!/^\d+$/.test(id)) errs.push('ALLOWED_USER_IDS chứa giá trị không phải số: ' + id);
  for (const id of cfg.adminUserIds) if (!cfg.allowedUserIds.has(id)) errs.push('ADMIN_USER_IDS có ID không nằm trong ALLOWED_USER_IDS: ' + id);
  if (!['off', 'auto', 'bwrap'].includes(cfg.sandboxMode)) errs.push('SANDBOX phải là off, auto hoặc bwrap');
  if (!(cfg.minFreeMb >= 0)) errs.push('MIN_FREE_MB không hợp lệ');
  if (cfg.engineOrder.length === 0) errs.push('ENGINE_ORDER rỗng');
  for (const e of cfg.engineOrder) if (!KNOWN_ENGINES.includes(e)) errs.push('ENGINE_ORDER có engine không biết: ' + e);
  if (new Set(cfg.engineOrder).size !== cfg.engineOrder.length) errs.push('ENGINE_ORDER bị lặp engine');
  return errs;
}

module.exports = { load, loadEnvFile, validate, KNOWN_ENGINES };
