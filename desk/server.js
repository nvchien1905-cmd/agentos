#!/usr/bin/env node
'use strict';
// Trợ lý màn hình (deskd): dịch vụ chạy bằng root, nghe ở /run/agentos/desk.sock (chỉ nhóm `agentos` nối được), nhận một số LỆNH CỐ ĐỊNH
// để nhìn / điều khiển màn hình thật của người đang ngồi máy: chụp màn hình, mở/đóng ứng dụng, bấm chuột, gõ phím, chép chữ vào bộ nhớ tạm,
// khóa màn hình, khởi động lại / tắt máy. Bộ điều phối (chạy bằng `agentos`, bị systemd gia cố nên KHÔNG dùng được sudo) gọi qua socket này.
// Danh sách ứng dụng và lệnh là cố định ở đây; không có lệnh "chạy bất kỳ" nào.
const net = require('net');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SOCK = process.env.DESK_SOCKET || '/run/agentos/desk.sock';
const OUT_DIR = process.env.DESK_OUT || '/run/agentos';

// Ứng dụng mở được. `match`: nhận diện tiến trình để đóng.
const APPS = {
  zalo: { label: 'Zalo', argv: ['/usr/local/bin/agentos-app', 'zalo'], match: (c) => /agentos-app-zalo/.test(c) },
  kiotviet: { label: 'KiotViet', argv: ['/usr/local/bin/agentos-app', 'kiotviet'], match: (c) => /agentos-app-kiotviet/.test(c) },
  deepseek: { label: 'DeepSeek', argv: ['/usr/local/bin/agentos-app', 'deepseek'], match: (c) => /agentos-app-deepseek/.test(c) },
  claudeweb: { label: 'Claude (web)', argv: ['/usr/local/bin/agentos-app', 'claudeweb'], match: (c) => /agentos-app-claudeweb/.test(c) },
  chatgpt: { label: 'ChatGPT', argv: ['/usr/local/bin/agentos-app', 'chatgpt'], match: (c) => /agentos-app-chatgpt/.test(c) },
  chrome: { label: 'Google Chrome', argv: ['/usr/bin/google-chrome-stable', '--password-store=basic'], match: (c) => /\/opt\/google\/chrome\/chrome/.test(c) && !/--app=|agentos-app-/.test(c) },
  rustdesk: { label: 'RustDesk', argv: ['/usr/bin/rustdesk'], match: (c) => /\/usr\/share\/rustdesk\/rustdesk|^rustdesk|\/usr\/bin\/rustdesk/.test(c) && !/--service/.test(c) },
  claude: { label: 'Claude Code', argv: ['/usr/local/bin/agentos-ai', 'claude'], match: null },
  codex: { label: 'Codex', argv: ['/usr/local/bin/agentos-ai', 'codex'], match: null },
  gemini: { label: 'Gemini', argv: ['/usr/local/bin/agentos-ai', 'gemini'], match: null },
};
const KEY_RE = /^[A-Za-z0-9_+\- ]{1,60}$/;      // tên phím xdotool: Return, ctrl+v, alt+F4...
const MAX_TYPE = 2000;
// Bỏ dấu + chữ thường để so khớp chữ trên màn hình (OCR hay sai dấu): "Gửi" khớp "gui"
const fold = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Đọc bảng TSV của tesseract -> các dòng chữ { words:[{t,l,t,w,h}] } rồi tìm cụm từ (nhiều từ liền nhau trong cùng một dòng)
function ocrFind(tsv, phrase) {
  const want = fold(phrase).split(' ').filter(Boolean); if (!want.length) return [];
  const lines = new Map();
  for (const row of String(tsv).split('\n').slice(1)) {
    const c = row.split('\t'); if (c.length < 12 || c[0] !== '5') continue;
    const txt = c.slice(11).join('\t').trim(); if (!txt) continue;
    const k = c[2] + '.' + c[3] + '.' + c[4];
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k).push({ txt, f: fold(txt), l: Number(c[6]), t: Number(c[7]), w: Number(c[8]), h: Number(c[9]), conf: Number(c[10]) });
  }
  const out = [];
  for (const ws of lines.values()) {
    for (let i = 0; i + want.length <= ws.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) { const f = ws[i + j].f; if (!(want.length === 1 ? f.includes(want[0]) : f === want[j])) { ok = false; break; } }
      if (!ok) continue;
      const seg = ws.slice(i, i + want.length);
      const l = Math.min(...seg.map((w) => w.l)), t = Math.min(...seg.map((w) => w.t)), r = Math.max(...seg.map((w) => w.l + w.w)), b = Math.max(...seg.map((w) => w.t + w.h));
      out.push({ text: seg.map((w) => w.txt).join(' '), x: l, y: t, w: r - l, h: b - t, cx: Math.round((l + r) / 2), cy: Math.round((t + b) / 2), conf: Math.round(seg.reduce((a, w) => a + w.conf, 0) / seg.length) });
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 10);
}
const point = (x, y) => { const a = Math.round(Number(x)), b = Math.round(Number(y)); return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0 && a <= 20000 && b <= 20000 ? { x: a, y: b } : null; };

// Chạy lệnh (không qua shell). Trả { code, out, err }; không bao giờ ném lỗi.
function realRun(cmd, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const fin = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    let child;
    try { child = cp.spawn(cmd, args, { env: opts.env || process.env, stdio: ['pipe', opts.noPipes ? 'ignore' : 'pipe', opts.noPipes ? 'ignore' : 'pipe'] }); } catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* đã thoát */ } fin({ code: -2, out, err: err + ' (quá thời gian)' }); }, opts.timeoutMs || 15000);
    if (child.stdout) child.stdout.on('data', (d) => { out += d; });
    if (child.stderr) child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => fin({ code: -1, out, err: e.message }));
    child.on(opts.noPipes ? 'exit' : 'close', (code) => fin({ code, out, err }));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input === undefined ? undefined : opts.input);
  });
}

// Chạy một lệnh và để nó sống tiếp độc lập (mở ứng dụng).
function realDetach(cmd, args, env) {
  const c = cp.spawn(cmd, args, { env, detached: true, stdio: 'ignore' });
  c.on('error', () => {});
  c.unref();
  return c.pid;
}

function createDesk(o) {
  o = o || {};
  const run = o.run || realRun;
  const detach = o.detach || realDetach;
  const outDir = o.outDir || OUT_DIR;
  const now = o.now || Date.now;

  // Phiên đồ họa đang hoạt động (người đang đăng nhập ở màn hình chính).
  async function session() {
    if (o.session) return o.session();
    const ls = await run('loginctl', ['list-sessions', '--no-legend'], { timeoutMs: 8000 });
    const cands = [];
    for (const line of String(ls.out).split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p.length < 3 || !/^\d+$/.test(p[1])) continue;
      const sh = await run('loginctl', ['show-session', p[0], '-p', 'Type', '-p', 'Active', '-p', 'Display', '-p', 'Name', '-p', 'Class'], { timeoutMs: 8000 });
      const kv = {}; for (const l of String(sh.out).split('\n')) { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim(); }
      // Phiên đồ họa của người dùng (không phải màn hình đăng nhập lightdm). "Active" có thể sai tạm thời khi vừa chuyển màn hình đăng nhập -> chỉ dùng để ưu tiên.
      if (kv.Class !== 'user' || !/^x11$/i.test(kv.Type || '') || !kv.Display) continue;
      cands.push({ id: p[0], uid: p[1], user: p[2], display: kv.Display, active: kv.Active === 'yes' });
    }
    cands.sort((x, y) => Number(y.active) - Number(x.active) || Number(y.id) - Number(x.id));
    if (cands.length) {
      const c = cands[0];
      const pw = await run('getent', ['passwd', c.user], { timeoutMs: 5000 });
      const home = String(pw.out).split(':')[5] || ('/home/' + c.user);
      const auth = path.join(home, '.Xauthority');
      return { id: c.id, uid: c.uid, user: c.user, display: c.display, home, active: c.active, xauth: fs.existsSync(auth) ? auth : '' };
    }
    return null;
  }
  const xenv = (s) => Object.assign({}, process.env, { DISPLAY: s.display }, s.xauth ? { XAUTHORITY: s.xauth } : {});
  const userArgs = (s, argv, extra) => ['-u', s.user, '--', 'env', 'DISPLAY=' + s.display, ...(s.xauth ? ['XAUTHORITY=' + s.xauth] : []),
    'XDG_RUNTIME_DIR=/run/user/' + s.uid, 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/' + s.uid + '/bus', 'HOME=' + s.home, ...(extra || []), ...argv];
  // Biến môi trường của phiên LightDM (light-locker cần XDG_SESSION_PATH...). Lấy từ tiến trình xfce4-session đang chạy của người dùng.
  async function sessionEnv(s) {
    try {
      const p = (await listProcs(s)).find((x) => /(^|\/)xfce4-session( |$)/.test(x.cmd));
      if (!p) return [];
      return fs.readFileSync('/proc/' + p.pid + '/environ', 'utf8').split('\0').filter((l) => /^(XDG_SESSION_PATH|XDG_SESSION_ID|XDG_SEAT|XDG_SEAT_PATH|XDG_VTNR|XDG_SESSION_CLASS|XDG_SESSION_TYPE|XDG_SESSION_DESKTOP|XDG_CURRENT_DESKTOP)=/.test(l));
    } catch (e) { return []; }
  }

  const fail = (msg) => ({ ok: false, error: msg });
  // Màn hình đang khóa / đang ở màn hình đăng nhập: phiên người dùng không "Active", màn hình hiện ra là màn hình đăng nhập nên ảnh chụp ra đen
  // và bấm/gõ phím sẽ rơi vào khoảng không. Báo rõ thay vì làm bừa.
  const LOCKED = 'Màn hình máy đang khóa (hoặc đang ở màn hình đăng nhập). Người ngồi máy cần mở khóa bằng mật khẩu.';
  const live = (s) => s.active !== false;

  async function listProcs(s) {
    const r = await run('ps', ['-u', s.user, '-o', 'pid=,args='], { timeoutMs: 8000 });
    return String(r.out).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(' '); return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) }; });
  }

  const cmds = {
    async who() { const s = await session(); return s ? { ok: true, user: s.user, display: s.display, locked: !live(s) } : fail('Không có ai đang đăng nhập màn hình chính.'); },

    async screenshot() {
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính (máy ở màn hình đăng nhập hoặc chưa ai vào).');
      if (!live(s)) return fail(LOCKED);
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, 'manhinh-' + now() + '.png');
      const r = await run('scrot', ['-o', file], { env: xenv(s), timeoutMs: 15000 });
      if (r.code !== 0 || !fs.existsSync(file)) return fail('Không chụp được màn hình: ' + String(r.err || r.out).trim().slice(0, 200));
      try { fs.chmodSync(file, 0o644); if (o.chownTo) fs.chownSync(file, ...o.chownTo); } catch (e) { /* thử nghiệm không có quyền chown */ }
      return { ok: true, file };
    },

    async windows() {
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      const r = await run('xdotool', ['search', '--onlyvisible', '--name', '.'], { env: xenv(s) });
      const names = [];
      for (const id of String(r.out).split('\n').filter((x) => /^\d+$/.test(x)).slice(0, 40)) {
        const n = await run('xdotool', ['getwindowname', id], { env: xenv(s), timeoutMs: 4000 });
        const t = String(n.out).trim(); if (t) names.push(t);
      }
      return { ok: true, windows: [...new Set(names)] };
    },

    async open(req) {
      const app = APPS[String(req.app || '').toLowerCase()];
      if (!app) return fail('Ứng dụng không có trong danh sách. Dùng: ' + Object.keys(APPS).join(', '));
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      const pid = detach('runuser', userArgs(s, app.argv), process.env);
      return { ok: true, app: app.label, pid };
    },

    async close(req) {
      const key = String(req.app || '').toLowerCase(); const app = APPS[key];
      if (!app) return fail('Ứng dụng không có trong danh sách. Dùng: ' + Object.keys(APPS).join(', '));
      if (!app.match) return fail(app.label + ' chạy trong cửa sổ dòng lệnh, hãy tự đóng cửa sổ đó.');
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      const hit = (await listProcs(s)).filter((p) => app.match(p.cmd));
      if (!hit.length) return { ok: true, app: app.label, closed: 0 };
      await run('kill', ['-TERM', ...hit.map((p) => String(p.pid))], { timeoutMs: 8000 });
      return { ok: true, app: app.label, closed: hit.length };
    },

    async click(req) {
      const x = Math.round(Number(req.x)), y = Math.round(Number(req.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20000 || y > 20000) return fail('Toạ độ không hợp lệ');
      const b = String(req.button || 1); if (!/^[1-5]$/.test(b)) return fail('Nút chuột không hợp lệ (1-5)');
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      if (!live(s)) return fail(LOCKED);
      const args = ['mousemove', String(x), String(y), 'click'].concat(req.double ? ['--repeat', '2', '--delay', '80'] : [], [b]);
      const r = await run('xdotool', args, { env: xenv(s) });
      return r.code === 0 ? { ok: true } : fail(String(r.err).trim().slice(0, 200));
    },

    // Kích thước màn hình, cửa sổ đang chọn, vị trí chuột: để biết toạ độ trong ảnh chụp khớp với màn hình thật
    async info() {
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      if (!live(s)) return fail(LOCKED);
      const g = await run('xdotool', ['getdisplaygeometry'], { env: xenv(s), timeoutMs: 5000 });
      const w = await run('xdotool', ['getactivewindow', 'getwindowname'], { env: xenv(s), timeoutMs: 5000 });
      const m = String(g.out).trim().split(/\s+/).map(Number);
      return { ok: true, width: m[0] || null, height: m[1] || null, active: String(w.out).trim() || null };
    },

    // Đưa cửa sổ có tên chứa <name> lên trước (nhận bàn phím)
    async focus(req) {
      const name = String(req.name || '').trim();
      if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) return fail('Tên cửa sổ phải dài 1-80 ký tự');
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      if (!live(s)) return fail(LOCKED);
      const f = await run('xdotool', ['search', '--onlyvisible', '--name', name], { env: xenv(s), timeoutMs: 8000 });
      const id = String(f.out).split('\n').filter((x) => /^\d+$/.test(x))[0];
      if (!id) return fail('Không thấy cửa sổ nào có tên chứa "' + name + '". Gõ /cuaso để xem danh sách.');
      const a = await run('xdotool', ['windowactivate', '--sync', id], { env: xenv(s), timeoutMs: 8000 });
      return a.code === 0 ? { ok: true } : fail('Không đưa được cửa sổ lên trước: ' + String(a.err).trim().slice(0, 150));
    },

    // Tìm chữ trên màn hình (OCR tesseract) -> toạ độ để bấm đúng nút/ô theo tên, không phải đoán toạ độ từ ảnh
    async findtext(req) {
      const text = String(req.text || '').trim();
      if (!text || text.length > 80) return fail('Chữ cần tìm phải dài 1-80 ký tự');
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      if (!live(s)) return fail(LOCKED);
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, 'ocr-' + now() + '.png');
      const sc = await run('scrot', ['-o', file], { env: xenv(s), timeoutMs: 15000 });
      if (sc.code !== 0) return fail('Không chụp được màn hình: ' + String(sc.err || sc.out).trim().slice(0, 150));
      const oc = await run('tesseract', [file, 'stdout', '-l', 'vie+eng', '--psm', '11', 'tsv'], { timeoutMs: 60000 });
      try { fs.rmSync(file, { force: true }); } catch (e) { /* bỏ qua */ }
      if (oc.code !== 0) return fail('Không đọc được chữ trên màn hình (tesseract): ' + String(oc.err).trim().slice(0, 150));
      return { ok: true, matches: ocrFind(oc.out, text) };
    },

    // Bấm vào chữ tìm thấy (lần thứ n, mặc định 1)
    async clicktext(req) {
      const r = await cmds.findtext(req); if (!r.ok) return r;
      if (!r.matches.length) return fail('Không thấy chữ "' + req.text + '" trên màn hình.');
      const n = Math.max(1, Math.round(Number(req.nth) || 1));
      const m = r.matches[n - 1]; if (!m) return fail('Chỉ thấy ' + r.matches.length + ' chỗ có chữ "' + req.text + '", không có chỗ thứ ' + n + '.');
      const c = await cmds.click({ x: m.cx, y: m.cy, button: req.button || 1, double: !!req.double });
      return c.ok ? { ok: true, x: m.cx, y: m.cy, text: m.text, found: r.matches.length } : c;
    },

    // Đọc chữ đang ở bộ nhớ tạm của màn hình chính (để chuyển sang điện thoại)
    async clipget() {
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      const r = await run('xclip', ['-selection', 'clipboard', '-o'], { env: xenv(s), timeoutMs: 5000 });
      if (r.code !== 0) return { ok: true, text: '' };                      // bộ nhớ tạm trống cũng trả về mã lỗi
      return { ok: true, text: String(r.out).slice(0, 20000) };
    },

    // Mở khóa màn hình qua systemd-logind (không cần mật khẩu, deskd chạy bằng root); phụ thuộc bộ khóa có nghe tín hiệu Unlock.
    async unlock() {
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính (máy ở màn hình đăng nhập: cần nhập mật khẩu trực tiếp).');
      if (live(s)) return { ok: true, already: true };
      const r = await run('loginctl', ['unlock-sessions'], { timeoutMs: 8000 });
      if (r.code !== 0) return fail('Không mở khóa được: ' + String(r.err).trim().slice(0, 150));
      await new Promise((x) => setTimeout(x, 1200));
      const s2 = await session();
      return s2 && live(s2) ? { ok: true } : fail('Đã gửi lệnh mở khóa nhưng màn hình vẫn khóa (bộ khóa không nghe lệnh). Nhập mật khẩu trực tiếp trên máy.');
    },

    // Rê chuột tới một điểm (không bấm): mở menu rê chuột, xem gợi ý...
    async move(req) {
      const p = point(req.x, req.y); if (!p) return fail('Toạ độ không hợp lệ');
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      if (!live(s)) return fail(LOCKED);
      const r = await run('xdotool', ['mousemove', String(p.x), String(p.y)], { env: xenv(s) });
      return r.code === 0 ? { ok: true } : fail(String(r.err).trim().slice(0, 200));
    },

    // Kéo thả: nhấn giữ nút chuột ở (x,y), kéo tới (x2,y2) rồi thả.
    async drag(req) {
      const a = point(req.x, req.y), b = point(req.x2, req.y2); if (!a || !b) return fail('Toạ độ không hợp lệ');
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      if (!live(s)) return fail(LOCKED);
      const args = ['mousemove', String(a.x), String(a.y), 'mousedown', '1', 'sleep', '0.15', 'mousemove_relative', '--', '1', '1',
        'sleep', '0.1', 'mousemove', String(b.x), String(b.y), 'sleep', '0.15', 'mouseup', '1'];
      const r = await run('xdotool', args, { env: xenv(s), timeoutMs: 20000 });
      return r.code === 0 ? { ok: true } : fail(String(r.err).trim().slice(0, 200));
    },

    // Cuộn chuột: hướng up|down|left|right, số nấc 1-50; có x,y thì rê chuột tới đó trước.
    async scroll(req) {
      const dir = String(req.dir || 'down').toLowerCase();
      const btn = { up: '4', down: '5', left: '6', right: '7' }[dir]; if (!btn) return fail('Hướng cuộn: up, down, left, right');
      const n = Math.round(Number(req.amount === undefined ? 5 : req.amount)); if (!Number.isFinite(n) || n < 1 || n > 50) return fail('Số nấc cuộn phải từ 1 đến 50');
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      if (!live(s)) return fail(LOCKED);
      const args = [];
      if (req.x !== undefined && req.y !== undefined) { const p = point(req.x, req.y); if (!p) return fail('Toạ độ không hợp lệ'); args.push('mousemove', String(p.x), String(p.y)); }
      args.push('click', '--repeat', String(n), '--delay', '30', btn);
      const r = await run('xdotool', args, { env: xenv(s) });
      return r.code === 0 ? { ok: true } : fail(String(r.err).trim().slice(0, 200));
    },

    async type(req) {
      const text = String(req.text === undefined ? '' : req.text);
      if (!text || text.length > MAX_TYPE) return fail('Chữ cần gõ phải dài 1-' + MAX_TYPE + ' ký tự');
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      if (!live(s)) return fail(LOCKED);
      const r = await run('xdotool', ['type', '--delay', '12', '--', text], { env: xenv(s), timeoutMs: 60000 });
      return r.code === 0 ? { ok: true } : fail(String(r.err).trim().slice(0, 200));
    },

    async key(req) {
      const k = String(req.key || '');
      if (!KEY_RE.test(k)) return fail('Tên phím không hợp lệ (VD: Return, ctrl+v, alt+F4)');
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      if (!live(s)) return fail(LOCKED);
      const r = await run('xdotool', ['key', '--', ...k.split(' ').filter(Boolean)], { env: xenv(s) });
      return r.code === 0 ? { ok: true } : fail(String(r.err).trim().slice(0, 200));
    },

    // Chép chữ vào bộ nhớ tạm của màn hình chính (để người dùng bấm Ctrl+V), VD chuẩn bị câu lệnh cho DeepSeek web.
    async clip(req) {
      const text = String(req.text === undefined ? '' : req.text);
      if (!text || text.length > 20000) return fail('Chữ cần chép phải dài 1-20000 ký tự');
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      // xclip ở lại nền giữ nội dung bộ nhớ tạm và giữ ống đầu ra mở: không chờ ống đóng (noPipes), chỉ chờ tiến trình cha thoát
      const r = await run('xclip', ['-selection', 'clipboard', '-i'], { env: xenv(s), input: text, timeoutMs: 8000, noPipes: true });
      return r.code === 0 ? { ok: true } : fail('Không chép được vào bộ nhớ tạm: ' + String(r.err).trim().slice(0, 200));
    },

    async lock() {
      const s = await session(); if (!s) return fail('Không có ai đang đăng nhập màn hình chính.');
      if (!live(s)) return { ok: true, already: true };
      // Máy này mặc định KHÔNG tự khóa khi nhàn rỗi (xem lệnh nolock); khóa theo yêu cầu bằng bộ khóa light-locker đang chạy sẵn trong phiên
      // (light-locker bắt buộc chạy BÊN TRONG phiên đăng nhập, không khởi động từ dịch vụ nền được: "session_id is not set").
      const r = await run('runuser', userArgs(s, ['light-locker-command', '-l'], await sessionEnv(s)), { timeoutMs: 8000 });
      if (r.code === 0 && !/ServiceUnknown|error message from the locker/i.test(String(r.out) + String(r.err))) return { ok: true };
      return fail('Không khóa được màn hình (bộ khóa chưa chạy trong phiên). Hãy đăng xuất rồi đăng nhập lại máy một lần.');
    },

    // Giữ cho màn hình KHÔNG tự khóa/tối vì nhàn rỗi (trình bảo vệ màn hình của X làm light-locker khóa, khi đó /manhinh chụp ra ảnh đen).
    // deskd gọi lệnh này định kỳ vì xfce4-power-manager có thể đặt lại.
    async nolock() {
      const s = await session(); if (!s || !live(s)) return fail('Không có phiên đang mở.');
      await run('xset', ['s', 'off'], { env: xenv(s), timeoutMs: 5000 });
      await run('xset', ['s', 'noblank'], { env: xenv(s), timeoutMs: 5000 });
      return { ok: true };
    },

    // Khởi động lại / tắt máy sau vài giây để kịp trả lời Telegram.
    async reboot() { await run('systemd-run', ['--on-active=6', '--unit=agentos-desk-power', 'systemctl', 'reboot']); return { ok: true, after: 6 }; },
    async poweroff() { await run('systemd-run', ['--on-active=6', '--unit=agentos-desk-power', 'systemctl', 'poweroff']); return { ok: true, after: 6 }; },
  };

  return {
    apps: () => Object.keys(APPS),
    async handle(req) {
      if (!req || typeof req !== 'object' || typeof req.cmd !== 'string' || !Object.prototype.hasOwnProperty.call(cmds, req.cmd)) return fail('Lệnh không có');
      try { return await cmds[req.cmd](req); } catch (e) { return fail('Lỗi: ' + e.message); }
    },
  };
}

// Máy chủ socket: mỗi dòng là một yêu cầu JSON, trả một dòng JSON.
function serve(desk, sock, group) {
  try { fs.rmSync(sock, { force: true }); } catch (e) { /* chưa có */ }
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  const srv = net.createServer((c) => {
    let buf = '';
    c.setEncoding('utf8'); c.setTimeout(120000, () => c.destroy());
    c.on('error', () => {});
    c.on('data', async (d) => {
      buf += d; if (buf.length > 100000) return c.destroy();
      const i = buf.indexOf('\n'); if (i < 0) return;
      let req; try { req = JSON.parse(buf.slice(0, i)); } catch (e) { c.end(JSON.stringify({ ok: false, error: 'JSON hỏng' }) + '\n'); return; }
      buf = '';
      c.end(JSON.stringify(await desk.handle(req)) + '\n');
    });
  });
  srv.listen(sock, () => {
    try { fs.chmodSync(sock, 0o660); } catch (e) { /* */ }
    if (group) { try { cp.execFileSync('chgrp', [group, sock]); } catch (e) { /* nhóm chưa có */ } }
  });
  return srv;
}

if (require.main === module) {
  const desk = createDesk({ chownTo: (() => { try { const id = Number(cp.execFileSync('id', ['-u', 'agentos']).toString()); const g = Number(cp.execFileSync('id', ['-g', 'agentos']).toString()); return [id, g]; } catch (e) { return null; } })() });
  const dir = path.dirname(SOCK);
  fs.mkdirSync(dir, { recursive: true });
  try { cp.execFileSync('chgrp', ['agentos', dir]); fs.chmodSync(dir, 0o750); } catch (e) { /* */ }
  serve(desk, SOCK, 'agentos');
  // Không để màn hình tự khóa khi nhàn rỗi (mỗi phút, tốn rất ít)
  setInterval(() => { desk.handle({ cmd: 'nolock' }).catch(() => {}); }, 60000).unref();
  setTimeout(() => { desk.handle({ cmd: 'nolock' }).catch(() => {}); }, 5000).unref();
  // Dọn ảnh chụp cũ (>10 phút)
  setInterval(() => { try { for (const f of fs.readdirSync(dir)) if (/^manhinh-\d+\.png$/.test(f) && Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 600000) fs.rmSync(path.join(dir, f), { force: true }); } catch (e) { /* */ } }, 120000).unref();
  console.log('deskd nghe ở ' + SOCK);
}

module.exports = { createDesk, serve, APPS, ocrFind, fold };
