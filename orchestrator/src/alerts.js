'use strict';

// CẢNH BÁO CHỦ ĐỘNG (không tốn hạn mức AI): bot tự nhắn chủ máy khi số liệu KiotViet có chuyện, không chờ hỏi.
//   - 📉 Doanh số TỤT: tại các giờ kiểm tra (mặc định 15h, 19h, 21h giờ VN) so doanh số hôm nay tới giờ đó với TRUNG BÌNH 4 tuần cùng thứ, cùng giờ.
//        Thấp hơn ngưỡng (mặc định còn dưới 50%) và nền đủ lớn (≥ 1 triệu) thì báo. Mỗi giờ kiểm tra một lần/ngày.
//   - 📦 Hàng MỚI sắp hết: cứ 2 giờ quét; mặt hàng vừa chạm mức tồn tối thiểu (chưa báo) thì báo; còn thiếu sau 7 ngày thì nhắc lại.
// Bật/tắt và xem số liệu bằng /canhbao. Chưa làm "khách quan trọng lâu chưa quay lại": cần kiểm trường ngày mua gần nhất của API khách hàng KiotViet trên dữ liệu thật.
const DEFAULTS = { salesDrop: { on: true, hours: [15, 19, 21], ratio: 0.5, minBase: 1000000 }, lowStock: { on: true, everyHours: 2, repeatDays: 7 } };
const pad = (n) => String(n).padStart(2, '0');
const vn = (ms) => { const d = new Date(ms + 7 * 3600 * 1000); return { date: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()), hour: d.getUTCHours(), min: d.getUTCMinutes(), time: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()), ms }; };
const addDays = (isoDate, n) => { const [y, m, d] = isoDate.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); };
const money = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' triệu' : Math.round(n).toLocaleString('vi-VN') + 'đ');
const DONE = 1;                          // trạng thái hóa đơn "Hoàn thành" của KiotViet

function createAlerts(o) {
  const { kiotviet, db, notify } = o, admins = o.admins || [], log = o.log || (() => {}), now = o.now || Date.now;
  const load = () => { let j = {}; try { j = JSON.parse(db.kvGet('alerts') || '{}'); } catch (e) { /* mặc định */ } return { salesDrop: Object.assign({}, DEFAULTS.salesDrop, j.salesDrop || {}), lowStock: Object.assign({}, DEFAULTS.lowStock, j.lowStock || {}) }; };
  const save = (c) => db.kvSet('alerts', JSON.stringify(c));
  const state = () => { try { return JSON.parse(db.kvGet('alerts_state') || '{}'); } catch (e) { return {}; } };
  const saveState = (s) => db.kvSet('alerts_state', JSON.stringify(s));
  const tell = async (text) => { for (const a of admins) { try { await notify(a, text); } catch (e) { log('cảnh báo: không gửi được: ' + e.message); } } };

  // Tổng doanh số các hóa đơn hoàn thành của ngày `date` tính tới HH:MM `upTo`
  function sumUntil(list, date, upTo) {
    let s = 0, n = 0;
    for (const i of list) {
      if (i.status !== DONE) continue; const p = String(i.purchaseDate || '');
      if (p.slice(0, 10) !== date || p.slice(11, 16) > upTo) continue;
      s += Number(i.total) || 0; n++;
    }
    return { sum: s, n };
  }

  // So hôm nay với trung bình 4 tuần cùng thứ. Trả null nếu không đủ dữ liệu nền.
  async function salesCompare(t) {
    const c = load().salesDrop;
    const from = addDays(t.date, -28), to = addDays(t.date, 1);
    const list = await kiotviet.invoiceTotals(from, to);
    const today = sumUntil(list, t.date, t.time);
    const weeks = [1, 2, 3, 4].map((k) => sumUntil(list, addDays(t.date, -7 * k), t.time).sum).filter((x) => x > 0);
    if (weeks.length < 2) return { today, base: null };
    const base = weeks.reduce((a, b) => a + b, 0) / weeks.length;
    return { today, base, weeks: weeks.length, ratio: base > 0 ? today.sum / base : null, enough: base >= c.minBase };
  }

  async function checkSales() {
    const cfg = load().salesDrop; if (!cfg.on || !kiotviet || !kiotviet.configured || !kiotviet.configured() || !kiotviet.invoiceTotals) return null;
    const t = vn(now()), st = state(); st.sales = st.sales || {};
    const due = cfg.hours.filter((h) => t.hour >= h && t.hour < h + 3 && !st.sales[t.date + ':' + h]);        // trong 3 giờ sau mốc (máy bật muộn vẫn chạy bù), mỗi mốc một lần
    if (!due.length) return null;
    for (const h of due) st.sales[t.date + ':' + h] = 1;
    for (const k of Object.keys(st.sales)) if (k.slice(0, 10) < addDays(t.date, -2)) delete st.sales[k];
    saveState(st);
    const r = await salesCompare(t);
    if (!r.base || !r.enough || r.ratio >= cfg.ratio) return { alerted: false, r };
    const pct = Math.round((1 - r.ratio) * 100);
    await tell('📉 Doanh số hôm nay đến ' + t.time + ' mới ' + money(r.today.sum) + ' (' + r.today.n + ' hóa đơn), thấp hơn ' + pct + '% so với trung bình ' + r.weeks + ' tuần cùng thứ (' + money(r.base) + '). ' +
      'Đây chỉ là cảnh báo từ số liệu KiotViet: nên xem cửa hàng có chuyện gì không (mất điện, nghỉ, hệ thống lỗi...). Tắt: /canhbao doanhso tat');
    return { alerted: true, r };
  }

  async function checkLowStock() {
    const cfg = load().lowStock; if (!cfg.on || !kiotviet || !kiotviet.configured || !kiotviet.configured() || !kiotviet.lowStock) return null;
    const st = state(), t = now();
    if (st.lowAt && t - st.lowAt < cfg.everyHours * 3600000) return null;
    st.lowAt = t; saveState(st);
    const res = await kiotviet.lowStock(60, 60);
    const seen = st.low || {}, next = {}, fresh = [];
    for (const it of res.items) {
      const prev = seen[it.code]; next[it.code] = prev || t;
      if (!prev || t - prev > cfg.repeatDays * 86400000) { fresh.push(it); next[it.code] = t; }
    }
    const st2 = state(); st2.low = next; saveState(st2);                       // sản phẩm đã đủ hàng trở lại thì quên, lần sau hết lại báo mới
    if (!fresh.length) return { alerted: false, total: res.total };
    await tell('📦 ' + fresh.length + ' mặt hàng MỚI sắp hết (tồn ≤ mức tối thiểu trong KiotViet):\n' + fresh.slice(0, 10).map((i) => '• ' + i.name + ' (' + i.code + '): còn ' + i.onHand + ' / tối thiểu ' + i.min).join('\n') + (fresh.length > 10 ? '\n…và ' + (fresh.length - 10) + ' mặt hàng nữa (xem /baocao).' : '') + '\nTắt: /canhbao tonkho tat');
    return { alerted: true, total: res.total, fresh };
  }

  async function tick() {
    const out = {};
    try { out.sales = await checkSales(); } catch (e) { log('cảnh báo doanh số lỗi: ' + e.message); }
    try { out.low = await checkLowStock(); } catch (e) { log('cảnh báo tồn kho lỗi: ' + e.message); }
    return out;
  }

  // Lệnh /canhbao: xem, bật/tắt, kiểm tra ngay (cho số liệu thật, không gửi cảnh báo)
  async function command(arg) {
    const w = String(arg || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').trim().replace(/\s+/g, ' ');
    const c = load();
    let m;
    if ((m = w.match(/^(doanhso|tonkho) (bat|tat)$/))) {
      const key = m[1] === 'doanhso' ? 'salesDrop' : 'lowStock'; c[key].on = m[2] === 'bat'; save(c);
      return '✅ Cảnh báo ' + (key === 'salesDrop' ? 'doanh số tụt' : 'hàng mới sắp hết') + ': ' + (c[key].on ? 'BẬT' : 'tắt') + '.';
    }
    if ((m = w.match(/^doanhso (\d{1,2})$/))) { const r = Number(m[1]); if (r < 10 || r > 90) return 'Ngưỡng từ 10 đến 90 (%): ví dụ /canhbao doanhso 50 = báo khi doanh số còn dưới 50% mức thường.'; c.salesDrop.ratio = r / 100; save(c); return '✅ Báo khi doanh số tới giờ kiểm tra còn dưới ' + r + '% trung bình 4 tuần cùng thứ.'; }
    if (w === 'kiemtra') {
      if (!kiotviet || !kiotviet.configured || !kiotviet.configured() || !kiotviet.invoiceTotals) return '⚠️ Chưa nối KiotViet.';
      const t = vn(now()), r = await salesCompare(t);
      if (!r.base) return '📊 Chưa đủ dữ liệu 4 tuần cùng thứ để so sánh (cần ít nhất 2 tuần có bán).';
      return '📊 Đến ' + t.time + ': hôm nay ' + money(r.today.sum) + ' (' + r.today.n + ' hóa đơn) · trung bình ' + r.weeks + ' tuần cùng thứ ' + money(r.base) + ' · ' + Math.round(r.ratio * 100) + '% (báo khi dưới ' + Math.round(c.salesDrop.ratio * 100) + '%' + (r.enough ? '' : ', nhưng nền dưới ' + money(c.salesDrop.minBase) + ' nên không báo') + ').';
    }
    return '🔔 Cảnh báo chủ động (không tốn hạn mức AI):\n• Doanh số tụt: ' + (c.salesDrop.on ? 'BẬT' : 'tắt') + ' — kiểm tra lúc ' + c.salesDrop.hours.join('h, ') + 'h, báo khi còn dưới ' + Math.round(c.salesDrop.ratio * 100) + '% trung bình 4 tuần cùng thứ\n• Hàng mới sắp hết: ' + (c.lowStock.on ? 'BẬT' : 'tắt') + ' — quét mỗi ' + c.lowStock.everyHours + ' giờ\n' +
      'Lệnh: /canhbao doanhso bat|tat · /canhbao tonkho bat|tat · /canhbao doanhso <ngưỡng %> · /canhbao kiemtra (xem số liệu hiện tại)';
  }

  return { tick, checkSales, checkLowStock, command, salesCompare, load, start(ms) { const t = setInterval(() => tick().catch(() => {}), ms || 5 * 60 * 1000); if (t.unref) t.unref(); return t; } };
}

module.exports = { createAlerts, DEFAULTS, addDays };
