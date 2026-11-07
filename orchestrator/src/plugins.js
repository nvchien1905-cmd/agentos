'use strict';
const fs = require('fs');
const path = require('path');
const { validCommand, ENV_NAME } = require('./connectors');

// CHỢ KỸ NĂNG / PLUGIN (như "Plugins" của app Claude): mỗi plugin là một thư mục có plugin.json + skills/*.md (kỹ năng dạy AI) + các kết nối dịch vụ (MCP) đi kèm.
//  - Danh mục nằm trong bản cài AgentOS (/opt/agentos/wizard/plugins/<mã>/…) nên TỰ CẬP NHẬT cùng mỗi bản cập nhật hệ điều hành (OTA có chữ ký) cho MỌI máy.
//  - Trạng thái cài của từng máy ở data/plugins.json ({installed:{mã:{version,at,enabled}}, seen:[…]}). Plugin "default": true được tự cài MỘT lần trên mọi máy (gỡ rồi thì không tự cài lại).
//  - Cài plugin = bật các kỹ năng của nó cho MỌI dự án (projects.skillsOf đọc skillDirs()) + thêm các kết nối kèm theo vào /dichvu (tắt, chờ nhập khóa).
//  - Plugin ra phiên bản mới (sync(): lúc khởi động bot và sau mỗi lần cập nhật) → kỹ năng mới dùng ngay, định nghĩa kết nối được cập nhật nhưng GIỮ khóa đã nhập và trạng thái bật.
//  - AN TOÀN: chỉ đọc thư mục danh mục (có chữ ký cùng bản cập nhật); mã, tên kết nối, lệnh khởi chạy đều kiểm tra như kết nối tự thêm; kỹ năng chỉ là văn bản, không chạy gì.
const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const KEY_RE = /^[a-z][a-z0-9]{0,15}$/;
const MAX_SKILLS = 30;

const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function front(raw) {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const pick = (k) => { const m = fm && fm[1].match(new RegExp('^' + k + '\\s*:\\s*(.+)$', 'mi')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  const body = raw.replace(/^---[\s\S]*?---\s*/, '').split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return { name: pick('name'), description: pick('description') || body };
}

function createPlugins(o) {
  const dir = o.dir, file = o.stateFile, connectors = o.connectors || null, log = o.log || (() => {}), now = o.now || Date.now;
  let state = load(), sig = fileSig();

  function fileSig() { try { const st = fs.statSync(file); return st.mtimeMs + ':' + st.size; } catch (e) { return ''; } }
  function load() {
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return { installed: j.installed && typeof j.installed === 'object' ? j.installed : {}, seen: Array.isArray(j.seen) ? j.seen : [] }; }
    catch (e) { return { installed: {}, seen: [] }; }
  }
  function refresh() { const n = fileSig(); if (n !== sig) { state = load(); sig = n; return true; } return false; }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o644 });
    fs.renameSync(tmp, file);
    sig = fileSig();
  }

  // Đọc danh mục: bỏ qua plugin hỏng (không làm hỏng cả danh mục)
  function catalogRaw() {
    let names; try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch (e) { return []; }
    const out = [];
    for (const n of names) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, n, 'plugin.json'), 'utf8'));
        if (!m || m.id !== n || !ID_RE.test(n) || !/^\d+(\.\d+){0,3}$/.test(String(m.version))) { log('plugin "' + n + '" bỏ qua: plugin.json sai mã/phiên bản'); continue; }
        const skills = [];
        try {
          for (const f of fs.readdirSync(path.join(dir, n, 'skills')).filter((x) => /^[\w-]{1,60}\.md$/.test(x)).sort().slice(0, MAX_SKILLS)) {
            const raw = fs.readFileSync(path.join(dir, n, 'skills', f), 'utf8').slice(0, 4000), fm = front(raw);
            skills.push({ slug: f.replace(/\.md$/, ''), name: fm.name || f.replace(/\.md$/, ''), description: cut(fm.description, 160) });
          }
        } catch (e) { /* không có kỹ năng */ }
        const cons = [];
        for (const c of Array.isArray(m.connectors) ? m.connectors : []) {
          if (!c || !KEY_RE.test(String(c.key)) || !validCommand(c.command) || !String(c.label || '').trim()) { log('plugin ' + n + ': bỏ kết nối "' + (c && c.key) + '" (sai định dạng/lệnh)'); continue; }
          const args = (Array.isArray(c.args) ? c.args : []).map(String);
          if (args.length > 20 || args.some((a) => a.length > 300 || /[\x00-\x1f]/.test(a))) continue;
          const secrets = (Array.isArray(c.secrets) ? c.secrets : []).filter((q) => q && ENV_NAME.test(String(q.name))).slice(0, 10).map((q) => ({ name: String(q.name), ask: cut(q.ask, 400), plain: !!q.plain }));
          cons.push({ key: String(c.key), label: cut(c.label, 40), about: cut(c.about, 300), command: String(c.command), args, secrets, manual: cut(c.manual, 600), plugin: n });
        }
        out.push({ id: n, name: cut(m.name || n, 50), version: String(m.version), icon: cut(m.icon || '🧩', 4), category: cut(m.category || 'Khác', 30), description: cut(m.description, 400), author: cut(m.author || 'AgentOS', 40), default: !!m.default, skills, connectors: cons });
      } catch (e) { log('plugin "' + n + '" bỏ qua: ' + e.message); }
    }
    return out;
  }

  const byId = (id) => catalogRaw().find((p) => p.id === id);
  const stateOf = (id) => state.installed[id] || null;

  // Thêm các kết nối kèm theo của plugin vào danh sách kết nối (tắt, chờ khóa); kết nối đã có thì thôi
  function ensureConnectors(p) {
    if (!connectors) return [];
    const added = [];
    for (const c of p.connectors) { const cur = connectors.get(c.key); if (cur) continue; const r = connectors.addFromCatalog(c.key); if (r.ok) added.push(c.key); }
    return added;
  }

  const view = (p) => {
    const st = stateOf(p.id);
    return { id: p.id, name: p.name, version: p.version, icon: p.icon, category: p.category, description: p.description, author: p.author, default: p.default,
      skills: p.skills.map((s) => ({ name: s.name, description: s.description })), connectors: p.connectors.map((c) => ({ key: c.key, label: c.label, needs: c.secrets.map((q) => q.name) })),
      installed: !!st, enabled: !!(st && st.enabled), installedVersion: st ? st.version : '', updated: !!(st && st.version !== p.version), at: st ? st.at : 0 };
  };

  return {
    // Đọc lại tệp trạng thái nếu tiến trình khác (trang Cài đặt) vừa sửa
    reload: () => refresh(),
    list() { refresh(); return catalogRaw().map(view); },
    get(id) { refresh(); const p = byId(id); return p ? view(p) : null; },
    install(id) {
      refresh(); const p = byId(id);
      if (!p) return { ok: false, error: 'Không có plugin "' + id + '" trong chợ.' };
      if (stateOf(id)) return { ok: false, error: p.name + ' đã được cài rồi.' };
      state.installed[id] = { version: p.version, at: now(), enabled: true };
      if (!state.seen.includes(id)) state.seen.push(id);
      save();
      const added = ensureConnectors(p);
      log('plugin ' + id + ' v' + p.version + ': đã cài (' + p.skills.length + ' kỹ năng' + (added.length ? ', thêm kết nối ' + added.join(',') : '') + ')');
      return { ok: true, skills: p.skills.length, connectors: added };
    },
    uninstall(id) {
      refresh();
      if (!stateOf(id)) return { ok: false, error: 'Plugin này chưa được cài.' };
      delete state.installed[id]; save();
      const removed = connectors ? connectors.removeFromPlugin(id) : [];
      log('plugin ' + id + ': đã gỡ' + (removed.length ? ' (gỡ kết nối ' + removed.join(',') + ')' : ''));
      return { ok: true, removedConnectors: removed };
    },
    setEnabled(id, on) {
      refresh(); const st = stateOf(id);
      if (!st) return { ok: false, error: 'Plugin này chưa được cài.' };
      st.enabled = !!on; save(); return { ok: true };
    },
    // Thư mục kỹ năng của các plugin ĐÃ CÀI và ĐANG BẬT (projects.skillsOf đọc thêm các thư mục này cho mọi dự án)
    skillDirs() {
      refresh();
      const out = [];
      for (const [id, st] of Object.entries(state.installed)) if (st && st.enabled && ID_RE.test(id)) { const d = path.join(dir, id, 'skills'); if (fs.existsSync(d)) out.push(d); }
      return out;
    },
    // Kết nối do plugin đã cài và đang bật cung cấp (hiện trong danh mục /dichvu)
    extraCatalog() {
      refresh();
      const out = [];
      for (const p of catalogRaw()) { const st = stateOf(p.id); if (st && st.enabled) out.push(...p.connectors); }
      return out;
    },
    // Lúc khởi động bot / sau cập nhật: tự cài plugin "mặc định" mới, nâng phiên bản plugin đã cài. Trả những gì đã đổi (để báo chủ máy).
    sync() {
      refresh();
      const res = { installed: [], updated: [], missing: [] };
      for (const p of catalogRaw()) {
        let st = stateOf(p.id);
        if (!st && p.default && !state.seen.includes(p.id)) { state.installed[p.id] = { version: p.version, at: now(), enabled: true }; st = state.installed[p.id]; state.seen.push(p.id); ensureConnectors(p); res.installed.push({ id: p.id, name: p.name, version: p.version }); save(); continue; }
        if (!st) continue;
        if (st.version !== p.version) {
          const from = st.version; st.version = p.version; save();
          const upgraded = connectors ? connectors.upgradeFromPlugin(p.id) : [];
          ensureConnectors(p);
          res.updated.push({ id: p.id, name: p.name, from, to: p.version, connectors: upgraded });
        } else ensureConnectors(p);
      }
      for (const id of Object.keys(state.installed)) if (!catalogRaw().some((p) => p.id === id)) res.missing.push(id);
      if (res.installed.length || res.updated.length) log('plugin: ' + res.installed.map((x) => 'cài ' + x.id).concat(res.updated.map((x) => x.id + ' ' + x.from + '→' + x.to)).join(', '));
      return res;
    },
    // Đường dẫn tệp kỹ năng của một plugin (đọc nội dung để xem)
    skillText(id, slug) {
      if (!ID_RE.test(String(id)) || !/^[\w-]{1,60}$/.test(String(slug))) return null;
      try { return fs.readFileSync(path.join(dir, id, 'skills', slug + '.md'), 'utf8'); } catch (e) { return null; }
    },
  };
}

module.exports = { createPlugins, ID_RE };
