'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const cp = require('child_process');

// CHROME DÙNG CHUNG CHO AI. Bộ điều phối giữ MỘT Chrome sống lâu cho mỗi "danh tính":
//   "admin"        = Chrome của chủ máy (hồ sơ browser-profile, đã đăng nhập sẵn các trang chủ máy cần) — mọi cuộc trò chuyện của chủ máy dùng chung Chrome này
//   "id-<chat>"    = Chrome riêng của từng ID Telegram thường (hồ sơ riêng, KHÔNG thấy đăng nhập của chủ máy)
// Mỗi AI nối vào Chrome của danh tính mình qua CDP (cổng 127.0.0.1 ngẫu nhiên) bằng browser-mcp.js và chỉ điều khiển TAB do chính nó mở, nên nhiều cuộc trò chuyện chạy song song mà không đè lên nhau.
// Chrome chạy ngoài hộp cô lập của AI (do bộ điều phối khởi động), nên AI không đọc được tệp hồ sơ (cookie) — chỉ điều khiển qua CDP.
const probeDefault = (port, timeoutMs) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs || 1500 }, (r) => { r.resume(); resolve(r.statusCode === 200); });
  req.on('timeout', () => { req.destroy(); resolve(false); }); req.on('error', () => resolve(false));
});
const listDefault = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 2000 }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve([]); } }); });
  req.on('timeout', () => { req.destroy(); resolve([]); }); req.on('error', () => resolve([]));
});
const freePortDefault = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function createBrowserHost(o) {
  o = o || {};
  const chromeBin = o.chromeBin || '/usr/bin/google-chrome-stable', display = o.display || ':99';
  const log = o.log || (() => {}), now = o.now || Date.now, stateFile = o.stateFile || '';
  const probe = o.probe || probeDefault, listPages = o.listPages || listDefault, freePort = o.freePort || freePortDefault;
  const spawn = o.spawn || ((cmd, args, opts) => { const c = cp.spawn(cmd, args, opts); c.on('error', () => {}); c.unref(); return c; });
  const kill = o.kill || ((pid, sig) => { try { process.kill(-pid, sig); } catch (e) { try { process.kill(pid, sig); } catch (e2) { /* đã thoát */ } } });
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const waitMs = o.waitMs === undefined ? 20000 : o.waitMs;
  const hosts = new Map();                                              // key -> { key, port, profile, pid, lastUse, starting }

  const loadState = () => { try { const j = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } };
  const saveState = () => {
    if (!stateFile) return;
    const out = {}; for (const [k, h] of hosts) out[k] = { port: h.port, profile: h.profile, pid: h.pid || 0 };
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(out, null, 1), { mode: 0o600 }); } catch (e) { /* bỏ qua */ }
  };
  const endpoint = (port) => 'http://127.0.0.1:' + port;

  async function launch(h, noSandbox) {
    fs.mkdirSync(h.profile, { recursive: true, mode: 0o700 });
    const args = ['--user-data-dir=' + h.profile, '--remote-debugging-port=' + h.port, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'];
    if (noSandbox) args.push('--no-sandbox');
    if (o.headless) args.push('--headless=new');                          // chỉ dùng khi thử nghiệm (không có màn hình)
    args.push('about:blank');
    const child = spawn(chromeBin, args, { env: Object.assign({}, process.env, { DISPLAY: display }), detached: true, stdio: 'ignore' });
    h.pid = child && child.pid;
    for (let t = 0; t < waitMs; t += 250) { if (await probe(h.port)) return true; await sleep(250); }
    if (h.pid) kill(h.pid, 'SIGKILL');
    return false;
  }
  async function start(h) {
    log('trình duyệt dùng chung "' + h.key + '": khởi động Chrome (cổng ' + h.port + ')');
    if (await launch(h, !!o.noSandbox)) return true;
    if (!o.noSandbox && await launch(h, true)) { log('trình duyệt dùng chung "' + h.key + '": phải chạy với --no-sandbox'); return true; }
    return false;
  }

  // Bảo đảm Chrome của danh tính `key` đang chạy; trả địa chỉ CDP (http://127.0.0.1:cổng). Hai việc đòi cùng lúc thì dùng chung một lần khởi động.
  const inflight = new Map();                                          // key -> Promise: hai việc cùng xin Chrome một lúc thì chỉ khởi động MỘT lần
  function ensure(key, profile) {
    if (inflight.has(key)) return inflight.get(key);
    const p = ensureOnce(key, profile).finally(() => inflight.delete(key));
    inflight.set(key, p); return p;
  }
  async function ensureOnce(key, profile) {
    let h = hosts.get(key);
    if (!h) { const st = loadState()[key]; if (st && st.port && st.profile === profile) { h = { key, port: st.port, profile, pid: st.pid, lastUse: now() }; hosts.set(key, h); } }
    if (h && h.starting) { await h.starting; return endpoint(h.port); }
    if (h && await probe(h.port)) { h.lastUse = now(); return endpoint(h.port); }
    const port = await freePort();
    h = { key, port, profile, pid: 0, lastUse: now(), starting: null };
    hosts.set(key, h);
    h.starting = start(h).then((ok) => { h.starting = null; if (!ok) { hosts.delete(key); throw new Error('Không mở được Chrome dùng chung cho AI (hồ sơ ' + profile + '). Nếu trình duyệt của bot đang mở để đăng nhập thì đóng lại (/dong webbot) rồi thử lại.'); } saveState(); });
    await h.starting;
    return endpoint(h.port);
  }

  // Dừng Chrome của một danh tính (vd để chủ máy mở cửa sổ đăng nhập cùng hồ sơ) — lần sau ensure() tự mở lại
  async function stop(key) {
    const h = hosts.get(key) || (() => { const st = loadState()[key]; return st ? { key, port: st.port, pid: st.pid } : null; })();
    if (!h) return false;
    if (h.starting) { try { await h.starting; } catch (e) { /* bỏ qua */ } }
    if (h.pid) kill(h.pid, 'SIGTERM');
    for (let t = 0; t < 4000 && await probe(h.port, 500); t += 250) await sleep(250);
    if (h.pid && await probe(h.port, 500)) kill(h.pid, 'SIGKILL');
    hosts.delete(key); saveState();
    return true;
  }
  async function stopAll() { let n = 0; for (const k of [...hosts.keys()]) if (await stop(k)) n++; return n; }

  // Dọn Chrome của ID thường nhàn rỗi (không còn tab nào ngoài about:blank và quá hạn); Chrome của chủ máy giữ nguyên. Trả số Chrome đã dừng.
  async function reap(maxIdleMs) {
    let n = 0;
    for (const [key, h] of [...hosts]) {
      if (key === 'admin' || h.starting || now() - h.lastUse < maxIdleMs) continue;
      const pages = (await listPages(h.port)).filter((t) => t.type === 'page' && t.url !== 'about:blank');
      if (pages.length) { h.lastUse = now(); continue; }
      if (await stop(key)) n++;
    }
    return n;
  }
  const status = () => [...hosts.values()].map((h) => ({ key: h.key, port: h.port, profile: h.profile, pid: h.pid, idleMs: now() - h.lastUse, starting: !!h.starting }));

  return { ensure, stop, stopAll, reap, status, endpoint };
}

module.exports = { createBrowserHost };
