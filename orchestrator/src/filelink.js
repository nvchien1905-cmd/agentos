'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// LINK TẠM để chuyển tệp LỚN (tới 5 GB) giữa điện thoại và máy, vì Telegram giới hạn bot (tải xuống 20 MB, gửi đi 50 MB).
//   downloadLink(đường dẫn)  -> http://<địa chỉ>:<cổng>/d/<mã>      điện thoại mở link để tải tệp (hỗ trợ tải tiếp khi đứt mạng)
//   uploadLink(chat)         -> http://<địa chỉ>:<cổng>/u/<mã>      trang chọn tệp và gửi lên, có thanh tiến độ; tệp lưu vào thư mục inbox
// An toàn: mã ngẫu nhiên 192 bit, hết hạn sau ttlMs (mặc định 1 giờ), cổng chỉ mở khi còn link và đóng khi hết;
// chỉ dùng được khi điện thoại ở cùng mạng nhà hoặc đã cài Tailscale (ưu tiên địa chỉ Tailscale vì được mã hóa).
const MAX_UP = 5 * 1024 * 1024 * 1024;
const clean = (n) => String(n || 'tep').replace(/[\\/\u0000-\u001f"<>|?*:]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'tep';
const fmtSize = (b) => (b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB');

const PAGE = (token, minutes) => `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gửi tệp lên máy</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:24px auto;padding:0 16px}button{font-size:18px;padding:12px 20px;margin-top:12px}progress{width:100%;height:18px}#log div{margin:6px 0;word-break:break-all}</style></head>
<body><h2>📤 Gửi tệp lên máy AgentOS</h2><p>Chọn một hoặc nhiều tệp (mỗi tệp tối đa 5 GB). Link hết hạn sau ${minutes} phút.</p>
<input type="file" id="f" multiple><br><button id="b">Gửi lên</button><div id="log"></div>
<script>
var T=${JSON.stringify(token)};
document.getElementById('b').onclick=function(){var fs=document.getElementById('f').files;if(!fs.length){alert('Chưa chọn tệp');return;}
for(var i=0;i<fs.length;i++)(function(f){var d=document.createElement('div');d.innerHTML='<b></b><br><progress max="100" value="0"></progress> <span></span>';d.querySelector('b').textContent=f.name;document.getElementById('log').appendChild(d);
var x=new XMLHttpRequest();x.open('PUT','/u/'+T+'/'+encodeURIComponent(f.name));
x.upload.onprogress=function(e){if(e.lengthComputable){d.querySelector('progress').value=e.loaded*100/e.total;d.querySelector('span').textContent=Math.round(e.loaded*100/e.total)+'%';}};
x.onload=function(){d.querySelector('span').textContent=x.status==200?'✅ Xong':'❌ Lỗi '+x.status+' '+x.responseText;};
x.onerror=function(){d.querySelector('span').textContent='❌ Mất kết nối';};x.send(f);})(fs[i]);};
</script></body></html>`;

function createLinks(o) {
  o = o || {};
  const log = o.log || (() => {});
  const dir = o.dir || path.join(os.tmpdir(), 'agentos-inbox');
  const port = o.port === undefined ? 8090 : o.port;
  const ttlMs = o.ttlMs || 3600 * 1000;
  const now = o.now || Date.now;
  const hostFn = o.host || defaultHost(o.tailscale);
  const onUpload = o.onUpload || (() => {});
  const tokens = new Map();
  let srv = null, sweep = null;

  function defaultHost(ts) {
    return async () => {
      try { const i = ts && await ts.info(); if (i && i.state === 'Running' && i.ips && i.ips[0]) return { host: i.ips[0], via: 'Tailscale' }; } catch (e) { /* dùng mạng nhà */ }
      for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return { host: a.address, via: 'mạng nhà' };
      return null;
    };
  }

  const alive = () => { for (const [k, v] of tokens) if (v.expires <= now()) tokens.delete(k); return tokens.size; };

  function handler(req, res) {
    const fail = (code, msg) => { if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(msg); };
    alive();
    const m = String(req.url || '').split('?')[0].match(/^\/([du])\/([0-9a-f]{48})(?:\/(.*))?$/);
    const t = m && tokens.get(m[2]);
    if (!m || !t || t.type !== m[1]) return fail(404, 'Link không có hoặc đã hết hạn.');

    if (t.type === 'd' && (req.method === 'GET' || req.method === 'HEAD')) {
      let st; try { st = fs.statSync(t.path); } catch (e) { return fail(404, 'Tệp không còn.'); }
      let start = 0, end = st.size - 1, code = 200;
      const rg = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
      if (rg && (rg[1] || rg[2])) {
        if (rg[1]) { start = Number(rg[1]); if (rg[2]) end = Math.min(end, Number(rg[2])); } else { start = Math.max(0, st.size - Number(rg[2])); }
        if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': 'bytes */' + st.size }); return res.end(); }
        code = 206;
      }
      const h = { 'content-type': 'application/octet-stream', 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(t.name) };
      if (code === 206) h['content-range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      res.writeHead(code, h);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(t.path, { start, end }).on('error', () => res.destroy()).pipe(res);
      return;
    }
    if (t.type === 'u' && req.method === 'GET' && !m[3]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE(m[2], Math.max(1, Math.round((t.expires - now()) / 60000))));
    }
    if (t.type === 'u' && req.method === 'PUT' && m[3]) {
      let name; try { name = clean(decodeURIComponent(m[3])); } catch (e) { return fail(400, 'Tên tệp hỏng.'); }
      const len = Number(req.headers['content-length'] || 0);
      if (len > MAX_UP) return fail(413, 'Tệp quá 5 GB.');
      try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { return fail(500, 'Không tạo được thư mục nhận tệp.'); }
      const stamp = new Date(now() + 7 * 3600 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const dest = path.join(dir, 'gui-' + stamp + '-' + name);
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp, { mode: 0o600 });
      let got = 0, dead = false;
      const abort = (code, msg) => { if (dead) return; dead = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); fail(code, msg); };
      req.on('data', (d) => { got += d.length; if (got > MAX_UP) { abort(413, 'Tệp quá 5 GB.'); req.destroy(); } });
      req.on('aborted', () => abort(499, 'Đứt kết nối.'));
      req.on('error', () => abort(400, 'Lỗi nhận.'));
      out.on('error', (e) => abort(500, 'Không ghi được tệp: ' + e.message));
      out.on('finish', () => {
        if (dead) return;
        try { fs.renameSync(tmp, dest); } catch (e) { return abort(500, 'Không lưu được tệp.'); }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('ok');
        log('đã nhận tệp ' + name + ' (' + fmtSize(got) + ') qua link tạm');
        Promise.resolve(onUpload({ chat: t.chat, path: dest, name, size: got })).catch(() => {});
      });
      req.pipe(out);
      return;
    }
    fail(405, 'Không hỗ trợ.');
  }

  function ensureServer() {
    if (srv) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = http.createServer(handler);
      s.requestTimeout = 0; s.headersTimeout = 30000; s.keepAliveTimeout = 5000;
      s.once('error', (e) => { srv = null; reject(e); });
      s.listen(port, o.bind || '0.0.0.0', () => { srv = s; sweep = setInterval(() => { if (!alive()) stop(); }, 30000); if (sweep.unref) sweep.unref(); resolve(); });
    });
  }
  function stop() { if (sweep) clearInterval(sweep); sweep = null; if (srv) { const s = srv; srv = null; s.close(); if (s.closeIdleConnections) s.closeIdleConnections(); } }
  const portOf = () => (srv && srv.address() ? srv.address().port : port);

  async function make(entry, kind) {
    const h = await hostFn();
    if (!h) return { ok: false, error: 'Máy không có địa chỉ mạng nào. Kiểm tra dây mạng/wifi.' };
    try { await ensureServer(); } catch (e) { return { ok: false, error: 'Không mở được cổng ' + port + ': ' + e.message }; }
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, Object.assign({ type: kind, expires: now() + ttlMs }, entry));
    return { ok: true, url: 'http://' + h.host + ':' + portOf() + '/' + kind + '/' + token, via: h.via, minutes: Math.round(ttlMs / 60000) };
  }

  const how = (via) => via === 'Tailscale' ? 'Mở được từ bất cứ đâu khi điện thoại đã bật app Tailscale cùng tài khoản.' : 'Chỉ mở được khi điện thoại cùng wifi/mạng nhà với máy (muốn từ xa: /tailscale ketnoi).';

  return {
    async downloadLink(file) {
      let st; try { st = fs.statSync(file); } catch (e) { return { text: '⚠️ Không thấy tệp: ' + file }; }
      if (!st.isFile()) return { text: '⚠️ Không phải tệp thường: ' + file };
      const r = await make({ path: file, name: path.basename(file) }, 'd');
      if (!r.ok) return { text: '⚠️ ' + r.error };
      return { text: '📎 ' + path.basename(file) + ' (' + fmtSize(st.size) + ') quá lớn để gửi qua Telegram.\nTải về bằng link (hết hạn sau ' + r.minutes + ' phút, tải tiếp được khi đứt mạng):\n' + r.url + '\n' + how(r.via) };
    },
    async uploadLink(chat) {
      const r = await make({ chat }, 'u');
      if (!r.ok) return '⚠️ ' + r.error;
      return '📤 Mở link này trên điện thoại, chọn tệp (mỗi tệp tới 5 GB) rồi bấm Gửi lên:\n' + r.url + '\nHết hạn sau ' + r.minutes + ' phút; dùng được nhiều lần trong thời gian đó. Nhận xong bot nhắn lại đường dẫn tệp trên máy.\n' + how(r.via);
    },
    active: alive,
    stop,
    port: portOf,
  };
}

module.exports = { createLinks, fmtSize, MAX_UP };
