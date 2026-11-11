'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { createTrace } = require('../../orchestrator/src/trace');
const { createWatch } = require('./watch');

// BẢNG ĐIỀU KHIỂN TỪNG BOT (Cài đặt → Bảng điều khiển bot). Chạy bằng root nên đọc được dữ liệu của MỌI bot (bot quản lý và bot thường), nhưng chỉ ĐỌC cơ sở dữ liệu:
//  - danh sách lệnh bot đã nhận (jobs) + trạng thái + kết quả; chi tiết từng lệnh: các bước (trace), thành quả (tệp bot tạo ra), nhật ký quyền (audit)
//  - điều khiển (tạm dừng / tiếp tục / hủy / chạy lại) thả tệp yêu cầu vào thư mục điều khiển CỦA ĐÚNG BOT đó (control.js đọc)
//  - AI độc lập đánh giá: chép dữ liệu lệnh cho bộ điều phối bot quản lý (board/in), nhận kết quả ở board/out
//  - "Dạy bot": ghi bài học vào lessons.json trong thư mục dữ liệu của bot (lessons.js đọc ở mỗi việc mới)
//  - tài liệu lưu trữ: duyệt/xem/tải tệp trong thư mục làm việc của bot (chỉ đọc)
const ID_RE = /^(main|a\d{1,3})$/;
const MAX_LESSON = 600, MAX_LESSONS = 30;
const TEXT_PREVIEW = 300 * 1024, IMG_MAX = 4 * 1024 * 1024, DL_MAX = 25 * 1024 * 1024;
const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function createBotBoard(o) {
  o = o || {};
  const mainDir = o.mainDataDir || '/var/lib/agentos/data';
  const agentsHome = o.agentsHome || '/var/lib/agentos-agents';
  const mainWork = () => (typeof o.mainWorkdir === 'function' ? o.mainWorkdir() : o.mainWorkdir) || '/var/lib/agentos/work';
  const now = o.now || Date.now;
  const chown = o.chown || (() => {});                                   // (đường dẫn, tên người dùng) -> chuyển chủ cho bot đọc/ghi được

  function target(key) {
    key = String(key || 'main');
    if (!ID_RE.test(key)) throw new Error('Bot không hợp lệ');
    if (key === 'main') return { key, dataDir: mainDir, workdir: mainWork(), owner: 'agentos' };
    const home = path.join(agentsHome, key);
    return { key, dataDir: path.join(home, 'data'), workdir: path.join(home, 'work'), owner: 'agentos-' + key };
  }
  const watchFor = (t) => createWatch({ traceDir: path.join(t.dataDir, 'trace'), journalDir: path.join(t.dataDir, 'journal'), projects: { get: () => null } });
  const traceFor = (t) => createTrace({ dir: path.join(t.dataDir, 'trace') });

  function openDb(t) {
    let Database; try { Database = require('../../orchestrator/node_modules/better-sqlite3'); } catch (e) { try { Database = require('better-sqlite3'); } catch (e2) { throw new Error('Chưa đọc được cơ sở dữ liệu (thiếu better-sqlite3).'); } }
    const f = path.join(t.dataDir, 'agentos.db');
    if (!fs.existsSync(f)) return null;
    return new Database(f, { readonly: true, fileMustExist: true });
  }
  function withDb(t, fn) { const db = openDb(t); if (!db) return fn(null); try { return fn(db); } finally { db.close(); } }
  const kv = (db, k) => { try { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; } catch (e) { return null; } };

  // ---- sổ đánh giá + bài học (mỗi bot một tệp trong board/, bài học nằm trong thư mục dữ liệu của bot) ----
  const boardDir = path.join(mainDir, 'board');
  const reviewOut = (key, id) => path.join(boardDir, 'out', key + '-' + id + '.json');
  const reviewIn = (key, id) => path.join(boardDir, 'in', key + '-' + id + '.json');
  const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } };
  const lessonsFile = (t) => path.join(t.dataDir, 'lessons.json');
  const lessonsOf = (t) => { const j = readJson(lessonsFile(t), {}); return Array.isArray(j.lessons) ? j.lessons : []; };
  function saveLessons(t, list) {
    fs.mkdirSync(t.dataDir, { recursive: true });
    const f = lessonsFile(t), tmp = f + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ lessons: list }, null, 1), { mode: 0o644 }); fs.renameSync(tmp, f);
    try { chown(f, t.owner); } catch (e) { /* bỏ qua */ }
  }
  const reviewOf = (key, id) => { const r = readJson(reviewOut(key, id), null); return r || null; };

  // ---- danh sách lệnh ----
  function list(key, q) {
    const t = target(key); q = q || {};
    const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
    return withDb(t, (db) => {
      if (!db) return { bot: key, jobs: [], running: null, paused: null, counts: {}, lessons: lessonsOf(t), exists: false };
      const where = [], args = [];
      if (q.status === 'active') where.push("status IN ('queued','running','waiting')");
      else if (['done', 'error', 'cancelled', 'running', 'queued', 'waiting', 'limit', 'interrupted'].includes(q.status)) { where.push('status = ?'); args.push(q.status); }
      if (Number(q.before) > 0) { where.push('id < ?'); args.push(Number(q.before)); }
      const rows = db.prepare('SELECT id, status, lane, chat_id, created_at, started_at, finished_at, engine, cost_usd, substr(prompt,1,300) AS prompt, substr(result,1,240) AS result, substr(error,1,240) AS error FROM jobs' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?').all(...args, limit);
      const counts = {}; for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()) counts[r.status] = r.n;
      const paused = kv(db, 'paused_job');
      const run = db.prepare("SELECT id FROM jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1").get();
      const jobs = rows.map((r) => { const rv = reviewOf(key, r.id); return Object.assign({}, r, { paused: String(r.id) === paused && r.status === 'running', score: rv && rv.diem != null ? rv.diem : null }); });
      return { bot: key, jobs, running: run ? run.id : null, paused: paused ? Number(paused) : null, counts, lessons: lessonsOf(t), exists: true, more: rows.length === limit };
    });
  }

  // ---- chi tiết một lệnh ----
  const stepsText = (events) => events.filter((e) => e.k === 'tool').map((e) => (e.n || '') + ': ' + String(e.l || '').replace(/^\S+\s/, '')).slice(0, 80).join('\n');
  async function outputsFor(t, job) {
    const out = [], from = (Number(job.started_at) || Number(job.created_at) || 0) - 5000, to = (Number(job.finished_at) || now()) + 15000;
    const root = path.join(t.workdir, 'out');
    async function walk(dir, depth) {
      let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (out.length >= 60) return;
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4) { await walk(p, depth + 1); continue; }
        if (!e.isFile()) continue;
        let st; try { st = await fsp.stat(p); } catch (er) { continue; }
        if (st.mtimeMs >= from && st.mtimeMs <= to) out.push({ rel: 'out/' + path.relative(root, p).split(path.sep).join('/'), size: st.size, mtime: Math.round(st.mtimeMs) });
      }
    }
    await walk(root, 0);
    return out.sort((a, b) => a.mtime - b.mtime);
  }
  async function detail(key, id) {
    const t = target(key); id = Number(id);
    if (!Number.isInteger(id) || id < 1) throw new Error('Mã lệnh sai');
    const base = withDb(t, (db) => {
      if (!db) return null;
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id); if (!job) return null;
      let audit = []; try { audit = db.prepare('SELECT ts, tool, cls, decision, source, summary FROM audit WHERE job_id = ? ORDER BY id LIMIT 200').all(id); } catch (e) { /* chưa có bảng */ }
      return { job, audit, paused: kv(db, 'paused_job') === String(id) };
    });
    if (!base) throw new Error('Không có lệnh này.');
    const w = watchFor(t), tr = await traceFor(t).read(String(id), 0);
    const ch = await w.changes(String(id)).catch(() => ({ exists: false, files: [] }));
    const files = (ch.files || []).map((f) => ({ p: f.p, status: f.status, size: f.size, add: f.add || 0, del: f.del || 0, note: f.note || '' }));
    const j = base.job, ended = (tr.events || []).find((e) => e.k === 'end');
    return {
      bot: key, id,
      job: { id: j.id, status: j.status, lane: j.lane, project: j.project, engine: j.engine, cost: j.cost_usd, created: j.created_at, started: j.started_at, finished: j.finished_at, prompt: String(j.prompt || '').slice(0, 6000), result: String(j.result || '').slice(0, 20000), error: j.error || '' },
      paused: base.paused && j.status === 'running',
      steps: { count: (tr.events || []).filter((e) => e.k === 'tool').length, secs: ended ? ended.secs : null, hasTrace: !!tr.exists },
      audit: base.audit,
      deliverables: { changed: files, changedTotal: ch.total || files.length, outputs: await outputsFor(t, j) },
      review: reviewOf(key, id), reviewPending: fs.existsSync(reviewIn(key, id)) && !reviewOf(key, id),
      lessons: lessonsOf(t),
    };
  }

  // ---- AI đánh giá ----
  async function requestReview(key, id) {
    const t = target(key); id = Number(id);
    const d = await detail(key, id);
    if (!['done', 'error', 'cancelled', 'limit', 'interrupted'].includes(d.job.status)) throw new Error('Lệnh đang chạy, đợi xong rồi hãy nhờ đánh giá.');
    const tr = await traceFor(t).read(String(id), 0);
    const les = lessonsOf(t).map((x) => x.text).join(' | ');
    fs.mkdirSync(path.join(boardDir, 'in'), { recursive: true }); fs.mkdirSync(path.join(boardDir, 'out'), { recursive: true });
    try { fs.rmSync(reviewOut(key, id), { force: true }); } catch (e) { /* bỏ qua */ }
    fs.writeFileSync(reviewIn(key, id), JSON.stringify({ prompt: d.job.prompt, result: d.job.result, error: d.job.error, status: d.job.status, engine: d.job.engine, secs: d.steps.secs, stepCount: d.steps.count, steps: stepsText(tr.events || []), lessons: les }), { mode: 0o644 });
    try { chown(path.join(boardDir, 'in'), 'agentos'); chown(path.join(boardDir, 'out'), 'agentos'); chown(reviewIn(key, id), 'agentos'); } catch (e) { /* bỏ qua */ }
    control('main', { action: 'review.run', bot: key, id });
    return { requested: true };
  }

  // ---- dạy bot ----
  function teach(key, text, fromJob) {
    const t = target(key);
    const s = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LESSON);
    if (s.length < 5) throw new Error('Bài học quá ngắn.');
    const l = lessonsOf(t);
    if (l.some((x) => x.text === s)) return { lessons: l, dup: true };
    l.push({ id: crypto.randomBytes(4).toString('hex'), text: s, at: now(), fromJob: Number(fromJob) || null });
    saveLessons(t, l.slice(-MAX_LESSONS));
    return { lessons: lessonsOf(t) };
  }
  function forget(key, lessonId) {
    const t = target(key); const l = lessonsOf(t).filter((x) => x.id !== String(lessonId));
    saveLessons(t, l); return { lessons: l };
  }

  // ---- thả yêu cầu điều khiển vào thư mục điều khiển của ĐÚNG bot ----
  function control(key, req) {
    const t = target(key), dir = path.join(t.dataDir, 'control');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, now() + '-' + crypto.randomBytes(3).toString('hex') + '.json');
    fs.writeFileSync(f, JSON.stringify(req), { mode: 0o664 });
    try { chown(dir, t.owner); chown(f, t.owner); } catch (e) { /* bỏ qua */ }
    return { sent: true };
  }

  // ---- trực tiếp: các bước đang chạy của một lệnh ----
  const trace = (key, id, from) => traceFor(target(key)).read(String(id), Number(from) || 0);
  const traceSig = (key, id) => { try { if (!/^\d{1,12}$/.test(String(id))) return -1; return fs.statSync(path.join(target(key).dataDir, 'trace', String(id) + '.jsonl')).size; } catch (e) { return -1; } };
  const changes = (key, id) => watchFor(target(key)).changes(String(id));

  // ---- tài liệu lưu trữ (thư mục làm việc của bot, chỉ đọc) ----
  async function safe(t, rel) {
    const root = path.resolve(t.workdir), abs = path.resolve(root, String(rel || '').replace(/^[/\\]+/, ''));
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Đường dẫn không hợp lệ.');
    const real = await fsp.realpath(abs).catch(() => null);
    const rr = await fsp.realpath(root).catch(() => root);
    if (!real || (real !== rr && !real.startsWith(rr + path.sep))) throw new Error('Không có đường dẫn này.');
    return real;
  }
  async function archive(key, rel) {
    const t = target(key), abs = await safe(t, rel);
    const ents = await fsp.readdir(abs, { withFileTypes: true }).catch(() => { throw new Error('Không mở được thư mục.'); });
    const rows = [];
    for (const e of ents.slice(0, 600)) {
      let st; try { st = await fsp.lstat(path.join(abs, e.name)); } catch (er) { continue; }
      if (st.isSymbolicLink()) continue;
      rows.push({ name: e.name, dir: st.isDirectory(), size: st.isFile() ? st.size : 0, mtime: Math.round(st.mtimeMs) });
    }
    rows.sort((a, b) => (a.dir === b.dir ? (a.name < b.name ? -1 : 1) : a.dir ? -1 : 1));
    return { path: String(rel || ''), entries: rows };
  }
  async function fileView(key, rel, download) {
    const t = target(key), abs = await safe(t, rel), st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new Error('Không phải tệp.');
    const ext = path.extname(abs).toLowerCase(), name = path.basename(abs);
    if (download) {
      if (st.size > DL_MAX) throw new Error('Tệp quá lớn để tải qua trang này (' + Math.round(st.size / 1048576) + ' MB).');
      return { name, size: st.size, base64: (await fsp.readFile(abs)).toString('base64') };
    }
    if (IMG[ext]) { if (st.size > IMG_MAX) return { name, kind: 'big', size: st.size }; return { name, kind: 'image', size: st.size, dataUrl: 'data:' + IMG[ext] + ';base64,' + (await fsp.readFile(abs)).toString('base64') }; }
    const buf = await fsp.readFile(abs);
    const head = buf.subarray(0, 4096);
    if (head.includes(0)) return { name, kind: 'binary', size: st.size };
    return { name, kind: 'text', size: st.size, text: buf.subarray(0, TEXT_PREVIEW).toString('utf8'), cut: st.size > TEXT_PREVIEW };
  }

  function bots(agents) {
    return [{ key: 'main', name: 'Bot quản lý' }].concat((agents || []).map((a) => ({ key: a.id, name: a.name })));
  }

  return { list, detail, requestReview, teach, forget, control, trace, traceSig, changes, archive, fileView, bots, target, lessonsOf, ID_RE };
}

module.exports = { createBotBoard, ID_RE };
