#!/usr/bin/env node
'use strict';
// Chạy bằng root (qua agentos-agentctl): `init` chuẩn bị thư mục, `drain` xử lý mọi yêu cầu agent đang chờ.
const { createAgentCtl } = require('./agentctl');
const ctl = createAgentCtl();
const cmd = process.argv[2] || 'drain';
(cmd === 'init' ? ctl.init().then(() => 0) : ctl.drain()).then(() => process.exit(0), (e) => { console.error(e && e.message); process.exit(1); });
