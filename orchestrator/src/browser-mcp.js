#!/usr/bin/env node
'use strict';
// TRÌNH DUYỆT CHO AI — MỘT Chrome dùng chung (đã đăng nhập), MỖI AI MỘT TAB RIÊNG.
// Máy chủ MCP này thay cho playwright-mcp thường: nối vào Chrome đang chạy qua CDP, nhưng chỉ "thấy" các tab do CHÍNH tiến trình này mở (kể cả cửa sổ bật lên từ tab của nó).
// Nhiều AI/cuộc trò chuyện chạy song song, mỗi AI một tiến trình + một tab, dùng chung cookie/đăng nhập của Chrome nhưng không đè lên tab của nhau (playwright-mcp thường nối chung sẽ dùng chung MỘT tab).
// Tham số: --cdp <http://127.0.0.1:cổng>  --output-dir <thư mục>  [--images] (mặc định bỏ ảnh trong phản hồi như cấu hình cũ)
// Cần playwright-core (có sẵn trong /opt/agentos/tools); đặt AGENTOS_TOOLS_DIR nếu cài ở chỗ khác.
const TOOLS_DIR = process.env.AGENTOS_TOOLS_DIR || '/opt/agentos/tools';


// Bọc BrowserContext dùng chung thành "ngữ cảnh chỉ có các tab của mình". Tách riêng để thử nghiệm.
// Chrome phát sự kiện "tab mới" TRƯỚC khi newPage() trả về (lúc đó tab chưa được đánh dấu là của mình) nên tab do mình mở được báo lại cho các listener ngay khi newPage xong.
function scopeContext(base) {
  const own = new Set();
  const listeners = new Set();                                            // các hàm đã đăng ký nghe sự kiện 'page'
  const wrapped = new Map();                                              // hàm gốc -> bản bọc (để gỡ listener)
  const track = (page) => {
    if (own.has(page)) return false;
    own.add(page);
    page.once('close', () => own.delete(page));
    page.on('popup', (p) => track(p));                                   // cửa sổ bật lên từ tab của mình cũng là của mình
    return true;
  };
  const wrap = (fn) => {
    if (wrapped.has(fn)) return wrapped.get(fn);
    const w = (page) => {
      if (own.has(page)) return fn(page);
      Promise.resolve(page.opener()).then((o) => { if (o && own.has(o)) { track(page); fn(page); } }).catch(() => {});   // tab của AI khác: bỏ qua
    };
    wrapped.set(fn, w); return w;
  };
  let scoped;
  const handler = {
    get(t, p) {
      if (p === 'pages') return () => [...own].filter((x) => !x.isClosed());
      if (p === 'newPage') return async (...a) => { const pg = await t.newPage(...a); if (track(pg)) for (const fn of [...listeners]) fn(pg); return pg; };
      if (p === 'on' || p === 'addListener' || p === 'prependListener') return (ev, fn) => { if (ev === 'page') { listeners.add(fn); t[p]('page', wrap(fn)); } else t[p](ev, fn); return scoped; };
      if (p === 'once') return (ev, fn) => { if (ev !== 'page') { t.once(ev, fn); return scoped; } const one = (pg) => { listeners.delete(one); t.off('page', wrap(one)); fn(pg); }; listeners.add(one); t.on('page', wrap(one)); return scoped; };
      if (p === 'off' || p === 'removeListener') return (ev, fn) => { if (ev === 'page') { listeners.delete(fn); t[p]('page', wrap(fn)); } else t[p](ev, fn); return scoped; };
      if (p === 'close' || p === 'closeOwn') return async () => { for (const pg of [...own]) { try { await pg.close(); } catch (e) { /* đã đóng */ } } };      // KHÔNG đóng Chrome/ngữ cảnh dùng chung
      if (p === 'ownCount') return () => own.size;
      const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
    },
  };
  scoped = new Proxy(base, handler);
  return scoped;
}

async function main() {
  const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
  const cdp = opt('--cdp', process.env.AGENTOS_CDP || '');
  if (!cdp) { process.stderr.write('Thiếu --cdp <địa chỉ Chrome>\n'); process.exit(2); }
  const req = (m) => require(require.resolve(m, { paths: [TOOLS_DIR] }));
  const { chromium } = req('playwright-core');
  const { tools } = req('playwright-core/lib/coreBundle');
  const { StdioServerTransport } = req('playwright-core/lib/utilsBundle');

  const browser = await chromium.connectOverCDP(cdp, { timeout: 30000 });
  const base = browser.contexts()[0] || await browser.newContext();       // ngữ cảnh mặc định của Chrome = hồ sơ đã đăng nhập
  const scoped = scopeContext(base);
  const config = { outputDir: opt('--output-dir', undefined), imageResponses: args.includes('--images') ? 'allow' : 'omit' };
  if (!config.outputDir) delete config.outputDir;
  const server = await tools.createConnection(config, async () => scoped);

  let closing = false;
  const bye = async () => { if (closing) return; closing = true; try { await scoped.closeOwn(); } catch (e) { /* bỏ qua */ } try { await browser.close(); } catch (e) { /* chỉ ngắt kết nối */ } process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye); process.stdin.on('end', bye); process.stdin.on('close', bye);
  await server.connect(new StdioServerTransport());
}

if (require.main === module) main().catch((e) => { process.stderr.write('Lỗi trình duyệt MCP: ' + (e && e.stack || e) + '\n'); process.exit(1); });
module.exports = { scopeContext };
