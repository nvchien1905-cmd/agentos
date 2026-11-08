'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// HAI LỚP KỸ NĂNG, để kỹ năng không "biến tính" theo thói quen từng chủ máy:
//   LỚP GỐC     = kỹ năng trong plugin của AgentOS (chỉ đọc, tự cập nhật cùng bản hệ điều hành, có chữ ký). Không ai sửa trực tiếp được.
//   LỚP CỦA CHỦ = (a) GHI CHÚ RIÊNG gắn vào một kỹ năng gốc ("khách của tôi hay hỏi giá sỉ, trả lời kiểu X") — bổ sung, KHÔNG thay bản gốc, bản gốc cập nhật thì ghi chú vẫn còn;
//                 (b) kỹ năng tự viết trong dự án; nếu trùng TÊN với kỹ năng gốc thì nó ĐÈ lên bản gốc — nay được báo rõ, và khi bản gốc đổi sau đó
//                     thì báo "bản gốc đã cập nhật, kỹ năng của anh đang che nó", kèm nút "Dùng bản gốc" (cất bản của anh vào .da-thay-the, không xóa).
// Ghi chú nằm NGOÀI thư mục dữ liệu bị giấu của AI (như plugins-user) để AI đọc được.
const NOTE_MAX = 4000;
const SLUG = /^[\w-]{1,60}$/, PLUGIN = /^[a-z0-9][a-z0-9-]{1,40}$/;
const norm = (s) => String(s || '').trim().toLowerCase();
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

function createSkillLayers(o) {
  const { plugins, projects } = o;
  const notesDir = o.notesDir, stateFile = o.stateFile, now = o.now || Date.now;
  const load = () => { try { const j = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return { shadow: j.shadow && typeof j.shadow === 'object' ? j.shadow : {} }; } catch (e) { return { shadow: {} }; } };
  const save = (st) => { if (!stateFile) return; fs.mkdirSync(path.dirname(stateFile), { recursive: true }); const t = stateFile + '.tmp' + process.pid; fs.writeFileSync(t, JSON.stringify(st, null, 1)); fs.renameSync(t, stateFile); };

  const noteFile = (plugin, slug) => (notesDir && PLUGIN.test(String(plugin)) && SLUG.test(String(slug)) ? path.join(notesDir, plugin, slug + '.md') : null);
  const readNote = (plugin, slug) => { const f = noteFile(plugin, slug); if (!f) return ''; try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };

  const officials = () => { try { return plugins ? plugins.officialSkills() : []; } catch (e) { return []; } };
  const officialDirs = () => { try { return plugins ? plugins.skillDirs() : []; } catch (e) { return []; } };
  const inside = (file, dir) => path.resolve(file).startsWith(path.resolve(dir) + path.sep);

  // Tệp ghi chú của một kỹ năng gốc (theo đường dẫn tệp gốc) -> đường dẫn ghi chú nếu có (projects.js nhắc AI đọc kèm)
  function noteFor(officialFile) {
    const m = path.resolve(String(officialFile)).split(path.sep), slug = (m.pop() || '').replace(/\.md$/i, ''); m.pop();          // …/<plugin>/skills/<slug>.md
    const plugin = m.pop(); const f = noteFile(plugin, slug);
    try { return f && fs.statSync(f).size > 0 ? f : null; } catch (e) { return null; }
  }

  // Phân tích kỹ năng của một dự án thành 2 lớp
  function analyze(projectId) {
    const offs = officials(), dirs = officialDirs(), st = load();
    const byName = new Map(offs.map((x) => [norm(x.name), x]));
    let all = []; try { all = projects.skillsOf(projectId); } catch (e) { all = []; }
    const out = [], seenOff = new Set(); let dirty = false;
    for (const s of all) {
      const slug = path.basename(s.file).replace(/\.md$/i, '');
      const off = dirs.some((d) => inside(s.file, d)) ? offs.find((x) => path.resolve(x.file) === path.resolve(s.file)) : null;
      if (off) {                                                                              // kỹ năng GỐC đang có hiệu lực
        seenOff.add(off.plugin + '/' + off.slug);
        const note = readNote(off.plugin, off.slug);
        out.push({ layer: 'official', name: s.name, description: s.description, slug, plugin: off.plugin, pluginName: off.pluginName, official: true, hasNote: !!note.trim(), noteLength: note.length });
        continue;
      }
      const over = byName.get(norm(s.name));                                                  // kỹ năng của dự án — có đè bản gốc không?
      const row = { layer: 'custom', name: s.name, description: s.description, slug, overrides: null };
      if (over) {
        const key = projectId + '|' + norm(s.name);
        if (!st.shadow[key]) { st.shadow[key] = { plugin: over.plugin, hash: over.hash, at: now() }; dirty = true; }
        const rec = st.shadow[key];
        row.overrides = { plugin: over.plugin, pluginName: over.pluginName, slug: over.slug, officialChanged: rec.hash !== over.hash };
      }
      out.push(row);
    }
    // Kỹ năng gốc bị che mất (không còn trong skillsOf vì trùng tên) vẫn cần hiện để chủ biết
    const hidden = offs.filter((x) => !seenOff.has(x.plugin + '/' + x.slug) && out.some((r) => r.layer === 'custom' && norm(r.name) === norm(x.name))).map((x) => ({ plugin: x.plugin, pluginName: x.pluginName, slug: x.slug, name: x.name }));
    if (dirty) { try { save(st); } catch (e) { /* bỏ qua */ } }
    return { skills: out, hidden, officialChanged: out.filter((r) => r.overrides && r.overrides.officialChanged).map((r) => r.name) };
  }

  const api = {
    analyze, noteFor,
    getNote(plugin, slug) { return { text: readNote(plugin, slug) }; },
    setNote(plugin, slug, text) {
      if (!officials().some((x) => x.plugin === plugin && x.slug === slug)) return { ok: false, error: 'Không có kỹ năng gốc này (plugin chưa cài/đang tắt).' };
      const f = noteFile(plugin, slug); if (!f) return { ok: false, error: 'Tên không hợp lệ.' };
      text = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
      if (!text) return api.clearNote(plugin, slug);
      if (text.length > NOTE_MAX) return { ok: false, error: 'Ghi chú quá dài (tối đa ' + NOTE_MAX + ' ký tự). Ghi gọn các điểm khác với bản gốc thôi.' };
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '# Ghi chú riêng của chủ máy cho kỹ năng "' + slug + '"\n(Bổ sung cho bản gốc, KHÔNG thay bản gốc. Nếu mâu thuẫn với bản gốc về an toàn/quyền hạn thì theo bản gốc.)\n\n' + text + '\n');
      return { ok: true };
    },
    clearNote(plugin, slug) { const f = noteFile(plugin, slug); if (!f) return { ok: false, error: 'Tên không hợp lệ.' }; try { fs.rmSync(f, { force: true }); } catch (e) { /* bỏ qua */ } return { ok: true, cleared: true }; },
    // "Dùng bản gốc": cất kỹ năng của dự án đang đè (không xóa) để bản gốc có hiệu lực trở lại
    useOfficial(projectId, name) {
      const p = projects.get(projectId); if (!p) return { ok: false, error: 'Không có dự án này.' };
      const a = analyze(projectId), row = a.skills.find((r) => r.layer === 'custom' && r.overrides && norm(r.name) === norm(name));
      if (!row) return { ok: false, error: 'Kỹ năng này không đè lên bản gốc nào.' };
      const cur = projects.skillsOf(projectId).find((s) => norm(s.name) === norm(name));
      const base = projects.dirOf ? projects.dirOf(projectId) : (p.dir || '');
      if (!cur || !base || !inside(cur.file, base)) return { ok: false, error: 'Không tìm thấy tệp kỹ năng của dự án.' };
      const dest = path.join(base, 'KY-NANG', '.da-thay-the');
      fs.mkdirSync(dest, { recursive: true });
      const bak = path.join(dest, path.basename(cur.file).replace(/\.md$/i, '') + '-' + new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.md');
      fs.renameSync(cur.file, bak);
      const st = load(); delete st.shadow[projectId + '|' + norm(name)]; try { save(st); } catch (e) { /* bỏ qua */ }
      return { ok: true, backup: bak, plugin: row.overrides.plugin };
    },
    // Dùng cho nhật ký/khởi động: dự án nào đang có kỹ năng đè mà bản gốc đã đổi
    staleOverrides() {
      const out = []; let list = []; try { list = projects.load().list.filter((x) => !x.deleted); } catch (e) { list = []; }
      for (const p of list) { const a = analyze(p.id); if (a.officialChanged.length) out.push({ project: p.id, names: a.officialChanged }); }
      return out;
    },
    NOTE_MAX,
  };
  return api;
}

module.exports = { createSkillLayers, NOTE_MAX };
