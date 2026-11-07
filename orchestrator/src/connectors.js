'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// KẾT NỐI DỊCH VỤ (như "Connectors" của app Claude): thêm một máy chủ MCP (Notion, Lịch, Gmail… hoặc lệnh tự chọn) mà KHÔNG phải sửa tools.json bằng tay.
//  - Chỉ chủ máy thêm/bật/tắt/xóa (qua /dichvu); khóa (token) nhập qua Telegram rồi tin nhắn bị xóa ngay, lưu tệp 0600 trong thư mục dữ liệu (bị che khỏi AI trong hộp cô lập) và KHÔNG bao giờ hiện lại.
//  - "Thử" = chạy thật máy chủ rồi bắt tay MCP (initialize + tools/list) để biết có chạy được không và có những công cụ nào.
//  - Kết nối chỉ gắn vào việc của chủ máy ở chế độ toàn quyền (tools.servers → allMcp()); ID thường không bao giờ thấy. Công cụ có tác dụng ghi/gửi của kết nối bị hàng rào hỏi trước (policy.js).
//  - Tên máy chủ MCP luôn có tiền tố "c_" để không đụng "browser" / "agentos_gate".
const CATALOG = [
  { key: 'google', label: 'Google (Lịch + Gmail)', about: 'Máy chủ Google RIÊNG của AgentOS: CHỈ ĐỌC theo mặc định (xem lịch, tìm/đọc thư); công cụ tạo/sửa/xóa sự kiện, soạn nháp, gửi thư chỉ có khi chủ máy bật "cho phép ghi" và luôn hỏi trước.',
    command: 'node', args: [path.join(__dirname, 'google-mcp.js')], secrets: [],
    manual: 'Đăng nhập một lần ở Cài đặt → Kết nối và kỹ năng → Google (nhập khóa ứng dụng Google, bấm Đăng nhập).' },
  { key: 'notion', label: 'Notion', about: 'Đọc/ghi trang và cơ sở dữ liệu Notion (bản chính thức của Notion).',
    command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'],
    secrets: [{ name: 'NOTION_TOKEN', ask: 'Mã tích hợp Notion: vào notion.so/profile/integrations → New integration → copy mã (bắt đầu bằng ntn_ hoặc secret_). Nhớ vào trang Notion cần dùng → ⋯ → Connections → chọn tích hợp đó.' }] },
  { key: 'lich', label: 'Google Lịch', about: 'Xem/tạo/sửa sự kiện Google Calendar (gói cộng đồng @cocal/google-calendar-mcp).',
    command: 'npx', args: ['-y', '@cocal/google-calendar-mcp'],
    secrets: [{ name: 'GOOGLE_OAUTH_CREDENTIALS', plain: true, ask: 'Đường dẫn tới tệp gcp-oauth.keys.json trên máy (khóa OAuth loại "Desktop app" tạo ở console.cloud.google.com).' }],
    manual: 'Cần làm MỘT LẦN trên máy: bật Google Calendar API, tạo OAuth client (Desktop app), tải tệp JSON về, rồi chạy `GOOGLE_OAUTH_CREDENTIALS=<đường dẫn> npx @cocal/google-calendar-mcp auth` và đăng nhập tài khoản Google trên trình duyệt. CHƯA kiểm với tài khoản Google thật.' },
  { key: 'gmail', label: 'Gmail', about: 'Đọc/tìm/soạn thư Gmail (gói cộng đồng @gongrzhe/server-gmail-autoauth-mcp).',
    command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'], secrets: [],
    manual: 'Cần làm MỘT LẦN trên máy: tạo OAuth client (Desktop app) ở Google Cloud, lưu thành ~/.gmail-mcp/gcp-oauth.keys.json rồi chạy `npx @gongrzhe/server-gmail-autoauth-mcp auth` và đăng nhập Gmail trên trình duyệt. CHƯA kiểm với tài khoản Google thật. Gửi thư luôn bị hàng rào hỏi anh trước.' },
];

const SLUG_MAX = 16;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,40}$/;
const CMD_RE = /^[A-Za-z0-9_./-]{1,100}$/;
const LAUNCHERS = new Set(['npx', 'uvx', 'pipx', 'node', 'python', 'python3', 'bunx', 'deno', 'docker']);     // lệnh khởi chạy máy chủ MCP quen thuộc (chống gõ nhầm lệnh khác như rm); ngoài ra chỉ nhận đường dẫn tuyệt đối
const noAccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

// Bắt tay MCP qua stdio (JSON theo từng dòng): initialize → initialized → tools/list. Trả { ok, tools:[tên], server, error, ms }.
function handshake({ command, args, env, timeoutMs, spawn, secrets }) {
  spawn = spawn || cp.spawn;
  const mask = (s) => { let t = String(s || ''); for (const v of secrets || []) if (v && String(v).length >= 4) t = t.split(String(v)).join('***'); return t; };
  return new Promise((resolve) => {
    const t0 = Date.now(); let done = false, buf = '', err = '', child;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child && child.kill('SIGKILL'); } catch (e) { /* đã dừng */ } resolve(Object.assign({ ms: Date.now() - t0 }, r)); };
    const timer = setTimeout(() => finish({ ok: false, error: 'quá ' + Math.round((timeoutMs || 60000) / 1000) + ' giây không trả lời' + (err ? ': ' + mask(err).trim().slice(-200) : '') }), timeoutMs || 60000);
    if (timer.unref) timer.unref();
    try { child = spawn(command, args || [], { env: Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }, env || {}), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return finish({ ok: false, error: 'không chạy được lệnh: ' + e.message }); }
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch (e) { /* tiến trình đã thoát: sự kiện exit báo */ } };
    let server = '';
    child.on('error', (e) => finish({ ok: false, error: e.code === 'ENOENT' ? 'không tìm thấy lệnh "' + command + '" trên máy' : 'không chạy được: ' + e.message }));
    child.on('close', (code) => finish({ ok: false, error: 'máy chủ dừng ngay (mã ' + code + ')' + (err ? ': ' + mask(err).trim().slice(-300) : '') }));
    if (child.stderr) child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    if (child.stdout) child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch (e) { continue; }          // dòng không phải JSON (nhật ký lẫn vào): bỏ qua
        if (m.id === 1 && m.result) { server = (m.result.serverInfo && m.result.serverInfo.name) || ''; send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
        else if (m.id === 1 && m.error) finish({ ok: false, error: 'máy chủ từ chối khởi tạo: ' + mask(m.error.message || JSON.stringify(m.error)).slice(0, 200) });
        else if (m.id === 2 && m.result) finish({ ok: true, server, tools: (m.result.tools || []).map((x) => String(x.name)).slice(0, 80) });
        else if (m.id === 2 && m.error) finish({ ok: false, error: 'không lấy được danh sách công cụ: ' + mask(m.error.message || '').slice(0, 200) });
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agentos', version: '1' } } });
  });
}

// Tên máy chủ MCP một AI được cấp. AI KHÔNG qua hàng rào hỏi duyệt (Codex, Gemini) tuyệt đối không được cấp kết nối dịch vụ ("c_…"): công cụ gửi thư/ghi/xóa của kết nối sẽ chạy không hỏi.
const isConnector = (name) => /^c_/.test(String(name));
const mcpNamesFor = (servers, gated) => Object.keys(servers || {}).filter((k) => gated || !isConnector(k));

function createConnectors(o) {
  const file = o.file, log = o.log || (() => {}), now = o.now || Date.now, spawn = o.spawn;
  const testMs = o.testTimeoutMs || 90000;            // lần đầu npx tải gói nên cho khá lâu
  let items = load();
  let sig = fileSig();                                  // dấu vết tệp lúc đọc/ghi gần nhất: tệp bị tiến trình khác (trang Cài đặt) sửa thì đọc lại
  const extra = o.extraCatalog || (() => []);          // kết nối do plugin cung cấp (plugins.js)
  const pending = new Map();                          // chatId -> { id, name, until }: tin nhắn kế tiếp của chủ máy là giá trị khóa

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (Array.isArray(j.items) ? j.items : []).filter((x) => x && /^[a-z][a-z0-9]{0,15}$/.test(x.id) && CMD_RE.test(String(x.command || ''))).map((x) => Object.assign({ args: [], secrets: [], env: {}, enabled: false, last: null }, x));
    } catch (e) { return []; }
  }
  function fileSig() { try { const st = fs.statSync(file); return st.mtimeMs + ':' + st.size; } catch (e) { return ''; } }
  function refresh() { const n = fileSig(); if (n !== sig) { items = load(); sig = n; return true; } return false; }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ items }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (e) { /* hệ tệp không hỗ trợ */ }
    sig = fileSig();
  }
  const allCatalog = () => CATALOG.concat((extra() || []).filter((c) => c && /^[a-z][a-z0-9]{0,15}$/.test(String(c.key)) && !CATALOG.some((b) => b.key === c.key)));
  const find = (id) => items.find((x) => x.id === id);
  const missing = (x) => x.secrets.filter((s) => !x.env[s.name]).map((s) => s.name);
  const view = (x) => ({
    id: x.id, label: x.label, about: x.about || '', plugin: x.plugin || '', command: x.command, args: x.args, enabled: x.enabled, server: 'c_' + x.id, manual: x.manual || '',
    ready: !missing(x).length, missing: missing(x), last: x.last,
    secrets: x.secrets.map((s) => ({ name: s.name, ask: s.ask || '', plain: !!s.plain, set: !!x.env[s.name], value: s.plain && x.env[s.name] ? x.env[s.name] : undefined })),
  });
  const slugOf = (label) => {
    let s = noAccent(label).replace(/[^a-z0-9]+/g, '').slice(0, SLUG_MAX);
    if (!/^[a-z]/.test(s)) s = 'x' + s;
    let id = s, n = 2; while (find(id)) id = s.slice(0, SLUG_MAX - String(n).length) + n++;
    return id;
  };

  return {
    // Đọc lại tệp nếu tiến trình khác (trang Cài đặt) vừa sửa; trả true nếu có đổi
    reload: () => refresh(),
    catalog: () => { refresh(); return allCatalog().map((c) => ({ key: c.key, label: c.label, about: c.about, manual: c.manual || '', installed: !!find(c.key), needs: c.secrets.map((s) => s.name), plugin: c.plugin || '' })); },
    list: () => { refresh(); return items.map(view); },
    get: (id) => { refresh(); return find(id) ? view(find(id)) : null; },
    addFromCatalog(key) {
      refresh();
      const c = allCatalog().find((x) => x.key === key);
      if (!c) return { ok: false, error: 'Không có mục "' + key + '" trong danh mục.' };
      if (find(c.key)) return { ok: false, error: c.label + ' đã được thêm rồi.' };
      items.push({ id: c.key, label: c.label, about: c.about, command: c.command, args: c.args.slice(), secrets: c.secrets.map((s) => Object.assign({}, s)), env: c.key === 'google' ? { GOOGLE_DIR: o.googleDir || path.join(path.dirname(file), 'google') } : {}, manual: c.manual || '', enabled: false, last: null, addedAt: now(), plugin: c.plugin || undefined });
      save(); return { ok: true, id: c.key };
    },
    addCustom({ label, command, args }) {
      refresh();
      label = String(label || '').trim().slice(0, 40); command = String(command || '').trim();
      if (!label) return { ok: false, error: 'Thiếu tên kết nối.' };
      if (!LAUNCHERS.has(command) && !/^\/[A-Za-z0-9_./-]{1,100}$/.test(command)) return { ok: false, error: 'Lệnh chạy máy chủ không hợp lệ: chỉ nhận ' + [...LAUNCHERS].join(', ') + ' hoặc đường dẫn tuyệt đối (/...). Vd: npx -y ten-goi-mcp.' };
      args = (Array.isArray(args) ? args : []).map(String);
      if (args.length > 20 || args.some((a) => a.length > 300 || /[\x00-\x1f]/.test(a))) return { ok: false, error: 'Đối số lệnh không hợp lệ (tối đa 20, mỗi cái ≤ 300 ký tự).' };
      const id = slugOf(label);
      items.push({ id, label, about: 'Kết nối tự thêm.', command, args, secrets: [], env: {}, enabled: false, last: null, custom: true, addedAt: now() });
      save(); return { ok: true, id };
    },
    // Đặt giá trị khóa (không bao giờ trả ra ngoài). Kết nối từ danh mục chỉ nhận khóa đã khai; kết nối tự thêm nhận tên biến bất kỳ.
    setSecret(id, name, value) {
      refresh();
      const x = find(id); if (!x) return { ok: false, error: 'Không có kết nối này.' };
      name = String(name || '').trim();
      if (!ENV_NAME.test(name)) return { ok: false, error: 'Tên biến phải viết HOA, chữ/số/_ (vd NOTION_TOKEN).' };
      value = String(value == null ? '' : value).trim();
      if (!value || value.length > 4000 || /[\x00-\x08\x0b-\x1f]/.test(value)) return { ok: false, error: 'Giá trị trống hoặc không hợp lệ.' };
      if (!x.secrets.some((s) => s.name === name)) { if (!x.custom) return { ok: false, error: 'Kết nối ' + x.label + ' không dùng biến ' + name + '.' }; if (x.secrets.length >= 10) return { ok: false, error: 'Tối đa 10 biến cho một kết nối.' }; x.secrets.push({ name }); }
      x.env[name] = value; x.last = null; save(); return { ok: true, missing: missing(x) };
    },
    setEnabled(id, on) {
      refresh();
      const x = find(id); if (!x) return { ok: false, error: 'Không có kết nối này.' };
      if (on && missing(x).length) return { ok: false, error: 'Còn thiếu: ' + missing(x).join(', ') };
      x.enabled = !!on; save(); return { ok: true };
    },
    remove(id) { refresh(); const n = items.length; items = items.filter((x) => x.id !== id); if (items.length === n) return { ok: false, error: 'Không có kết nối này.' }; save(); return { ok: true }; },
    // Chạy thật máy chủ và bắt tay MCP; lưu kết quả để hiện ở danh sách
    async test(id) {
      refresh();
      const x = find(id); if (!x) return { ok: false, error: 'Không có kết nối này.' };
      if (missing(x).length) return { ok: false, error: 'Còn thiếu: ' + missing(x).join(', ') };
      const r = await handshake({ command: x.command, args: x.args, env: x.env, timeoutMs: testMs, spawn, secrets: Object.values(x.env) });
      x.last = { ok: r.ok, at: now(), tools: r.tools || [], server: r.server || '', error: r.error || '', ms: r.ms };
      try { save(); } catch (e) { log('lưu kết quả thử lỗi: ' + e.message); }
      return r;
    },
    // Đưa các kết nối ĐANG BẬT và đủ khóa vào tools.servers (tên "c_<id>"); gỡ những cái đã tắt/xóa. Gọi lúc khởi động và sau mỗi thay đổi.
    apply(tools) {
      refresh();
      const srv = tools.servers || (tools.servers = {});
      for (const k of Object.keys(srv)) if (k.startsWith('c_')) delete srv[k];
      const on = [];
      for (const x of items) {
        if (!x.enabled || missing(x).length) continue;
        srv['c_' + x.id] = { command: x.command, args: x.args.slice() };
        if (Object.keys(x.env).length) srv['c_' + x.id].env = Object.assign({}, x.env);
        on.push('c_' + x.id);
      }
      return on;
    },
    // Plugin ra phiên bản mới: cập nhật lệnh/mô tả/tên biến của kết nối đã thêm từ plugin đó (giữ khóa đã nhập và trạng thái bật). Trả danh sách id đã đổi.
    upgradeFromPlugin(pluginId) {
      refresh(); const changed = [];
      for (const c of allCatalog().filter((x) => x.plugin === pluginId)) {
        const x = find(c.key); if (!x || x.plugin !== pluginId) continue;
        const next = { label: c.label, about: c.about, command: c.command, args: c.args.slice(), manual: c.manual || '' };
        const secrets = c.secrets.map((q) => Object.assign({}, q));
        if (JSON.stringify([x.label, x.about, x.command, x.args, x.manual || '', x.secrets]) !== JSON.stringify([next.label, next.about, next.command, next.args, next.manual, secrets])) { Object.assign(x, next, { secrets }); changed.push(x.id); }
      }
      if (changed.length) save();
      return changed;
    },
    // Gỡ plugin: bỏ các kết nối do plugin đó thêm
    removeFromPlugin(pluginId) { refresh(); const ids = items.filter((x) => x.plugin === pluginId).map((x) => x.id); if (ids.length) { items = items.filter((x) => x.plugin !== pluginId); save(); } return ids; },
    // Tin nhắn kế tiếp của chủ máy là giá trị khóa (hết hạn sau 10 phút)
    setPending(chatId, id, name) { pending.set(String(chatId), { id, name, until: now() + 10 * 60000 }); },
    pendingOf(chatId) { const p = pending.get(String(chatId)); if (!p) return null; if (p.until < now()) { pending.delete(String(chatId)); return null; } return p; },
    clearPending(chatId) { pending.delete(String(chatId)); },
    CATALOG,
    allCatalog,
  };
}

// Lệnh khởi chạy máy chủ MCP có hợp lệ không (dùng cho cả kết nối do plugin cung cấp)
const validCommand = (c) => LAUNCHERS.has(String(c)) || /^\/[A-Za-z0-9_./-]{1,100}$/.test(String(c));

module.exports = { createConnectors, handshake, CATALOG, isConnector, mcpNamesFor, validCommand, ENV_NAME };
