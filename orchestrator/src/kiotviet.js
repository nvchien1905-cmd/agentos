'use strict';
// KiotViet qua API CHÍNH THỨC (chỉ đọc): doanh số theo ngày/tuần/tháng và tồn kho. Ổn định hơn nhiều so với để AI bấm chuột trên trang KiotViet.
// Cấu hình trong /etc/agentos/orchestrator.env: KIOTVIET_CLIENT_ID, KIOTVIET_CLIENT_SECRET, KIOTVIET_RETAILER (tên cửa hàng).
const API = 'https://public.kiotapi.com';
const TOKEN_URL = 'https://id.kiotviet.vn/connect/token';
const STATUS_DONE = 1;                      // hóa đơn "Hoàn thành"

const noAccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const money = (n) => Math.round(Number(n) || 0).toLocaleString('vi-VN') + 'đ';
const pad = (n) => String(n).padStart(2, '0');

// Ngày theo giờ Việt Nam (UTC+7), không phụ thuộc múi giờ của máy.
function vnDate(offsetDays, nowMs) {
  const d = new Date((nowMs === undefined ? Date.now() : nowMs) + 7 * 3600 * 1000 + (offsetDays || 0) * 86400000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay(), iso: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()), show: pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() };
}

// Hiểu cách người dùng gõ khoảng thời gian: "", "hôm nay", "hôm qua", "tuần", "tháng".
function parseRange(arg, nowMs) {
  const a = noAccent(arg);
  if (!a || /^(hom nay|nay|homnay|today)$/.test(a)) { const t = vnDate(0, nowMs); return { key: 'homnay', title: 'hôm nay (' + t.show + ')', from: t.iso, to: vnDate(1, nowMs).iso }; }
  if (/^(hom qua|qua|homqua|yesterday)$/.test(a)) { const t = vnDate(-1, nowMs); return { key: 'homqua', title: 'hôm qua (' + t.show + ')', from: t.iso, to: vnDate(0, nowMs).iso }; }
  if (/^(tuan|tuan nay)$/.test(a)) { const t = vnDate(0, nowMs); const back = (t.dow + 6) % 7; const s = vnDate(-back, nowMs); return { key: 'tuan', title: 'tuần này (từ ' + s.show + ')', from: s.iso, to: vnDate(1, nowMs).iso }; }
  if (/^(thang|thang nay)$/.test(a)) { const t = vnDate(0, nowMs); return { key: 'thang', title: 'tháng này (' + pad(t.m) + '/' + t.y + ')', from: t.y + '-' + pad(t.m) + '-01', to: vnDate(1, nowMs).iso }; }
  return null;
}

function createKiotViet(o) {
  o = o || {};
  const f = o.fetch || fetch;
  const cfg = { id: o.clientId || '', secret: o.clientSecret || '', retailer: o.retailer || '' };
  let token = null, tokenExp = 0;

  async function getToken() {
    if (token && Date.now() < tokenExp) return token;
    const r = await f(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ scopes: 'PublicApi.Access', grant_type: 'client_credentials', client_id: cfg.id, client_secret: cfg.secret }) });
    if (!r.ok) throw new Error('KiotViet từ chối đăng nhập API (HTTP ' + r.status + '). Kiểm tra KIOTVIET_CLIENT_ID / KIOTVIET_CLIENT_SECRET.');
    const d = await r.json();
    token = d.access_token; tokenExp = Date.now() + ((d.expires_in || 3600) - 120) * 1000;
    return token;
  }
  async function get(pathAndQuery, retried) {
    const r = await f(API + pathAndQuery, { headers: { Authorization: 'Bearer ' + (await getToken()), Retailer: cfg.retailer } });
    if (r.status === 401 && !retried) { token = null; return get(pathAndQuery, true); }
    if (!r.ok) throw new Error('KiotViet lỗi ' + r.status + ' khi đọc ' + pathAndQuery.split('?')[0]);
    return r.json();
  }

  return {
    configured: () => !!(cfg.id && cfg.secret && cfg.retailer),
    parseRange,

    async revenue(arg, nowMs) {
      const range = parseRange(arg, nowMs);
      if (!range) return 'Khoảng thời gian không hiểu được. Gõ: /doanhso (hôm nay), /doanhso hôm qua, /doanhso tuần, /doanhso tháng';
      const all = [];
      for (let cur = 0; cur < 20000; cur += 100) {
        const qs = new URLSearchParams({ pageSize: '100', currentItem: String(cur), fromPurchaseDate: range.from, toPurchaseDate: range.to, orderBy: 'purchaseDate', orderDirection: 'Asc' });
        const d = await get('/invoices?' + qs.toString());
        const items = d.data || [];
        all.push(...items);
        if (items.length < 100 || all.length >= (d.total || 0)) break;
      }
      // KiotViet có thể trả cả ngày kế tiếp ở biên: lọc lại theo ngày mua
      const inRange = all.filter((i) => { const day = String(i.purchaseDate || '').slice(0, 10); return day >= range.from && day < range.to; });
      const done = inRange.filter((i) => i.status === STATUS_DONE);
      const cancelled = inRange.filter((i) => i.status !== STATUS_DONE).length;
      if (!done.length) return '📊 Doanh số ' + range.title + ': chưa có hóa đơn hoàn thành nào.' + (cancelled ? ' (' + cancelled + ' hóa đơn đã hủy/chưa hoàn thành)' : '');
      const by = new Map();
      for (const i of done) { const k = i.branchName || 'Chi nhánh ?'; const e = by.get(k) || { n: 0, sum: 0 }; e.n += 1; e.sum += Number(i.total) || 0; by.set(k, e); }
      const rows = [...by.entries()].sort((a, b) => b[1].sum - a[1].sum).map(([k, e]) => '• ' + k + ': ' + e.n + ' hóa đơn · ' + money(e.sum));
      const total = done.reduce((s, i) => s + (Number(i.total) || 0), 0);
      return ['📊 Doanh số ' + range.title, ...rows, 'Tổng: ' + done.length + ' hóa đơn · ' + money(total) + (cancelled ? '  (không tính ' + cancelled + ' hóa đơn hủy/chưa hoàn thành)' : ''),
        'Tính theo tiền hàng sau giảm giá của hóa đơn hoàn thành.'].join('\n');
    },

    async stock(query) {
      const q = String(query || '').trim();
      if (q.length < 2) return 'Cách dùng: /ton <tên hoặc mã sản phẩm>, ví dụ /ton nồi chiên';
      const qs = new URLSearchParams({ name: q, includeInventory: 'true', pageSize: '6' });
      let d = await get('/products?' + qs.toString());
      let items = d.data || [];
      if (!items.length && /^[A-Za-z0-9._-]+$/.test(q)) {                         // gõ mã sản phẩm
        try { const p = await get('/products/code/' + encodeURIComponent(q)); if (p && p.id) items = [p]; } catch (e) { /* không có mã đó */ }
      }
      if (!items.length) return 'Không thấy sản phẩm nào khớp "' + q + '".';
      const out = items.slice(0, 5).map((p) => {
        const inv = (p.inventories || []).filter((x) => Number(x.onHand) !== 0).map((x) => x.branchName + ': ' + Number(x.onHand));
        const sum = (p.inventories || []).reduce((s, x) => s + (Number(x.onHand) || 0), 0);
        return '• ' + (p.name || '?') + ' (' + (p.code || '?') + ') · giá ' + money(p.basePrice) + '\n   Tồn: ' + (inv.length ? inv.join(' · ') + ' → tổng ' + sum : 'hết hàng ở mọi chi nhánh');
      });
      return '📦 Tồn kho "' + q + '"' + (d.total > 5 ? ' (5/' + d.total + ' sản phẩm đầu)' : '') + '\n' + out.join('\n');
    },
  };
}

module.exports = { createKiotViet, parseRange, vnDate, noAccent, money };
