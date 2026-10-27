'use strict';

// THỐNG KÊ SỬ DỤNG AI + NGÂN SÁCH THÁNG: ai dùng bao nhiêu việc/thời gian/chi phí theo AI, theo dự án, theo ngày; đặt trần số việc mỗi tháng cho từng AI
// (vượt trần thì việc tự dồn sang AI khác còn trong ngân sách; nếu AI nào cũng vượt thì vẫn chạy bình thường: trần là mềm, không bỏ rơi việc).
// Chỉ AI chạy bằng khóa API mới có chi phí USD (Claude báo total_cost_usd); AI dùng gói thuê bao chỉ đếm số việc/thời gian.
const NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', deepseekapi: 'DeepSeek (API)' };
const pad = (n) => String(n).padStart(2, '0');
const vnDate = (ms) => { const d = new Date(ms + 7 * 3600 * 1000); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
const vnMonthStart = (ms) => { const d = new Date(ms + 7 * 3600 * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 7 * 3600 * 1000; };
const dayStart = (ms) => { const d = new Date(ms + 7 * 3600 * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 7 * 3600 * 1000; };

function createUsage(o) {
  const db = o.db, projects = o.projects || null, now = o.now || Date.now;
  const raw = () => db.raw;
  const projName = (id) => { if (!id) return 'Chung (không thuộc dự án)'; const p = projects && projects.get(id); return p ? p.name : id; };

  function budgets() { try { const j = JSON.parse(db.kvGet('budgets') || '{}'); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
  function setBudget(engine, jobs) {
    const b = budgets();
    if (!jobs) delete b[engine]; else b[engine] = { jobs: Math.max(1, Math.round(Number(jobs))) };
    db.kvSet('budgets', JSON.stringify(b)); return b;
  }
  const monthJobs = (engine) => raw().prepare("SELECT COUNT(*) AS n FROM jobs WHERE engine = ? AND status = 'done' AND finished_at >= ?").get(engine, vnMonthStart(now())).n;
  // true nếu AI này đã dùng hết trần tháng
  function overBudget(engine) { const cap = (budgets()[engine] || {}).jobs; return !!cap && monthJobs(engine) >= cap; }

  function summary(days) {
    days = Math.max(1, Math.min(366, days || 30));
    const from = dayStart(now()) - (days - 1) * 86400000;
    const rows = raw().prepare("SELECT engine, project, COUNT(*) AS jobs, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors, SUM(COALESCE(finished_at, 0) - COALESCE(started_at, 0)) AS ms, SUM(COALESCE(cost_usd, 0)) AS cost " +
      "FROM jobs WHERE finished_at IS NOT NULL AND finished_at >= ? AND engine IS NOT NULL AND status IN ('done','error') GROUP BY engine, project ORDER BY jobs DESC").all(from)
      .map((r) => ({ engine: r.engine, project: r.project || null, projectName: projName(r.project), jobs: r.jobs, errors: r.errors, secs: Math.round((r.ms || 0) / 1000), cost: Math.round((r.cost || 0) * 100) / 100 }));
    const dailyRaw = raw().prepare("SELECT finished_at AS t, engine FROM jobs WHERE finished_at IS NOT NULL AND finished_at >= ? AND engine IS NOT NULL AND status = 'done'").all(from);
    const byDay = new Map();
    for (let i = 0; i < days; i++) byDay.set(vnDate(from + i * 86400000 + 3600000), {});
    for (const r of dailyRaw) { const d = byDay.get(vnDate(r.t)); if (d) d[r.engine] = (d[r.engine] || 0) + 1; }
    const daily = [...byDay.entries()].map(([date, e]) => ({ date, engines: e, total: Object.values(e).reduce((s, n) => s + n, 0) }));
    const b = budgets(), month = {};
    for (const e of new Set([...Object.keys(b), ...rows.map((r) => r.engine)])) month[e] = { used: monthJobs(e), cap: (b[e] || {}).jobs || null };
    const perEngine = {}; for (const r of rows) { const x = perEngine[r.engine] || (perEngine[r.engine] = { engine: r.engine, name: NAMES[r.engine] || r.engine, jobs: 0, errors: 0, secs: 0, cost: 0 }); x.jobs += r.jobs; x.errors += r.errors; x.secs += r.secs; x.cost = Math.round((x.cost + r.cost) * 100) / 100; }
    const perProject = {}; for (const r of rows) { const x = perProject[r.project || ''] || (perProject[r.project || ''] = { project: r.project, name: r.projectName, jobs: 0, secs: 0, cost: 0, engines: {} }); x.jobs += r.jobs; x.secs += r.secs; x.cost = Math.round((x.cost + r.cost) * 100) / 100; x.engines[r.engine] = (x.engines[r.engine] || 0) + r.jobs; }
    return { days, from, rows, perEngine: Object.values(perEngine), perProject: Object.values(perProject).sort((a, b) => b.jobs - a.jobs), daily, month, budgets: b };
  }

  const mins = (s) => (s >= 3600 ? (s / 3600).toFixed(1) + ' giờ' : Math.round(s / 60) + ' phút');
  function text(days) {
    const s = summary(days);
    if (!s.rows.length) return '📊 Chưa có việc nào trong ' + s.days + ' ngày qua.';
    const total = s.perEngine.reduce((a, e) => a + e.jobs, 0), cost = s.perEngine.reduce((a, e) => a + e.cost, 0);
    const lines = ['📊 Sử dụng AI ' + s.days + ' ngày qua: ' + total + ' việc' + (cost ? ', chi phí khóa API ≈ $' + cost.toFixed(2) : '')];
    lines.push('Theo AI:');
    for (const e of s.perEngine.sort((a, b) => b.jobs - a.jobs)) {
      const m = s.month[e.engine];
      lines.push('• ' + e.name + ': ' + e.jobs + ' việc' + (e.errors ? ' (' + e.errors + ' lỗi)' : '') + ', ' + mins(e.secs) + (e.cost ? ', $' + e.cost.toFixed(2) : '') + (m && m.cap ? ' · tháng này ' + m.used + '/' + m.cap + (m.used >= m.cap ? ' ⚠️ hết trần' : '') : ''));
    }
    lines.push('Theo dự án:');
    for (const p of s.perProject.slice(0, 8)) lines.push('• ' + p.name + ': ' + p.jobs + ' việc, ' + mins(p.secs) + (p.cost ? ', $' + p.cost.toFixed(2) : '') + ' (' + Object.entries(p.engines).map(([k, v]) => (NAMES[k] || k) + ' ' + v).join(', ') + ')');
    return lines.join('\n');
  }

  return { summary, text, budgets, setBudget, overBudget, monthJobs };
}

module.exports = { createUsage, vnDate, vnMonthStart };
