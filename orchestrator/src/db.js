'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued|running|waiting|done|error|limit|cancelled|interrupted
  engine      TEXT,
  engine_pref TEXT,      -- người dùng ép dùng engine này (/claude, /codex)
  profile     TEXT,      -- bộ công cụ của việc (tools.json); trống = mặc định
  run_after   INTEGER,   -- status=waiting: chạy lại không sớm hơn mốc này (ms)
  result      TEXT,
  error       TEXT,
  session_id  TEXT,
  cost_usd    REAL,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, id);
CREATE INDEX IF NOT EXISTS jobs_chat ON jobs(chat_id, id);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
-- Nhật ký mọi lần AI xin dùng công cụ: ai quyết (policy|auto|user|timeout|cancel|error), cho phép hay từ chối
CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  job_id   INTEGER,
  tool     TEXT,
  cls      TEXT,
  decision TEXT,
  source   TEXT,
  summary  TEXT
);
CREATE INDEX IF NOT EXISTS audit_job ON audit(job_id, id);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  // Nâng cấp cơ sở dữ liệu GĐ 1 (thiếu cột mới)
  const cols = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  if (!cols.includes('engine_pref')) db.exec('ALTER TABLE jobs ADD COLUMN engine_pref TEXT');
  if (!cols.includes('run_after')) db.exec('ALTER TABLE jobs ADD COLUMN run_after INTEGER');
  if (!cols.includes('profile')) db.exec('ALTER TABLE jobs ADD COLUMN profile TEXT');
  const now = () => Date.now();

  const q = {
    add: db.prepare('INSERT INTO jobs (chat_id, prompt, engine_pref, profile, created_at) VALUES (?, ?, ?, ?, ?)'),
    get: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    next: db.prepare("SELECT * FROM jobs WHERE status = 'queued' OR (status = 'waiting' AND run_after <= ?) ORDER BY id LIMIT 1"),
    run: db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status IN ('queued','waiting')"),
    setEngine: db.prepare('UPDATE jobs SET engine = ? WHERE id = ?'),
    wait: db.prepare("UPDATE jobs SET status = 'waiting', run_after = ? WHERE id = ?"),
    finish: db.prepare('UPDATE jobs SET status = ?, result = ?, error = ?, session_id = ?, cost_usd = ?, run_after = NULL, finished_at = ? WHERE id = ?'),
    recent: db.prepare('SELECT * FROM jobs WHERE chat_id = ? ORDER BY id DESC LIMIT ?'),
    history: db.prepare("SELECT id, prompt, result FROM jobs WHERE chat_id = ? AND status = 'done' AND id > ? AND id < ? ORDER BY id DESC LIMIT ?"),
    lastId: db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM jobs WHERE chat_id = ?'),
    countQueued: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','waiting')"),
    countWaiting: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'waiting'"),
    countAhead: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','waiting') AND id < ?"),
    running: db.prepare("SELECT * FROM jobs WHERE status = 'running'"),
    interrupt: db.prepare("UPDATE jobs SET status = 'interrupted', finished_at = ? WHERE status = 'running'"),
    cancelQueued: db.prepare("UPDATE jobs SET status = 'cancelled', run_after = NULL, finished_at = ? WHERE chat_id = ? AND status IN ('queued','waiting')"),
    addAudit: db.prepare('INSERT INTO audit (ts, job_id, tool, cls, decision, source, summary) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    recentAudit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?'),
    jobAudit: db.prepare('SELECT * FROM audit WHERE job_id = ? ORDER BY id'),
    kvGet: db.prepare('SELECT v FROM kv WHERE k = ?'),
    kvSet: db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    kvDel: db.prepare('DELETE FROM kv WHERE k = ?'),
    kvDelPrefix: db.prepare("DELETE FROM kv WHERE substr(k, 1, length(?)) = ?"),
  };

  return {
    raw: db,
    addJob(chatId, prompt, enginePref, profile) { return Number(q.add.run(String(chatId), prompt, enginePref || null, profile || null, now()).lastInsertRowid); },
    getJob(id) { return q.get.get(id); },
    // Lấy việc tới lượt (đang xếp hàng, hoặc đang chờ hạn mức mà đã tới giờ) và đánh dấu đang chạy.
    claimNext(at) {
      const j = q.next.get(at == null ? now() : at);
      if (!j) return null;
      if (q.run.run(now(), j.id).changes !== 1) return null;
      return q.get.get(j.id); // run_after còn nguyên để biết việc này từng phải chờ
    },
    setEngine(id, engine) { q.setEngine.run(engine, id); },
    setWaiting(id, runAfter) { q.wait.run(runAfter, id); },
    finishJob(id, status, { result = null, error = null, sessionId = null, costUsd = null } = {}) {
      q.finish.run(status, result, error, sessionId, costUsd, now(), id);
    },
    recentJobs(chatId, n) { return q.recent.all(String(chatId), n || 5); },
    // Các việc 'done' gần nhất của chat với id trong (afterId, beforeId), cũ -> mới.
    history(chatId, afterId, beforeId, n) { return q.history.all(String(chatId), afterId || 0, beforeId, n || 3).reverse(); },
    lastJobId(chatId) { return q.lastId.get(String(chatId)).n; },
    queuedCount() { return q.countQueued.get().n; },
    waitingCount() { return q.countWaiting.get().n; },
    aheadOf(id) { return q.countAhead.get(id).n; },
    // Khởi động lại sau sự cố: việc đang chạy dở KHÔNG tự chạy lại (có thể đã gây tác dụng phụ).
    markInterrupted() {
      const list = q.running.all();
      q.interrupt.run(now());
      return list;
    },
    cancelQueued(chatId) { return q.cancelQueued.run(now(), String(chatId)).changes; },
    addAudit(a) { q.addAudit.run(now(), a.jobId == null ? null : a.jobId, a.tool || null, a.cls || null, a.decision, a.source || null, String(a.summary || '').slice(0, 500)); },
    recentAudit(n) { return q.recentAudit.all(n || 15).reverse(); },
    jobAudit(jobId) { return q.jobAudit.all(jobId); },
    // Sao lưu nhất quán ra file mới (VACUUM INTO).
    backupTo(file) { db.exec("VACUUM INTO '" + String(file).replace(/'/g, "''") + "'"); },
    // Dọn dữ liệu cũ để file không phình mãi: việc đã xong trước jobsBefore, nhật ký trước auditBefore (ms). Việc đang chờ/chạy giữ nguyên.
    pruneOld(jobsBefore, auditBefore) {
      const jobs = db.prepare("DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ? AND status IN ('done','error','limit','cancelled','interrupted')").run(jobsBefore).changes;
      const audit = db.prepare('DELETE FROM audit WHERE ts < ?').run(auditBefore).changes;
      return { jobs, audit };
    },
    kvGet(k) { const r = q.kvGet.get(k); return r ? r.v : null; },
    kvSet(k, v) { q.kvSet.run(k, String(v)); },
    kvDel(k) { q.kvDel.run(k); },
    kvDelPrefix(p) { q.kvDelPrefix.run(p, p); },
    close() { db.close(); },
  };
}

module.exports = { openDb };
