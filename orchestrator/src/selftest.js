'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// TỰ CHẨN ĐOÁN: kiểm từng bộ phận của máy và báo ✅ / ⚠️ / ❌ kèm lý do. Hai mức:
//   light()  kiểm nhanh, KHÔNG tốn hạn mức AI, chạy định kỳ (healthmon.js) và khi gõ /tuchan
//   full()   thêm: chụp màn hình, thử LibreOffice, và (nếu ai:true) hỏi thử từng AI một câu ("trả lời OK") để biết AI nào đang chạy được
// Mỗi kiểm tra trả { id, name, status: 'ok'|'warn'|'fail', detail }. Không có kiểm tra nào ném lỗi ra ngoài.
function createSelfTest(o) {
  o = o || {};
  const home = o.home || process.env.HOME || os.homedir();
  const run = o.run || ((bin, args, timeout) => new Promise((res) => execFile(bin, args || [], { timeout: timeout || 8000, maxBuffer: 1 << 20, env: process.env }, (e, so, se) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(so || '').trim(), err: String(se || '').trim(), missing: !!(e && e.code === 'ENOENT') }))));
  const exists = o.exists || ((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  const diskFreeMb = o.diskFreeMb || (() => Infinity);
  const minFreeMb = o.minFreeMb || 500;
  const R = (id, name, status, detail) => ({ id, name, status, detail: detail || '' });
  const safe = (id, name, fn) => Promise.resolve().then(fn).catch((e) => R(id, name, 'fail', 'lỗi khi kiểm tra: ' + (e && e.message || e)));

  const checks = {
    telegram: () => safe('telegram', 'Telegram', async () => {
      const w = o.tgwatch ? o.tgwatch.state() : { kind: 'ok' };
      if (w.kind === 'conflict') return R('telegram', 'Telegram', 'fail', 'XUNG ĐỘT NHẬN TIN (409): chương trình khác dùng chung token hoặc đang đặt webhook. Tạo bot riêng ở @BotFather.');
      if (w.kind === 'badtoken') return R('telegram', 'Telegram', 'fail', 'Token bot không dùng được (401/404): tạo token mới ở @BotFather.');
      if (!o.tg) return R('telegram', 'Telegram', 'warn', 'không kiểm được (thiếu kết nối)');
      const me = await o.tg.call('getMe');
      let hook = null; try { hook = await o.tg.call('getWebhookInfo'); } catch (e) { /* bỏ qua */ }
      if (hook && hook.url) return R('telegram', 'Telegram', 'fail', 'Token đang đặt webhook (' + String(hook.url).replace(/^(https?:\/\/[^/]+).*$/, '$1') + ') nên bot không nhận tin hỏi-đáp.');
      return R('telegram', 'Telegram', 'ok', 'bot @' + me.username + ' nhận tin bình thường' + (hook && hook.pending_update_count ? ', ' + hook.pending_update_count + ' tin chờ' : ''));
    }),

    services: () => safe('services', 'Dịch vụ', async () => {
      const list = (o.services || ['agentos-deskd', 'agentos-settings', 'tailscaled', 'rustdesk']);
      const r = await run('systemctl', ['is-active'].concat(list));
      if (r.missing) return R('services', 'Dịch vụ', 'warn', 'không có systemctl (không phải Linux?)');
      const st = r.out.split('\n');
      const bad = list.filter((n, i) => st[i] !== 'active');
      const required = new Set(o.requiredServices || ['agentos-deskd', 'agentos-settings']);
      const badReq = bad.filter((n) => required.has(n));
      if (badReq.length) return R('services', 'Dịch vụ', 'fail', 'không chạy: ' + badReq.join(', '));
      return R('services', 'Dịch vụ', bad.length ? 'warn' : 'ok', bad.length ? 'chưa bật (không bắt buộc): ' + bad.join(', ') : list.length + ' dịch vụ đang chạy');
    }),

    engines: () => safe('engines', 'AI (công cụ + đăng nhập)', async () => {
      const lines = []; let bad = 0, warn = 0;
      for (const e of o.engines || []) {
        const v = await run(e.bin, (e.binArgs || []).concat(['--version']), 15000);
        if (v.missing || (v.code !== 0 && !v.out)) { lines.push(e.label + ': ❌ không chạy được (' + (v.missing ? 'chưa cài' : (v.err || 'lỗi').slice(0, 60)) + ')'); bad++; continue; }
        const keyOk = e.key ? true : false;
        const loginOk = keyOk || (e.login || []).some((p) => exists(path.join(home, p)));
        if (!loginOk && !(e.login || []).length) { lines.push(e.label + ': ✅ ' + (v.out.split('\n')[0] || 'có').slice(0, 40)); continue; }
        if (!loginOk) { lines.push(e.label + ': ⚠️ có phần mềm nhưng CHƯA đăng nhập/khóa API'); warn++; continue; }
        lines.push(e.label + ': ✅ ' + (keyOk ? 'dùng khóa API' : 'đã đăng nhập'));
      }
      if (!lines.length) return R('engines', 'AI', 'warn', 'không có AI nào được cấu hình');
      return R('engines', 'AI (công cụ + đăng nhập)', bad === (o.engines || []).length ? 'fail' : (bad || warn ? 'warn' : 'ok'), lines.join('\n   '));
    }),

    resources: () => safe('resources', 'Tài nguyên máy', async () => {
      const free = diskFreeMb(); const memFree = Math.round(os.freemem() / 1048576), memTot = Math.round(os.totalmem() / 1048576);
      const la = os.loadavg()[0], cores = os.cpus().length || 1;
      let temp = null;
      try { const t = fs.readdirSync('/sys/class/thermal').filter((n) => /^thermal_zone/.test(n)).map((n) => Number(fs.readFileSync('/sys/class/thermal/' + n + '/temp', 'utf8')) / 1000).filter((x) => x > 0 && x < 150); if (t.length) temp = Math.max.apply(null, t); } catch (e) { /* không có cảm biến */ }
      const probs = [];
      if (free !== Infinity && free < minFreeMb) probs.push('ổ đĩa gần đầy (còn ' + free + ' MB)');
      if (memTot && memFree / memTot < 0.05) probs.push('RAM gần hết (còn ' + memFree + ' MB)');
      if (la > cores * 2) probs.push('máy đang quá tải (tải ' + la.toFixed(1) + '/' + cores + ' nhân)');
      if (temp !== null && temp > 85) probs.push('nóng ' + Math.round(temp) + '°C');
      const info = 'ổ đĩa ' + (free === Infinity ? '?' : free + ' MB trống') + ' · RAM ' + memFree + '/' + memTot + ' MB trống · tải ' + la.toFixed(1) + (temp !== null ? ' · ' + Math.round(temp) + '°C' : '');
      return R('resources', 'Tài nguyên máy', probs.length ? 'fail' : 'ok', probs.length ? probs.join('; ') + ' (' + info + ')' : info);
    }),

    storage: () => safe('storage', 'Lưu trữ (cơ sở dữ liệu, thư mục ghi được)', async () => {
      const probs = [];
      if (o.db) { try { const r = o.db.raw.prepare('PRAGMA quick_check').get(); if (!r || Object.values(r)[0] !== 'ok') probs.push('cơ sở dữ liệu báo lỗi: ' + JSON.stringify(r)); } catch (e) { probs.push('cơ sở dữ liệu không trả lời: ' + e.message); } }
      for (const [label, dir] of Object.entries(o.writable || {})) {
        if (!dir) continue;
        try { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, '.tuchan-' + process.pid); fs.writeFileSync(f, 'x'); fs.rmSync(f, { force: true }); }
        catch (e) { probs.push(label + ' không ghi được (' + e.code + '): ' + dir); }
      }
      return R('storage', 'Lưu trữ', probs.length ? 'fail' : 'ok', probs.length ? probs.join('; ') : 'cơ sở dữ liệu nguyên vẹn, thư mục làm việc/OneDrive/điểm khôi phục ghi được');
    }),

    tools: () => safe('tools', 'Công cụ văn phòng và OCR', async () => {
      const miss = []; const have = [];
      for (const [bin, args] of [['soffice', ['--version']], ['agentos-office', ['--help']], ['tesseract', ['--list-langs']], ['pdftotext', ['-v']], ['xdotool', ['version']]]) {
        const r = await run(bin, args, 10000);
        if (r.missing) miss.push(bin); else if (bin === 'tesseract' && !/\bvie\b/.test(r.out + r.err)) miss.push('tesseract(thiếu tiếng Việt)'); else have.push(bin);
      }
      return R('tools', 'Công cụ văn phòng và OCR', miss.length ? (miss.length > 2 ? 'fail' : 'warn') : 'ok', miss.length ? 'thiếu: ' + miss.join(', ') : have.join(', ') + ' đều có');
    }),

    desk: () => safe('desk', 'Màn hình (điều khiển từ xa)', async () => {
      if (!o.desk) return R('desk', 'Màn hình', 'warn', 'chưa có trợ lý màn hình');
      const r = await o.desk.call({ cmd: 'who' });
      if (!r.ok) return R('desk', 'Màn hình', 'warn', r.error);
      if (r.locked) return R('desk', 'Màn hình', 'warn', 'màn hình đang KHÓA (' + r.user + '): gõ /mokhoa');
      return R('desk', 'Màn hình', 'ok', 'người dùng ' + r.user + ' đang đăng nhập, màn hình mở');
    }),

    network: () => safe('network', 'Mạng và Tailscale', async () => {
      const parts = []; let st = 'ok';
      try { const r = await fetch('https://api.telegram.org', { method: 'HEAD', signal: AbortSignal.timeout(6000) }); parts.push('ra Internet được (HTTP ' + r.status + ')'); } catch (e) { parts.push('KHÔNG ra được Internet'); st = 'fail'; }
      if (o.tailscale) { try { const i = await o.tailscale.info(); parts.push(i.state === 'Running' ? 'Tailscale ' + (i.ips[0] || '') : 'Tailscale: ' + i.state); if (i.state !== 'Running' && st === 'ok') st = 'warn'; } catch (e) { parts.push('Tailscale lỗi'); } }
      return R('network', 'Mạng và Tailscale', st, parts.join(' · '));
    }),

    queue: () => safe('queue', 'Hàng đợi việc', async () => {
      if (!o.db) return R('queue', 'Hàng đợi việc', 'ok', '');
      const waiting = o.db.waitingCount ? o.db.waitingCount() : 0, queued = o.db.queuedCount();
      return R('queue', 'Hàng đợi việc', waiting ? 'warn' : 'ok', queued + ' việc chờ' + (waiting ? ', ' + waiting + ' việc chờ AI hồi hạn mức' : '') + (o.currentJob && o.currentJob() ? ', đang chạy #' + o.currentJob() : ', không có việc đang chạy'));
    }),
  };

  const LIGHT = ['telegram', 'services', 'engines', 'resources', 'storage', 'queue'];
  const FULL = ['telegram', 'services', 'engines', 'resources', 'storage', 'tools', 'desk', 'network', 'queue'];

  async function runList(ids) { const out = []; for (const id of ids) out.push(await checks[id]()); return out; }

  // Hỏi thử từng AI một câu ngắn (tốn một ít hạn mức): chạy qua đúng đường chạy thật của máy
  async function aiPing(engineNames, startFn) {
    const out = [];
    for (const name of engineNames) {
      const t0 = Date.now();
      try {
        const h = startFn(name, 'Chỉ trả lời đúng một từ: OK');
        const to = new Promise((res) => setTimeout(() => { try { h.kill('timeout'); } catch (e) { /* đã dừng */ } res({ ok: false, error: 'quá 90 giây' }); }, 90000).unref());
        const r = await Promise.race([h.done, to]);
        const ok = r.ok && /\bOK\b/i.test(r.text || '');
        out.push(R('ai-' + name, 'Thử hỏi ' + name, ok ? 'ok' : (r.ok ? 'warn' : 'fail'), ok ? 'trả lời sau ' + Math.round((Date.now() - t0) / 1000) + ' giây' : (r.ok ? 'trả lời lạ: ' + String(r.text).slice(0, 40) : (r.limit ? 'hết hạn mức' : String(r.error || 'lỗi').slice(0, 120)))));
      } catch (e) { out.push(R('ai-' + name, 'Thử hỏi ' + name, 'fail', e.message)); }
    }
    return out;
  }

  return {
    light: () => runList(LIGHT),
    async full(opts) {
      const base = await runList(FULL);
      if (opts && opts.ai && opts.startFn) base.push(...await aiPing(opts.engineNames || [], opts.startFn));
      return base;
    },
    format(results, title) {
      const ICON = { ok: '✅', warn: '⚠️', fail: '❌' };
      const bad = results.filter((r) => r.status === 'fail').length, warn = results.filter((r) => r.status === 'warn').length;
      return (title || '🩺 Tự chẩn đoán') + ': ' + (bad ? bad + ' lỗi' : warn ? 'ổn, ' + warn + ' lưu ý' : 'mọi thứ ổn') + '\n' + results.map((r) => ICON[r.status] + ' ' + r.name + (r.detail ? ' — ' + r.detail : '')).join('\n');
    },
    checks,
  };
}

module.exports = { createSelfTest };
