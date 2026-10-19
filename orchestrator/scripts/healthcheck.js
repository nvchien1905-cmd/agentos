#!/usr/bin/env node
'use strict';
// Kiểm tra sức khỏe từ bên ngoài: exit 0 = ổn, 1 = không ổn. Dùng cho quản trị viên/giám sát:
//   node scripts/healthcheck.js [đường-dẫn-heartbeat.json]
const path = require('path');
const { readHeartbeat } = require('../src/health');

if (require.main === module) {
  const file = process.argv[2] || process.env.HEARTBEAT_FILE || path.join(path.dirname(path.resolve(process.env.DB_PATH || './data/agentos.db')), 'heartbeat.json');
  const r = readHeartbeat(file, 60000);
  console.log((r.ok ? 'OK: ' : 'LỖI: ') + r.reason);
  process.exit(r.ok ? 0 : 1);
}
