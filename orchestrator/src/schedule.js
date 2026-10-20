'use strict';
const fs = require('fs');
const path = require('path');
const { noAccent } = require('./kiotviet');

// BÁO CÁO TỰ ĐỘNG + HẸN GIỜ. Giờ tính theo giờ Việt Nam (UTC+7), không phụ thuộc múi giờ của máy.
//   /baocao                 chạy báo cáo ngay (doanh số hôm nay, hàng sắp hết, ổ đĩa, sao lưu)
//   /baocao gio 21:30       đổi giờ gửi báo cáo hằng ngày  ·  /baocao tat  ·  /baocao bat
//   /hen 08:00 <việc>       mỗi ngày đúng giờ đó giao <việc> cho AI (như chủ máy vừa nhắn)
//   /hen                    xem danh sách  ·  /hen xoa <số>
// Máy tắt đúng giờ hẹn: bật lại trong vòng 2 giờ sau giờ hẹn thì vẫn chạy bù (mỗi ngày tối đa một lần).
const KEY = 'sched';
const MAX_JOBS = 20, LATE_MIN = 120;
const pad = (n) => String(n).padStart(2, '0');

function parseTime(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})(?:[:hH](\d{2})?)?$/);
  if (!m) return null;
  const h = Number(m[1]), mi = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return pad(h) + ':' + pad(mi);
}
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

function createSchedule(o) {
  const db = o.db, kv = o.kiotviet, log = o.log || (() => {});
  const now = o.now || (() => Date.now());
  const notify = o.notify, submitJob = o.submitJob;
  const admins = o.admins || [];
  const diskFreeMb = o.diskFreeMb || (() => Infinity);
  const dataDir = o.oneDriveDir || '';
  const backupDir = o.backupDir || (dataDir ? path.join(dataDir, 'AgentOS', 'sao-luu') : '');
  const defaultTime = o.defaultReportTime || '21:30';

  function load() {
    let s = null;
    try { s = JSON.parse(db.kvGet(KEY) || 'null'); } catch (e) { /* hỏng -> mặc định */ }
    s = s || {};
    s.report = Object.assign({ enabled: true, time: defaultTime, last: '' }, s.report || {});
    s.jobs = Array.isArray(s.jobs) ? s.jobs : [];
    s.nextId = s.nextId || 1;
    return s;
  }
  const save = (s) => db.kvSet(KEY, JSON.stringify(s));
  function vn(ms) {
    const d = new Date((ms === undefined ? now() : ms) + 7 * 3600 * 1000);
    return { date: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()), min: d.getUTCHours() * 60 + d.getUTCMinutes(), show: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' ' + pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) };
  }

  function lastBackup() {
    try {
      const f = fs.readdirSync(backupDir).filter((x) => /^agentos-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(x)).sort().pop();
      return f ? f.slice(8, 18) : null;
    } catch (e) { return null; }
  }

  async function buildReport() {
    const t = vn();
    const lines = ['📋 Báo cáo AgentOS · ' + t.show];
    if (kv && kv.configured()) {
      try { lines.push(await kv.revenue('')); } catch (e) { lines.push('📊 Doanh số: không đọc được KiotViet (' + e.message + ')'); }
      try {
        const low = await kv.lowStock(12);
        if (!low.total) lines.push('📦 Không có hàng nào chạm mức tồn tối thiểu đã đặt trong KiotViet.');
        else lines.push('📦 ' + low.total + ' mặt hàng sắp hết (tồn ≤ mức tối thiểu)' + (low.total > low.items.length ? ', ' + low.items.length + ' mặt đầu' : '') + ':\n' +
          low.items.map((i) => '• ' + i.name + ' (' + i.code + '): còn ' + i.onHand + ' / tối thiểu ' + i.min).join('\n'));
      } catch (e) { lines.push('📦 Tồn kho: không đọc được KiotViet (' + e.message + ')'); }
    } else lines.push('📊 Doanh số/tồn kho: chưa cấu hình KiotViet (chạy dat-khoa-kiotviet.sh).');
    const free = diskFreeMb();
    lines.push('💾 Ổ đĩa còn ' + (free === Infinity ? '?' : (free >= 1024 ? (free / 1024).toFixed(1) + ' GB' : free + ' MB')) + (free !== Infinity && free < 2048 ? ' ⚠️ sắp đầy' : ''));
    const b = lastBackup();
    lines.push('🗂️ Sao lưu lên OneDrive gần nhất: ' + (b || 'chưa có') + (b && b < vn(now() - 3 * 86400000).date ? ' ⚠️ đã quá 3 ngày' : ''));
    const q = db.queuedCount ? db.queuedCount() : 0;
    if (q) lines.push('⏳ Việc AI đang chờ: ' + q);
    return lines.join('\n');
  }

  function archive(text) {
    if (!dataDir) return;
    try {
      const d = path.join(dataDir, 'AgentOS', 'bao-cao');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, vn().date + '.md'), text + '\n');
    } catch (e) { /* OneDrive chưa sẵn sàng: bỏ qua, vẫn gửi Telegram */ }
  }

  async function runReport(sendTo) {
    const text = await buildReport();
    archive(text);
    if (sendTo) for (const a of sendTo) { try { await notify(a, text); } catch (e) { log('gửi báo cáo lỗi: ' + e.message); } }
    return text;
  }

  // Gọi định kỳ (30 giây/lần). Trả số việc đã kích hoạt (để test).
  async function tick() {
    const s = load(), t = vn();
    let fired = 0, dirty = false;
    const due = (time, last) => last !== t.date && t.min >= minutes(time) && t.min - minutes(time) <= LATE_MIN;
    if (s.report.enabled && due(s.report.time, s.report.last)) {
      s.report.last = t.date; dirty = true; fired++;
      save(s);                                               // ghi trước: lỗi giữa chừng cũng không gửi lặp
      runReport(admins).catch((e) => log('báo cáo lỗi: ' + e.message));
    }
    for (const j of s.jobs) {
      if (!due(j.time, j.last)) continue;
      j.last = t.date; dirty = true; fired++;
      save(s);
      try { submitJob(j.chatId, j.text); log('hẹn giờ #' + j.id + ' đã giao việc cho AI'); } catch (e) { log('hẹn giờ #' + j.id + ' lỗi: ' + e.message); }
    }
    if (dirty) save(s);
    return fired;
  }

  async function command(name, arg, ctx) {
    arg = String(arg || '').trim();
    const s = load();
    if (name === 'baocao') {
      const a = noAccent(arg);
      if (!a) return await runReport(null);
      let m;
      if ((m = arg.match(/^gi[oờ]\s+(.+)$/i)) || (m = a.match(/^gio (.+)$/))) {
        const tm = parseTime(m[1]);
        if (!tm) return 'Giờ không hiểu được. Ví dụ: /baocao gio 21:30';
        s.report.time = tm; s.report.enabled = true; s.report.last = ''; save(s);
        return '✅ Báo cáo hằng ngày sẽ gửi lúc ' + tm + ' (giờ Việt Nam).';
      }
      if (a === 'tat') { s.report.enabled = false; save(s); return '⏸️ Đã tắt báo cáo hằng ngày. Gõ /baocao bat để bật lại.'; }
      if (a === 'bat') { s.report.enabled = true; save(s); return '✅ Đã bật báo cáo hằng ngày lúc ' + s.report.time + '.'; }
      return 'Cách dùng: /baocao (xem ngay) · /baocao gio 21:30 · /baocao tat · /baocao bat\nHiện tại: ' + (s.report.enabled ? 'gửi lúc ' + s.report.time : 'đang tắt') + '.';
    }
    // /hen
    const a = noAccent(arg);
    if (!a) {
      return '⏰ Báo cáo hằng ngày: ' + (s.report.enabled ? s.report.time : 'tắt') + '\n' +
        (s.jobs.length ? 'Việc hẹn giờ (mỗi ngày):\n' + s.jobs.map((j) => '#' + j.id + ' ' + j.time + ' · ' + j.text.slice(0, 80).replace(/\s+/g, ' ')).join('\n') : 'Chưa có việc hẹn giờ nào.') +
        '\nThêm: /hen 08:00 <việc cho AI> · Xóa: /hen xoa <số>';
    }
    let m = a.match(/^(?:xoa|huy|bo) #?(\d+)$/);
    if (m) {
      const id = Number(m[1]), n = s.jobs.length;
      s.jobs = s.jobs.filter((j) => j.id !== id);
      if (s.jobs.length === n) return 'Không có việc hẹn giờ #' + id + '.';
      save(s); return '🗑️ Đã xóa việc hẹn giờ #' + id + '.';
    }
    m = arg.match(/^(\S+)\s+([\s\S]+)$/);
    const tm = m && parseTime(m[1]);
    if (!tm) return 'Cách dùng: /hen 08:00 <việc cho AI>, ví dụ /hen 08:00 tóm tắt email và việc cần làm hôm nay\nHoặc /hen (xem danh sách) · /hen xoa <số>';
    if (s.jobs.length >= MAX_JOBS) return 'Đã đủ ' + MAX_JOBS + ' việc hẹn giờ. Xóa bớt bằng /hen xoa <số>.';
    const job = { id: s.nextId++, time: tm, text: m[2].trim().slice(0, 2000), chatId: String((ctx && ctx.chatId) || admins[0] || ''), last: '' };
    s.jobs.push(job); save(s);
    return '✅ Đã hẹn #' + job.id + ': mỗi ngày lúc ' + tm + ' (giờ Việt Nam) giao cho AI: ' + job.text.slice(0, 100) + '\nDùng AI mặc định, tính vào hạn mức như bình thường. Xóa: /hen xoa ' + job.id;
  }

  return { tick, command, buildReport, runReport, parseTime, load };
}

module.exports = { createSchedule, parseTime };
