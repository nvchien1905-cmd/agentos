'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { describe, clean } = require('./progress');

// DẤU VẾT TỪNG BƯỚC của AI (để màn hình "Việc AI" trong Cài đặt xem trực tiếp như màn hình Claude Code): mỗi việc một tệp JSON-từng-dòng
// {t giờ, k loại, n tên công cụ, l nhãn một dòng, i tóm tắt đầu vào, todos danh sách việc cần làm, text lời AI}. Đã che khóa/mật khẩu; KHÔNG lưu nội dung tệp.
// Chỉ ghi thêm vào cuối (an toàn khi đọc cùng lúc); quá 3 MB một việc thì dừng ghi bước (vẫn ghi kết thúc); giữ 400 việc gần nhất, tối đa 30 ngày.
const DEFAULTS = { maxBytes: 3 * 1024 * 1024, keep: 400, keepDays: 30, maxTodos: 25 };

function summarize(name, input) {
  const i = input || {};
  const o = {};
  if (name === 'Bash') { o.cmd = clean(i.command, 500); if (i.description) o.desc = clean(i.description, 140); }
  else if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit') o.file = String(i.file_path || i.path || '').slice(0, 300);
  else if (name === 'NotebookEdit') o.file = String(i.notebook_path || '').slice(0, 300);
  else if (name === 'Glob' || name === 'Grep') o.pattern = clean(i.pattern || i.query, 200);
  else if (name === 'WebFetch') o.url = clean(i.url, 300);
  else if (name === 'WebSearch') o.query = clean(i.query, 200);
  else if (name === 'Task' || name === 'Agent') o.desc = clean(i.description || i.prompt, 200);
  return o;
}

function todosOf(name, input) {
  if (name !== 'TodoWrite' || !input || !Array.isArray(input.todos)) return null;
  return input.todos.slice(0, DEFAULTS.maxTodos).map((t) => ({ c: clean(t && (t.content || t.activeForm), 140), a: clean(t && t.activeForm, 140), s: ['completed', 'in_progress', 'pending'].includes(t && t.status) ? t.status : 'pending' })).filter((t) => t.c);
}

function createTrace(o) {
  const dir = o.dir, now = o.now || Date.now, log = o.log || (() => {});
  const L = Object.assign({}, DEFAULTS, o.limits || {});
  const sizes = new Map();
  const file = (id) => { if (!/^\d{1,12}$/.test(String(id))) throw new Error('mã việc không hợp lệ'); return path.join(dir, id + '.jsonl'); };
  let ready = false;
  const put = (id, ev, force) => {
    try {
      if (!ready) { fs.mkdirSync(dir, { recursive: true, mode: 0o755 }); ready = true; }
      const line = JSON.stringify(ev) + '\n';
      const sz = (sizes.get(id) || 0) + line.length;
      if (sz > L.maxBytes && !force) return;
      sizes.set(id, sz); if (sizes.size > 500) sizes.delete(sizes.keys().next().value);
      fs.appendFileSync(file(id), line);
    } catch (e) { log('dấu vết lỗi: ' + e.message); }
  };
  return {
    todosOf,
    begin(job) { put(String(job.id), { t: now(), k: 'start', chat: String(job.chat_id), project: job.project || null, lane: job.lane || 'main', prompt: clean(job.prompt, 400) }, true); },
    // ev: { kind:'tool'|'text', name, input, text } (progress.js)
    step(job, ev) {
      if (!ev) return;
      const id = String(job.id);
      if (ev.kind === 'text') { const t = clean(ev.text, 900); if (t) put(id, { t: now(), k: 'text', text: t }); return; }
      const td = todosOf(ev.name, ev.input);
      if (td) { put(id, { t: now(), k: 'todo', todos: td }); return; }
      put(id, { t: now(), k: 'tool', n: String(ev.name || ''), l: describe(ev) || ('🔧 ' + clean(ev.name, 40)), i: summarize(ev.name, ev.input) });
    },
    end(job, info) { put(String(job.id), { t: now(), k: 'end', ok: !!(info && info.ok), secs: info && info.secs, steps: info && info.steps }, true); },
    // Đọc từ dòng thứ `from`; trả { events, next, done, todos } (todos = danh sách mới nhất)
    async read(id, from) {
      let txt; try { txt = await fsp.readFile(file(id), 'utf8'); } catch (e) { return { events: [], next: 0, done: false, todos: null, exists: false }; }
      const lines = txt.split('\n').filter(Boolean), events = [];
      let todos = null, done = false;
      for (let n = 0; n < lines.length; n++) {
        let ev; try { ev = JSON.parse(lines[n]); } catch (e) { continue; }
        if (ev.k === 'todo') todos = ev.todos;
        if (ev.k === 'end') done = true;
        if (n >= (from || 0)) events.push(ev);
      }
      return { events, next: lines.length, done, todos, exists: true };
    },
    async gc() {
      let names; try { names = (await fsp.readdir(dir)).filter((n) => /^\d+\.jsonl$/.test(n)); } catch (e) { return; }
      const info = [];
      for (const n of names) { try { info.push({ n, m: (await fsp.stat(path.join(dir, n))).mtimeMs }); } catch (e) { /* bỏ */ } }
      info.sort((a, b) => b.m - a.m);
      for (let k = 0; k < info.length; k++) if (k >= L.keep || now() - info[k].m > L.keepDays * 86400000) await fsp.rm(path.join(dir, info[k].n), { force: true }).catch(() => {});
    },
  };
}

module.exports = { createTrace, summarize, todosOf };
