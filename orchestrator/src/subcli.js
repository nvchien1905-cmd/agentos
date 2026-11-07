#!/usr/bin/env node
'use strict';
// Lệnh cho AI chính giao việc cho TRỢ LÝ PHỤ chạy song song (qua cổng nội bộ 127.0.0.1, xem subagents.js).
//   node subcli.js spawn "mô tả việc, đủ ngữ cảnh" [--ai claude|codex|gemini]   → in mã trợ lý, chạy nền
//   node subcli.js wait [mã ...] [--sec 90]                                        → chờ rồi in kết quả (chưa xong thì gọi lại)
//   node subcli.js list | cancel <mã>
async function call(body) {
  const url = process.env.AGENTOS_GATE_URL, token = process.env.AGENTOS_GATE_TOKEN, jobId = process.env.AGENTOS_JOB_ID;
  if (!url || !token || !jobId) throw new Error('Thiếu thông tin cổng nội bộ (chỉ chạy được bên trong một việc của bot).');
  const r = await fetch(url + '/sub', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': token }, body: JSON.stringify(Object.assign({ jobId: Number(jobId) }, body)) });
  return r.json();
}
const HELP = 'Giao việc cho trợ lý phụ chạy SONG SONG (mỗi trợ lý là một AI riêng, không thấy cuộc trò chuyện nên phải mô tả đủ ngữ cảnh):\n' +
  '  spawn "việc cần làm" [--ai claude|codex|gemini]   giao việc, in mã ngay (chạy nền)\n  wait [mã ...] [--sec 90]   chờ và in kết quả; còn trợ lý chưa xong thì gọi lại wait\n  list   xem tất cả · cancel <mã>   dừng một trợ lý\nTối đa vài trợ lý cùng lúc; trợ lý không giao việc tiếp được.';

async function main(argv) {
  argv = argv.slice();
  const take = (flag) => { const i = argv.indexOf(flag); if (i < 0) return ''; const v = String(argv[i + 1] || ''); argv.splice(i, 2); return v; };
  const ai = take('--ai'), sec = take('--sec');
  const [cmd, ...rest] = argv;
  if (cmd === 'spawn' && rest.length) {
    const d = await call({ op: 'spawn', task: rest.join(' '), engine: ai || undefined });
    if (!d.ok) { console.error('Lỗi: ' + d.error); return 1; }
    console.log('Đã giao trợ lý #' + d.id + ' (' + d.engine + '), đang chạy nền. Lấy kết quả: node subcli.js wait ' + d.id);
    return 0;
  }
  if (cmd === 'wait') {
    const ids = rest.map(Number).filter(Boolean);
    const d = await call({ op: 'wait', ids, sec: sec ? Number(sec) : undefined });
    if (!d.ok) { console.error('Lỗi: ' + d.error); return 1; }
    for (const s of d.subs) console.log('=== Trợ lý #' + s.id + ' (' + s.engine + ') — ' + ({ running: 'CHƯA XONG', done: 'xong', error: 'LỖI', cancelled: 'đã dừng' }[s.status] || s.status) + ' · ' + s.secs + ' giây · việc: ' + s.task + '\n' + (s.status === 'done' ? s.text : s.status === 'error' ? s.error : ''));
    if (d.pending) console.log('\n' + d.pending + ' trợ lý chưa xong: gọi lại `node subcli.js wait` để chờ tiếp.');
    return 0;
  }
  if (cmd === 'list') {
    const d = await call({ op: 'list' });
    if (!d.ok) { console.error('Lỗi: ' + (d.error || 'không rõ')); return 1; }
    for (const s of d.subs || []) console.log('#' + s.id + ' [' + s.status + '] ' + s.engine + ' — ' + s.task);
    if (!(d.subs || []).length) console.log('(chưa giao trợ lý nào)');
    return 0;
  }
  if (cmd === 'cancel' && rest[0]) { const d = await call({ op: 'cancel', id: Number(rest[0]) }); console.log(d.ok ? 'Đã dừng.' : 'Lỗi: ' + d.error); return d.ok ? 0 : 1; }
  console.log(HELP);
  return 2;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error('Lỗi: ' + e.message); process.exit(1); });
module.exports = { main };
