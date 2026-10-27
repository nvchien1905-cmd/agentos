'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// THIẾT BỊ TRONG CỬA HÀNG: camera (chụp ảnh từ camera IP: RTSP hoặc địa chỉ chụp ảnh HTTP) và công tắc/ổ cắm thông minh (Shelly, Tasmota, Home Assistant, hoặc địa chỉ tự đặt).
//  /camera <tên> → bot gửi ảnh vừa chụp; /camera <tên> <câu hỏi> → AI nhìn ảnh rồi trả lời ("có khách không?", "cửa đã đóng chưa?").
//  /dien <tên> bat|tat|xem → bật/tắt/xem ổ cắm, đèn, quạt.
// An toàn: chỉ nói chuyện với địa chỉ NỘI BỘ (mạng nhà/Tailscale: 10.x, 172.16–31.x, 192.168.x, 100.64–127.x, 127.x, *.local) — không bao giờ gửi ra Internet công cộng.
// Địa chỉ có thể chứa tài khoản/mật khẩu camera: tệp cấu hình quyền 600, mọi nơi hiển thị đều che phần đó.
const NAME_RE = /^[\p{L}\p{N} _-]{1,30}$/u;
const PLUG_TYPES = ['shelly', 'shelly2', 'tasmota', 'homeassistant', 'url'];

function isLocalHost(h) {
  h = String(h || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h === '::1') return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/); if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}
function checkUrl(u, protocols) {
  let url; try { url = new URL(String(u || '')); } catch (e) { throw new Error('Địa chỉ không đúng.'); }
  if (!protocols.includes(url.protocol)) throw new Error('Địa chỉ phải bắt đầu bằng ' + protocols.map((p) => p + '//').join(' hoặc '));
  if (!isLocalHost(url.hostname)) throw new Error('Chỉ nhận địa chỉ trong mạng nội bộ/Tailscale (' + url.hostname + ' là địa chỉ ngoài Internet).');
  return url;
}
const maskUrl = (u) => { try { const x = new URL(u); if (x.username || x.password) { x.username = '***'; x.password = ''; } return x.toString().replace(/\/$/, ''); } catch (e) { return '(không đọc được)'; } };

function createDevices(o) {
  o = o || {};
  const file = o.file || '/var/lib/agentos/data/devices.json', outDir = o.outDir || '/var/lib/agentos/work/inbox';
  const doFetch = o.fetch || fetch, now = o.now || Date.now, log = o.log || (() => {});
  const ffmpeg = o.ffmpeg || 'ffmpeg';
  const run = o.run || ((bin, args, ms) => new Promise((res) => execFile(bin, args, { timeout: ms || 20000 }, (e, so, se) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(so || ''), err: String(se || ''), missing: e && e.code === 'ENOENT' }))));
  const load = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return { cameras: Array.isArray(j.cameras) ? j.cameras : [], plugs: Array.isArray(j.plugs) ? j.plugs : [] }; } catch (e) { return { cameras: [], plugs: [] }; } };
  const save = (c) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = file + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(c, null, 1), { mode: 0o600 }); fs.renameSync(t, file); };
  const find = (list, name) => list.find((x) => x.name.toLowerCase() === String(name || '').trim().toLowerCase()) || null;
  const nameOk = (n) => { n = String(n || '').trim(); if (!NAME_RE.test(n)) throw new Error('Tên 1–30 ký tự (chữ, số, dấu cách, - _).'); return n; };

  function addCamera(c) {
    const name = nameOk(c.name), url = checkUrl(c.url, ['rtsp:', 'rtsps:', 'http:', 'https:']);
    const all = load(); if (find(all.cameras, name)) throw new Error('Đã có camera tên "' + name + '".');
    all.cameras.push({ name, url: url.toString() }); save(all); return { name, url: maskUrl(url.toString()) };
  }
  function addPlug(p) {
    const name = nameOk(p.name), type = String(p.type || 'url'); if (!PLUG_TYPES.includes(type)) throw new Error('Loại thiết bị: ' + PLUG_TYPES.join(', '));
    const rec = { name, type };
    if (type === 'url') { rec.onUrl = checkUrl(p.onUrl, ['http:', 'https:']).toString(); rec.offUrl = checkUrl(p.offUrl, ['http:', 'https:']).toString(); if (p.statusUrl) rec.statusUrl = checkUrl(p.statusUrl, ['http:', 'https:']).toString(); }
    else { rec.url = checkUrl(p.url, ['http:', 'https:']).origin; if (type === 'homeassistant') { if (!/^[a-z_]+\.[a-z0-9_]+$/.test(String(p.entity || ''))) throw new Error('Mã thiết bị Home Assistant dạng switch.den_phong_khach.'); rec.entity = String(p.entity); if (!p.token) throw new Error('Cần mã truy cập (long-lived token) của Home Assistant.'); rec.token = String(p.token); } if (p.channel !== undefined) rec.channel = Math.max(0, Math.min(8, Number(p.channel) || 0)); }
    const all = load(); if (find(all.plugs, name)) throw new Error('Đã có thiết bị tên "' + name + '".');
    all.plugs.push(rec); save(all); return { name, type };
  }
  const remove = (kind, name) => { const all = load(), k = kind === 'camera' ? 'cameras' : 'plugs', n = all[k].length; all[k] = all[k].filter((x) => x.name.toLowerCase() !== String(name).toLowerCase()); save(all); return all[k].length < n; };
  const list = () => { const a = load(); return { cameras: a.cameras.map((c) => ({ name: c.name, url: maskUrl(c.url) })), plugs: a.plugs.map((p) => ({ name: p.name, type: p.type, url: p.url ? maskUrl(p.url) : maskUrl(p.onUrl) })) }; };

  // Chụp một ảnh: địa chỉ http(s) trả ảnh trực tiếp (kèm tài khoản trong địa chỉ nếu có), còn lại (rtsp...) dùng ffmpeg
  async function snapshot(name) {
    const cam = find(load().cameras, name); if (!cam) throw new Error('Không có camera "' + name + '".');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, 'camera-' + cam.name.replace(/[^\p{L}\p{N}-]+/gu, '_') + '-' + now() + '.jpg');
    const u = new URL(cam.url);
    if (/^https?:$/.test(u.protocol)) {
      const headers = {}; if (u.username) { headers.authorization = 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64'); u.username = ''; u.password = ''; }
      const r = await doFetch(u.toString(), { headers, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('Camera trả lỗi ' + r.status + ' (sai tài khoản/địa chỉ chụp ảnh?)');
      const buf = Buffer.from(await r.arrayBuffer());
      if (!(buf[0] === 0xff && buf[1] === 0xd8) && !(buf[0] === 0x89 && buf[1] === 0x50)) throw new Error('Camera không trả về ảnh JPEG/PNG (kiểm tra địa chỉ chụp ảnh).');
      fs.writeFileSync(out, buf, { mode: 0o640 });
    } else {
      const r = await run(ffmpeg, ['-y', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', cam.url, '-frames:v', '1', '-q:v', '3', out], 25000);
      if (r.missing) throw new Error('Máy chưa cài ffmpeg.');
      if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Không lấy được ảnh từ camera (' + String(r.err || '').split('\n')[0].replace(cam.url, '***').slice(0, 120) + ')');
    }
    return { file: out, camera: cam.name, at: now() };
  }

  async function plug(name, action) {
    const p = find(load().plugs, name); if (!p) throw new Error('Không có thiết bị "' + name + '".');
    const act = String(action || '').toLowerCase(); if (!['on', 'off', 'status'].includes(act)) throw new Error('Hành động: bat, tat hoặc xem.');
    const call = async (url, opt) => { const r = await doFetch(url, Object.assign({ signal: AbortSignal.timeout(8000) }, opt || {})); if (!r.ok) throw new Error('thiết bị trả lỗi ' + r.status); const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; } };
    const ch = p.channel || 0;
    switch (p.type) {
      case 'shelly': { if (act === 'status') { const j = await call(p.url + '/relay/' + ch); return { on: !!j.ison }; } const j = await call(p.url + '/relay/' + ch + '?turn=' + act); return { on: !!j.ison }; }
      case 'shelly2': { if (act === 'status') { const j = await call(p.url + '/rpc/Switch.GetStatus?id=' + ch); return { on: !!j.output }; } await call(p.url + '/rpc/Switch.Set?id=' + ch + '&on=' + (act === 'on')); const j = await call(p.url + '/rpc/Switch.GetStatus?id=' + ch); return { on: !!j.output }; }
      case 'tasmota': { const cmd = act === 'status' ? 'Power' : 'Power ' + act; const j = await call(p.url + '/cm?cmnd=' + encodeURIComponent(cmd)); const v = String(j.POWER || j.POWER1 || '').toUpperCase(); return { on: v === 'ON' }; }
      case 'homeassistant': {
        const H = { authorization: 'Bearer ' + p.token, 'content-type': 'application/json' };
        if (act === 'status') { const j = await call(p.url + '/api/states/' + p.entity, { headers: H }); return { on: j.state === 'on' }; }
        await call(p.url + '/api/services/' + p.entity.split('.')[0] + '/turn_' + act, { method: 'POST', headers: H, body: JSON.stringify({ entity_id: p.entity }) }); return { on: act === 'on' };
      }
      default: { if (act === 'status') { if (!p.statusUrl) return { on: null }; const j = await call(p.statusUrl); return { on: /\bon\b|true|"1"/i.test(typeof j === 'string' ? j : JSON.stringify(j)) }; } await call(act === 'on' ? p.onUrl : p.offUrl); return { on: act === 'on' }; }
    }
  }

  return { addCamera, addPlug, remove, list, snapshot, plug, load, isLocalHost, maskUrl, PLUG_TYPES };
}

module.exports = { createDevices, isLocalHost, checkUrl, maskUrl };
