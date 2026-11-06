'use strict';
const path = require('path');

// CHẾ ĐỘ QUYỀN + LUẬT CHO/HỎI/CẤM THEO DỰ ÁN (giống permission modes của Claude Code). Chạy trong cổng duyệt (gate.js) SAU chính sách có sẵn (policy.js) và chỉ làm
// quyết định chặt hơn hoặc nới trong phạm vi dự án — không bao giờ nới thứ chính sách đã CẤM cứng (đọc khóa/token, sudo…).
//   hoi      HỎI TỪNG LẦN (mặc định, như trước): việc ghi/chạy lệnh hỏi chủ máy qua Telegram
//   tusua    TỰ SỬA trong thư mục dự án: ghi/sửa tệp nằm trong thư mục dự án thì tự cho phép; chạy lệnh vẫn hỏi
//   kehoach  CHỈ LẬP KẾ HOẠCH: chỉ được đọc/xem web; không ghi, không chạy lệnh, không thao tác trang web — AI trình bày kế hoạch để duyệt
//   chay     CHẠY THẲNG: mọi việc đang phải hỏi thì tự cho phép. CHỈ việc của chủ máy và CHỈ khi hộp cô lập đang bật (không thì tự hạ về "hỏi")
// Luật (mỗi dòng "Công cụ" hoặc "Công cụ(mẫu)", ví dụ Bash(git push*), Write(*.xlsx), mcp__browser__*): CẤM thắng mọi chế độ; HỎI buộc hỏi dù đang tự cho phép; CHO tự cho phép việc đang phải hỏi.
const MODES = ['hoi', 'tusua', 'kehoach', 'chay'];
const MODE_NAMES = { hoi: 'Hỏi từng lần', tusua: 'Tự sửa trong dự án', kehoach: 'Chỉ lập kế hoạch', chay: 'Chạy thẳng' };
const MAX_RULES = 30, MAX_RULE_LEN = 120;

const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const globRe = (g) => new RegExp('^' + esc(String(g)).replace(/\*/g, '.*') + '$', 'i');

// "Bash(git push*)" -> { tool: 'Bash', pat: 'git push*' }; "Write" -> { tool: 'Write', pat: '' }
function parseRule(text) {
  const m = String(text || '').trim().match(/^([A-Za-z0-9_*.\-]+)(?:\(([\s\S]*)\))?$/);
  if (!m) return null;
  return { tool: m[1], pat: m[2] === undefined ? '' : m[2].trim(), text: String(text).trim() };
}
const subjectOf = (tool, input) => String((input && (input.command || input.file_path || input.path || input.url || input.pattern || input.notebook_path)) || '');
function matches(rule, tool, input) {
  const r = typeof rule === 'string' ? parseRule(rule) : rule;
  if (!r || !globRe(r.tool).test(String(tool))) return false;
  if (!r.pat) return true;
  const subj = subjectOf(tool, input);
  return globRe(r.pat).test(subj) || (/^Bash$/i.test(r.tool) && subj.split(/\s*(?:&&|;|\|\|?)\s*/).some((part) => globRe(r.pat).test(part.trim())));   // "Bash(git push*)" khớp cả "cd x && git push"
}

// Chuẩn hóa danh sách luật từ chữ người nhập: bỏ dòng sai/trùng, giới hạn số lượng
function cleanRules(list) {
  const seen = new Set(), out = [];
  for (const raw of (Array.isArray(list) ? list : String(list || '').split('\n'))) {
    const t = String(raw).trim();
    if (!t || t.length > MAX_RULE_LEN || !parseRule(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

function createProjectPerms(o) {
  const { projects } = o;
  const sandboxOn = o.sandboxOn || (() => false), isAdmin = o.isAdmin || (() => false);

  // Chế độ thực sự áp dụng cho việc (sau khi kiểm điều kiện của "chạy thẳng")
  function effectiveMode(job, p) {
    const m = MODES.includes(p && p.mode) ? p.mode : 'hoi';
    if (m === 'chay' && !(isAdmin(String(job.chat_id)) && sandboxOn())) return 'hoi';
    return m;
  }
  const inside = (file, dir) => { if (!file || !dir) return false; const r = path.relative(path.resolve(dir), path.resolve(String(file))); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

  // d = quyết định của policy.js ({action:'allow'|'ask'|'deny', cls, ...}). Trả phần ghi đè lên d, hoặc null nếu giữ nguyên.
  function apply(job, tool, input, d) {
    const p = job && job.project ? projects.get(job.project) : null;
    if (!p) return null;
    const rules = p.rules || {};
    const hit = (list) => (list || []).find((r) => matches(r, tool, input));
    const denied = hit(rules.deny);
    if (denied) return { action: 'deny', reason: 'luật của dự án cấm (' + denied + ')' };
    if (d.action === 'deny') return null;                                   // chính sách đã cấm cứng: không bao giờ nới
    const mode = effectiveMode(job, p);
    if (mode === 'kehoach' && ['write', 'exec', 'interact', 'other'].includes(d.cls)) {
      return { action: 'deny', reason: 'dự án đang ở chế độ CHỈ LẬP KẾ HOẠCH (không ghi/sửa/chạy lệnh/thao tác). Hãy trình bày kế hoạch cho người dùng duyệt, đừng thử cách khác' };
    }
    const asked = hit(rules.ask);
    if (asked) return { action: 'ask', canRemember: false, warn: 'luật của dự án buộc hỏi (' + asked + ')' };
    if (d.action === 'ask') {
      if (hit(rules.allow)) return { action: 'allow' };
      if (mode === 'chay') return { action: 'allow' };
      if (mode === 'tusua' && d.cls === 'write' && inside(input && (input.file_path || input.path || input.notebook_path), p.dir)) return { action: 'allow' };
    }
    return null;
  }
  // Luật CẤM của dự án: kiểm TRƯỚC mọi cơ chế tự cho phép. Trả lý do (chuỗi) nếu bị cấm.
  function denies(job, tool, input) {
    const p = job && job.project ? projects.get(job.project) : null;
    const r = p && p.rules && (p.rules.deny || []).find((x) => matches(x, tool, input));
    return r ? 'luật của dự án cấm (' + r + ')' : null;
  }
  return { apply, denies, effectiveMode };
}

module.exports = { createProjectPerms, parseRule, matches, cleanRules, MODES, MODE_NAMES, MAX_RULES };
