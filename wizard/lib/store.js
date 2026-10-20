'use strict';
const fs = require('fs');
const path = require('path');

// Lưu trạng thái trình hướng dẫn (quyền 600, chỉ root) để mất điện giữa chừng vẫn nối tiếp được. Xóa khi hoàn tất (token đã nằm trong orchestrator.env).
const KEYS = ['token', 'bot', 'owner', 'claudeToken', 'lastError', 'fullAccess', 'apiKeys'];

function load(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const k of KEYS) if (j[k] !== undefined) out[k] = j[k];
    return out;
  } catch (e) { return {}; }
}

function save(file, state) {
  const out = {};
  for (const k of KEYS) if (state[k] !== undefined && state[k] !== null) out[k] = state[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function clear(file) { try { fs.rmSync(file, { force: true }); } catch (e) { /* không có */ } }

module.exports = { load, save, clear };
