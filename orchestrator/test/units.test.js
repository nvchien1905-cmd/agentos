'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createSelfTest } = require('../src/selftest');
const { createRemote } = require('../src/remote');

const ROOT = path.join(__dirname, '..', '..');

test('dịch vụ bộ điều phối: không có tùy chọn systemd làm hỏng hộp cô lập bubblewrap (đo trên máy cài thật: RestrictSUIDSGID chặn bwrap)', () => {
  const unit = fs.readFileSync(path.join(ROOT, 'iso/config/includes.chroot/etc/systemd/system/agentos-orchestrator.service'), 'utf8');
  const active = unit.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  for (const bad of ['RestrictSUIDSGID', 'RestrictNamespaces', 'PrivateDevices', 'SystemCallFilter', 'ProtectKernelTunables', 'ProtectProc', 'ProcSubset']) assert.ok(!active.includes(bad), 'bwrap cần: không đặt ' + bad);
  assert.match(active, /NoNewPrivileges=true/); assert.match(active, /ProtectSystem=strict/);          // phần gia cố còn lại vẫn giữ
});

test('apply.sh: nạp lại dịch vụ rồi khởi động lại Cài đặt và trình hướng dẫn (đang chạy mã cũ nếu không)', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'update/apply.sh'), 'utf8');
  assert.match(sh, /systemctl daemon-reload/); assert.match(sh, /agentos-settings agentos-wizard/); assert.match(sh, /systemctl is-active --quiet/);
  assert.ok(sh.indexOf('daemon-reload') < sh.indexOf('systemd-run'), 'nạp lại trước khi khởi động lại');
});

test('/tuchan: không có việc đang chạy thì không hiện "#null"', async () => {
  const mk = (cur) => createSelfTest({ db: { raw: { prepare: () => ({ get: () => ({ quick_check: 'ok' }) }) }, queuedCount: () => 0, waitingCount: () => 0 }, currentJob: () => cur, engines: [], run: async () => ({ code: 0, out: '' }) });
  const idle = (await mk(null).checks.queue()).detail, busy = (await mk(7).checks.queue()).detail;
  assert.doesNotMatch(idle, /null/); assert.match(idle, /không có việc đang chạy/); assert.match(busy, /đang chạy #7/);
});

test('/maytinh: nhiều thư mục cùng nằm trên một ổ đĩa chỉ hiện một dòng', { skip: process.platform !== 'linux' }, async () => {
  const df = 'Filesystem Size Used Avail Use% Mounted on\n/dev/sda2 294G 9,0G 270G 4% /\n/dev/sda2 294G 9,0G 270G 4% /srv/onedrive\n/dev/sda2 294G 9,0G 270G 4% /var/lib/agentos\n/dev/sdb1 100G 1G 99G 1% /mnt/du-lieu';
  // đoạn df chạy qua execFile thật; ở đây kiểm bằng cách thay lệnh df bằng tệp giả trong PATH
  const os = require('os'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfbin-'));
  fs.writeFileSync(path.join(dir, 'df'), '#!/bin/sh\ncat <<EOF\n' + df + '\nEOF\n', { mode: 0o755 });
  const old = process.env.PATH; process.env.PATH = dir + ':' + old;
  try { const t = (await createRemote({}).sysinfo()).text; const lines = t.split('\n').filter((l) => /^\s+sd/.test(l)); assert.equal(lines.length, 2, t); assert.match(lines[0], /sda2 \(\/\): dùng 9,0G\/294G/); assert.match(lines[1], /sdb1/); }
  finally { process.env.PATH = old; }
});

test('chế độ toàn quyền: Cài đặt đổi FULL_ACCESS trong env thì thắng lệnh Telegram cũ; env không đổi thì lệnh Telegram được giữ', () => {
  const { reconcile } = require('../src/mode');
  const { openDb } = require('../src/db');
  const db = openDb(':memory:');
  assert.deepEqual(reconcile(db, true), { changed: false, value: null });             // lần đầu: chỉ ghi nhớ env
  db.kvSet('fullAccess', '0');                                                        // chủ gõ /baove trên Telegram
  assert.deepEqual(reconcile(db, true), { changed: false, value: '0' });              // env vẫn như cũ -> giữ lệnh Telegram
  db.kvSet('fullAccess', '1');                                                        // chủ gõ /toanquyen
  assert.equal(reconcile(db, false).changed, true); assert.equal(db.kvGet('fullAccess'), '0', 'Cài đặt chuyển sang Bảo vệ thì thắng');
  assert.equal(reconcile(db, false).changed, false);
  assert.equal(reconcile(db, true).changed, true); assert.equal(db.kvGet('fullAccess'), '1');
});

test('dịch vụ AgentOS: KHÔNG có vòng thứ tự khởi động (vòng làm systemd xóa việc khởi động bộ điều phối -> bot im sau mỗi lần bật máy lại)', () => {
  const dir = path.join(ROOT, 'iso/config/includes.chroot/etc/systemd/system');
  const edges = new Map(); const add = (a, b) => { if (!edges.has(a)) edges.set(a, new Set()); edges.get(a).add(b); };   // a phải chạy TRƯỚC b
  const names = fs.readdirSync(dir).filter((n) => /\.service$/.test(n));
  for (const n of names) {
    const txt = fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l));
    for (const l of txt) {
      let m;
      if ((m = l.match(/^After=(.+)$/))) for (const v of m[1].split(/\s+/).filter(Boolean)) add(v, n);
      if ((m = l.match(/^Before=(.+)$/))) for (const v of m[1].split(/\s+/).filter(Boolean)) add(n, v);
      if ((m = l.match(/^WantedBy=(.+)$/))) for (const t of m[1].split(/\s+/).filter(Boolean)) add(n, t);       // target được dịch vụ này kéo vào thì nằm SAU nó
    }
  }
  // thứ tự mặc định có sẵn của systemd: multi-user.target chạy sau basic.target, graphical.target sau multi-user.target
  add('basic.target', 'multi-user.target'); add('multi-user.target', 'graphical.target');
  const state = new Map(); let cycle = null;
  const visit = (u, stack) => {
    if (cycle) return;
    if (state.get(u) === 1) { cycle = stack.slice(stack.indexOf(u)).concat(u); return; }
    if (state.get(u) === 2) return;
    state.set(u, 1);
    for (const v of edges.get(u) || []) visit(v, stack.concat(u));
    state.set(u, 2);
  };
  for (const u of [...edges.keys()]) visit(u, []);
  assert.equal(cycle, null, 'vòng thứ tự: ' + (cycle && cycle.join(' -> ')));
});
