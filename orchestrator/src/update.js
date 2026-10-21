'use strict';
const fs = require('fs');
const cp = require('child_process');
const { noAccent } = require('./kiotviet');

// CẬP NHẬT PHẦN MỀM từ xa qua Telegram (không boot lại). Bộ điều phối chỉ HỎI phiên bản mới và GỬI YÊU CẦU; việc tải/kiểm chữ ký/cài do dịch vụ root
// `agentos-update` làm (xem update/updater.js): chỉ gói do chủ dự án KÝ mới được cài, lỗi thì tự khôi phục.
//   /capnhat              phiên bản đang cài + bản mới nhất       /capnhat co [ep]   cài ngay (đang có việc AI chạy thì cần "ep")
//   /capnhat tudong bat|tat   tự cài trong khung 02:00-05:00 giờ VN khi máy rảnh (mặc định TẮT: chỉ báo có bản mới)
//   /capnhat hedieuhanh [co]  cập nhật HỆ ĐIỀU HÀNH Debian (gói hệ thống: Linux, Chrome, LibreOffice...) lên bản mới nhất; dịch vụ root agentos-os-update làm
const DEFAULT_URL = 'https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/updates/';
const CHECK_EVERY_MS = 3 * 3600 * 1000;
const cmpVersion = (a, b) => {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0), pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
};

function createUpdateWatcher(o) {
  const db = o.db, log = o.log || (() => {});
  const f = o.fetch || fetch;
  const now = o.now || (() => Date.now());
  const url = String(o.url || DEFAULT_URL).replace(/\/?$/, '/');
  const versionFile = o.versionFile || '/opt/agentos/VERSION';
  const requestFile = o.requestFile || '/var/lib/agentos/update-request';
  const resultFile = o.resultFile || '/var/lib/agentos/update-result.json';
  const osRequestFile = o.osRequestFile || '/var/lib/agentos/os-update-request';
  const osResultFile = o.osResultFile || '/var/lib/agentos/os-update-result.json';
  const rebootFile = o.rebootFile || '/var/run/reboot-required';
  const sh = o.run || ((cmd, args) => new Promise((resolve) => cp.execFile(cmd, args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve({ code: err ? 1 : 0, out: String(out || '') }))));
  const notify = o.notify, admins = o.admins || [];
  const idle = o.idle || (() => true);

  const installed = () => { try { return fs.readFileSync(versionFile, 'utf8').trim() || '0'; } catch (e) { return '0'; } };
  const autoOn = () => db.kvGet('update:auto') === '1';

  async function latest() {
    const r = await f(url + 'manifest.json', { signal: AbortSignal.timeout(30000), headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = await r.json();
    if (!m || !/^\d+(\.\d+){1,3}$/.test(String(m.version))) throw new Error('manifest không hợp lệ');
    return { version: String(m.version), notes: String(m.notes || '').slice(0, 600), date: String(m.date || '') };
  }

  function vnHour(ms) { return new Date((ms === undefined ? now() : ms) + 7 * 3600 * 1000).getUTCHours(); }

  function request() {
    fs.writeFileSync(requestFile, JSON.stringify({ at: new Date(now()).toISOString() }) + '\n');
  }

  // Cập nhật hệ điều hành (apt): bot chỉ XEM và GỬI YÊU CẦU; dịch vụ root agentos-os-update chạy apt-get update + dist-upgrade không hỏi.
  async function osCommand(rest) {
    const r = noAccent(rest);
    if (/^(co|ngay|capnhat|cai|ep)\b/.test(r)) {
      if (!/\bep\b/.test(r) && !idle()) return '⏳ Đang có việc AI chạy/chờ. Đợi xong rồi gõ /capnhat hedieuhanh co lại, hoặc /capnhat hedieuhanh co ep để làm ngay.';
      try { fs.writeFileSync(osRequestFile, JSON.stringify({ at: new Date(now()).toISOString() }) + '\n'); } catch (e) { return '⚠️ Không gửi được yêu cầu: ' + e.message; }
      return '⏳ Đã yêu cầu cập nhật hệ điều hành: máy tải danh sách gói mới rồi nâng cấp (vài phút tới vài chục phút tùy số gói). Xong bot nhắn kết quả; nếu cần khởi động lại sẽ báo.';
    }
    const s = await sh('apt-get', ['-s', 'dist-upgrade']);
    const pkgs = String(s.out).split('\n').filter((l) => l.startsWith('Inst ')).map((l) => l.split(' ')[1]);
    const lines = ['🖥️ Hệ điều hành (Debian)'];
    lines.push(pkgs.length ? pkgs.length + ' gói có bản mới (theo danh sách gói lần cập nhật gần nhất): ' + pkgs.slice(0, 15).join(', ') + (pkgs.length > 15 ? '...' : '') : 'Theo danh sách gói gần nhất: đã mới nhất (máy tự tải danh sách mới khi bạn cập nhật).');
    if (fs.existsSync(rebootFile)) lines.push('⚠️ Máy đang chờ khởi động lại để hoàn tất cập nhật trước (gõ /khoimay co).');
    lines.push('Gõ /capnhat hedieuhanh co để cập nhật lên bản mới nhất.');
    return lines.join('\n');
  }

  async function command(arg) {
    const a = noAccent(arg);
    const om = a.match(/^(he dieu hanh|hedieuhanh|he thong|hethong|hdh|os|debian)\b\s*(.*)$/);
    if (om) return osCommand(om[2]);
    if (a === 'tudong bat' || a === 'tudong tat') {
      db.kvSet('update:auto', a === 'tudong bat' ? '1' : '0');
      return a === 'tudong bat' ? '✅ Đã bật tự cập nhật: khi có bản mới, máy tự cài trong khung 02:00-05:00 (giờ VN) lúc không có việc AI. Gõ /capnhat tudong tat để tắt.' : '⏸️ Đã tắt tự cập nhật (vẫn báo khi có bản mới).';
    }
    let lat;
    try { lat = await latest(); } catch (e) { return '⚠️ Không hỏi được phiên bản mới (' + e.message + '). Đang cài: ' + installed() + '.'; }
    const inst = installed();
    const newer = cmpVersion(lat.version, inst) > 0;
    if (/^(co|ngay|capnhat|cai|ep)\b/.test(a)) {
      if (!newer) return '✅ Đã là bản mới nhất (' + inst + ').';
      if (!/\bep\b/.test(a) && !idle()) return '⏳ Đang có việc AI chạy/chờ — cập nhật sẽ khởi động lại bộ điều phối. Đợi xong rồi gõ /capnhat co lại, hoặc /capnhat co ep để cài ngay (việc đang chạy bị ngắt).';
      try { request(); } catch (e) { return '⚠️ Không gửi được yêu cầu cập nhật: ' + e.message; }
      return '⏳ Đã yêu cầu cập nhật ' + inst + ' → ' + lat.version + '. Máy tải, kiểm chữ ký rồi cài (khoảng 1-2 phút, bộ điều phối khởi động lại); bot sẽ nhắn kết quả. Có lỗi thì tự khôi phục bản cũ.';
    }
    return '🔄 Phần mềm AgentOS\nĐang cài: ' + inst + '\nMới nhất: ' + lat.version + (lat.date ? ' (' + lat.date + ')' : '') + (newer ? '  → CÓ BẢN MỚI' : '  (đã mới nhất)') +
      (newer && lat.notes ? '\nNội dung: ' + lat.notes : '') + '\nTự cập nhật: ' + (autoOn() ? 'BẬT' : 'tắt') + (newer ? '\nGõ /capnhat co để cài.' : '') + '\n/capnhat tudong bat|tat · /capnhat co [ep]';
  }

  // Gọi định kỳ (30 giây/lần): hỏi bản mới tối đa mỗi 3 giờ, báo một lần cho mỗi phiên bản, tự cài nếu được bật.
  async function tick() {
    const last = Number(db.kvGet('update:lastCheck')) || 0;
    if (now() - last < CHECK_EVERY_MS) return null;
    db.kvSet('update:lastCheck', now());
    let lat; try { lat = await latest(); } catch (e) { log('hỏi bản cập nhật lỗi: ' + e.message); return null; }
    const inst = installed();
    if (cmpVersion(lat.version, inst) <= 0) return null;
    let did = null;
    if (db.kvGet('update:notified') !== lat.version) {
      db.kvSet('update:notified', lat.version);
      for (const a of admins) { try { await notify(a, '🔔 Có phiên bản AgentOS mới: ' + lat.version + ' (đang cài ' + inst + ')' + (lat.notes ? '\n' + lat.notes : '') + '\nGõ /capnhat co để cập nhật' + (autoOn() ? ' (hoặc đợi 02:00-05:00, máy tự cập nhật)' : '') + '.'); } catch (e) { log('báo bản mới lỗi: ' + e.message); } }
      did = 'notified';
    }
    return did;
  }
  // Khung tự cài: gọi mỗi 30 giây từ tick của bộ điều phối (khác tick() ở chỗ không bị giới hạn 3 giờ, nhưng chỉ chạy trong khung giờ)
  async function autoTick() {
    if (!autoOn()) return false;
    const h = vnHour();
    if (h < 2 || h >= 5 || !idle()) return false;
    const tried = db.kvGet('update:autoTry') || '';
    if (tried && now() - Number(tried.split('@')[1] || 0) < 6 * 3600 * 1000) return false;
    let lat; try { lat = await latest(); } catch (e) { return false; }
    if (cmpVersion(lat.version, installed()) <= 0) return false;
    db.kvSet('update:autoTry', lat.version + '@' + now());
    request();
    log('tự cập nhật: đã yêu cầu ' + installed() + ' → ' + lat.version);
    return true;
  }

  // Khi bộ điều phối vừa khởi động lại: có kết quả cập nhật mới chưa báo thì báo cho quản trị viên.
  async function announceResult() {
    // kết quả cập nhật hệ điều hành (apt)
    try {
      const os = JSON.parse(fs.readFileSync(osResultFile, 'utf8'));
      if (os && os.at && db.kvGet('update:lastOsResultAt') !== os.at) {
        db.kvSet('update:lastOsResultAt', os.at);
        const t = os.ok
          ? '✅ Đã cập nhật hệ điều hành: ' + (os.upgraded || 0) + ' gói được nâng cấp.' + (os.rebootRequired ? '\n⚠️ Cần khởi động lại để hoàn tất: gõ /khoimay co.' : '')
          : '⚠️ Cập nhật hệ điều hành KHÔNG thành công: ' + (os.error || 'lỗi') + (os.tail ? '\n' + os.tail : '');
        for (const adm of admins) { try { await notify(adm, t); } catch (e) { log('báo kết quả cập nhật hệ điều hành lỗi: ' + e.message); } }
      }
    } catch (e) { /* chưa có */ }
    let r; try { r = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { return null; }
    if (!r || !r.at || db.kvGet('update:lastResultAt') === r.at) return null;
    db.kvSet('update:lastResultAt', r.at);
    const text = r.ok ? '✅ Đã cập nhật AgentOS ' + r.from + ' → ' + r.to + '.' + (r.notes ? '\n' + r.notes : '')
      : '⚠️ Cập nhật ' + (r.from || '?') + ' → ' + (r.to || '?') + ' KHÔNG thành công: ' + (r.error || r.code) + (r.rolledBack ? '\nĐã khôi phục bản cũ, máy vẫn chạy bình thường.' : '');
    for (const a of admins) { try { await notify(a, text); } catch (e) { log('báo kết quả cập nhật lỗi: ' + e.message); } }
    return r;
  }

  return { command, tick, autoTick, announceResult, installed, latest };
}

module.exports = { createUpdateWatcher, cmpVersion, DEFAULT_URL };
