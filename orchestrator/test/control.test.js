'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createControl } = require('../src/control');
const { createSchedule } = require('../src/schedule');
const { createProjects } = require('../src/projects');
const { createAuditLog } = require('../src/auditlog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'));
function mk(clock) {
  const db = openDb(':memory:'), dir = tmp(), base = tmp();
  const projects = createProjects({ db, baseDir: base });
  const jobs = [], cancelled = [];
  const schedule = createSchedule({ db, projects, admins: ['1'], notify: async () => {}, now: clock ? () => clock : undefined, submitJob: (c, t, p) => jobs.push([c, t, p]) });
  const worker = { cancelJob: (id) => { cancelled.push(id); return true; }, wake() {} };
  const control = createControl({ dir, db, worker, schedule, projects, log() {} });
  const send = (req) => { fs.writeFileSync(path.join(dir, Date.now() + '-' + Math.random().toString(36).slice(2) + '.json'), JSON.stringify(req)); return control.tick(); };
  return { db, dir, projects, schedule, control, send, jobs, cancelled };
}

test('điều khiển việc: tạm dừng thì không được nhận chạy và không chặn bản cập nhật; tiếp tục; hủy; đổi dự án', () => {
  const S = mk(); const p = S.projects.create('Facebook', 'test');
  const id = S.db.addJob('1', 'việc A');
  assert.equal(S.send({ action: 'job.hold', id }), 1);
  assert.equal(S.db.getJob(id).status, 'waiting'); assert.equal(S.db.queuedCount(), 0); assert.equal(S.db.waitingCount(), 0);
  assert.equal(S.db.claimNext(Date.now() + 86400000 * 365), null, 'tạm dừng thì không bao giờ được nhận chạy');
  assert.equal(createAuditLog({ db: { raw: S.db.raw } }).list({ days: 1 })[0].statusText, 'tạm dừng');
  S.send({ action: 'job.release', id }); assert.equal(S.db.getJob(id).status, 'queued');
  S.send({ action: 'job.project', id, project: p.id }); assert.equal(S.db.getJob(id).project, p.id);
  S.send({ action: 'job.project', id, project: 'khong-co-du-an' }); assert.equal(S.db.getJob(id).project, p.id, 'dự án không có thì không đổi');
  S.send({ action: 'job.project', id, project: '' }); assert.equal(S.db.getJob(id).project, null);
  S.send({ action: 'job.cancel', id }); assert.equal(S.db.getJob(id).status, 'cancelled');
  const run = S.db.addJob('1', 'đang chạy'); S.db.raw.prepare("UPDATE jobs SET status='running' WHERE id=?").run(run);
  S.send({ action: 'job.cancel', id: run }); assert.deepEqual(S.cancelled, [run], 'việc đang chạy: giao worker dừng tiến trình');
  assert.equal(S.db.setJobProject(run, null), false, 'việc đang chạy không đổi dự án');
});

test('điều khiển việc định kỳ: tạm dừng không chạy, bật lại chạy, chuyển vào dự án, xóa', async () => {
  const S = mk(Date.UTC(2026, 10, 4, 2, 0, 0));                         // 09:00 giờ VN
  const p = S.projects.create('Học Facebook', 'test');
  S.schedule.command('hen', '08:30 đọc tin Facebook', { chatId: '1' });
  const id = S.schedule.load().jobs[0].id;
  S.send({ action: 'sched.pause', scope: '', id });
  assert.equal(await S.schedule.tick(), 0, 'tạm dừng: tới giờ cũng không chạy'); assert.equal(S.jobs.length, 0);
  assert.equal(S.schedule.listAll()[0].paused, true);
  S.send({ action: 'sched.resume', scope: '', id });
  assert.equal(await S.schedule.tick(), 1); assert.equal(S.jobs.length, 1);
  S.send({ action: 'sched.project', id, project: p.id });
  assert.equal(S.schedule.load().jobs.length, 0, 'rời danh sách chung'); assert.equal(S.schedule.listAll()[0].scope, p.id);
  const ps = S.projects.get(p.id).schedule[0];
  S.send({ action: 'sched.pause', scope: p.id, id: ps.id }); assert.equal(S.projects.get(p.id).schedule[0].paused, true);
  S.send({ action: 'sched.remove', scope: p.id, id: ps.id }); assert.equal(S.schedule.listAll().length, 0);
});

test('hủy theo nhãn: xóa việc định kỳ chứa nhãn và hủy việc chờ/đang chạy cùng nhãn, không đụng việc khác; yêu cầu lạ bị bỏ', () => {
  const S = mk(); const TAG = '[HOC-FACEBOOK-HUYEN-ANH]';
  S.schedule.command('hen', '09:00 ' + TAG + ' đọc tin', { chatId: '1' }); S.schedule.command('hen', '10:00 việc khác', { chatId: '1' });
  const q = S.db.addJob('1', TAG + ' việc chờ'), other = S.db.addJob('1', 'việc khác'), run = S.db.addJob('1', TAG + ' đang chạy');
  S.db.raw.prepare("UPDATE jobs SET status='running' WHERE id=?").run(run);
  assert.equal(S.send({ action: 'sched.removeMatching', text: TAG }), 1);
  assert.equal(S.schedule.load().jobs.length, 1); assert.equal(S.schedule.load().jobs[0].text, 'việc khác');
  assert.equal(S.db.getJob(q).status, 'cancelled'); assert.equal(S.db.getJob(other).status, 'queued'); assert.deepEqual(S.cancelled, [run]);
  assert.equal(S.control.apply({ action: 'sched.removeMatching', text: 'ngắn' }), false, 'đoạn chữ quá ngắn không xóa gì');
  S.send({ action: 'rm -rf', id: 1 }); S.send({ action: 'job.cancel' });
  assert.equal(fs.readdirSync(S.dir).length, 0, 'tệp yêu cầu luôn được xóa');
});
