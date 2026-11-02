'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runProcess } = require('../src/engines/proc');

// Lỗi gốc: máy chủ MCP/trình duyệt tự tách sang nhóm tiến trình riêng và giữ ống stdout → 'close' không tới → /huy không bao giờ kết thúc việc.
test('hủy việc: tiến trình cháu tách nhóm riêng và giữ ống cũng bị giết, việc kết thúc, không treo', { skip: process.platform === 'win32' }, async () => {
  const h = runProcess({ bin: 'bash', args: ['-c', 'setsid -w sleep 300 & echo $! ; sleep 300'], cwd: process.cwd(), input: '' });
  await new Promise((r) => setTimeout(r, 800));
  const t0 = Date.now(); h.kill('cancelled');
  const res = await h.done;
  assert.equal(res.killedBy, 'cancelled');
  assert.ok(Date.now() - t0 < 12000, 'phải xong trong vài giây, thực tế ' + (Date.now() - t0) + 'ms');
  const pid = Number(String(res.out).trim().split('\n')[0]);
  assert.ok(pid > 0);
  await new Promise((r) => setTimeout(r, 300));
  let alive = true; try { process.kill(pid, 0); } catch (e) { alive = false; }
  assert.equal(alive, false, 'tiến trình cháu phải bị giết');
});
