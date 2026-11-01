'use strict';

// BƯỚC KIỂM NHANH cho trợ lý trực Facebook — KHÔNG dùng AI. Giữ MỘT tab Messenger mở sẵn bằng ĐÚNG hồ sơ trình duyệt của bot (đã đăng nhập sẵn) như một người dùng bình thường để tab đó.
// Messenger/Facebook tự cập nhật tiêu đề theo thời gian thực, kiểu "(3) Messenger" khi có 3 cuộc trò chuyện chưa đọc, nên mỗi lần kiểm CHỈ ĐỌC tiêu đề (không tải lại trang, không bấm/gõ gì)
// → kiểm mỗi 30 giây rất nhẹ và không giống robot bấm tải lại liên tục. Chỉ khi có tin chưa đọc MỚI thì facebook.js mới gọi AI.
// Vì tab giữ hồ sơ trình duyệt (khóa), bot phải NHẢ ra (release) trước khi AI hoặc cửa sổ đăng nhập (fbbot) cần dùng; lần kiểm sau tab tự mở lại. Tải lại trang mỗi 15 phút phòng kết nối nền bị đứt.
// Mỗi lần kiểm có GIỚI HẠN THỜI GIAN (mặc định 90 giây): mạng treo/Facebook sập thì đóng trình duyệt và báo lỗi, không bao giờ treo bộ điều phối.
// Kết quả mỗi lần: { unread: số | null(không đọc được), login: true nếu bị đưa tới trang đăng nhập/xác minh, busy: true nếu hồ sơ đang bị bên khác dùng, error: chuỗi }.
const LOGIN_URL = /\/(login|checkpoint|recover|two_step_verification|authentication|help\/contact)|[?&]next=/i;
const LOGIN_TITLE = /^(log in|login|đăng nhập|facebook\s*[-–]\s*(log in|đăng nhập)|security check|checkpoint)/i;
const BUSY_ERR = /ProcessSingleton|already in use|SingletonLock|profile.*in use|Target page, context or browser has been closed|Failed to launch/i;
const RELOAD_MS = 15 * 60000;
const firstLine = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 160);

function parseTitle(title) {
  const m = /^\s*\((\d{1,3})\+?\)/.exec(String(title || ''));
  return m ? Number(m[1]) : (String(title || '').trim() ? 0 : null);
}

function createProbe(o) {
  o = o || {};
  const url = o.url || 'https://www.messenger.com/';
  const exe = o.chromium || '/usr/bin/chromium';
  const settleMs = o.settleMs === undefined ? 5000 : o.settleMs;
  const now = o.now || Date.now;
  const load = o.load || (() => require(o.lib || '/opt/agentos/tools/node_modules/playwright-core'));
  let ctx = null, page = null, openedAt = 0, opening = null;

  // Đóng NGAY, không chờ việc mở đang dở (open() gọi hàm này khi lỗi: chờ chính nó sẽ treo vĩnh viễn).
  async function forceClose() { const c = ctx; ctx = null; page = null; if (c) { try { await c.close(); } catch (e) { /* đã đóng */ } } }
  // Nhả cho bên ngoài (AI / cửa sổ đăng nhập): chờ việc mở đang dở xong rồi đóng.
  async function release() { if (opening) { try { await opening; } catch (e) { /* mở lỗi thì không có gì để nhả */ } } await forceClose(); }

  async function open() {
    let pw; try { pw = load(); } catch (e) { return { error: 'thiếu thư viện trình duyệt (' + firstLine(e) + ')' }; }
    try {
      ctx = await pw.chromium.launchPersistentContext(o.profileDir, {
        executablePath: exe, headless: !!o.headless, timeout: 30000, viewport: { width: 1100, height: 800 },
        args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--disable-features=Translate'],
        env: Object.assign({}, process.env, { DISPLAY: o.display || process.env.DISPLAY || ':99' }),
      });
    } catch (e) { ctx = null; return BUSY_ERR.test(String(e.message)) ? { busy: true } : { error: 'không mở được trình duyệt: ' + firstLine(e) }; }
    const mine = ctx; mine.on('close', () => { if (ctx === mine) { ctx = null; page = null; } });             // người dùng/AI đóng ngoài ý muốn: lần sau mở lại
    try {
      page = mine.pages()[0] || await mine.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (settleMs) await page.waitForTimeout(settleMs);
      openedAt = now();
      return null;
    } catch (e) { await forceClose(); return { error: firstLine(e) }; }
  }

  async function probeOnce() {
    try {
      if (!ctx || !page || page.isClosed()) {
        opening = open(); const err = await opening; opening = null;
        if (err) return err;
      } else if (now() - openedAt > RELOAD_MS) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); if (settleMs) await page.waitForTimeout(settleMs); openedAt = now();
      }
      const title = await page.title(), cur = page.url();
      const hasPassword = !!(await page.$('input[type="password"]').catch(() => null));
      if (LOGIN_URL.test(cur) || LOGIN_TITLE.test(String(title).trim()) || hasPassword) return { login: true, title: String(title).slice(0, 80) };
      return { unread: parseTitle(title), title: String(title).slice(0, 80) };
    } catch (e) { opening = null; await forceClose(); return { error: firstLine(e) }; }
  }

  async function probe() {
    let timer; const limit = new Promise((r) => { timer = setTimeout(() => r({ timeout: true }), o.timeoutMs || 90000); if (timer.unref) timer.unref(); });
    const r = await Promise.race([probeOnce(), limit]); clearTimeout(timer);
    if (r && r.timeout) { opening = null; await forceClose(); return { error: 'quá thời gian chờ Messenger (mạng treo?)' }; }
    return r;
  }
  probe.release = release;
  probe.isOpen = () => !!ctx;
  return probe;
}

module.exports = { createProbe, parseTitle, LOGIN_URL, LOGIN_TITLE };
