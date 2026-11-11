'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { createTrace } = require('../../orchestrator/src/trace');
const { createWatch } = require('./watch');
const searchLib = require('../../orchestrator/src/search');

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
  // (o.onedriveDir: thư mục OneDrive của bot quản lý, có sổ tay ở AgentOS/SO-TAY)

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

  // ---- BỘ NHỚ của bot: tóm tắt cuộn từng cuộc trò chuyện, sổ tay (mục lục + chương), việc cũ tìm lại được, bài học ----
  // Mặc định giống memory.js: giữ nguyên văn 4 việc gần nhất, nén khi có từ 15 việc cũ.
  const KEEP_RECENT = 4, COMPRESS_AT = 15;
  function bookDirOf(t) {
    const candidates = t.key === 'main'
      ? [path.join(o.onedriveDir || '/srv/onedrive', 'AgentOS', 'SO-TAY'), path.join(t.dataDir, 'so-tay')]
      : [path.join(path.dirname(t.dataDir), 'onedrive', 'AgentOS', 'SO-TAY'), path.join(t.dataDir, 'so-tay')];
    return candidates.find((d) => fs.existsSync(d)) || candidates[0];
  }
  function bookOf(t) {
    const dir = bookDirOf(t), { createBook } = require('../../orchestrator/src/book');
    const bk = createBook({ rootDir: dir });
    const chapters = bk.list().map((c) => ({ slug: c.slug, no: c.part ? c.part + '.' + c.no : '', part: c.part || 9, title: c.title, summary: c.summary, updated: c.updated, entries: c.entries.map((e) => ({ id: e.id, date: e.date, text: e.text })) }));
    let history = 0; try { for (const n of fs.readdirSync(path.join(dir, '.lichsu'))) history += (fs.readFileSync(path.join(dir, '.lichsu', n), 'utf8').match(/^- /gm) || []).length; } catch (e) { /* chưa có */ }
    let inbox = 0; try { inbox = (fs.readFileSync(path.join(path.dirname(dir), 'GHI-NHO.md'), 'utf8').match(/^- /gm) || []).length; } catch (e) { /* chưa có */ }
    return { dir, exists: fs.existsSync(dir), chapters, entries: chapters.reduce((s, c) => s + c.entries.length, 0), history, inbox };
  }
  function memory(key) {
    const t = target(key), book = bookOf(t);
    const out = withDb(t, (db) => {
      if (!db) return { exists: false, scopes: [], jobs: { total: 0, done: 0, indexed: 0 } };
      const num = (sql, ...a) => { try { return db.prepare(sql).get(...a).n; } catch (e) { return 0; } };
      const sums = []; try { sums.push(...db.prepare("SELECT k, v FROM kv WHERE k LIKE 'sum:%'").all()); } catch (e) { /* chưa có */ }
      const scopes = sums.map((r) => {
        const scope = r.k.slice(4), i = scope.indexOf('#'), chat = i < 0 ? scope : scope.slice(0, i), proj = i < 0 ? '' : scope.slice(i + 1);
        const upto = Number(kv(db, 'sumupto:' + scope)) || 0, from = Number(kv(db, 'ctxfrom:' + scope)) || 0, after = Math.max(upto, from);
        const pending = num("SELECT COUNT(*) AS n FROM jobs WHERE chat_id = ? AND COALESCE(project,'') = ? AND status = 'done' AND id > ?", chat, proj, after);
        const compressed = num("SELECT COUNT(*) AS n FROM jobs WHERE chat_id = ? AND COALESCE(project,'') = ? AND status = 'done' AND id <= ? AND id > ?", chat, proj, upto, from);
        const toCompress = Math.max(0, pending - KEEP_RECENT);
        return { scope, chat, project: proj, summary: r.v, summaryLen: r.v.length, upTo: upto, compressedJobs: compressed, pendingJobs: pending, untilNext: Math.max(0, COMPRESS_AT - toCompress), willCompress: toCompress >= COMPRESS_AT };
      }).sort((a, b) => b.upTo - a.upTo);
      // cuộc trò chuyện có việc nhưng CHƯA có tóm tắt (chưa tới ngưỡng nén lần đầu)
      let fresh = []; try { fresh = db.prepare("SELECT chat_id, COALESCE(project,'') AS project, COUNT(*) AS n FROM jobs WHERE status = 'done' GROUP BY chat_id, COALESCE(project,'')").all(); } catch (e) { /* chưa có */ }
      const have = new Set(scopes.map((s) => s.scope));
      for (const f of fresh) {
        const scope = f.chat_id + (f.project ? '#' + f.project : '');
        if (have.has(scope)) continue;
        const from = Number(kv(db, 'ctxfrom:' + scope)) || 0;
        const pending = from ? num("SELECT COUNT(*) AS n FROM jobs WHERE chat_id = ? AND COALESCE(project,'') = ? AND status = 'done' AND id > ?", f.chat_id, f.project, from) : f.n;
        scopes.push({ scope, chat: String(f.chat_id), project: f.project, summary: '', summaryLen: 0, upTo: 0, compressedJobs: 0, pendingJobs: pending, untilNext: Math.max(0, COMPRESS_AT - Math.max(0, pending - KEEP_RECENT)), willCompress: pending - KEEP_RECENT >= COMPRESS_AT });
      }
      const sessions = []; try { for (const r of db.prepare("SELECT k FROM kv WHERE k LIKE 'turns:%'").all()) sessions.push(r.k); } catch (e) { /* chưa có */ }
      return { exists: true, scopes, jobs: { total: num('SELECT COUNT(*) AS n FROM jobs'), done: num("SELECT COUNT(*) AS n FROM jobs WHERE status = 'done'"), indexed: num('SELECT COUNT(*) AS n FROM jobs_fts') }, aiSessions: sessions.length };
    });
    return Object.assign({ bot: key, rules: { keepRecent: KEEP_RECENT, compressAt: COMPRESS_AT }, book, lessons: lessonsOf(t) }, out);
  }

  // ---- Ô TÌM CHUNG: tìm trong câu hỏi + câu trả lời của mọi việc (và sổ tay, bài học) của một bot, hoặc của TẤT CẢ bot (key = 'all') ----
  function search(key, text, q) {
    q = q || {};
    const t = target(key);
    return withDb(t, (db) => {
      if (!db) return { bot: t.key, exists: false, hits: [], total: 0, terms: [], memory: [] };
      const r = searchLib.searchJobs(db, text, { status: q.status || undefined, from: Number(q.from) || 0, to: Number(q.to) || 0, limit: q.limit, offset: q.offset, chatId: q.chat || undefined });
      let mem = [];
      if (!Number(q.offset)) { try { mem = searchLib.searchMemory(bookOf(t).chapters, lessonsOf(t), text, 8); } catch (e) { mem = []; } }
      return { bot: t.key, exists: true, hits: r.hits, total: r.total, terms: r.terms, mode: r.mode, memory: mem };
    });
  }
  function searchAll(text, q, agents) {
    const keys = bots(agents).map((b) => b.key), names = new Map(bots(agents).map((b) => [b.key, b.name]));
    const parts = keys.map((k) => { try { return search(k, text, Object.assign({}, q, { offset: 0, limit: 50 })); } catch (e) { return { bot: k, hits: [], total: 0, memory: [], error: e.message }; } });
    const hits = [].concat(...parts.map((p) => p.hits.map((h) => Object.assign({}, h, { bot: p.bot, botName: names.get(p.bot) })))).sort((a, b) => b.at - a.at);
    const off = Math.max(0, Number(q && q.offset) || 0), lim = Math.max(1, Math.min(50, Number(q && q.limit) || 20));
    return { bot: 'all', exists: true, hits: hits.slice(off, off + lim), total: parts.reduce((s, p) => s + p.total, 0), terms: searchLib.terms(text), memory: [].concat(...parts.map((p) => (p.memory || []).map((m) => Object.assign({}, m, { bot: p.bot, botName: names.get(p.bot) })))).slice(0, 12) };
  }

  function bots(agents) {
    return [{ key: 'main', name: 'Bot quản lý' }].concat((agents || []).map((a) => ({ key: a.id, name: a.name })));
  }

  return { search, searchAll, list, detail, requestReview, teach, forget, control, trace, traceSig, changes, archive, fileView, memory, bots, target, lessonsOf, ID_RE };
}

module.exports = { createBotBoard, ID_RE };
