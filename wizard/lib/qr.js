'use strict';

// Mã QR dạng SVG bằng chương trình `qrencode` (gói qrencode). Không có thì trả null (giao diện tự ẩn mã QR).
async function svg(run, text) {
  text = String(text || '');
  if (!text || text.length > 400) throw new Error('Nội dung mã QR không hợp lệ');
  const r = await run('qrencode', ['-t', 'SVG', '-m', '1', '-s', '8', '-o', '-', text], { timeoutMs: 10000 });
  return r.code === 0 && /<svg/.test(r.out) ? r.out : null;
}

module.exports = { svg };
