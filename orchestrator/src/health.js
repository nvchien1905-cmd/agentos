'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Báo cho systemd (Type=notify, NotifyAccess=all): READY=1, WATCHDOG=1, STATUS=... Không chạy dưới systemd thì bỏ qua.
function systemdNotify(assignments) {
  if (!process.env.NOTIFY_SOCKET) return;
  try {
    const c = spawn('systemd-notify', assignments, { stdio: 'ignore' });
    c.on('error', () => { /* không có systemd-notify */ });
    c.unref();
  } catch (e) { /* bỏ qua */ }
}

// Nhịp tim: mỗi `intervalMs` kiểm tra sức khỏe, ghi file heartbeat (cho healthcheck.js) và, nếu khỏe, báo WATCHDOG=1.
// Không khỏe (cơ sở dữ liệu lỗi, vòng nhận tin Telegram đứng) -> KHÔNG báo -> systemd tự khởi động lại sau WatchdogSec.
// Mất mạng KHÔNG tính là không khỏe (khởi động lại không chữa được mạng): chỉ đo vòng nhận tin còn quay hay không.
//   tickLoop()  gọi mỗi vòng nhận tin (kể cả vòng lỗi)      markPoll()  gọi khi nhận tin Telegram thành công
//   stats()     -> { running, queued }
function createHealth({ db, file, log, notify, intervalMs, loopStaleMs, now, stats }) {
  log = log || (() => {});
  notify = notify || systemdNotify;
  intervalMs = intervalMs || 10000;
  loopStaleMs = loopStaleMs || 180000;
  now = now || Date.now;
  stats = stats || (() => ({}));
  const st = { startedAt: now(), lastLoop: now(), lastPoll: 0, ready: false };
  let timer = null;

  function check() {
    let dbOk = true;
    try { db.raw.prepare('SELECT 1').get(); } catch (e) { dbOk = false; log('cơ sở dữ liệu không trả lời: ' + e.message); }
    const loopOk = now() - st.lastLoop < loopStaleMs;
    const ok = dbOk && loopOk;
    const s = stats() || {};
    const beat = { ts: now(), pid: process.pid, startedAt: st.startedAt, ok, dbOk, loopOk, lastPoll: st.lastPoll, running: s.running || null, queued: s.queued || 0 };
    if (file) {
      try {
        const tmp = file + '.tmp';
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(beat));
        fs.renameSync(tmp, file);
      } catch (e) { log('không ghi được heartbeat: ' + e.message); }
    }
    if (ok) notify(['WATCHDOG=1', 'STATUS=' + (s.running ? 'đang chạy việc #' + s.running : 'rảnh') + ', chờ ' + (s.queued || 0) + (st.lastPoll && now() - st.lastPoll > 120000 ? ', Telegram chưa kết nối được' : '')]);
    else log('không khỏe (db=' + dbOk + ', vòng nhận tin=' + loopOk + ') -> không báo watchdog, systemd sẽ khởi động lại');
    return beat;
  }

  return {
    check,
    tickLoop() { st.lastLoop = now(); },
    markPoll() { st.lastPoll = now(); st.lastLoop = now(); },
    // Gọi một lần khi đã sẵn sàng nhận việc (sau khi nối được Telegram).
    ready() { if (!st.ready) { st.ready = true; notify(['READY=1']); } },
    start() { check(); timer = setInterval(check, intervalMs); if (timer.unref) timer.unref(); },
    stop() { clearInterval(timer); notify(['STOPPING=1']); },
  };
}

// Dùng cho scripts/healthcheck.js: đọc heartbeat, trả { ok, reason }.
function readHeartbeat(file, maxAgeMs, at) {
  let beat;
  try { beat = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, reason: 'không đọc được heartbeat (' + e.code + ')' }; }
  const age = (at == null ? Date.now() : at) - beat.ts;
  if (age > (maxAgeMs || 60000)) return { ok: false, reason: 'heartbeat cũ ' + Math.round(age / 1000) + ' giây', beat };
  if (!beat.ok) return { ok: false, reason: 'tiến trình báo không khỏe (db=' + beat.dbOk + ', vòng nhận tin=' + beat.loopOk + ')', beat };
  return { ok: true, reason: 'ổn', beat };
}

module.exports = { createHealth, readHeartbeat, systemdNotify };
