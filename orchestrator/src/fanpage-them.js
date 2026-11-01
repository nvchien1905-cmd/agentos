#!/usr/bin/env node
'use strict';
// Thêm một fanpage vào bot BẰNG KHÓA TRUY CẬP ĐỌC TỪ STDIN (khóa không nằm trên dòng lệnh, không in ra, không vào lịch sử chat).
//   printf '%s' '<khóa trang>' | node /opt/agentos/orchestrator/src/fanpage-them.js [tudong]
// Kiểm khóa với Graph API (hỏi /me), ghi vào fanpage.json (0600). Mặc định chế độ NHÁP (bot soạn, chủ máy bấm Gửi); thêm tham số "tudong" để tự trả lời.
const { createFanpage } = require('./fanpage');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', async () => {
  try {
    const fp = createFanpage({ file: process.env.AGENTOS_FANPAGE_FILE || '/var/lib/agentos/data/fanpage.json', notify: async () => {}, runAI: async () => ({ ok: false }), admin: () => null });
    const r = await fp.addPage(buf.trim(), process.argv[2] === 'tudong' ? 'tudong' : 'nhap');
    console.log('Đã kết nối trang "' + r.name + '" (id ' + r.id + ', chế độ ' + (r.mode === 'tudong' ? 'TỰ ĐỘNG' : 'NHÁP') + ').');
  } catch (e) { console.error('Lỗi: ' + e.message); process.exit(1); }
});
