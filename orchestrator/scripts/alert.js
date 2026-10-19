#!/usr/bin/env node
'use strict';
// Gửi cảnh báo Telegram cho quản trị viên khi dịch vụ lỗi liên tục (systemd OnFailure=agentos-alert@%n.service).
// Đọc TELEGRAM_TOKEN, ADMIN_USER_IDS (hoặc ALLOWED_USER_IDS) từ môi trường.
//   node scripts/alert.js "nội dung cảnh báo"
const { sendAlert, idsFromEnv } = require('../src/alert-lib');

const text = process.argv.slice(2).join(' ') || 'AgentOS: dịch vụ gặp lỗi.';
const token = process.env.TELEGRAM_TOKEN;
const ids = idsFromEnv(process.env);
if (!token || !ids.length) { console.error('Thiếu TELEGRAM_TOKEN hoặc ID quản trị viên'); process.exit(1); }
sendAlert({ token, chatIds: ids, text }).then((n) => process.exit(n ? 0 : 1));
