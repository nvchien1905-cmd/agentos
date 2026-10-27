'use strict';

// NHẬT KÝ KIỂM TOÁN cho chủ máy: ai nhắn việc gì, AI nào làm, mất bao lâu, AI xin dùng công cụ nào và được/bị từ chối ra sao.
// Đọc từ cơ sở dữ liệu của bộ điều phối (bảng jobs + audit) — chỉ đọc, dùng cho trang Cài đặt và Telegram (/nhatky tuan).
const SECRET = /(token|secret|key|password|mật khẩu|api[_-]?key)\s*[=:]\s*\S+/gi;
const BEARER = /\b(sk-[A-Za-z0-9_-]{12,}|AAH[A-Za-z0-9_-]{25,}|\d{8,10}:[A-Za-z0-9_-]{30,})\b/g;
const mask = (s) => String(s == null ? '' : s).replace(SECRET, '$1=***').replace(BEARER, '***');
const pad = (n) => String(n).padStart(2, '0');
const vnTime = (ms) => { if (!ms) return ''; const d = new Date(ms + 7 * 3600 * 1000); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()); };
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const STATUS = { queued: 'chờ', running: 'đang chạy', waiting: 'chờ hạn mức', done: 'xong', error: 'lỗi', limit: 'hết hạn mức', cancelled: 'đã hủy', interrupted: 'bị ngắt' };

function createAuditLog(o) {
  const db = o.db, projects = o.projects || null, now = o.now || Date.now, roles = o.roles || null;
  const raw = () => db.raw;
  const projName = (id) => { if (!id) return ''; const p = projects && projects.get(id); return p ? p.name : id; };
  const who = (chat) => { const r = roles && roles.label ? (() => { try { return roles.label(chat); } catch (e) { return ''; } })() : ''; return String(chat) + (r ? ' (' + r + ')' : ''); };

  // Danh sách việc (mới nhất trước) + số lần AI xin dùng công cụ / bị từ chối của từng việc
  function list(opt) {
    opt = opt || {};
    const days = Math.max(1, Math.min(366, Number(opt.days) || 7)), limit = Math.max(1, Math.min(500, Number(opt.limit) || 100));
    const from = now() - days * 86400000;
    const conds = ['j.created_at >= ?'], args = [from];
    if (opt.status && STATUS[opt.status]) { conds.push('j.status = ?'); args.push(opt.status); }
    if (opt.project === '-') conds.push("COALESCE(j.project,'') = ''"); else if (opt.project) { conds.push('j.project = ?'); args.push(String(opt.project)); }
    if (opt.chat) { conds.push('j.chat_id = ?'); args.push(String(opt.chat)); }
    if (opt.q) { conds.push('(j.prompt LIKE ? OR j.result LIKE ?)'); args.push('%' + opt.q + '%', '%' + opt.q + '%'); }
    if (opt.denied) conds.push('EXISTS (SELECT 1 FROM audit a WHERE a.job_id = j.id AND a.decision = \'deny\')');
    const rows = raw().prepare('SELECT j.id, j.chat_id, j.lane, j.project, j.engine, j.status, j.prompt, j.created_at, j.started_at, j.finished_at, j.cost_usd, ' +
      "(SELECT COUNT(*) FROM audit a WHERE a.job_id = j.id) AS tools, (SELECT COUNT(*) FROM audit a WHERE a.job_id = j.id AND a.decision = 'deny') AS denied " +
      'FROM jobs j WHERE ' + conds.join(' AND ') + ' ORDER BY j.id DESC LIMIT ?').all(...args, limit);
    return rows.map((r) => ({ id: r.id, who: who(r.chat_id), chat: r.chat_id, lane: r.lane, project: r.project || null, projectName: projName(r.project), engine: r.engine, status: r.status, statusText: STATUS[r.status] || r.status,
      prompt: cut(mask(r.prompt), 160), at: vnTime(r.created_at), secs: r.started_at && r.finished_at ? Math.round((r.finished_at - r.started_at) / 1000) : null, cost: r.cost_usd, tools: r.tools, denied: r.denied }));
  }

  function detail(id) {
    const j = raw().prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id));
    if (!j) return null;
    const tools = raw().prepare('SELECT ts, tool, cls, decision, source, summary FROM audit WHERE job_id = ? ORDER BY id').all(j.id).map((a) => ({ at: vnTime(a.ts), tool: a.tool, cls: a.cls, decision: a.decision, source: a.source, summary: cut(mask(a.summary), 300) }));
    return { id: j.id, who: who(j.chat_id), project: j.project, projectName: projName(j.project), engine: j.engine, engineWanted: j.engine_pref, status: j.status, statusText: STATUS[j.status] || j.status, lane: j.lane, council: !!j.council,
      at: vnTime(j.created_at), started: vnTime(j.started_at), finished: vnTime(j.finished_at), prompt: mask(j.prompt), result: mask(j.result || ''), error: mask(j.error || ''), cost: j.cost_usd, tools };
  }

  // Báo cáo tuần: số việc, kết quả, AI, công cụ bị từ chối, lệnh nguy hiểm, ai nhắn nhiều
  function week(days) {
    days = days || 7; const from = now() - days * 86400000;
    const q = (sql, ...a) => raw().prepare(sql).all(...a);
    const total = q('SELECT COUNT(*) AS n FROM jobs WHERE created_at >= ?', from)[0].n;
    const byStatus = q('SELECT status, COUNT(*) AS n FROM jobs WHERE created_at >= ? GROUP BY status', from);
    const byWho = q('SELECT chat_id, COUNT(*) AS n FROM jobs WHERE created_at >= ? GROUP BY chat_id ORDER BY n DESC LIMIT 5', from).map((r) => ({ who: who(r.chat_id), n: r.n }));
    const decisions = q('SELECT decision, source, COUNT(*) AS n FROM audit WHERE ts >= ? GROUP BY decision, source', from);
    const denied = q("SELECT ts, tool, source, summary FROM audit WHERE ts >= ? AND decision = 'deny' ORDER BY id DESC LIMIT 8", from).map((a) => ({ at: vnTime(a.ts), tool: a.tool, source: a.source, summary: cut(mask(a.summary), 120) }));
    const remote = q("SELECT ts, tool, summary FROM audit WHERE ts >= ? AND cls = 'remote' ORDER BY id DESC LIMIT 10", from).map((a) => ({ at: vnTime(a.ts), tool: a.tool, summary: cut(mask(a.summary), 120) }));
    return { days, total, byStatus, byWho, decisions, denied, remote };
  }
  function weekText(days) {
    const w = week(days || 7), st = Object.fromEntries(w.byStatus.map((r) => [r.status, r.n]));
    const dec = (d) => w.decisions.filter((x) => x.decision === d).reduce((s, x) => s + x.n, 0);
    const L = ['🧾 Nhật ký ' + w.days + ' ngày qua: ' + w.total + ' việc (' + (st.done || 0) + ' xong, ' + (st.error || 0) + ' lỗi, ' + (st.cancelled || 0) + ' hủy)'];
    L.push('Công cụ AI xin dùng: ' + dec('allow') + ' được phép, ' + dec('deny') + ' bị từ chối');
    if (w.byWho.length) L.push('Ai nhắn nhiều: ' + w.byWho.map((x) => x.who + ' ' + x.n).join(', '));
    if (w.denied.length) L.push('Bị từ chối gần đây:\n' + w.denied.map((d) => '• ' + d.at + ' ' + d.tool + ': ' + d.summary).join('\n'));
    if (w.remote.length) L.push('Lệnh điều khiển máy gần đây:\n' + w.remote.map((d) => '• ' + d.at + ' ' + d.tool + ' ' + d.summary).join('\n'));
    return L.join('\n');
  }

  const csvCell = (v) => { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  function csv(days) {
    const head = ['Việc', 'Thời gian', 'Người nhắn', 'Dự án', 'AI', 'Trạng thái', 'Giây', 'Chi phí USD', 'Công cụ xin', 'Bị từ chối', 'Nội dung'];
    const lines = [head.join(',')].concat(list({ days: days || 30, limit: 500 }).map((r) => [r.id, r.at, r.who, r.projectName, r.engine || '', r.statusText, r.secs == null ? '' : r.secs, r.cost == null ? '' : r.cost, r.tools, r.denied, r.prompt].map(csvCell).join(',')));
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  return { list, detail, week, weekText, csv, mask, STATUS };
}

module.exports = { createAuditLog, mask };
