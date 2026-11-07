'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createRenderer } = require('../src/render');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'));

// Playwright giả: ghi lại cách dùng; routes[] = các URL ta thử xem bị chặn hay cho qua
function fakePw(o) {
  o = o || {};
  const calls = { ctxOpts: null, closed: [], goto: null, shot: null, aborted: [], continued: [], connect: null };
  const ctx = {
    route: async (pat, fn) => { for (const u of (o.probe || [])) await fn({ request: () => ({ url: () => u }), abort: async () => { calls.aborted.push(u); }, continue: async () => { calls.continued.push(u); } }); },
    newPage: async () => ({
      goto: async (u, opt) => { calls.goto = [u, opt]; if (o.gotoDelay) await new Promise((r) => setTimeout(r, o.gotoDelay)); if (o.gotoError) throw new Error(o.gotoError); },
      screenshot: async (opt) => { calls.shot = opt; fs.writeFileSync(opt.path, Buffer.alloc(o.pngBytes === undefined ? 5000 : o.pngBytes, 1)); },
    }),
    close: async () => { calls.closed.push('ctx'); },
  };
  const browser = { newContext: async (opt) => { calls.ctxOpts = opt; return ctx; }, close: async () => { calls.closed.push('browser'); } };
  return { calls, pw: { chromium: { connectOverCDP: async (ep, opt) => { calls.connect = [ep, opt]; return browser; } } } };
}
const mk = (pwo, extra) => { const F = fakePw(pwo); const logs = []; return { F, logs, R: createRenderer(Object.assign({ log: (m) => logs.push(m), endpointFor: async () => 'http://127.0.0.1:41000', loadPlaywright: () => F.pw }, extra || {})) }; };

test('render: chụp báo cáo HTML thành ảnh dài — tắt JavaScript, chặn mạng và tệp ngoài thư mục báo cáo, ảnh có tên ẩn cạnh tệp gốc, luôn đóng ngữ cảnh', async () => {
  const dir = tmp(), html = path.join(dir, 'bao-cao.html'); fs.writeFileSync(html, '<h1>Xin chào</h1>');
  const self = pathToFileURL(html).href, sibling = pathToFileURL(path.join(dir, 'logo.png')).href;
  const { F, R } = mk({ probe: [self, sibling, 'http://127.0.0.1:22/x.png', 'https://cdn.example.com/lib.js', 'file:///etc/hostname', pathToFileURL(path.join(dir + '-khac', 'a.png')).href, pathToFileURL(path.join(dir, '..', 'bi-mat.txt')).href] });
  const r = await R.renderHtml(html, { id: 1, chat_id: '111' });
  assert.ok(r.ok); assert.equal(r.png, path.join(dir, '.bao-cao.preview.png')); assert.ok(fs.existsSync(r.png));
  assert.deepEqual(F.calls.connect, ['http://127.0.0.1:41000', { timeout: 15000 }]);
  assert.equal(F.calls.ctxOpts.javaScriptEnabled, false); assert.equal(F.calls.ctxOpts.serviceWorkers, 'block');
  assert.equal(F.calls.goto[0], self); assert.equal(F.calls.shot.fullPage, true);
  assert.deepEqual(F.calls.continued.sort(), [self, sibling].sort(), 'chỉ cho đọc chính báo cáo và tệp cùng thư mục');
  assert.equal(F.calls.aborted.length, 5, 'mạng, tệp hệ thống, thư mục anh em, thư mục cha đều bị chặn');
  assert.ok(F.calls.aborted.includes('file:///etc/hostname')); assert.ok(F.calls.aborted.some((u) => /-khac/.test(u)), 'tiền tố gần giống tên thư mục không lọt qua');
  assert.deepEqual(F.calls.closed, ['ctx', 'browser']);
});

test('render: lỗi → không để lại ảnh dở dang, vẫn đóng ngữ cảnh, trả lỗi rõ; quá giờ thì bỏ; HTML quá lớn / ảnh rỗng / ảnh quá lớn bị từ chối', async () => {
  const dir = tmp(), html = path.join(dir, 'a.html'); fs.writeFileSync(html, '<p>x</p>');
  let m = mk({ gotoError: 'net::ERR_FAILED' }); let r = await m.R.renderHtml(html, {});
  assert.equal(r.ok, false); assert.match(r.error, /ERR_FAILED/); assert.deepEqual(m.F.calls.closed, ['ctx', 'browser']); assert.equal(fs.existsSync(path.join(dir, '.a.preview.png')), false);
  m = mk({ gotoDelay: 3000 }, { timeoutMs: 200 }); r = await m.R.renderHtml(html, {}); assert.equal(r.ok, false); assert.match(r.error, /quá 0 giây|quá \d+ giây/); assert.deepEqual(m.F.calls.closed, ['ctx', 'browser']);
  m = mk({ pngBytes: 0 }); r = await m.R.renderHtml(html, {}); assert.match(r.error, /rỗng/); assert.equal(fs.existsSync(path.join(dir, '.a.preview.png')), false);
  m = mk({ pngBytes: 11 * 1024 * 1024 }); r = await m.R.renderHtml(html, {}); assert.match(r.error, /quá lớn/); assert.equal(fs.existsSync(path.join(dir, '.a.preview.png')), false);
  const big = path.join(dir, 'big.html'); fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1, 97)); m = mk(); r = await m.R.renderHtml(big, {}); assert.match(r.error, /quá lớn/); assert.equal(m.F.calls.connect, null, 'không mở trình duyệt cho tệp quá lớn');
  m = mk(); r = await m.R.renderHtml(path.join(dir, 'khong-co.html'), {}); assert.equal(r.ok, false);
  m = mk({}, { endpointFor: async () => null }); r = await m.R.renderHtml(html, {}); assert.match(r.error, /chưa có trình duyệt/);
  const nopw = createRenderer({ endpointFor: async () => 'x', loadPlaywright: () => { throw new Error('không có playwright'); } }); r = await nopw.renderHtml(html, {}); assert.match(r.error, /không có playwright/);
});

test('render.prepare: mỗi .html thêm ảnh xem trước (gửi TRƯỚC) rồi tới tệp gốc; tệp khác giữ nguyên thứ tự; tối đa 2 báo cáo/việc; lỗi chụp thì chỉ gửi HTML', async () => {
  const dir = tmp(); const f = (n) => { const p = path.join(dir, n); fs.writeFileSync(p, '<p>x</p>'); return { path: p, name: n, kind: 'document', size: 8 }; };
  const files = [{ path: '/x/a.png', name: 'a.png', kind: 'photo' }, f('r1.html'), f('r2.htm'), f('r3.html'), { path: '/x/b.pdf', name: 'b.pdf', kind: 'document' }];
  const { R } = mk();
  const out = await R.prepare(files, { id: 1, chat_id: '1' });
  assert.deepEqual(out.map((x) => x.name + ':' + x.kind), ['a.png:photo', 'r1.png:photo', 'r1.html:document', 'r2.png:photo', 'r2.htm:document', 'r3.html:document', 'b.pdf:document']);
  assert.equal(out[1].path, path.join(dir, '.r1.preview.png'));
  const bad = mk({ gotoError: 'hỏng' }); const out2 = await bad.R.prepare([f('x.html')], {}); assert.deepEqual(out2.map((x) => x.name), ['x.html']); assert.match(bad.logs.join(' '), /chụp báo cáo x\.html lỗi: hỏng/);
  assert.deepEqual(await R.prepare([], {}), []); assert.deepEqual(await R.prepare(null, {}), []);
});
