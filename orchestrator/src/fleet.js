'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ĐỘI MÁY: một máy AgentOS làm "đầu não" giao việc cho các máy AgentOS khác trong cửa hàng (nối với nhau qua Tailscale), xem tình trạng, cập nhật.
//  - Mỗi máy CON bật "cho phép máy đầu não điều khiển" ở Cài đặt → Đội máy: máy sinh ra một KHÓA, mở cổng chỉ trên địa chỉ Tailscale/nội bộ.
//  - Máy ĐẦU NÃO thêm máy con bằng địa chỉ + khóa (Cài đặt hoặc /may them ...). Mọi yêu cầu ký HMAC-SHA256 (khóa + phương thức + đường dẫn + giờ + nội dung), lệch giờ > 60 giây
//    hoặc dùng lại chữ ký thì bị từ chối. Việc giao sang máy con LUÔN chạy chế độ bảo vệ (hỏi duyệt qua Telegram của máy con), không bao giờ toàn quyền.
//  - Dữ liệu cấu hình nằm ở một tệp JSON (0600) để trang Cài đặt (root) và bộ điều phối (agentos) cùng đọc/ghi.
const NAME_RE = /^[\p{L}\p{N} _-]{1,30}$/u;
const MAX_SKEW_MS = 60000, MAX_BODY = 65536;

const sign = (key, method, p, ts, body) => crypto.createHmac('sha256', key).update([String(method).toUpperCase(), p, String(ts), body || ''].join('\n')).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function createFleet(o) {
  o = o || {};
  const file = o.file || '/var/lib/agentos/data/fleet.json', log = o.log || (() => {}), now = o.now || Date.now, doFetch = o.fetch || fetch;
  const load = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return { agent: Object.assign({ enabled: false, key: '', host: '', port: 8433, name: '' }, j.agent || {}), machines: Array.isArray(j.machines) ? j.machines : [] }; } catch (e) { return { agent: { enabled: false, key: '', host: '', port: 8433, name: '' }, machines: [] }; } };
  const save = (c) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = file + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(c, null, 1), { mode: 0o600 }); fs.renameSync(t, file); };

  // ---------- máy con: bật/tắt cho phép điều khiển ----------
  function enableAgent(opt) {
    const c = load(); opt = opt || {};
    if (opt.name !== undefined) { if (!NAME_RE.test(String(opt.name))) throw new Error('Tên máy 1–30 ký tự (chữ, số, dấu cách, - _).'); c.agent.name = String(opt.name); }
    if (!c.agent.name) c.agent.name = require('os').hostname();
    if (opt.port !== undefined) { const p = Number(opt.port); if (!(p >= 1024 && p <= 65535)) throw new Error('Cổng từ 1024 đến 65535.'); c.agent.port = p; }
    if (opt.host !== undefined) c.agent.host = String(opt.host || '');
    if (opt.regenerate || !c.agent.key) c.agent.key = crypto.randomBytes(24).toString('hex');
    c.agent.enabled = true; save(c); return c.agent;
  }
  const disableAgent = () => { const c = load(); c.agent.enabled = false; save(c); };

  // ---------- máy đầu não: danh sách máy con ----------
  function addMachine(m) {
    const name = String((m && m.name) || '').trim(); if (!NAME_RE.test(name)) throw new Error('Tên máy 1–30 ký tự (chữ, số, dấu cách, - _).');
    let url; try { url = new URL(String(m.url || '')); } catch (e) { throw new Error('Địa chỉ không đúng (ví dụ http://100.64.0.5:8433).'); }
    if (!/^https?:$/.test(url.protocol)) throw new Error('Địa chỉ phải bắt đầu bằng http:// hoặc https://');
    const key = String(m.key || '').trim(); if (!/^[0-9a-f]{32,128}$/i.test(key)) throw new Error('Khóa không đúng (chuỗi 48 ký tự hex lấy ở Cài đặt của máy con).');
    const c = load(); if (c.machines.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new Error('Đã có máy tên "' + name + '".');
    c.machines.push({ name, url: url.origin, key }); save(c); return { name, url: url.origin };
  }
  function removeMachine(name) { const c = load(), n = c.machines.length; c.machines = c.machines.filter((x) => x.name.toLowerCase() !== String(name).toLowerCase()); save(c); return c.machines.length < n; }
  const findMachine = (name) => load().machines.find((x) => x.name.toLowerCase() === String(name || '').trim().toLowerCase()) || null;

  async function call(machine, method, p, body, timeoutMs) {
    const ts = now(), raw = body === undefined ? '' : JSON.stringify(body);
    const r = await doFetch(machine.url + p, { method, headers: { 'content-type': 'application/json', 'x-fleet-ts': String(ts), 'x-fleet-sig': sign(machine.key, method, p, ts, raw) }, body: raw || undefined, signal: AbortSignal.timeout(timeoutMs || 8000) });
    let j = null; try { j = await r.json(); } catch (e) { /* không phải JSON */ }
    if (!r.ok) throw new Error((j && j.error) || 'máy trả lời lỗi ' + r.status);
    return j;
  }
  async function statusAll() {
    const c = load();
    return Promise.all(c.machines.map(async (m) => { try { const s = await call(m, 'GET', '/fleet/status', undefined, 5000); return Object.assign({}, s, { agentName: s.name, name: m.name, url: m.url, online: true }); } catch (e) { return { name: m.name, url: m.url, online: false, error: e.cause && e.cause.code ? e.cause.code : e.message }; } }));
  }
  async function sendTask(name, prompt, opt) {
    const m = findMachine(name); if (!m) throw new Error('Không có máy "' + name + '".');
    return call(m, 'POST', '/fleet/task', { prompt: String(prompt), project: opt && opt.project ? String(opt.project) : undefined });
  }
  async function jobResult(name, id) { const m = findMachine(name); if (!m) throw new Error('Không có máy "' + name + '".'); return call(m, 'GET', '/fleet/job?id=' + encodeURIComponent(id), undefined, 8000); }
  async function updateMachine(name) { const m = findMachine(name); if (!m) throw new Error('Không có máy "' + name + '".'); return call(m, 'POST', '/fleet/update', {}, 20000); }
  // Chép KHÓA CÔNG KHAI SSH của máy đầu não sang máy con (máy con phải được chủ máy đó bật riêng "cho phép nhận khóa SSH")
  async function installKey(name, pubkey) { const m = findMachine(name); if (!m) throw new Error('Không có máy "' + name + '".'); return call(m, 'POST', '/fleet/sshkey', { key: String(pubkey) }, 15000); }

  // ---------- máy con: dịch vụ nhận yêu cầu ----------
  // deps: { submit(prompt, project) -> jobId, getJob(id) -> {status,result,error}|null, update() -> Promise<string>, stats() -> {...}, version }
  function createAgent(deps) {
    const seen = new Map();                                              // chữ ký đã dùng (chống phát lại)
    async function handle(method, urlStr, headers, rawBody) {
      const c = load().agent; if (!c.enabled || !c.key) return { status: 403, body: { error: 'máy này chưa cho phép điều khiển từ xa' } };
      const u = new URL(urlStr, 'http://x'), ts = Number(headers['x-fleet-ts']), sig = String(headers['x-fleet-sig'] || '');
      if (!ts || Math.abs(now() - ts) > MAX_SKEW_MS) return { status: 401, body: { error: 'giờ lệch quá 60 giây (kiểm tra đồng hồ hai máy)' } };
      if (!safeEq(sig, sign(c.key, method, u.pathname + u.search, ts, rawBody))) return { status: 401, body: { error: 'chữ ký sai (khóa không khớp?)' } };
      for (const [k, t] of seen) if (now() - t > 2 * MAX_SKEW_MS) seen.delete(k);
      if (seen.has(sig)) return { status: 401, body: { error: 'yêu cầu bị gửi lặp' } };
      seen.set(sig, now());
      let body = {}; try { body = rawBody ? JSON.parse(rawBody) : {}; } catch (e) { return { status: 400, body: { error: 'nội dung không phải JSON' } }; }
      try {
        if (method === 'GET' && u.pathname === '/fleet/status') return { status: 200, body: Object.assign({ name: c.name, version: deps.version ? deps.version() : '', time: now() }, deps.stats ? deps.stats() : {}) };
        if (method === 'POST' && u.pathname === '/fleet/task') {
          const p = String(body.prompt || '').trim(); if (p.length < 2 || p.length > 8000) return { status: 400, body: { error: 'việc dài 2–8000 ký tự' } };
          const id = deps.submit('[VIỆC TỪ MÁY ĐẦU NÃO] ' + p, body.project ? String(body.project) : null); log('đội máy: nhận việc #' + id + ' từ máy đầu não'); return { status: 200, body: { jobId: id } };
        }
        if (method === 'GET' && u.pathname === '/fleet/job') { const j = deps.getJob(Number(u.searchParams.get('id'))); return j ? { status: 200, body: j } : { status: 404, body: { error: 'không có việc này' } }; }
        if (method === 'POST' && u.pathname === '/fleet/update') return { status: 200, body: { text: deps.update ? await deps.update() : 'máy này không hỗ trợ cập nhật từ xa' } };
        if (method === 'POST' && u.pathname === '/fleet/sshkey') {
          if (!deps.sshKey) return { status: 400, body: { error: 'máy này không hỗ trợ nhận khóa SSH' } };
          return { status: 200, body: await deps.sshKey(String(body.key || '')) };
        }
        return { status: 404, body: { error: 'không có' } };
      } catch (e) { return { status: 500, body: { error: e.message } }; }
    }
    let server = null;
    function listen() {
      const c = load().agent; if (!c.enabled) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          let raw = '', over = false;
          req.on('data', (d) => { raw += d; if (raw.length > MAX_BODY) { over = true; req.destroy(); } });
          req.on('end', async () => { if (over) return; const r = await handle(req.method, req.url, req.headers, raw); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body)); });
        });
        server.once('error', reject);
        server.listen(c.port, c.host || '0.0.0.0', () => resolve(server.address()));
      });
    }
    return { handle, listen, close: () => new Promise((r) => (server ? server.close(() => r()) : r())) };
  }

  return { load, save, enableAgent, disableAgent, addMachine, removeMachine, findMachine, call, statusAll, sendTask, jobResult, updateMachine, installKey, createAgent, sign };
}

module.exports = { createFleet, sign, NAME_RE };
