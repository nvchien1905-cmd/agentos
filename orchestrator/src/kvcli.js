#!/usr/bin/env node
'use strict';
// Lệnh cho AI đọc KiotViet qua API chính thức (chỉ đọc). Khóa API nằm ở bộ điều phối; lệnh này chỉ gọi cổng nội bộ 127.0.0.1.
//   node kvcli.js get "/invoices?pageSize=20&fromPurchaseDate=2026-11-01"
//   node kvcli.js ton "nồi chiên"      (tồn kho + giá theo tên hoặc mã)
const MAX = 60000;

async function call(path) {
  const url = process.env.AGENTOS_GATE_URL, token = process.env.AGENTOS_GATE_TOKEN, jobId = process.env.AGENTOS_JOB_ID;
  if (!url || !token || !jobId) throw new Error('Thiếu thông tin cổng nội bộ (chỉ chạy được bên trong một việc của bot).');
  const r = await fetch(url + '/kiotviet', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': token }, body: JSON.stringify({ jobId: Number(jobId), path }) });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || 'KiotViet lỗi');
  return d.data;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  let path;
  if (cmd === 'get' && rest[0]) path = rest[0];
  else if (cmd === 'ton' && rest.length) path = '/products?' + new URLSearchParams({ name: rest.join(' '), includeInventory: 'true', pageSize: '10' }).toString();
  else {
    console.log('Cách dùng (CHỈ ĐỌC, qua API chính thức của KiotViet):\n  get "/invoices?pageSize=20&fromPurchaseDate=2026-11-01"\n  ton <tên hoặc mã sản phẩm>\nNhóm được đọc: invoices, products, customers, branches, categories, orders, purchaseorders, returns, suppliers, users, pricebooks, transfers...\nPhân trang: pageSize (tối đa 100) + currentItem. Muốn ghi/sửa/xóa: KHÔNG làm được ở đây, hãy báo chủ máy.');
    return 2;
  }
  const out = JSON.stringify(await call(path));
  console.log(out.length > MAX ? out.slice(0, MAX) + '\n…(đã cắt, còn ' + (out.length - MAX) + ' ký tự: thu hẹp bằng pageSize / khoảng ngày / tên)' : out);
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error('Lỗi: ' + e.message); process.exit(1); });
module.exports = { main, call };
