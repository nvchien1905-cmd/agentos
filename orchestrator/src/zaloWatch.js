'use strict';
const { inHours } = require('./zalo');
const { noAccent } = require('./kiotviet');

// TỰ CANH TIN ZALO MỚI (không tốn token). Mỗi ~2 phút (lệch ngẫu nhiên) nối vào Chrome của bot (CDP, cùng Chrome đã đăng nhập Zalo Web), ĐỌC danh sách hội thoại bằng một đoạn mã nhỏ
// chạy trong trang (đếm huy hiệu đỏ "chưa đọc") — KHÔNG gửi gì, KHÔNG bấm vào hội thoại. Chỉ khi có tin MỚI mới báo chủ máy và (nếu chế độ "ai") nhờ AI mở đọc + soạn trả lời.
// Hàng rào: chỉ chạy khi trợ lý Zalo BẬT + canh BẬT + trong khung giờ trực; lần đầu chỉ ghi nhận tin đang chờ (không trả lời tin cũ); mỗi tin mới chỉ xử lý 1 lần (so "chữ ký" số tin + dòng xem trước);
// tối đa watchMaxAi việc AI mỗi giờ; hội thoại trong danh sách chặn bị bỏ qua; việc AI chạy xong mới canh tiếp; Zalo Web chỉ cho MỘT tab nên đóng tab canh trước khi AI vào.
const ZALO_URL = 'https://chat.zalo.me/';
const firstLine = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 160);
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Chạy TRONG trang Zalo Web (page.evaluate) — phải tự đủ, không dùng biến ngoài. Trả { href, title, titleCount, loggedOut, listFound, items:[{name,count,preview}] }.
// Zalo hay đổi giao diện nên không dựa vào tên class cố định: tìm các dòng hội thoại bằng vài cách, rồi tìm "huy hiệu" = phần tử nhỏ nền ĐỎ chứa số (hoặc chấm đỏ trống).
function extractUnread() {
  const out = { href: location.href, title: document.title || '', titleCount: 0, loggedOut: false, listFound: false, items: [] };
  const tm = /^\s*\((\d{1,3})\+?\)/.exec(out.title); if (tm) out.titleCount = Number(tm[1]);
  const text = (e) => String(e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const box = (e) => e.getBoundingClientRect();
  const shown = (e) => { const r = box(e); return r.width > 0 && r.height > 0; };
  const red = (e) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(getComputedStyle(e).backgroundColor || '');
    if (!m) return false; if (m[4] !== undefined && Number(m[4]) < 0.5) return false;
    const r = +m[1], g = +m[2], b = +m[3]; return r >= 180 && g <= 120 && b <= 130 && r - g >= 90;
  };
  const sels = ['[id^="friend-item-"]', '[class*="conv-item"]', '#conversationListId > *', '[role="listitem"]', '[data-id^="div_"]'];
  let rows = [];
  for (const s of sels) {
    let list = []; try { list = [].slice.call(document.querySelectorAll(s)).filter(shown); } catch (e) { list = []; }
    list = list.filter((e) => !list.some((o) => o !== e && o.contains(e)));     // chỉ lấy phần tử ngoài cùng (bỏ các phần con cùng tên class)
    if (list.length) { rows = list; break; }
  }
  out.listFound = rows.length > 0;
  if (!out.listFound) {
    const body = document.body ? String(document.body.innerText || '').slice(0, 1500) : '';
    out.loggedOut = /id\.zalo\.me|\/login/.test(location.href) || !!document.querySelector('canvas, [class*="qr"]') || /quét mã qr|mã qr|đăng nhập (bằng|với|vào) /i.test(body);
    return out;
  }
  const timeLike = /^(\d{1,2}[:h]\d{2}|\d+\s*(phút|giờ|ngày|giây|tuần)\b.*|hôm qua|vừa xong|\d{1,2}\/\d{1,2}(\/\d{2,4})?)$/i;
  for (const row of rows.slice(0, 80)) {
    let count = 0, badgeText = '';
    for (const e of [].slice.call(row.querySelectorAll('*'))) {
      const r = box(e); if (r.width < 6 || r.height < 6 || r.width > 48 || r.height > 48 || !red(e)) continue;
      const t = text(e);
      if (t === '') { if (count < 1) count = 1; continue; }                         // chấm đỏ trống = có tin chưa đọc
      const n = /^(\d{1,3})\+?$/.exec(t); if (n) { if (Number(n[1]) > count) { count = Number(n[1]); badgeText = t; } }
    }
    if (count < 1) continue;
    const lines = String(row.innerText || '').split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const cands = [].slice.call(row.querySelectorAll('[class*="title"], [class*="name"]')).filter((e) => text(e));
    const inner = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)));        // phần tử trong cùng (bỏ khối bao ngoài chứa cả giờ)
    const name = (inner.length ? text(inner[0]) : '') || lines[0] || '';
    const cleanName = name.replace(/\s+(\d{1,2}[:h]\d{2}|hôm qua|vừa xong|\d+\s*(phút|giờ|ngày|giây|tuần))$/i, '').trim();
    const rest = lines.filter((x) => x !== name && x !== cleanName && x !== badgeText && !timeLike.test(x));
    out.items.push({ name: cleanName.slice(0, 80), count, preview: (rest[rest.length - 1] || '').slice(0, 100) });
  }
  return out;
}

// So tình hình hiện tại với lần trước: trả { next: {khóa: chữ ký}, fresh: [mục mới/đổi] }. Khóa = tên không dấu.
function diffUnread(seen, items) {
  const next = {}, fresh = [];
  for (const it of items) {
    const key = noAccent(it.name) || '?'; const sig = it.count + '|' + noAccent(it.preview);
    next[key] = sig; if ((seen || {})[key] !== sig) fresh.push(Object.assign({ key }, it));
  }
  return { next, fresh };
}

function createZaloWatch(o) {
  o = o || {};
  const zalo = o.zalo, log = o.log || (() => {}), now = o.now || Date.now, rand = o.rand || Math.random;
  const url = o.zaloUrl || ZALO_URL, origin = new URL(url).origin;
  const load = o.load || (() => require(require.resolve('playwright-core', { paths: [process.env.AGENTOS_TOOLS_DIR || '/opt/agentos/tools'] })));
  const settleMs = o.settleMs === undefined ? 6000 : o.settleMs;
  const tell = (text) => { try { return o.notify ? o.notify(text) : null; } catch (e) { return null; } };
  let running = false, stopped = true, timer = null, jobId = null, fails = 0, parseFails = 0, aiLog = [], last = null;
  const quiet = new Map();                                           // khóa -> lúc báo gần nhất (không báo lặp)
  const once = (key, ms, text) => { const t = now(); if (quiet.has(key) && t - quiet.get(key) < ms) return; quiet.set(key, t); tell(text); };
  const isZaloPage = (p) => { try { return p.url().startsWith(origin); } catch (e) { return false; } };

  async function withBrowser(fn) {
    const pw = load();
    const browser = await pw.chromium.connectOverCDP(await o.endpoint(), { timeout: 30000 });
    try { const ctx = browser.contexts()[0] || await browser.newContext(); return await fn(ctx); }
    finally { try { await browser.close(); } catch (e) { /* chỉ ngắt kết nối */ } }
  }
  // Mở (hoặc dùng lại) đúng MỘT tab Zalo rồi đọc danh sách; không bấm gì
  const snapshot = () => withBrowser(async (ctx) => {
    let page = ctx.pages().find(isZaloPage);
    if (!page) { page = await ctx.newPage(); await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); if (settleMs) await page.waitForTimeout(settleMs); }
    let s = await page.evaluate(extractUnread);
    if (!s.listFound && !s.loggedOut && settleMs) { await page.waitForTimeout(Math.min(settleMs, 4000)); s = await page.evaluate(extractUnread); }
    return s;
  });
  // Zalo Web chỉ cho một tab: đóng tab canh trước khi AI vào, tick sau sẽ mở lại
  const closeTab = () => withBrowser(async (ctx) => { for (const p of ctx.pages().filter(isZaloPage)) { try { await p.close(); } catch (e) { /* đã đóng */ } } });

  const jobBusy = () => { if (jobId == null) return false; try { return !!(o.jobActive && o.jobActive(jobId)); } catch (e) { return false; } };

  async function tick() {
    const c = zalo.load(), t = now();
    if (!c.enabled || !c.watch) return { skipped: 'tat' };
    if (!inHours(c, new Date(t))) return { skipped: 'ngoai-gio' };
    if (running) return { skipped: 'dang-chay' };
    if (jobBusy()) return { skipped: 'viec-ai-dang-chay' };
    running = true;
    try {
      let snap;
      try { snap = await snapshot(); fails = 0; } catch (e) {
        fails++; log('zaloWatch: ' + firstLine(e));
        if (fails >= 3) once('fail', 6 * 3600000, '⚠️ Em không nối được Chrome của bot để canh Zalo (' + fails + ' lần liền: ' + firstLine(e) + '). Em vẫn thử lại; nếu mãi không được, anh kiểm tra /mo webbot hoặc /zalo canh tat.');
        return { error: firstLine(e) };
      }
      last = { at: t, listFound: snap.listFound, loggedOut: snap.loggedOut, n: snap.items.length, titleCount: snap.titleCount };
      if (snap.loggedOut) { once('login', 6 * 3600000, '🔐 Zalo Web trong Chrome của bot đang CHƯA đăng nhập nên em không canh được tin. Anh nhắn "mở Chrome cho anh đăng nhập Zalo", quét QR rồi nhắn "xong".'); return { loggedOut: true }; }
      if (!snap.listFound && !snap.titleCount) {
        parseFails++; if (parseFails >= 3) once('parse', 24 * 3600000, '⚠️ Em mở được Zalo Web nhưng không đọc được danh sách hội thoại (Zalo có thể đã đổi giao diện). Em chưa canh được tin mới — anh báo em để sửa.');
        return { unreadable: true };
      }
      parseFails = 0;
      const items = snap.items.length ? snap.items : (snap.titleCount ? [{ name: '(chưa rõ tên)', count: snap.titleCount, preview: '' }] : []);
      const { next, fresh } = diffUnread(c.watchSeen, items);
      if (!c.watchBase) {                                            // lần đầu: chỉ ghi nhận tin đang chờ
        zalo.mut((x) => { x.watchSeen = next; x.watchBase = true; });
        const n = items.length;
        tell('👀 Đã bắt đầu canh Zalo. Hiện có ' + n + ' hội thoại chưa đọc — em chỉ ghi nhận, KHÔNG trả lời tin cũ; từ giờ có tin mới em báo anh.');
        return { baseline: true, n };
      }
      const block = new Set((c.block || []).map((b) => noAccent(b)));
      const todo = fresh.filter((f) => !block.has(f.key));
      if (!todo.length) { if (fresh.length || Object.keys(c.watchSeen || {}).length !== Object.keys(next).length) zalo.mut((x) => { x.watchSeen = next; }); return { fresh: 0 }; }
      const line = todo.slice(0, 8).map((f) => f.name + ' (' + f.count + ')' + (f.preview ? ': “' + clip(f.preview, 60) + '”' : '')).join('\n• ');
      const names = todo.map((f) => f.name);
      let note = '';
      let saved = Object.assign({}, next), acted = false;
      if (c.watchAct === 'bao') note = '\nChế độ chỉ báo: em không đọc/trả lời.';
      else {
        aiLog = aiLog.filter((x) => t - x < 3600000);
        if (aiLog.length >= (c.watchMaxAi || 6)) note = '\n⏸ Đã đủ ' + (c.watchMaxAi || 6) + ' lần nhờ AI trong 1 giờ — em chỉ báo, chưa đọc/trả lời (đổi: /zalo canh, hoặc anh tự nhắn em).';
        else {
          try {
            try { await closeTab(); } catch (e) { log('zaloWatch: không đóng được tab canh: ' + firstLine(e)); }
            jobId = o.submit(zalo.readPrompt(names)); aiLog.push(t); acted = true;
            note = '\nEm đang nhờ AI mở đọc và ' + (c.mode === 'tudong' ? 'tự trả lời' : 'soạn nháp cho anh bấm ✅') + (jobId ? ' (việc #' + jobId + ')' : '') + '.';
          } catch (e) {
            for (const f of todo) delete saved[f.key];                // chưa xử lý được → lần sau thử lại
            note = '\n⚠️ Không tạo được việc cho AI (' + firstLine(e) + '), em sẽ thử lại.';
          }
        }
      }
      zalo.mut((x) => { x.watchSeen = saved; });
      tell('💬 Zalo có tin mới:\n• ' + line + (todo.length > 8 ? '\n… và ' + (todo.length - 8) + ' hội thoại nữa' : '') + note);
      return { fresh: todo.length, acted, names };
    } finally { running = false; }
  }

  const delay = () => { const c = zalo.load(); return Math.round(Math.max(30, c.watchEvery || 120) * 1000 * (0.7 + 0.6 * rand())); };
  function schedule(ms) {
    if (stopped) return;
    timer = setTimeout(async () => { try { await tick(); } catch (e) { log('zaloWatch tick: ' + firstLine(e)); } schedule(delay()); }, ms);
    if (timer.unref) timer.unref();
  }
  function start(firstMs) { stopped = false; clearTimeout(timer); schedule(firstMs === undefined ? 90000 : firstMs); }
  function stop() { stopped = true; clearTimeout(timer); }
  const status = () => ({ running, last, jobId, aiLastHour: aiLog.filter((x) => now() - x < 3600000).length });

  return { tick, start, stop, status, snapshot, closeTab };
}

module.exports = { createZaloWatch, extractUnread, diffUnread, ZALO_URL };
