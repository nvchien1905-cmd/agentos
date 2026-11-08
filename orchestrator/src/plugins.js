'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { validCommand, ENV_NAME } = require('./connectors');

// CHỢ KỸ NĂNG / PLUGIN (như "Plugins" của app Claude): mỗi plugin là một thư mục có plugin.json + skills/*.md (kỹ năng dạy AI) + commands/*.md (LỆNH gõ được: /cho dung <plugin>/<lệnh>)
// + agents/*.md (TÁC NHÂN PHỤ: vai trò chuyên môn giao cho trợ lý phụ) + các kết nối dịch vụ (MCP) đi kèm.
//  - Danh mục CÓ SẴN nằm trong bản cài AgentOS (/opt/agentos/wizard/plugins/<mã>/…) nên TỰ CẬP NHẬT cùng mỗi bản cập nhật hệ điều hành (OTA có chữ ký) cho MỌI máy.
//  - Plugin THÊM TỪ LIÊN KẾT (addFromUrl): tải gói .tar.gz https, kiểm định dạng, lưu ở data/plugins-user/<mã>. Nguồn lạ nên: chủ máy phải xác nhận; KẾT NỐI (chạy mã) bị loại bỏ trừ khi
//    chủ máy cho phép riêng (allowConnectors); không được trùng mã plugin có sẵn; kỹ năng/lệnh/tác nhân chỉ là văn bản (nhưng AI sẽ làm theo → chỉ thêm nguồn tin cậy).
//  - Trạng thái cài của từng máy ở data/plugins.json ({installed:{mã:{version,at,enabled}}, seen:[…]}). Plugin "default": true được tự cài MỘT lần trên mọi máy (gỡ rồi thì không tự cài lại).
//  - Cài plugin = bật kỹ năng/lệnh/tác nhân của nó cho MỌI dự án + thêm các kết nối kèm theo vào /dichvu (tắt, chờ nhập khóa).
//  - Plugin ra phiên bản mới (sync(): lúc khởi động bot và sau mỗi lần cập nhật) → nâng phiên bản, cập nhật định nghĩa kết nối nhưng GIỮ khóa đã nhập và trạng thái bật.
const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const KEY_RE = /^[a-z][a-z0-9]{0,15}$/;
const MAX_FILES = 30, MAX_PKG = 5 * 1024 * 1024;

const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function front(raw) {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const pick = (k) => { const m = fm && fm[1].match(new RegExp('^' + k + '\\s*:\\s*(.+)$', 'mi')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  const body = raw.replace(/^---[\s\S]*?---\s*/, '').split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return { name: pick('name'), description: pick('description') || body, args: pick('args') };
}
const listMd = (d) => { try { return fs.readdirSync(d).filter((x) => /^[\w-]{1,60}\.md$/.test(x)).sort().slice(0, MAX_FILES); } catch (e) { return []; } };
const isPrivateHost = (h) => /^(localhost|.*\.local|.*\.internal)$/i.test(h) || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /^\[?(::1|fe80|fc|fd)/i.test(h);

function createPlugins(o) {
  const dir = o.dir, userDir = o.userDir || null, file = o.stateFile, connectors = o.connectors || null, log = o.log || (() => {}), now = o.now || Date.now;
  const fetchFn = o.fetch || fetch, runCmd = o.run || ((cmd, args) => new Promise((resolve) => cp.execFile(cmd, args, { timeout: 60000 }, (err, out) => resolve({ code: err ? 1 : 0, out: String(out || '') }))));
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

  // Đọc MỘT plugin trong thư mục root/<n>: trả null nếu hỏng (kèm ghi nhật ký), không làm hỏng cả danh mục
  function readPlugin(root, n, source, allowConnectors) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(root, n, 'plugin.json'), 'utf8'));
      if (!m || m.id !== n || !ID_RE.test(n) || !/^\d+(\.\d+){0,3}$/.test(String(m.version))) { log('plugin "' + n + '" bỏ qua: plugin.json sai mã/phiên bản'); return null; }
      const dirOf = (sub) => path.join(root, n, sub);
      const skills = listMd(dirOf('skills')).map((f) => { const fm = front(fs.readFileSync(path.join(dirOf('skills'), f), 'utf8').slice(0, 4000)); return { slug: f.replace(/\.md$/, ''), name: fm.name || f.replace(/\.md$/, ''), description: cut(fm.description, 160) }; });
      const commands = listMd(dirOf('commands')).map((f) => { const fm = front(fs.readFileSync(path.join(dirOf('commands'), f), 'utf8').slice(0, 6000)); return { slug: f.replace(/\.md$/, ''), name: fm.name || f.replace(/\.md$/, ''), description: cut(fm.description, 160), args: cut(fm.args, 80) }; });
      const agents = listMd(dirOf('agents')).map((f) => { const fm = front(fs.readFileSync(path.join(dirOf('agents'), f), 'utf8').slice(0, 6000)); return { slug: f.replace(/\.md$/, ''), name: fm.name || f.replace(/\.md$/, ''), description: cut(fm.description, 160) }; });
      const cons = [];
      for (const c of (source === 'user' && !allowConnectors) ? [] : (Array.isArray(m.connectors) ? m.connectors : [])) {
        if (!c || !KEY_RE.test(String(c.key)) || !validCommand(c.command) || !String(c.label || '').trim()) { log('plugin ' + n + ': bỏ kết nối "' + (c && c.key) + '" (sai định dạng/lệnh)'); continue; }
        const args = (Array.isArray(c.args) ? c.args : []).map(String);
        if (args.length > 20 || args.some((a) => a.length > 300 || /[\x00-\x1f]/.test(a))) continue;
        const secrets = (Array.isArray(c.secrets) ? c.secrets : []).filter((q) => q && ENV_NAME.test(String(q.name))).slice(0, 10).map((q) => ({ name: String(q.name), ask: cut(q.ask, 400), plain: !!q.plain }));
        cons.push({ key: String(c.key), label: cut(c.label, 40), about: cut(c.about, 300), command: String(c.command), args, secrets, manual: cut(c.manual, 600), plugin: n });
      }
      return { id: n, root: path.join(root, n), source, name: cut(m.name || n, 50), version: String(m.version), icon: cut(m.icon || '🧩', 4), category: cut(m.category || 'Khác', 30), description: cut(m.description, 400), author: cut(m.author || (source === 'user' ? 'bên thứ ba' : 'AgentOS'), 40), default: source === 'bundled' && !!m.default, skills, commands, agents, connectors: cons, hasConnectors: Array.isArray(m.connectors) && m.connectors.length > 0 };
    } catch (e) { log('plugin "' + n + '" bỏ qua: ' + e.message); return null; }
  }
  // Danh mục: có sẵn (bản cài) + do chủ máy thêm; mã trùng thì bản CÓ SẴN thắng
  function catalogRaw() {
    const out = [], seen = new Set();
    for (const [root, source] of [[dir, 'bundled'], [userDir, 'user']]) {
      if (!root) continue;
      let names; try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch (e) { continue; }
      for (const n of names) { if (seen.has(n)) continue; const p = readPlugin(root, n, source, source === 'user' ? userAllowsConnectors(n) : true); if (p) { out.push(p); seen.add(n); } }
    }
    return out;
  }
  const userAllowsConnectors = (n) => { try { return !!JSON.parse(fs.readFileSync(path.join(userDir, n, '.agentos-trust.json'), 'utf8')).connectors; } catch (e) { return false; } };
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
    return { id: p.id, name: p.name, version: p.version, icon: p.icon, category: p.category, description: p.description, author: p.author, default: p.default, source: p.source,
      skills: p.skills.map((s) => ({ name: s.name, description: s.description })), commands: p.commands.map((c) => ({ name: p.id + '/' + c.slug, description: c.description, args: c.args })), agents: p.agents.map((a) => ({ name: a.name, description: a.description })),
      connectors: p.connectors.map((c) => ({ key: c.key, label: c.label, needs: c.secrets.map((q) => q.name) })), droppedConnectors: p.source === 'user' && p.hasConnectors && !p.connectors.length,
      installed: !!st, enabled: !!(st && st.enabled), installedVersion: st ? st.version : '', updated: !!(st && st.version !== p.version), at: st ? st.at : 0 };
  };
  const enabledPlugins = () => { refresh(); const out = []; for (const p of catalogRaw()) { const st = stateOf(p.id); if (st && st.enabled) out.push(p); } return out; };

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
      log('plugin ' + id + ' v' + p.version + ': đã cài (' + p.skills.length + ' kỹ năng, ' + p.commands.length + ' lệnh, ' + p.agents.length + ' tác nhân' + (added.length ? ', thêm kết nối ' + added.join(',') : '') + ')');
      return { ok: true, skills: p.skills.length, commands: p.commands.length, agents: p.agents.length, connectors: added };
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
    // Thư mục kỹ năng / tác nhân của các plugin ĐÃ CÀI và ĐANG BẬT (projects.js đọc thêm cho mọi dự án)
    // Kỹ năng GỐC của plugin đang bật (bản cài, chỉ đọc): [{plugin, pluginName, source, slug, name, description, file, hash}] — skillLayers.js dùng để nhận ra kỹ năng của dự án đè lên bản gốc
    officialSkills() {
      const out = [];
      for (const p of enabledPlugins()) for (const k of p.skills) {
        const file = path.join(p.root, 'skills', k.slug + '.md'); let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        out.push({ plugin: p.id, pluginName: p.name, source: p.source, slug: k.slug, name: k.name, description: k.description, file, hash: require('crypto').createHash('sha256').update(raw).digest('hex').slice(0, 16) });
      }
      return out;
    },
    skillDirs() { return enabledPlugins().map((p) => path.join(p.root, 'skills')).filter((d) => fs.existsSync(d)); },
    agentDirs() { return enabledPlugins().map((p) => path.join(p.root, 'agents')).filter((d) => fs.existsSync(d)); },
    // Kết nối do plugin đã cài và đang bật cung cấp (hiện trong danh mục /dichvu)
    extraCatalog() { const out = []; for (const p of enabledPlugins()) out.push(...p.connectors); return out; },
    // Lệnh của plugin đã cài + đang bật: [{name:'plugin/lệnh', description, args}]
    commands() { const out = []; for (const p of enabledPlugins()) for (const c of p.commands) out.push({ name: p.id + '/' + c.slug, description: c.description, args: c.args }); return out; },
    // Nội dung lời nhắc của một lệnh với đối số đã thay vào {args}; null nếu không có/đang tắt
    commandPrompt(full, args) {
      const m = String(full || '').match(/^([a-z][a-z0-9-]{1,30})\/([\w-]{1,60})$/); if (!m) return null;
      const p = enabledPlugins().find((x) => x.id === m[1]); if (!p || !p.commands.some((c) => c.slug === m[2])) return null;
      let raw; try { raw = fs.readFileSync(path.join(p.root, 'commands', m[2] + '.md'), 'utf8'); } catch (e) { return null; }
      const body = raw.replace(/^---[\s\S]*?---\s*/, '').trim(), a = String(args || '').trim().slice(0, 4000);
      return (/\{args\}/.test(body) ? body.replace(/\{args\}/g, a) : body + (a ? '\n\nYêu cầu của chủ máy: ' + a : '')).slice(0, 12000);
    },
    // Lúc khởi động bot / sau cập nhật: tự cài plugin "mặc định" mới, nâng phiên bản plugin đã cài. Trả những gì đã đổi (để báo chủ máy).
    sync() {
      refresh();
      const res = { installed: [], updated: [], missing: [] };
      const cat = catalogRaw();
      for (const p of cat) {
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
      for (const id of Object.keys(state.installed)) if (!cat.some((p) => p.id === id)) res.missing.push(id);
      if (res.installed.length || res.updated.length) log('plugin: ' + res.installed.map((x) => 'cài ' + x.id).concat(res.updated.map((x) => x.id + ' ' + x.from + '→' + x.to)).join(', '));
      return res;
    },
    // Đọc nội dung một kỹ năng / lệnh / tác nhân của plugin (để xem)
    skillText(id, slug, kind) {
      const sub = kind === 'commands' ? 'commands' : kind === 'agents' ? 'agents' : 'skills';
      if (!ID_RE.test(String(id)) || !/^[\w-]{1,60}$/.test(String(slug))) return null;
      const p = byId(id); if (!p) return null;
      try { return fs.readFileSync(path.join(p.root, sub, slug + '.md'), 'utf8'); } catch (e) { return null; }
    },
    // THÊM PLUGIN TỪ LIÊN KẾT (gói .tar.gz qua https, ≤ 5 MB; chứa plugin.json ở gốc hoặc trong một thư mục con duy nhất)
    async addFromUrl(url, opt) {
      opt = opt || {};
      if (!userDir) return { ok: false, error: 'Máy này chưa bật thêm plugin từ liên kết.' };
      let u; try { u = new URL(String(url)); } catch (e) { return { ok: false, error: 'Liên kết không hợp lệ.' }; }
      if (u.protocol !== 'https:' || isPrivateHost(u.hostname)) return { ok: false, error: 'Chỉ nhận liên kết https tới máy chủ công cộng.' };
      let buf;
      try {
        const r = await fetchFn(u.toString(), { redirect: 'follow', signal: AbortSignal.timeout(60000) });
        if (!r.ok) return { ok: false, error: 'Tải về lỗi (' + r.status + ').' };
        if (isPrivateHost(new URL(r.url || u.toString()).hostname)) return { ok: false, error: 'Liên kết chuyển hướng tới địa chỉ nội bộ — từ chối.' };
        buf = Buffer.from(await r.arrayBuffer());
      } catch (e) { return { ok: false, error: 'Không tải được: ' + e.message }; }
      if (!buf.length || buf.length > MAX_PKG) return { ok: false, error: 'Gói rỗng hoặc lớn hơn 5 MB.' };
      const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agentos-plugin-'));
      try {
        fs.writeFileSync(path.join(tmp, 'p.tgz'), buf);
        const ls = await runCmd('tar', ['-tzf', path.join(tmp, 'p.tgz')]);
        if (ls.code !== 0) return { ok: false, error: 'Không đọc được gói (cần .tar.gz).' };
        if (ls.out.split('\n').some((l) => l.startsWith('/') || l.split('/').includes('..'))) return { ok: false, error: 'Gói có đường dẫn nguy hiểm — từ chối.' };
        fs.mkdirSync(path.join(tmp, 'x'));
        const ex = await runCmd('tar', ['-xzf', path.join(tmp, 'p.tgz'), '-C', path.join(tmp, 'x'), '--no-same-owner', '--no-same-permissions']);
        if (ex.code !== 0) return { ok: false, error: 'Giải nén gói lỗi.' };
        let root = path.join(tmp, 'x'); const kids = fs.readdirSync(root);
        if (!fs.existsSync(path.join(root, 'plugin.json')) && kids.length === 1 && fs.statSync(path.join(root, kids[0])).isDirectory()) root = path.join(root, kids[0]);
        let m; try { m = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')); } catch (e) { return { ok: false, error: 'Gói không có plugin.json hợp lệ.' }; }
        const id = String(m && m.id || '');
        if (!ID_RE.test(id)) return { ok: false, error: 'Mã plugin không hợp lệ (chữ thường, số, gạch ngang).' };
        if (fs.existsSync(path.join(dir, id))) return { ok: false, error: 'Mã "' + id + '" trùng plugin có sẵn của AgentOS — không ghi đè.' };
        // Chuẩn bị bản sạch: chỉ plugin.json + skills/commands/agents/*.md (bỏ mọi tệp khác như mã chạy được)
        const clean = path.join(tmp, 'clean', id); fs.mkdirSync(clean, { recursive: true });
        fs.copyFileSync(path.join(root, 'plugin.json'), path.join(clean, 'plugin.json'));
        let nfiles = 0;
        for (const sub of ['skills', 'commands', 'agents']) for (const f of listMd(path.join(root, sub))) { const sp = path.join(root, sub, f); if (!fs.lstatSync(sp).isFile() || fs.statSync(sp).size > 30000) continue; fs.mkdirSync(path.join(clean, sub), { recursive: true }); fs.copyFileSync(sp, path.join(clean, sub, f)); nfiles++; }
        const probe = readPlugin(path.join(tmp, 'clean'), id, 'user', !!opt.allowConnectors);
        if (!probe) return { ok: false, error: 'plugin.json sai (cần id khớp, version dạng 1.0.0).' };
        if (!nfiles && !probe.connectors.length) return { ok: false, error: 'Plugin rỗng: không có kỹ năng, lệnh, tác nhân hay kết nối hợp lệ.' };
        if (!opt.confirm) return { ok: false, needConfirm: true, preview: view(probe), error: 'Cần chủ máy xác nhận (xem nội dung trước).' };
        const dest = path.join(userDir, id);
        fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(userDir, { recursive: true });
        fs.cpSync(clean, dest, { recursive: true });
        fs.writeFileSync(path.join(dest, '.agentos-trust.json'), JSON.stringify({ connectors: !!opt.allowConnectors, from: u.hostname, at: now() }));
        log('plugin ' + id + ' v' + probe.version + ': thêm từ ' + u.hostname + (opt.allowConnectors ? ' (CHO PHÉP kết nối)' : ''));
        return { ok: true, id, version: probe.version, skills: probe.skills.length, commands: probe.commands.length, agents: probe.agents.length, connectors: probe.connectors.length };
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    },
    // Xóa hẳn một plugin do chủ máy thêm (gỡ cài đặt + xóa thư mục); plugin có sẵn không xóa được
    removeUser(id) {
      refresh();
      if (!userDir || !ID_RE.test(String(id)) || fs.existsSync(path.join(dir, id)) || !fs.existsSync(path.join(userDir, id))) return { ok: false, error: 'Chỉ xóa được plugin do chủ máy thêm.' };
      if (stateOf(id)) this.uninstall(id);
      fs.rmSync(path.join(userDir, id), { recursive: true, force: true });
      return { ok: true };
    },
  };
}

module.exports = { createPlugins, ID_RE };
