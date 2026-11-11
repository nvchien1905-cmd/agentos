'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiFix, buildPrompt } = require('../src/aifix');
const { createHealthMon } = require('../src/healthmon');

const fakeDb = () => { const m = {}; return { kvGet: (k) => (k in m ? m[k] : null), kvSet: (k, v) => { m[k] = v; } }; };

test('AI tự sửa: giao một việc gom mọi lỗi, tối đa 2 lần/ngày/lỗi, cách nhau ≥ 1 giờ, tắt được', () => {
  let t = 1800000000000; const jobs = [];
  const f = createAiFix({ db: fakeDb(), now: () => t, submit: (p) => { jobs.push(p); return jobs.length; } });
  const bad = [{ id: 'x', name: 'Máy in', detail: 'không thấy máy in' }, { id: 'y', name: 'Kho tệp', detail: 'ổ lỗi' }];
  const a = f.repair(bad); assert.equal(jobs.length, 1); assert.equal(a.jobs.length, 2);
  assert.match(jobs[0], /Máy in/); assert.match(jobs[0], /TỰ SỬA/);
  assert.equal(f.repair(bad).jobs.length, 0, 'chưa đủ 1 giờ: không giao lại');
  t += 61 * 60 * 1000; assert.equal(f.repair(bad).jobs.length, 2);
  t += 61 * 60 * 1000; const c = f.repair(bad); assert.equal(c.jobs.length, 0); assert.match(c.notes[0], /đã thử 2 lần/);
  const off = createAiFix({ db: fakeDb(), enabled: () => false, submit: () => { throw new Error('không được gọi'); } });
  assert.equal(off.repair(bad).jobs.length, 0);
  assert.match(buildPrompt(bad), /Không xóa dữ liệu/);
});

test('giám sát: lỗi không có cách sửa cố định → giao AI và báo cho chủ; lỗi bác sĩ máy đã sửa xong thì không giao', async () => {
  const sent = [], jobs = [];
  const selftest = { light: async () => [{ id: 'printer', name: 'Máy in', status: 'fail', detail: 'mất kết nối' }, { id: 'services', name: 'Dịch vụ', status: 'fail', detail: 'không chạy: cups' }, { id: 'ok', name: 'Mạng', status: 'ok', detail: '' }] };
  const doctor = { heal: async () => [{ id: 'services', name: 'Dịch vụ', tried: true, fixed: true, note: 'đã khởi động lại cups' }], hasRule: (id) => id === 'services' };
  const aiFix = createAiFix({ db: fakeDb(), submit: (p) => { jobs.push(p); return 7; } });
  const M = createHealthMon({ selftest, db: fakeDb(), notify: async (a, m) => { sent.push(m); }, admins: ['1'], doctor, aiFix });
  await M.tick();
  assert.equal(jobs.length, 1); assert.match(jobs[0], /Máy in/); assert.doesNotMatch(jobs[0], /Dịch vụ \(services\)/);
  assert.ok(sent.some((m) => /giao AI tự sửa \(việc #7\)/.test(m)), sent.join('|'));
});
