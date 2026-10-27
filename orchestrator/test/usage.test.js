'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createUsage } = require('../src/usage');
const { createProjects } = require('../src/projects');
const { createWorker } = require('../src/worker');
const { createQuick } = require('../src/quick');

const NOW = Date.parse('2026-10-27T12:00:00+07:00');
function mk() {
  const db = openDb(':memory:'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-')); const P = createProjects({ db, baseDir: dir });
  const u = createUsage({ db, projects: P, now: () => NOW });
  const add = (engine, project, at, secs, cost, status) => {
    const id = db.addJob('1', 'x', null, null, 'main', project); db.claimNext();
    db.raw.prepare('UPDATE jobs SET engine = ?, status = ?, started_at = ?, finished_at = ?, cost_usd = ? WHERE id = ?').run(engine, status || 'done', at - secs * 1000, at, cost, id);
  };
  return { db, P, u, add };
}

test('thống kê: theo AI, theo dự án, theo ngày; chi phí chỉ có với AI báo chi phí; lỗi đếm riêng; việc ngoài khoảng bị loại', () => {
  const { P, u, add } = mk(); const p = P.create('Kế toán');
  add('claude', p.id, NOW - 3600e3, 120, 0.5); add('claude', null, NOW - 2 * 86400e3, 60, 0.25); add('codex', p.id, NOW - 7200e3, 300, null); add('codex', null, NOW - 3600e3, 10, null, 'error');
  add('gemini', null, NOW - 40 * 86400e3, 30, null);                                            // 40 ngày trước: ngoài khoảng 30 ngày
  const s = u.summary(30);
  const e = Object.fromEntries(s.perEngine.map((x) => [x.engine, x]));
  assert.equal(e.claude.jobs, 2); assert.equal(e.claude.secs, 180); assert.equal(e.claude.cost, 0.75); assert.equal(e.codex.jobs, 2); assert.equal(e.codex.errors, 1); assert.equal(e.codex.cost, 0); assert.ok(!e.gemini);
  const pj = Object.fromEntries(s.perProject.map((x) => [x.project || 'chung', x]));
  assert.equal(pj[p.id].name, 'Kế toán'); assert.equal(pj[p.id].jobs, 2); assert.deepEqual(pj[p.id].engines, { claude: 1, codex: 1 }); assert.equal(pj.chung.jobs, 2);
  assert.equal(s.daily.length, 30); assert.equal(s.daily[s.daily.length - 1].date, '2026-10-27'); assert.equal(s.daily[s.daily.length - 1].total, 2, 'hôm nay: 1 claude + 1 codex xong (việc lỗi không tính)');
  assert.equal(u.summary(1).perEngine.length, 2);
  const t = u.text(30); assert.match(t, /Claude: 2 việc.*\$0\.75/); assert.match(t, /Codex: 2 việc \(1 lỗi\)/); assert.match(t, /Kế toán: 2 việc/);
});

test('ngân sách tháng: đếm việc xong trong THÁNG (giờ VN), vượt trần thì AI đó bị bỏ qua nếu còn AI khác; AI nào cũng vượt thì vẫn chạy', async () => {
  const { db, u, add } = mk();
  add('claude', null, Date.parse('2026-10-05T10:00:00+07:00'), 5, null); add('claude', null, Date.parse('2026-10-20T10:00:00+07:00'), 5, null); add('claude', null, Date.parse('2026-09-30T23:00:00+07:00'), 5, null);
  assert.equal(u.monthJobs('claude'), 2, 'việc tháng trước không tính'); assert.equal(u.overBudget('claude'), false);
  u.setBudget('claude', 2); assert.equal(u.overBudget('claude'), true); assert.deepEqual(u.budgets(), { claude: { jobs: 2 } });
  const run = async (budgetFn) => {
    const order = []; const eng = (n) => ({ start: () => { order.push(n); return { done: Promise.resolve({ ok: true, text: n }), kill() {} }; } });
    const w = createWorker({ db, engines: { claude: eng('claude'), codex: eng('codex') }, order: ['claude', 'codex'], notify: async () => {}, retryDelaysMs: [1], overBudget: budgetFn });
    db.addJob('1', 'việc'); await w.wake(); return order;
  };
  assert.deepEqual(await run((e) => u.overBudget(e)), ['codex'], 'Claude hết trần -> dồn sang Codex');
  assert.deepEqual(await run(() => true), ['claude'], 'AI nào cũng vượt trần -> vẫn chạy theo thứ tự thường');
  u.setBudget('claude', 0); assert.equal(u.overBudget('claude'), false, 'bỏ trần');
});

test('/chiphi: xem thống kê, đặt/bỏ trần tháng, AI lạ bị từ chối', async () => {
  const { db, P, u, add } = mk(); add('claude', null, NOW - 3600e3, 30, null);
  const q = createQuick({ usage: u, projects: P });
  assert.ok(q.has('chiphi'));
  assert.match(await q.run('chiphi', '', {}), /Sử dụng AI 30 ngày qua: 1 việc/); assert.match(await q.run('chiphi', 'tuần', {}), /7 ngày/);
  assert.match(await q.run('chiphi', 'tran claude 50', {}), /Trần tháng claude: 50 việc/); assert.equal(u.budgets().claude.jobs, 50); assert.match(await q.run('chiphi', '', {}), /tháng này 1\/50/);
  assert.match(await q.run('chiphi', 'tran deepseek 20', {}), /Trần tháng deepseekapi: 20/); assert.match(await q.run('chiphi', 'tran gpt 5', {}), /AI không biết/);
  assert.match(await q.run('chiphi', 'tran claude bo', {}), /Đã bỏ trần/); assert.equal(u.budgets().claude, undefined);
});
