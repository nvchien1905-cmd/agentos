'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// HIỂN THỊ KẾT QUẢ (như "artifact" của app Claude): AI viết báo cáo/bảng/biểu đồ thành MỘT tệp .html tự đủ → bộ điều phối chụp thành ẢNH DÀI xem ngay trên điện thoại, gửi kèm tệp HTML gốc.
// Chụp bằng Chrome DÙNG CHUNG của đúng danh tính (chủ máy / Chrome riêng của ID thường) qua Playwright, trong một ngữ cảnh riêng:
//  - TẮT JavaScript (không chạy được mã trong trang), chặn MỌI yêu cầu mạng, và chỉ cho đọc tệp nằm trong CHÍNH thư mục chứa báo cáo (iframe/ảnh trỏ tới tệp khác của máy đều bị chặn);
//  - tệp HTML tối đa 2 MB, chụp tối đa 2 tệp mỗi việc, mỗi tệp tối đa 40 giây; lỗi thì chỉ gửi tệp HTML như cũ, không làm hỏng việc.
const MAX_HTML = 2 * 1024 * 1024, MAX_PER_JOB = 2, MAX_PNG = 10 * 1024 * 1024;

function createRenderer(o) {
  const log = o.log || (() => {});
  const timeoutMs = o.timeoutMs || 40000;
  const js = o.javaScript !== false;                       // báo cáo có biểu đồ/tương tác (như Artifacts của Claude) chạy được JavaScript — vẫn CHẶN MỌI MẠNG, chỉ đọc tệp trong thư mục báo cáo
  const loadPw = o.loadPlaywright || (() => { const tdir = process.env.AGENTOS_TOOLS_DIR || '/opt/agentos/tools'; return require(require.resolve('playwright-core', { paths: [tdir] })); });
  const endpointFor = o.endpointFor;                       // async (job) -> địa chỉ CDP của Chrome dùng chung của danh tính này

  async function renderHtml(htmlPath, job) {
    let st; try { st = fs.statSync(htmlPath); } catch (e) { return { ok: false, error: 'không đọc được tệp' }; }
    if (st.size > MAX_HTML) return { ok: false, error: 'tệp HTML quá lớn (> 2 MB)' };
    const dir = path.resolve(path.dirname(htmlPath)), dirUrl = pathToFileURL(dir).href.replace(/\/?$/, '/'), self = pathToFileURL(path.resolve(htmlPath)).href;
    const png = path.join(dir, '.' + path.basename(htmlPath).replace(/\.html?$/i, '') + '.preview.png');       // tên ẩn: quét hộp thư ra không gửi riêng nó
    let browser = null, ctx = null, timer;
    const work = (async () => {
      const ep = await endpointFor(job); if (!ep) throw new Error('chưa có trình duyệt dùng chung');
      const { chromium } = loadPw();
      browser = await chromium.connectOverCDP(ep, { timeout: 15000 });
      ctx = await browser.newContext({ javaScriptEnabled: js, viewport: { width: 760, height: 900 }, deviceScaleFactor: 1.5, serviceWorkers: 'block' });
      await ctx.route('**/*', (route) => { const u = route.request().url(); if (u === self || u.startsWith(dirUrl)) return route.continue(); return route.abort(); });
      const page = await ctx.newPage();
      await page.goto(self, { waitUntil: 'load', timeout: 20000 });
      if (js && page.waitForTimeout) await page.waitForTimeout(800);          // cho biểu đồ/hoạt ảnh vẽ xong
      await page.screenshot({ path: png, fullPage: true, type: 'png', timeout: 20000 });
      const sz = fs.statSync(png).size;
      if (sz > MAX_PNG || sz === 0) { fs.rmSync(png, { force: true }); throw new Error(sz ? 'ảnh chụp quá lớn' : 'ảnh chụp rỗng'); }
      return { ok: true, png, size: sz };
    })();
    const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('quá ' + Math.round(timeoutMs / 1000) + ' giây')), timeoutMs); if (timer.unref) timer.unref(); });
    try { return await Promise.race([work, limit]); }
    catch (e) { fs.rmSync(png, { force: true }); return { ok: false, error: e && e.message || String(e) }; }
    finally {
      clearTimeout(timer);
      work.catch(() => {});                                // work còn chạy sau khi hết giờ: nuốt lỗi muộn
      try { if (ctx) await ctx.close(); } catch (e) { /* bỏ qua */ }
      try { if (browser) await browser.close(); } catch (e) { /* chỉ ngắt kết nối */ }
    }
  }

  // Danh sách tệp cần gửi → thêm ảnh xem trước (gửi trước) cho từng tệp .html, giữ tệp HTML gốc phía sau
  async function prepare(files, job) {
    const out = []; let n = 0;
    for (const f of files || []) {
      if (!/\.html?$/i.test(f.name) || n >= MAX_PER_JOB) { out.push(f); continue; }
      n++;
      let r; try { r = await renderHtml(f.path, job); } catch (e) { r = { ok: false, error: e.message }; }
      if (r.ok) out.push({ path: r.png, name: f.name.replace(/\.html?$/i, '') + '.png', kind: 'photo', size: r.size, mtime: Date.now() });
      else log('chụp báo cáo ' + f.name + ' lỗi: ' + r.error);
      out.push(f);
    }
    return out;
  }

  return { renderHtml, prepare };
}

module.exports = { createRenderer, MAX_HTML, MAX_PER_JOB };
