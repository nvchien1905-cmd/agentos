'use strict';
// Chạy: node hwcheck-cli.js [--json]   — kiểm tra phần cứng và in kết quả (dùng được cả trong phiên USB cài, trước khi cài).
const { collect, evaluate, format } = require('./hwcheck');
collect().then((f) => {
  const rep = evaluate(f);
  if (process.argv.includes('--json')) console.log(JSON.stringify(rep, null, 1));
  else console.log(format(rep));
  process.exit(rep.verdict === 'fail' ? 2 : 0);
}, (e) => { console.error('Không kiểm tra được: ' + (e && e.message || e)); process.exit(1); });
