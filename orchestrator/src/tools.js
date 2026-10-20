'use strict';
const fs = require('fs');
const path = require('path');

// Lệnh Telegram đã dùng, không được đặt tên profile trùng.
const RESERVED = new Set(['claude', 'codex', 'gemini', 'start', 'help', 'id', 'moi', 'trangthai', 'viec', 'huy', 'nhatky', 'toanquyen', 'baove', 'manhinh', 'cuaso', 'mo', 'dong', 'khoamay', 'khoimay', 'tatmay', 'deepseek', 'doanhso', 'ton', 'onedrive']);
const NAME_RE = /^[a-z][a-z0-9_]{0,23}$/;
const KNOWN_ENGINES = ['claude', 'codex', 'gemini'];

// Thay ${BIEN} trong mọi chuỗi của cấu hình (đường dẫn dữ liệu, màn hình ảo...). Biến lạ giữ nguyên.
function subst(v, vars) {
  if (typeof v === 'string') return v.replace(/\$\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  if (Array.isArray(v)) return v.map((x) => subst(x, vars));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = subst(v[k], vars); return o; }
  return v;
}

const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// Đọc tools.json: máy chủ MCP + các "bộ công cụ" (profile). Mỗi profile quyết định việc đó được dùng gì.
//   { servers: { ten: { command, args, env } },
//     profiles: { ten: { description, allow:[...], mcp:[tên server], hint, codexSandbox } },
//     default: "chung" }
// Không có file -> chỉ một profile mặc định với danh sách công cụ cho phép lấy từ .env (chỉ đọc).
function loadTools({ file, vars, fallbackAllow }) {
  let raw = null;
  if (file) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw) raw = { servers: {}, profiles: { chung: { description: 'Chỉ đọc', allow: splitList(fallbackAllow) } }, default: 'chung' };
  raw = subst(raw, vars || {});

  const servers = raw.servers || {};
  const profiles = {};
  const errors = [];
  for (const [n, s] of Object.entries(servers)) {
    if (!/^[a-z][a-z0-9_]*$/.test(n)) errors.push('Tên máy chủ MCP không hợp lệ (chữ thường/số/_): ' + n);
    if (n === 'agentos_gate') errors.push('Tên máy chủ "agentos_gate" dành riêng cho cổng duyệt');
    if (!s || typeof s.command !== 'string' || !s.command) errors.push('Máy chủ MCP "' + n + '" thiếu command');
  }
  for (const [n, p] of Object.entries(raw.profiles || {})) {
    if (!NAME_RE.test(n)) errors.push('Tên profile không hợp lệ (chữ thường/số/_, bắt đầu bằng chữ): ' + n);
    if (RESERVED.has(n)) errors.push('Tên profile trùng lệnh có sẵn: ' + n);
    if (n === 'agentos_gate') errors.push('Tên "agentos_gate" dành riêng');
    const mcp = Array.isArray(p.mcp) ? p.mcp : [];
    for (const m of mcp) if (!servers[m]) errors.push('Profile "' + n + '" dùng máy chủ MCP không có: ' + m);
    // Engine được chạy bộ này. Codex không đi qua cổng duyệt nên mặc định chỉ dùng cho bộ không có MCP.
    const engines = Array.isArray(p.engines) ? p.engines.slice() : (mcp.length ? ['claude'] : ['claude', 'codex', 'gemini']);
    for (const e of engines) if (!KNOWN_ENGINES.includes(e)) errors.push('Profile "' + n + '" có engine không biết: ' + e);
    if (engines.includes('codex') && p.codexSandbox && p.codexSandbox !== 'read-only') {
      errors.push('Profile "' + n + '" cho Codex ghi file (' + p.codexSandbox + ') nhưng Codex không qua cổng duyệt');
    }
    const pol = p.policy && typeof p.policy === 'object' ? p.policy : {};
    const allow = Array.isArray(p.allow) ? p.allow.slice() : [];
    profiles[n] = {
      name: n,
      description: p.description || '',
      allow,
      mcp,
      hint: p.hint || '',
      codexSandbox: p.codexSandbox || '',
      adminOnly: !!p.adminOnly,
      engines,
      gate: p.gate !== false,
      // Chính sách cho cổng duyệt: mẫu tên công cụ được tự cho phép / luôn hỏi / luôn cấm, lệnh shell an toàn, mạng nội bộ
      policy: {
        allow: [].concat(pol.allow || [], allow),
        ask: pol.ask || [],
        deny: pol.deny || [],
        allowExec: pol.allowExec || [],
        allowPrivateNetwork: !!pol.allowPrivateNetwork,
        askNewOrigin: !!pol.askNewOrigin,
      },
      mcpConfig: null,
    };
  }
  const def = raw.default;
  if (!def || !profiles[def]) errors.push('Thiếu "default" hoặc profile mặc định không tồn tại');

  const api = {
    errors,
    servers,
    profiles,
    defaultName: def,
    // Profile của một việc; tên không còn trong cấu hình -> dùng mặc định.
    profile(name) { return profiles[name] || profiles[def]; },
    // Profile người dùng chọn bằng lệnh /<tên> (trừ profile mặc định).
    selectable() { return Object.values(profiles).filter((p) => p.name !== def); },
    // Công cụ cho phép sẵn (--allowedTools). Bộ có cổng duyệt KHÔNG cho phép sẵn gì: mọi công cụ đều đi qua cổng,
    // chính sách (policy.js) mới quyết định tự cho phép, hỏi hay cấm.
    allowFor(p) { return p.gate ? [] : [...new Set([].concat(p.allow, p.mcp.map((m) => 'mcp__' + m)))]; },
    // Máy chủ MCP của một bộ công cụ, dạng cấu hình MCP của Claude.
    mcpServersFor(p) {
      const o = {};
      for (const m of p.mcp) {
        const s = servers[m];
        o[m] = { command: s.command, args: s.args || [] };
        if (s.env) o[m].env = s.env;
      }
      return o;
    },
    // Engine được phép chạy việc này.
    enginesFor(name) { return profiles[name] ? profiles[name].engines : profiles[def].engines; },
    // Ghi file cấu hình MCP cho mỗi profile (kể cả rỗng, để Claude chỉ dùng đúng bộ này: --strict-mcp-config).
    writeMcpConfigs(dir) {
      fs.mkdirSync(dir, { recursive: true });
      for (const p of Object.values(profiles)) {
        const mcpServers = {};
        for (const m of p.mcp) {
          const s = servers[m];
          mcpServers[m] = { command: s.command, args: s.args || [] };
          if (s.env) mcpServers[m].env = s.env;
        }
        p.mcpConfig = path.join(dir, 'mcp-' + p.name + '.json');
        fs.writeFileSync(p.mcpConfig, JSON.stringify({ mcpServers }, null, 2));
      }
    },
    // Tham số -c của Codex để khai báo máy chủ MCP (CHƯA kiểm với Codex thật).
    codexArgs(p) {
      const out = [];
      for (const m of p.mcp) {
        const s = servers[m];
        out.push('-c', 'mcp_servers.' + m + '.command=' + JSON.stringify(s.command));
        out.push('-c', 'mcp_servers.' + m + '.args=' + JSON.stringify(s.args || []));
        if (s.env && Object.keys(s.env).length) {
          out.push('-c', 'mcp_servers.' + m + '.env={' + Object.entries(s.env).map(([k, v]) => k + '=' + JSON.stringify(String(v))).join(',') + '}');
        }
      }
      return out;
    },
  };
  return api;
}

module.exports = { loadTools, subst, RESERVED };
