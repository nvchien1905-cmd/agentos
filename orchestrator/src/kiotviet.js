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

// Các nhóm dữ liệu AI được ĐỌC qua API (không có ghi/sửa/xóa: chỉ GET)
const READ_PATHS = new Set(['invoices', 'products', 'customers', 'branches', 'categories', 'orders', 'purchaseorders', 'returns', 'suppliers', 'users', 'pricebooks', 'transfers', 'trademarks', 'salechannels', 'vouchers', 'cashflow', 'surchages', 'bankaccounts', 'productattributes']);
function checkReadPath(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith('/') || s.startsWith('//') || /\.\.|[\s\\]/.test(s) || /^\/[a-z]+:/i.test(s)) return { ok: false, error: 'Đường dẫn KiotViet không hợp lệ: ' + s.slice(0, 80) + ' (ví dụ /invoices?pageSize=20)' };
  const seg = s.slice(1).split(/[/?]/)[0].toLowerCase();
  if (!READ_PATHS.has(seg)) return { ok: false, error: 'Nhóm "' + seg + '" không nằm trong danh sách được đọc: ' + [...READ_PATHS].join(', ') };
  return { ok: true, path: s };
}

// Câu hỏi doanh số tự nhiên ("báo cáo doanh thu từng chi nhánh Tulibaby hôm nay") -> khoảng thời gian + từ khóa lọc chi nhánh
const RANGE_RE = /\b(hom nay|hom qua|tuan nay|thang nay|today|yesterday|tuan|thang)\b/;
const FILLER = new Set('doanh thu so bao cao kiem tra cua tung moi cac chi nhanh ngay em anh cho va nhe giup xem lay tat ca tong ket hom nay qua'.split(' '));
function splitRevenueQuery(arg) {
  const t = noAccent(arg);
  const m = t.match(RANGE_RE);
  const rest = t.replace(RANGE_RE, ' ').split(' ').filter((w) => w && !FILLER.has(w));
  if (!m && rest.some((w) => /^\d+$/.test(w) || w === 'nam' || w === 'ngoai')) return { range: t, filter: '' };   // khoảng thời gian không hỗ trợ: để parseRange báo không hiểu
  return { range: m ? m[1] : '', filter: rest.join(' ') };
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

    // Đọc thẳng một đường dẫn API công khai (CHỈ phương thức GET, chỉ các nhóm dữ liệu trong READ_PATHS) cho AI dùng thay vì đăng nhập web KiotViet.
    async rawGet(pathAndQuery) {
      const p = checkReadPath(pathAndQuery);
      if (!p.ok) throw new Error(p.error);
      return get(p.path);
    },

    async revenue(arg, nowMs) {
      const q = splitRevenueQuery(arg);
      const range = parseRange(q.range, nowMs);
      if (!range) return 'Khoảng thời gian không hiểu được. Gõ: /doanhso (hôm nay), /doanhso hôm qua, /doanhso tuần, /doanhso tháng; thêm tên chi nhánh để lọc, ví dụ /doanhso hôm nay tulibaby';
      const all = [];
      for (let cur = 0; cur < 20000; cur += 100) {
        const qs = new URLSearchParams({ pageSize: '100', currentItem: String(cur), fromPurchaseDate: range.from, toPurchaseDate: range.to, orderBy: 'purchaseDate', orderDirection: 'Asc' });
        const d = await get('/invoices?' + qs.toString());
        const items = d.data || [];
        all.push(...items);
        if (items.length < 100 || all.length >= (d.total || 0)) break;
      }
      // KiotViet có thể trả cả ngày kế tiếp ở biên: lọc lại theo ngày mua
      let inRange = all.filter((i) => { const day = String(i.purchaseDate || '').slice(0, 10); return day >= range.from && day < range.to; });
      if (q.filter) {                                                       // lọc theo tên chi nhánh / thương hiệu (không dấu, mọi từ phải có trong tên chi nhánh)
        const words = q.filter.split(' ');
        const names = [...new Set(inRange.map((i) => i.branchName || 'Chi nhánh ?'))];
        inRange = inRange.filter((i) => { const b = noAccent(i.branchName); return words.every((w) => b.includes(w)); });
        if (!inRange.length) return '📊 Doanh số ' + range.title + ': không có hóa đơn nào ở chi nhánh khớp "' + q.filter + '".' + (names.length ? ' Hôm đó KiotViet này có hóa đơn ở: ' + names.join(', ') + '.' : '');
      }
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

    // Sản phẩm sắp hết: tổng tồn các chi nhánh <= mức tồn tối thiểu đã đặt trong KiotViet (chỉ tính sản phẩm có đặt mức tối thiểu > 0).
    // Hóa đơn của hôm nay (giờ VN), mới nhất cuối: dùng cho sự kiện "hóa đơn mới"
    async invoicesToday(nowMs) {
      const from = vnDate(0, nowMs).iso, to = vnDate(1, nowMs).iso;
      const all = [];
      for (let cur = 0; cur < 5000; cur += 100) {
        const qs = new URLSearchParams({ pageSize: '100', currentItem: String(cur), fromPurchaseDate: from, toPurchaseDate: to, orderBy: 'purchaseDate', orderDirection: 'Asc' });
        const d = await get('/invoices?' + qs.toString());
        const items = d.data || [];
        all.push(...items);
        if (items.length < 100 || all.length >= (d.total || 0)) break;
      }
      return all.map((i) => ({ id: i.id, code: i.code, total: i.total, status: i.status, branchName: i.branchName, customerName: i.customerName, purchaseDate: i.purchaseDate }));
    },

    async lowStock(limit, maxPages) {
      const out = [];
      for (let page = 0, cur = 0; page < (maxPages || 60); page++, cur += 100) {
        const qs = new URLSearchParams({ pageSize: '100', currentItem: String(cur), includeInventory: 'true', isActive: 'true' });
        const d = await get('/products?' + qs.toString());
        const items = d.data || [];
        for (const p of items) {
          const inv = p.inventories || [];
          const min = inv.reduce((m, x) => Math.max(m, Number(x.minQuantity) || 0), 0);
          if (min <= 0) continue;
          const sum = inv.reduce((s, x) => s + (Number(x.onHand) || 0), 0);
          if (sum <= min) out.push({ name: p.name || '?', code: p.code || '?', onHand: sum, min });
        }
        if (items.length < 100 || cur + 100 >= (d.total || 0)) break;
      }
      out.sort((a, b) => (a.onHand - a.min) - (b.onHand - b.min));
      return { total: out.length, items: out.slice(0, limit || 15) };
    },

    // Hóa đơn trong khoảng ngày [from, to) (YYYY-MM-DD) dạng gọn, dùng cho cảnh báo doanh số (alerts.js)
    async invoiceTotals(from, to) {
      const all = [];
      for (let cur = 0; cur < 20000; cur += 100) {
        const qs = new URLSearchParams({ pageSize: '100', currentItem: String(cur), fromPurchaseDate: from, toPurchaseDate: to, orderBy: 'purchaseDate', orderDirection: 'Asc' });
        const d = await get('/invoices?' + qs.toString());
        const items = d.data || [];
        all.push(...items.map((i) => ({ id: i.id, total: i.total, status: i.status, branchName: i.branchName, purchaseDate: i.purchaseDate })));
        if (items.length < 100 || all.length >= (d.total || 0)) break;
      }
      return all;
    },


    // Thống kê hàng hóa (chỉ số lượng, KHÔNG giá vốn): số mã đang bán, còn/hết hàng, tồn theo chi nhánh, 10 mã tồn nhiều nhất. arg = lọc theo tên/mã (tùy chọn).
    async catalog(arg) {
      const q = String(arg || '').trim();
      const all = [];
      for (let cur = 0; cur < 30000; cur += 100) {
        const qs = new URLSearchParams({ pageSize: '100', currentItem: String(cur), includeInventory: 'true', isActive: 'true' });
        if (q) qs.set('name', q);
        const d = await get('/products?' + qs.toString());
        const items = d.data || [];
        all.push(...items);
        if (items.length < 100 || all.length >= (d.total || 0)) break;
      }
      if (!all.length) return 'Không có sản phẩm nào' + (q ? ' khớp "' + q + '"' : '') + '.';
      const byBranch = new Map(); let inStock = 0, totalQty = 0; const rows = [];
      for (const p of all) {
        const inv = p.inventories || []; let sum = 0;
        for (const x of inv) { const n = Number(x.onHand) || 0; sum += n; if (n > 0) { const b = byBranch.get(x.branchName || '?') || { qty: 0, skus: 0 }; b.qty += n; b.skus++; byBranch.set(x.branchName || '?', b); } }
        if (sum > 0) inStock++; totalQty += sum; rows.push({ name: p.name || '?', code: p.code || '?', sum });
      }
      rows.sort((a, b) => b.sum - a.sum);
      const lines = ['📦 Hàng hóa KiotViet' + (q ? ' "' + q + '"' : '') + ': ' + all.length + ' mã đang bán',
        '• Còn hàng: ' + inStock + ' mã · hết hàng ở mọi chi nhánh: ' + (all.length - inStock) + ' mã · tổng tồn ' + totalQty.toLocaleString('vi-VN') + ' cái',
        '• Tồn theo chi nhánh:'].concat([...byBranch.entries()].sort((a, b) => b[1].qty - a[1].qty).map(([n, b]) => '   – ' + n + ': ' + b.qty.toLocaleString('vi-VN') + ' cái (' + b.skus + ' mã)'),
        ['• 10 mã tồn nhiều nhất:'], rows.slice(0, 10).map((r) => '   – ' + r.name + ' (' + r.code + '): ' + r.sum));
      return lines.join(String.fromCharCode(10));
    },

    // Danh sách sản phẩm có giá + tồn theo chi nhánh (dùng cho hỏi đáp bán hàng)
    async products(query, limit) {
      const q = String(query || '').trim(); if (q.length < 2) return [];
      const qs = new URLSearchParams({ name: q, includeInventory: 'true', pageSize: String(limit || 5) });
      const d = await get('/products?' + qs.toString());
      return (d.data || []).slice(0, limit || 5).map((p) => {
        const inv = (p.inventories || []).filter((x) => Number(x.onHand) !== 0).map((x) => ({ name: x.branchName, onHand: Number(x.onHand) }));
        return { name: p.name || '?', code: p.code || '?', price: p.basePrice, branches: inv, total: (p.inventories || []).reduce((s, x) => s + (Number(x.onHand) || 0), 0) };
      });
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

// NHIỀU GIAN HÀNG KiotViet (mỗi gian = một cửa hàng KiotViet riêng: Retailer + khóa API riêng, ví dụ Tulibaby và Huyền Anh).
// shops: [{ name, retailer, clientId, clientSecret }]. Cùng giao diện với createKiotViet nên chỗ khác trong bot dùng y hệt.
// Câu hỏi có tên gian ("doanh thu Tulibaby hôm nay") thì chỉ hỏi gian đó; không nêu tên thì hỏi tất cả và ghi rõ từng gian.
function createMultiKiotViet(shops, o) {
  o = o || {};
  const list = (shops || []).filter((s) => s && s.clientId && s.clientSecret && s.retailer).map((s, i) => {
    const name = String(s.name || s.retailer).trim();
    return { name, retailer: s.retailer, words: noAccent(name + ' ' + s.retailer).split(' ').filter(Boolean), api: createKiotViet({ clientId: s.clientId, clientSecret: s.clientSecret, retailer: s.retailer, fetch: o.fetch }), idx: i };
  });
  const multi = list.length > 1;
  const names = () => list.map((s) => s.name).join(', ');

  // Tách từ khóa chọn gian ra khỏi câu: trả { chosen: [gian], rest: phần còn lại }
  function choose(text) {
    const ws = noAccent(text).split(' ').filter(Boolean);
    const hit = list.filter((s) => s.words.some((w) => w.length >= 3 && ws.includes(w)));
    if (!hit.length) return { chosen: list, rest: String(text || ''), named: false };
    const used = new Set(); hit.forEach((s) => s.words.forEach((w) => used.add(w)));
    return { chosen: hit, rest: ws.filter((w) => !used.has(w)).join(' '), named: true };
  }
  // chạy fn trên từng gian, lỗi một gian không làm hỏng các gian khác
  async function each(chosen, fn) {
    const out = [];
    for (const s of chosen) { try { out.push({ s, v: await fn(s.api, s) }); } catch (e) { out.push({ s, err: e.message }); } }
    return out;
  }
  const head = (s) => '🏬 ' + s.name;

  return {
    configured: () => list.length > 0,
    shops: () => list.map((s) => ({ name: s.name, retailer: s.retailer })),
    parseRange,

    async rawGet(pathAndQuery, shop) {
      if (!list.length) throw new Error('Chưa cấu hình KiotViet.');
      let s;
      if (shop) { const c = choose(shop); s = c.named ? c.chosen[0] : null; if (!s) throw new Error('Không có gian hàng "' + shop + '". Đang có: ' + names()); }
      else if (list.length === 1) s = list[0];
      else throw new Error('Có ' + list.length + ' gian hàng KiotViet (' + names() + '): phải nói rõ gian nào (thêm --shop <tên>).');
      return s.api.rawGet(pathAndQuery);
    },

    async revenue(arg, nowMs) {
      if (!multi) return list.length ? list[0].api.revenue(arg, nowMs) : 'Chưa cấu hình KiotViet.';
      const q = splitRevenueQuery(arg);
      const c = choose(q.filter);
      const sub = (q.range + ' ' + c.rest).trim();
      const res = await each(c.chosen, (api) => api.revenue(sub, nowMs));
      return res.map((r) => head(r.s) + '\n' + (r.err ? '⚠️ ' + r.err : r.v)).join('\n\n');
    },

    async stock(query) {
      if (!multi) return list.length ? list[0].api.stock(query) : 'Chưa cấu hình KiotViet.';
      const c = choose(query);
      const res = await each(c.chosen, (api) => api.stock(c.rest));
      return res.map((r) => head(r.s) + '\n' + (r.err ? '⚠️ ' + r.err : r.v)).join('\n\n');
    },

    async catalog(arg) {
      if (!multi) return list.length ? list[0].api.catalog(arg) : 'Chưa cấu hình KiotViet.';
      const c = choose(arg);
      const res = await each(c.chosen, (api) => api.catalog(c.rest));
      return res.map((r) => head(r.s) + '\n' + (r.err ? '⚠️ ' + r.err : r.v)).join('\n\n');
    },

    async products(query, limit) {
      const res = await each(list, (api) => api.products(query, limit));
      const out = [];
      for (const r of res) if (r.v) for (const p of r.v) out.push(multi ? Object.assign({}, p, { name: '[' + r.s.name + '] ' + p.name }) : p);
      return out;
    },

    async invoicesToday(nowMs) {
      const res = await each(list, (api) => api.invoicesToday(nowMs));
      const out = [];
      for (const r of res) if (r.v) for (const i of r.v) out.push(multi ? Object.assign({}, i, { id: r.s.idx + ':' + i.id, branchName: r.s.name + ' · ' + (i.branchName || '?') }) : i);
      return out;
    },

    async invoiceTotals(from, to) {
      const res = await each(list, (api) => api.invoiceTotals(from, to));
      const out = [];
      for (const r of res) if (r.v) for (const i of r.v) out.push(multi ? Object.assign({}, i, { id: r.s.idx + ':' + i.id, branchName: r.s.name + ' · ' + (i.branchName || '?') }) : i);
      return out;
    },

    async lowStock(limit, maxPages) {
      const res = await each(list, (api) => api.lowStock(limit, maxPages));
      let total = 0; const items = [];
      for (const r of res) if (r.v) { total += r.v.total; for (const i of r.v.items) items.push(multi ? Object.assign({}, i, { name: '[' + r.s.name + '] ' + i.name }) : i); }
      items.sort((a, b) => (a.onHand - a.min) - (b.onHand - b.min));
      return { total, items: items.slice(0, limit || 15) };
    },
  };
}

// Danh sách gian hàng từ cấu hình: KIOTVIET_SHOPS (JSON một dòng, do trang Cài đặt ghi) + bộ khóa cũ KIOTVIET_CLIENT_ID/SECRET/RETAILER (nếu chưa có trong danh sách).
function parseShops(env) {
  env = env || {};
  let arr = [];
  try { const j = JSON.parse(env.KIOTVIET_SHOPS || '[]'); if (Array.isArray(j)) arr = j; } catch (e) { arr = []; }
  const out = arr.map((s) => ({ name: String((s && s.name) || '').trim(), retailer: String((s && s.retailer) || '').trim(), clientId: String((s && s.clientId) || '').trim(), clientSecret: String((s && s.clientSecret) || '').trim() })).filter((s) => s.retailer && s.clientId && s.clientSecret);
  if (env.KIOTVIET_CLIENT_ID && env.KIOTVIET_CLIENT_SECRET && env.KIOTVIET_RETAILER && !out.some((s) => s.retailer.toLowerCase() === String(env.KIOTVIET_RETAILER).toLowerCase())) {
    out.unshift({ name: '', retailer: env.KIOTVIET_RETAILER, clientId: env.KIOTVIET_CLIENT_ID, clientSecret: env.KIOTVIET_CLIENT_SECRET });
  }
  return out;
}

module.exports = { createKiotViet, createMultiKiotViet, parseShops, splitRevenueQuery, parseRange, vnDate, noAccent, money, checkReadPath };
