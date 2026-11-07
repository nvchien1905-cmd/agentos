'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

// NHẬT KÝ "TRƯỚC KHI SỬA" (khôi phục ở PHẠM VI TOÀN HỆ ĐIỀU HÀNH, tệp đến vài GB): ngay TRƯỚC khi AI sửa/xóa/ghi đè một tệp ở BẤT KỲ ĐÂU trên máy,
// cổng duyệt (gate.js) gọi before() → ta chép bản gốc sang kho riêng (chép nhân bản nếu hệ tệp hỗ trợ, nên tệp lớn cũng nhanh) rồi mới cho công cụ chạy.
// Biết đường dẫn từ: công cụ Write/Edit/MultiEdit/NotebookEdit (chính xác) và lệnh Bash (phân tích rm/mv/cp/sed -i/tee/truncate/dd/ln/chmod/chown/find -delete và chuyển hướng > >>).
// Lệnh Bash làm đổi trạng thái hệ thống mà không phải tệp (apt, systemctl, tar x, git checkout…) KHÔNG hoàn tác bằng tệp được → ghi vào "unsafe" để báo thật với chủ máy.
// Quay lại: ghi đè bản gốc, xóa tệp do việc đó tạo ra; trước khi quay lại tự lưu trạng thái hiện tại thành nhật ký "u<mã>-<giờ>" → quay lại cũng hoàn tác được.
// Không đụng: /proc /sys /dev /run, thư mục dữ liệu của bot, chính kho nhật ký này; thư viện (node_modules, .cache, __pycache__, .venv) không chép khi chép cả thư mục.
const GiB = 1024 * 1024 * 1024;
const DEFAULTS = { maxFileBytes: 8 * GiB, maxJobBytes: 20 * GiB, maxTotalBytes: 40 * GiB, keepJobs: 80, keepDays: 14, maxEntries: 100000, minFreeBytes: 1 * GiB };
const SKIP_NAMES = new Set(['node_modules', '__pycache__', '.cache', '.venv', 'venv']);
const SYSTEM_OFF = ['/proc', '/sys', '/dev', '/run'];
const FILE_TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
// Lệnh đổi trạng thái hệ thống/gói/dịch vụ: không hoàn tác được bằng cách chép tệp → chỉ báo cho chủ máy biết
const UNSAFE_CMDS = new Set(['apt', 'apt-get', 'aptitude', 'dpkg', 'snap', 'flatpak', 'pip', 'pip3', 'pipx', 'npm', 'pnpm', 'yarn', 'gem', 'cargo', 'systemctl', 'service', 'crontab', 'mkfs', 'mount', 'umount', 'fdisk', 'parted', 'useradd', 'userdel', 'usermod', 'groupadd', 'passwd', 'chsh', 'docker', 'podman', 'iptables', 'nft', 'ufw', 'reboot', 'shutdown', 'poweroff', 'unzip', 'tar', '7z', '7za', 'rsync', 'git', 'psql', 'mysql', 'sqlite3', 'curl', 'wget']);
const GIT_MUTATING = new Set(['checkout', 'reset', 'clean', 'restore', 'stash', 'rebase', 'merge', 'pull', 'switch', 'revert', 'cherry-pick', 'apply', 'am', 'rm', 'mv']);
const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'command', 'exec', 'env', 'nice', 'ionice', 'stdbuf', 'setsid', 'builtin']);

// ---------- Phân tích lệnh Bash ----------
// Tách lệnh thành các đoạn { args, redirs, dyn }: hiểu nháy đơn/kép, \ , ; && || | & xuống dòng, chuyển hướng > >> >| và bỏ qua < <<.
function lex(cmd) {
  const segs = []; let cur = { args: [], redirs: [], dyn: false }; let tok = null, tokDyn = false, pend = null;   // pend: 'out' (đích chuyển hướng), 'skip' (bỏ từ kế)
  const endTok = () => {
    if (tok === null) return;
    if (pend === 'out') { if (!/^&\d*$|^\/dev\/(null|stdout|stderr|tty)$/.test(tok)) cur.redirs.push({ p: tok, dyn: tokDyn }); }
    else if (pend === 'skip') { /* đích của < hoặc từ phân cách heredoc */ }
    else cur.args.push(tokDyn ? { s: tok, dyn: true } : tok);
    pend = null; tok = null; tokDyn = false;
  };
  const endSeg = () => { endTok(); if (cur.args.length || cur.redirs.length) segs.push(cur); cur = { args: [], redirs: [], dyn: false }; };
  const s = String(cmd || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { const j = s.indexOf("'", i + 1); const end = j < 0 ? s.length : j; tok = (tok || '') + s.slice(i + 1, end); i = end; continue; }
    if (c === '"') {
      let j = i + 1, buf = '';
      while (j < s.length && s[j] !== '"') { if (s[j] === '\\' && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue; } if (s[j] === '$' || s[j] === '`') tokDyn = true; buf += s[j]; j++; }
      tok = (tok || '') + buf; i = j; continue;
    }
    if (c === '\\' && i + 1 < s.length) { tok = (tok || '') + s[i + 1]; i++; continue; }
    if (c === '$' || c === '`') tokDyn = true;
    if (c === ' ' || c === '\t') { endTok(); continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '(' || c === ')') { endSeg(); if (c === '|' && s[i + 1] === '|') i++; continue; }
    if (c === '&') {
      if (s[i + 1] === '&') { endSeg(); i++; continue; }
      if (s[i + 1] === '>') { endTok(); pend = 'out'; i += s[i + 2] === '>' ? 2 : 1; continue; }        // &> / &>>
      endSeg(); continue;
    }
    if (c === '>') {
      if (tok !== null && /^\d+$/.test(tok)) tok = null;                         // 2> : bỏ số mô tả tệp
      else endTok();
      let j = i + 1; if (s[j] === '>' || s[j] === '|') j++;
      if (s[j] === '&') { pend = 'skip'; j++; } else pend = 'out';
      i = j - 1; continue;
    }
    if (c === '<') { endTok(); let j = i + 1; if (s[j] === '<') { j++; if (s[j] === '<') j++; } pend = 'skip'; i = j - 1; continue; }
    tok = (tok || '') + c;
  }
  endSeg();
  return segs;
}

const isDyn = (a) => typeof a === 'object' && a !== null;
const strOf = (a) => (isDyn(a) ? a.s : a);
const isOpt = (a) => typeof a === 'string' && /^-./.test(a) && a !== '--';

function hasGlob(s) { return /[*?[]/.test(s); }
function globToRe(p) { return new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$'); }

// Từ một lệnh Bash → { paths: [{p, recursive, meta}], unsafe: [mô tả] }
function targetsOfBash(cmd, cwd, depth) {
  const out = { paths: [], unsafe: [] };
  const add = (p, rec, meta) => out.paths.push({ p, recursive: !!rec, meta: !!meta });
  const unsafe = (m) => { if (!out.unsafe.includes(m)) out.unsafe.push(m); };
  for (const seg of lex(cmd)) {
    for (const r of seg.redirs) { if (r.dyn) unsafe('chuyển hướng ghi vào tệp có tên dùng biến'); else add(r.p, false); }
    let args = seg.args.slice();
    for (let guard = 0; args.length && guard < 8; guard++) {
      const a0 = strOf(args[0]);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a0) || a0 === '{' || a0 === '}' || a0 === '!' || /^(if|then|do|else|elif|while|until)$/.test(a0)) { args.shift(); continue; }
      if (WRAPPERS.has(a0)) { args.shift(); while (args.length && isOpt(args[0])) args.shift(); continue; }
      if (a0 === 'timeout') { args.shift(); while (args.length && isOpt(args[0])) args.shift(); args.shift(); continue; }
      break;
    }
    if (!args.length) continue;
    const name = path.basename(strOf(args[0]));
    const rest = args.slice(1);
    const ops = rest.filter((a) => !isOpt(a));
    const opts = rest.filter(isOpt).join(' ');
    const dynFlag = rest.some(isDyn);
    const each = (list, rec, meta) => { for (const a of list) { if (isDyn(a)) { unsafe(name + ' dùng tên tệp có biến (' + a.s.slice(0, 40) + ')'); continue; } add(a, rec, meta); } };
    const rec = /(^|\s)-[a-zA-Z]*[rR]|--recursive/.test(opts);
    if ((name === 'bash' || name === 'sh' || name === 'zsh' || name === 'dash') && depth < 2) {
      const ci = rest.findIndex((a) => typeof a === 'string' && /^-[a-z]*c$/.test(a));
      if (ci >= 0 && rest[ci + 1] !== undefined) { const sub = targetsOfBash(strOf(rest[ci + 1]), cwd, depth + 1); out.paths.push(...sub.paths); for (const u of sub.unsafe) unsafe(u); }
      continue;
    }
    if (name === 'rm' || name === 'rmdir' || name === 'unlink' || name === 'shred') each(ops, rec || name === 'rmdir');
    else if (name === 'mv') each(ops, true);
    else if (name === 'cp' || name === 'install') {
      if (ops.length < 2) continue;
      const dest = ops[ops.length - 1];
      if (isDyn(dest)) { unsafe(name + ' đích có biến'); continue; }
      out.paths.push({ p: dest, recursive: rec, meta: false, destFor: ops.slice(0, -1).filter((a) => !isDyn(a)) });
    } else if (name === 'sed') {
      if (/(^|\s)-[a-zA-Z]*i|--in-place/.test(opts)) { const hasScriptOpt = /(^|\s)-[a-zA-Z]*[ef]\b|--expression|--file/.test(opts); each(hasScriptOpt ? ops : ops.slice(1), false); }
    } else if (name === 'tee') each(ops, false);
    else if (name === 'truncate') { const t = []; for (let k = 0; k < rest.length; k++) { const a = rest[k]; if (a === '-s' || a === '--size') { k++; continue; } if (!isOpt(a)) t.push(a); } each(t, false); }
    else if (name === 'dd') { for (const a of rest) { const m = /^of=(.+)$/.exec(strOf(a)); if (m) add(m[1], false); } }
    else if (name === 'ln') { if (ops.length >= 2) each([ops[ops.length - 1]], false); }
    else if (name === 'chmod' || name === 'chown' || name === 'chgrp') each(ops.slice(1), /(^|\s)-[a-zA-Z]*R|--recursive/.test(opts), true);
    else if (name === 'find') {
      const roots = []; for (const a of rest) { const t = strOf(a); if (/^[-!(]/.test(t)) break; roots.push(a); }
      if (rest.some((a) => ['-delete', '-exec', '-execdir', '-ok'].includes(strOf(a)))) each(roots.length ? roots : ['.'], true);
    } else if (name === 'git') {
      const sub = ops[0] ? strOf(ops[0]) : '';
      if (GIT_MUTATING.has(sub)) unsafe('git ' + sub + ' có thể sửa nhiều tệp trong kho');
    } else if (UNSAFE_CMDS.has(name)) {
      if (name === 'tar') { if (/(^|\s)-?[a-zA-Z]*x/.test(rest.map(strOf).join(' '))) unsafe('tar giải nén ghi nhiều tệp'); }
      else if (name === 'rsync') { unsafe('rsync có thể ghi/xóa nhiều tệp'); }
      else if (name === 'curl' || name === 'wget') { const o = rest.map(strOf); for (let k = 0; k < o.length; k++) { if (/^(-o|-O|--output|--output-document)$/.test(o[k]) && o[k + 1]) add(o[k + 1], false); } }
      else if (name === 'psql' || name === 'mysql' || name === 'sqlite3') unsafe(name + ' có thể đổi dữ liệu trong cơ sở dữ liệu');
      else if (name === 'unzip') unsafe('unzip giải nén ghi nhiều tệp');
      else if (['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'pipx', 'gem', 'cargo'].includes(name) && !/(^|\s)(-g|--global|--user|--break-system-packages)(\s|$)/.test(opts)) { /* cài vào thư mục dự án: đã có mốc của dự án */ }
      else unsafe(name + ' đổi trạng thái hệ thống (gói/dịch vụ/tài khoản…)');
    }
    if (dynFlag && !out.unsafe.length && out.paths.length === 0 && /^(rm|mv|cp|sed|tee)$/.test(name)) unsafe(name + ' dùng biến, không biết tệp nào');
  }
  return out;
}

function targetsOf(tool, input, cwd) {
  input = input || {};
  if (FILE_TOOLS[tool]) { const p = input[FILE_TOOLS[tool]]; return p ? { paths: [{ p: String(p), recursive: false, meta: false }], unsafe: [] } : { paths: [], unsafe: [] }; }
  if (tool === 'Bash' && typeof input.command === 'string') return targetsOfBash(input.command, cwd || process.cwd(), 0);
  return { paths: [], unsafe: [] };
}

// ---------- Kho nhật ký ----------
function createJournal(o) {
  const dir = o.dir, log = o.log || (() => {}), now = o.now || Date.now;
  const L = Object.assign({}, DEFAULTS, o.limits || {});
  const cwdOf = o.cwdOf || (() => process.cwd());
  const off = SYSTEM_OFF.concat(o.exclude || [], [dir]).map((p) => path.resolve(p));
  const home = o.home || os.homedir();
  const chains = new Map();

  const blocked = (abs) => off.some((b) => abs === b || abs.startsWith(b + path.sep));
  const chain = (id, fn) => { const prev = chains.get(id) || Promise.resolve(); const next = prev.catch(() => {}).then(fn); chains.set(id, next.catch(() => {})); return next; };
  const jdir = (id) => { if (!/^[\w.-]{1,60}$/.test(String(id))) throw new Error('mã nhật ký không hợp lệ'); return path.join(dir, String(id)); };
  const readJson = async (f, d) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch (e) { return d; } };
  const writeJson = async (f, v) => { await fsp.mkdir(path.dirname(f), { recursive: true }); const t = f + '.tmp' + process.pid; await fsp.writeFile(t, JSON.stringify(v)); await fsp.rename(t, f); };
  const resolveP = (p, cwd) => { p = String(p); if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1)); return path.resolve(cwd, p); };

  async function expand(p, cwd) {   // glob đơn giản ở tên cuối → danh sách tệp thật
    const abs = resolveP(p, cwd);
    if (!hasGlob(path.basename(abs))) return [abs];
    if (hasGlob(path.dirname(abs))) return null;
    const re = globToRe(path.basename(abs));
    try { return (await fsp.readdir(path.dirname(abs))).filter((n) => re.test(n)).slice(0, 500).map((n) => path.join(path.dirname(abs), n)); } catch (e) { return []; }
  }

  async function freeBytes(where) { try { const s = await fsp.statfs(where); return Number(s.bavail) * Number(s.bsize); } catch (e) { return Infinity; } }

  async function load(id, mk) {
    const d = jdir(id), m = await readJson(path.join(d, 'meta.json'), null);
    if (m) return m;
    if (!mk) return null;
    await fsp.mkdir(path.join(d, 'b'), { recursive: true, mode: 0o700 });
    return { id: String(id), at: now(), label: mk.label || '', project: mk.project || null, files: 0, bytes: 0, seq: 0, unsafe: [], partial: false, seen: [] };
  }
  const save = async (id, m) => writeJson(path.join(jdir(id), 'meta.json'), m);
  const appendEntry = async (id, e) => fsp.appendFile(path.join(jdir(id), 'entries.jsonl'), JSON.stringify(e) + '\n');

  // Chép bản gốc của MỘT đường dẫn (tệp hoặc thư mục) vào nhật ký `id` — chỉ lần đầu trong nhật ký đó (trạng thái trước việc mới là cái cần giữ)
  async function capture(id, m, abs, recursive, meta) {
    if (blocked(abs)) return;
    if (m.seen.includes(abs) && !recursive) return;
    let st; try { st = await fsp.lstat(abs); } catch (e) { st = null; }
    if (!st) { if (!m.seen.includes(abs)) { m.seen.push(abs); await appendEntry(id, { p: abs, k: 'none' }); m.files++; } return; }
    if (m.seen.includes(abs) && !st.isDirectory()) return;
    m.seen.push(abs);
    if (m.seen.length > L.maxEntries) { m.partial = true; return; }
    if (st.isSymbolicLink()) { let t = ''; try { t = await fsp.readlink(abs); } catch (e) { /* bỏ */ } await appendEntry(id, { p: abs, k: 'link', to: t }); m.files++; return; }
    if (st.isDirectory()) {
      await appendEntry(id, { p: abs, k: 'dir', mode: st.mode & 0o7777, uid: st.uid, gid: st.gid }); m.files++;
      if (!recursive) return;
      if (abs === '/' || path.dirname(abs) === abs) { m.unsafe.push('không lưu cả thư mục gốc /'); m.partial = true; return; }
      let ents; try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (SKIP_NAMES.has(e.name)) continue;
        if (m.bytes > L.maxJobBytes || m.seen.length > L.maxEntries) { m.partial = true; m.unsafe.push('thư mục quá lớn, chỉ lưu một phần: ' + abs); return; }
        await capture(id, m, path.join(abs, e.name), true, meta);
      }
      return;
    }
    if (!st.isFile()) return;       // ổ cắm, ống…: bỏ
    const base = { p: abs, k: 'file', size: st.size, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid, mtime: Math.round(st.mtimeMs) };
    if (meta) { await appendEntry(id, Object.assign(base, { meta: true })); m.files++; return; }          // chmod/chown: chỉ cần quyền, không chép nội dung
    if (st.size > L.maxFileBytes) { m.partial = true; m.unsafe.push('tệp quá lớn để lưu (' + Math.round(st.size / GiB * 10) / 10 + ' GB): ' + abs); await appendEntry(id, Object.assign(base, { skipped: 'big' })); return; }
    if (m.bytes + st.size > L.maxJobBytes) { m.partial = true; m.unsafe.push('vượt hạn mức lưu của một việc, không lưu: ' + abs); await appendEntry(id, Object.assign(base, { skipped: 'quota' })); return; }
    if (await freeBytes(dir) < st.size + L.minFreeBytes) { m.partial = true; m.unsafe.push('thiếu chỗ trống trên đĩa, không lưu: ' + abs); await appendEntry(id, Object.assign(base, { skipped: 'disk' })); return; }
    const blob = String(++m.seq);
    try { await fsp.copyFile(abs, path.join(jdir(id), 'b', blob), fs.constants.COPYFILE_FICLONE); } catch (e) { m.partial = true; m.unsafe.push('không chép được ' + abs + ': ' + e.message); return; }
    m.bytes += st.size; m.files++;
    await appendEntry(id, Object.assign(base, { blob }));
  }

  async function captureTargets(id, t, cwd, meta0) {
    const m = await load(id, meta0);
    for (const u of t.unsafe) if (!m.unsafe.includes(u)) m.unsafe.push(u);
    for (const tg of t.paths) {
      const list = await expand(tg.p, cwd);
      if (list === null) { if (!m.unsafe.includes('tên tệp có ký tự đại diện ở thư mục cha')) m.unsafe.push('tên tệp có ký tự đại diện ở thư mục cha'); continue; }
      for (const abs of list) {
        await capture(id, m, abs, tg.recursive, tg.meta);
        if (tg.destFor) {      // cp a b/ : nếu đích là thư mục thì tệp bị ghi đè là b/<tên nguồn>
          let isDir = false; try { isDir = (await fsp.stat(abs)).isDirectory(); } catch (e) { /* bỏ */ }
          if (isDir) for (const src of tg.destFor) await capture(id, m, path.join(abs, path.basename(src)), tg.recursive, false);
        }
      }
    }
    await save(id, m);
    return m;
  }

  return {
    limits: L,
    targetsOf,
    // Gọi TRƯỚC khi công cụ chạy (đã được cho phép). Không ném lỗi ra ngoài gate.
    before(job, tool, input) {
      const cwd = job && job.id != null ? cwdOf(job) : process.cwd();
      const t = targetsOf(tool, input, cwd);
      if (!t.paths.length && !t.unsafe.length) return Promise.resolve();
      return chain(String(job.id), () => captureTargets(String(job.id), t, cwd, { label: String(job.prompt || '').replace(/\s+/g, ' ').slice(0, 120), project: job.project || null }));
    },
    // Danh sách nhật ký (mới nhất trước) có tệp được lưu hoặc có cảnh báo
    async list(limit) {
      let names; try { names = await fsp.readdir(dir); } catch (e) { return []; }
      const out = [];
      for (const n of names) { const m = await readJson(path.join(dir, n, 'meta.json'), null); if (m) out.push({ id: m.id, at: m.at, label: m.label, project: m.project, files: m.files, bytes: m.bytes, unsafe: m.unsafe, partial: m.partial }); }
      out.sort((a, b) => b.at - a.at);
      return out.slice(0, limit || 30);
    },
    async entries(id) { try { return (await fsp.readFile(path.join(jdir(id), 'entries.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } },
    async get(id) { return load(id, null); },
    // Xem trước: những gì sẽ bị đổi nếu quay lại
    async plan(id) {
      const es = await this.entries(id), out = [];
      for (const e of es) {
        if (blocked(e.p)) continue;
        let st = null; try { st = await fsp.lstat(e.p); } catch (er) { /* không có */ }
        if (e.k === 'none') { if (st && !st.isDirectory()) out.push({ p: e.p, act: 'xóa (tệp do việc này tạo)' }); }
        else if (e.k === 'file') { if (e.skipped) { out.push({ p: e.p, act: 'không lưu được bản gốc (' + e.skipped + ')', cannot: true }); continue; } if (e.meta) { if (!st || (st.mode & 0o7777) !== e.mode) out.push({ p: e.p, act: 'trả lại quyền truy cập' }); continue; } if (!st) out.push({ p: e.p, act: 'khôi phục (đã bị xóa)' }); else if (st.size !== e.size || Math.round(st.mtimeMs) !== e.mtime) out.push({ p: e.p, act: 'khôi phục (đã bị sửa)' }); }
        else if (e.k === 'dir') { if (!st) out.push({ p: e.p, act: 'tạo lại thư mục' }); }
        else if (e.k === 'link') { if (!st) out.push({ p: e.p, act: 'tạo lại liên kết' }); }
      }
      return out;
    },
    // Quay lại: trước hết lưu trạng thái hiện tại (nhật ký "u…") để hoàn tác được
    async restore(id) {
      const m = await load(id, null); if (!m) return { ok: false, error: 'Nhật ký này không còn.' };
      const es = await this.entries(id);
      const uid = 'u' + String(id).replace(/[^\w.-]/g, '') + '-' + now().toString(36);
      await chain(uid, () => captureTargets(uid, { paths: es.filter((e) => !blocked(e.p) && e.k !== 'link').map((e) => ({ p: e.p, recursive: false, meta: false })), unsafe: [] }, '/', { label: 'Trước khi quay lại nhật ký ' + id, project: m.project }));
      let restored = 0, deleted = 0, skipped = 0; const errors = [];
      for (const e of es.slice().reverse()) {
        if (blocked(e.p)) { skipped++; continue; }
        try {
          if (e.k === 'none') { const st = await fsp.lstat(e.p).catch(() => null); if (st && !st.isDirectory()) { await fsp.rm(e.p, { force: true }); deleted++; } }
          else if (e.k === 'dir') { await fsp.mkdir(e.p, { recursive: true }); await fsp.chmod(e.p, e.mode).catch(() => {}); }
          else if (e.k === 'link') { const st = await fsp.lstat(e.p).catch(() => null); if (!st) { await fsp.mkdir(path.dirname(e.p), { recursive: true }); await fsp.symlink(e.to, e.p); restored++; } }
          else if (e.k === 'file') {
            if (e.skipped) { skipped++; continue; }
            if (e.meta) { await fsp.chmod(e.p, e.mode).catch(() => {}); await fsp.chown(e.p, e.uid, e.gid).catch(() => {}); restored++; continue; }
            const src = path.join(jdir(id), 'b', e.blob);
            const cur = await fsp.lstat(e.p).catch(() => null);
            if (cur && cur.isFile() && cur.size === e.size && Math.round(cur.mtimeMs) === e.mtime) continue;           // chưa bị đổi
            await fsp.access(src);
            await fsp.mkdir(path.dirname(e.p), { recursive: true });
            const tmp = e.p + '.agentos-restore' + process.pid;
            await fsp.copyFile(src, tmp, fs.constants.COPYFILE_FICLONE);
            await fsp.chmod(tmp, e.mode).catch(() => {}); await fsp.chown(tmp, e.uid, e.gid).catch(() => {}); await fsp.utimes(tmp, new Date(), new Date(e.mtime)).catch(() => {});
            await fsp.rename(tmp, e.p); restored++;
          }
        } catch (er) { errors.push(e.p + ': ' + er.message); }
      }
      return { ok: errors.length === 0, restored, deleted, skipped, errors: errors.slice(0, 5), undoId: uid, unsafe: m.unsafe };
    },
    async forget(id) { await fsp.rm(jdir(id), { recursive: true, force: true }).catch(() => {}); },
    // Dọn: quá hạn, quá số lượng, quá tổng dung lượng (cũ nhất trước)
    async gc() {
      const all = (await this.list(100000)).slice().sort((a, b) => a.at - b.at);
      let total = all.reduce((s, x) => s + x.bytes, 0), n = all.length;
      for (const x of all) {
        const old = now() - x.at > L.keepDays * 86400000;
        if (old || n > L.keepJobs || total > L.maxTotalBytes) { await this.forget(x.id); total -= x.bytes; n--; }
      }
    },
  };
}

module.exports = { createJournal, targetsOf, targetsOfBash, lex, DEFAULTS };
