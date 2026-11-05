'use strict';
// Lấy SẴN số liệu KiotViet bằng API chính thức rồi đính vào câu hỏi cho MỌI AI (Claude, Codex, Gemini, DeepSeek; chế độ Bảo vệ hay Toàn quyền).
// Lý do: AI nào cũng phải trả lời được "doanh thu/tồn kho…" mà không phụ thuộc việc nó có chạy được lệnh, có mạng trong sandbox, hay có hiểu cách dùng kvcli không.
// AI còn công cụ (kvcli) vẫn tra thêm được nếu cần số liệu khác.
const { noAccent } = require('./kiotviet');

const WANT = /\b(doanh thu|doanh so|ban duoc|hoa don|ton kho|con hang|het hang|hang ton|kiotviet|chi nhanh|nhap hang|khach mua)\b/;
const FETCH_TIMEOUT_MS = 40000;
const CACHE_MS = 10 * 60 * 1000;
const STOCK_RE = /\b(?:ton kho|con hang|het hang|hang ton|ton)\s+(?:cua\s+|san pham\s+|mon\s+)?([a-z0-9][a-z0-9 ._-]{1,60})/;
const STOCK_STOP = new Set('khong nao the nhieu bao nhieu hom nay qua cac chi nhanh khong gi va'.split(' '));

function wants(text) { return WANT.test(noAccent(text)); }

function ranges(t) {
  const out = ['hom nay', 'hom qua'];
  if (/\btuan\b/.test(t)) out.push('tuan');
  if (/\bthang\b/.test(t)) out.push('thang');
  return out;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('quá ' + Math.round(ms / 1000) + ' giây')), ms).unref())]);

// Trả chuỗi dữ liệu (rỗng nếu không liên quan/chưa cấu hình). Không bao giờ ném lỗi.
async function build(kv, text, nowMs) {
  try {
    if (!kv || !kv.configured || !kv.configured() || !wants(text)) return '';
    const t = noAccent(text);
    const shopArg = kv.pick ? kv.pick(text).join(' ') : '';
    const blocks = [];
    for (const r of ranges(t)) {
      try { blocks.push(await withTimeout(kv.revenue((r + ' ' + shopArg).trim(), nowMs), FETCH_TIMEOUT_MS)); }
      catch (e) { blocks.push('⚠️ Không lấy được doanh số ' + r + ': ' + e.message); }
    }
    const m = t.match(STOCK_RE);
    if (m) {
      const q = m[1].trim().split(' ').filter((w) => !STOCK_STOP.has(w)).join(' ');
      if (q.length >= 2) { try { blocks.push(await withTimeout(kv.stock(q), FETCH_TIMEOUT_MS)); } catch (e) { blocks.push('⚠️ Không lấy được tồn kho "' + q + '": ' + e.message); } }
    }
    if (!blocks.length) return '';
    return '[DỮ LIỆU KIOTVIET — bot đã lấy sẵn bằng API chính thức (chỉ đọc), KHÔNG cần đăng nhập web. Dùng đúng số liệu này để trả lời chủ máy; thiếu hoặc lỗi thì nói thật là thiếu/lỗi, đừng bịa. Doanh số tính theo từng chi nhánh.]\n' +
      blocks.join('\n\n') + '\n[HẾT DỮ LIỆU KIOTVIET]\n\n';
  } catch (e) { return ''; }
}

// Bộ nhớ đệm theo việc: AI chạy lại / chuyển AI khác trong cùng việc thì không gọi lại KiotViet
function createKvContext(o) {
  const cache = new Map(), now = o.now || Date.now;
  return {
    wants,
    async prefix(job, text) {
      const hit = cache.get(job.id);
      if (hit && now() - hit.at < CACHE_MS) return hit.v;
      const v = await build(o.kiotviet, text, now());
      cache.set(job.id, { at: now(), v });
      if (cache.size > 100) for (const k of cache.keys()) { if (now() - cache.get(k).at > CACHE_MS) cache.delete(k); }
      return v;
    },
  };
}

module.exports = { createKvContext, build, wants };
