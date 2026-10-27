'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createAuditLog, mask } = require('../src/auditlog');
const { createProjects } = require('../src/projects');
const { createBot } = require('../src/bot');

const NOW = Date.parse('2026-10-27T12:00:00+07:00');
function mk() {
  const db = openDb(':memory:'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-')); const P = createProjects({ db, baseDir: dir });
  const A = createAuditLog({ db, projects: P, now: () => NOW, roles: { label: (u) => (u === '222' ? 'Nhân viên' : 'Chủ máy') } });
  const job = (chat, prompt, o) => {
    o = o || {}; const id = db.addJob(chat, prompt, null, null, 'main', o.project || null); db.claimNext();
    db.raw.prepare('UPDATE jobs SET engine = ?, status = ?, result = ?, error = ?, created_at = ?, started_at = ?, finished_at = ?, cost_usd = ? WHERE id = ?')
      .run(o.engine || 'claude', o.status || 'done', o.result || 'ok', o.error || null, o.at || NOW - 3600e3, (o.at || NOW - 3600e3) + 1000, (o.at || NOW - 3600e3) + 9000, o.cost == null ? null : o.cost, id);
    return id;
  };
  const tool = (jobId, name, decision, source, summary, cls) => db.raw.prepare('INSERT INTO audit (ts, job_id, tool, cls, decision, source, summary) VALUES (?,?,?,?,?,?,?)').run(NOW - 3000e3, jobId, name, cls || 'write', decision, source, summary);
  return { db, P, A, job, tool };
}

test('nhật ký: danh sách có người nhắn + vai, dự án, AI, thời gian, công cụ bị từ chối; lọc theo trạng thái/dự án/chữ/từ chối/ngày', () => {
  const { P, A, job, tool } = mk(); const p = P.create('Kế toán');
  const a = job('111', 'Lập báo cáo doanh số', { project: p.id }), b = job('222', 'Xóa thư mục tạm', { status: 'error', error: 'bị chặn' }), c = job('111', 'việc cũ', { at: NOW - 20 * 86400e3 });
  tool(a, 'Write', 'allow', 'auto', '/srv/x.md'); tool(b, 'Bash', 'deny', 'policy', 'rm -rf /srv'); tool(b, 'Bash', 'allow', 'user', 'ls');
  const all = A.list({ days: 7 }); assert.deepEqual(all.map((x) => x.id), [b, a]); assert.equal(all[0].who, '222 (Nhân viên)'); assert.equal(all[1].who, '111 (Chủ máy)'); assert.equal(all[1].projectName, 'Kế toán');
  assert.equal(all[0].tools, 2); assert.equal(all[0].denied, 1); assert.equal(all[0].secs, 8); assert.equal(all[0].statusText, 'lỗi'); assert.match(all[1].at, /^2026-10-27 11:00/);
  assert.deepEqual(A.list({ days: 30 }).map((x) => x.id), [c, b, a]);
  assert.deepEqual(A.list({ status: 'error' }).map((x) => x.id), [b]); assert.deepEqual(A.list({ project: p.id }).map((x) => x.id), [a]); assert.deepEqual(A.list({ project: '-' }).map((x) => x.id), [b]);
  assert.deepEqual(A.list({ q: 'báo cáo' }).map((x) => x.id), [a]); assert.deepEqual(A.list({ denied: true }).map((x) => x.id), [b]); assert.deepEqual(A.list({ chat: '222' }).map((x) => x.id), [b]);
});

test('nhật ký: chi tiết một việc (yêu cầu, kết quả, từng công cụ AI xin) và che khóa/token', () => {
  const { A, job, tool } = mk();
  const id = job('111', 'Dùng token=AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw và password: hunter2', { result: 'khóa sk-ant-api03-ABCDEFGHIJKLMNOP đã lưu' });
  tool(id, 'Bash', 'deny', 'policy', 'curl -H "key=SECRETVALUE123" http://x');
  const d = A.detail(id); assert.equal(d.tools.length, 1); assert.equal(d.tools[0].decision, 'deny');
  const all = JSON.stringify(d) + JSON.stringify(A.list({})); for (const leak of ['AAHdqTcv', 'hunter2', 'sk-ant-api03', 'SECRETVALUE123']) assert.ok(!all.includes(leak), 'lộ ' + leak);
  assert.equal(A.detail(9999), null); assert.equal(mask('mật khẩu = abc123'), 'mật khẩu=***');
});

test('nhật ký: báo cáo tuần + CSV (dấu phẩy/ngoặc kép/xuống dòng được bọc đúng, có BOM cho Excel)', () => {
  const { A, job, tool } = mk();
  const a = job('111', 'Tính "doanh số", xong\nbáo'), b = job('222', 'Chạy lệnh', { status: 'error' }); tool(b, 'Bash', 'deny', 'policy', 'sudo reboot'); tool(a, 'Read', 'allow', 'auto', 'x'); tool(a, '/lenh', 'allow', 'user', 'df -h', 'remote');
  const t = A.weekText(7); assert.match(t, /2 việc \(1 xong, 1 lỗi/); assert.match(t, /1 bị từ chối/); assert.match(t, /sudo reboot/); assert.match(t, /Lệnh điều khiển máy gần đây:[\s\S]*df -h/); assert.match(t, /Ai nhắn nhiều: .*111/);
  const csv = A.csv(7); assert.ok(csv.startsWith('﻿Việc,Thời gian')); assert.match(csv, /"Tính ""doanh số"", xong báo"/); assert.equal(csv.trim().split('\r\n').length, 3);
});

test('/nhatky tuan: chỉ chủ máy xem báo cáo tuần', async () => {
  const { db, A, job } = mk(); job('111', 'a');
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  const bot = createBot({ db, worker, allowed: new Set(['111', '222']), profiles: [], isAdmin: (u) => String(u) === '111', quietAck: true, auditlog: A });
  const say = (uid, t) => bot.handle({ from: { id: uid }, chat: { id: uid, type: 'private' }, text: t });
  assert.match(await say(111, '/nhatky tuan'), /Nhật ký 7 ngày qua: 1 việc/); assert.match(await say(222, '/nhatky tuan'), /Chỉ chủ máy/);
});
