'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// MỐC KHÔI PHỤC (giống "checkpoint / rewind" của Claude Code): trước mỗi việc AI làm trong một dự án, bot chụp lại trạng thái thư mục dự án;
// AI sửa hỏng thì /hoantac cho xem thay đổi và quay về mốc đó. Không cần git (máy chưa chắc có): tự lưu theo NỘI DUNG (mỗi nội dung một bản, tệp không đổi không tốn thêm chỗ).
//  - Chỉ chụp tệp thường trong thư mục dự án; bỏ qua thư mục thư viện/ẩn (node_modules, .git…), liên kết tắt, tệp quá lớn, và dừng khi quá nhiều tệp/quá nặng (ghi "chụp một phần").
//  - Khôi phục: tự chụp trạng thái HIỆN TẠI thành một mốc mới ("Trước khi khôi phục") rồi mới ghi đè → quay về cũng hoàn tác được. Tệp mới tạo sau mốc bị xóa; tệp nằm ngoài phạm vi chụp không bao giờ bị đụng.
//  - Chỉ giữ `keep` mốc gần nhất cho mỗi dự án; bản nội dung không còn mốc nào dùng thì dọn đi.
const DEFAULTS = { maxFiles: 4000, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, keep: 20 };
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '__pycache__', '.venv', 'venv', '.next', '.agentos-trash', '.Trash', '$RECYCLE.BIN']);
const SAFE_ID = /^[\w.-]{1,80}$/;

function createCheckpoints(o) {
  const dir = o.dir, log = o.log || (() => {}), now = o.now || Date.now;
  const L = Object.assign({}, DEFAULTS, o.limits || {});
  let seq = 0;
  const locks = new Map();

  const lock = (pid, fn) => {
    const prev = locks.get(pid) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(pid, next.catch(() => {}));
    return next;
  };
  const pdir = (pid) => { if (!SAFE_ID.test(String(pid))) throw new Error('mã dự án không hợp lệ'); return path.join(dir, String(pid)); };
  const readJson = async (f, dflt) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch (e) { return dflt; } };
  const writeJson = async (f, v) => { await fsp.mkdir(path.dirname(f), { recursive: true }); const t = f + '.tmp' + process.pid; await fsp.writeFile(t, JSON.stringify(v)); await fsp.rename(t, f); };
  const blobPath = (pid, h) => path.join(pdir(pid), 'blobs', h.slice(0, 2), h);
  const safeJoin = (root, rel) => {
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..') || /^[a-zA-Z]:/.test(rel)) throw new Error('đường dẫn không hợp lệ: ' + rel);
    const abs = path.join(root, ...rel.split('/'));
    const r = path.resolve(root);
    if (abs !== r && !abs.startsWith(r + path.sep)) throw new Error('đường dẫn ra ngoài thư mục dự án: ' + rel);
    return abs;
  };

  // Duyệt thư mục dự án: danh sách tệp được chụp + số tệp bị bỏ qua (kèm lý do)
  async function scan(root) {
    const files = [], skipped = { big: 0, over: 0 };
    let total = 0, stop = false;
    async function walk(abs, rel) {
      if (stop) return;
      let ents; try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { return; }
      ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of ents) {
        if (stop) return;
        const r = rel ? rel + '/' + e.name : e.name, a = path.join(abs, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(a, r); continue; }
        if (!e.isFile() || /\.tmp\d*$/.test(e.name)) continue;
        let st; try { st = await fsp.stat(a); } catch (er) { continue; }
        if (st.size > L.maxFileBytes) { skipped.big++; continue; }
        if (files.length >= L.maxFiles || total + st.size > L.maxTotalBytes) { skipped.over++; stop = true; return; }
        total += st.size; files.push({ rel: r, abs: a, size: st.size, mtime: Math.round(st.mtimeMs), mode: st.mode & 0o777 });
      }
    }
    await walk(root, '');
    return { files, skipped, bytes: total, partial: skipped.over > 0 };
  }

  const hashFile = async (abs) => crypto.createHash('sha1').update(await fsp.readFile(abs)).digest('hex');
  const loadIndex = async (pid) => readJson(path.join(pdir(pid), 'index.json'), []);
  const loadManifest = async (pid, id) => readJson(path.join(pdir(pid), 'snap-' + id + '.json'), null);

  async function gc(pid, index) {
    const used = new Set();
    for (const s of index) { const m = await loadManifest(pid, s.id); if (m) for (const k of Object.keys(m)) used.add(m[k][0]); }
    const bdir = path.join(pdir(pid), 'blobs');
    let subs; try { subs = await fsp.readdir(bdir); } catch (e) { return; }
    for (const sd of subs) {
      let names; try { names = await fsp.readdir(path.join(bdir, sd)); } catch (e) { continue; }
      for (const n of names) if (!used.has(n)) await fsp.rm(path.join(bdir, sd, n), { force: true }).catch(() => {});
    }
  }

  async function snapshotNow(pid, root, meta) {
    const index = await loadIndex(pid);
    const last = index[0] ? await loadManifest(pid, index[0].id) : null;
    const sc = await scan(root);
    const manifest = {};
    for (const f of sc.files) {
      const p = last && last[f.rel];
      let h;
      if (p && p[1] === f.size && p[2] === f.mtime) h = p[0];
      else { try { h = await hashFile(f.abs); } catch (e) { continue; } }
      const bp = blobPath(pid, h);
      try { await fsp.access(bp); } catch (e) { await fsp.mkdir(path.dirname(bp), { recursive: true }); try { await fsp.copyFile(f.abs, bp, fs.constants.COPYFILE_EXCL); } catch (er) { if (er.code !== 'EEXIST') continue; } }
      manifest[f.rel] = [h, f.size, f.mtime, f.mode];
    }
    if (last && !(meta && meta.force)) {
      const a = Object.keys(manifest), b = Object.keys(last);
      if (a.length === b.length && a.every((k) => last[k] && last[k][0] === manifest[k][0])) return { ok: true, id: index[0].id, unchanged: true, files: a.length };
    }
    const id = now().toString(36) + (++seq).toString(36);
    const entry = { id, at: now(), label: String((meta && meta.label) || '').slice(0, 160), jobId: meta && meta.jobId != null ? meta.jobId : null, files: Object.keys(manifest).length, bytes: sc.bytes, partial: sc.partial, skipped: sc.skipped.big + sc.skipped.over };
    await writeJson(path.join(pdir(pid), 'snap-' + id + '.json'), manifest);
    index.unshift(entry);
    const drop = meta && meta.noPrune ? [] : index.splice(Math.max(1, L.keep));          // khôi phục: chưa dọn, kẻo xóa mất dữ liệu của chính mốc đang quay về (mốc mới sau đó sẽ dọn)
    await writeJson(path.join(pdir(pid), 'index.json'), index);
    for (const d of drop) await fsp.rm(path.join(pdir(pid), 'snap-' + d.id + '.json'), { force: true }).catch(() => {});
    if (drop.length) await gc(pid, index);
    return { ok: true, id, unchanged: false, files: entry.files, partial: entry.partial };
  }

  // So mốc với thư mục hiện tại: tệp đã đổi nội dung / mới tạo sau mốc / đã bị xóa sau mốc
  async function diffNow(pid, id, root) {
    const m = await loadManifest(pid, id);
    if (!m) return null;
    const sc = await scan(root), cur = new Map(sc.files.map((f) => [f.rel, f]));
    const changed = [], added = [], removed = [];
    for (const rel of Object.keys(m)) {
      const f = cur.get(rel);
      if (!f) { removed.push(rel); continue; }
      if (f.size === m[rel][1] && f.mtime === m[rel][2]) continue;
      let h; try { h = await hashFile(f.abs); } catch (e) { continue; }
      if (h !== m[rel][0]) changed.push(rel);
    }
    for (const rel of cur.keys()) if (!m[rel]) added.push(rel);
    return { changed, added, removed, manifest: m, partialNow: sc.partial };
  }

  return {
    limits: L,
    // Chụp mốc mới (không ném lỗi; không đổi gì so với mốc trước thì dùng lại mốc cũ)
    snapshot(pid, root, meta) { return lock(pid, () => snapshotNow(pid, root, meta)).catch((e) => { log('mốc khôi phục lỗi: ' + e.message); return { ok: false, error: e.message }; }); },
    async list(pid) { try { return await loadIndex(pid); } catch (e) { return []; } },
    async diff(pid, id, root) {
      try { const d = await diffNow(pid, id, root); return d ? { ok: true, changed: d.changed, added: d.added, removed: d.removed } : { ok: false, error: 'Mốc này không còn.' }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    // Quay về mốc: chụp trạng thái hiện tại trước, rồi ghi lại tệp đã đổi/đã xóa và xóa tệp mới tạo
    restore(pid, id, root) {
      return lock(pid, async () => {
        const d = await diffNow(pid, id, root);
        if (!d) return { ok: false, error: 'Mốc này không còn.' };
        const todo = d.changed.concat(d.removed);
        for (const rel of todo) { try { await fsp.access(blobPath(pid, d.manifest[rel][0])); } catch (e) { return { ok: false, error: 'Thiếu dữ liệu của mốc (' + rel + '), không khôi phục để tránh làm hỏng thêm.' }; } safeJoin(root, rel); }
        for (const rel of d.added) safeJoin(root, rel);
        if (!todo.length && !d.added.length) return { ok: true, restored: 0, deleted: 0, nothing: true };
        const before = await snapshotNow(pid, root, { label: 'Trước khi khôi phục', force: true, noPrune: true });
        if (!before.ok) return { ok: false, error: 'Không lưu được trạng thái hiện tại nên không khôi phục: ' + before.error };
        let restored = 0, deleted = 0;
        for (const rel of todo) {
          const abs = safeJoin(root, rel), mm = d.manifest[rel];
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.copyFile(blobPath(pid, mm[0]), abs);
          try { await fsp.chmod(abs, mm[3] || 0o644); await fsp.utimes(abs, new Date(), new Date(mm[2])); } catch (e) { /* hệ tệp không hỗ trợ */ }
          restored++;
        }
        for (const rel of d.added) {
          const abs = safeJoin(root, rel);
          await fsp.rm(abs, { force: true }); deleted++;
          let up = path.dirname(abs); const r = path.resolve(root);
          while (up !== r && up.startsWith(r + path.sep)) { try { await fsp.rmdir(up); } catch (e) { break; } up = path.dirname(up); }
        }
        return { ok: true, restored, deleted, backupId: before.id };
      }).catch((e) => ({ ok: false, error: e.message }));
    },
    async forget(pid) { try { await fsp.rm(pdir(pid), { recursive: true, force: true }); } catch (e) { /* bỏ qua */ } },
  };
}

module.exports = { createCheckpoints, DEFAULTS };
