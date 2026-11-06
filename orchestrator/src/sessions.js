'use strict';

// BẢNG PHIÊN (giống "agent view" của Claude Code): mỗi cuộc trò chuyện (chat + dự án) là một phiên có trạng thái rõ ràng.
//   🟡 cần anh duyệt   AI đang chờ chủ máy bấm Cho phép/Từ chối
//   🟢 đang làm        có việc đang chạy
//   ⏳ xếp hàng        có việc chờ tới lượt
//   ✅ xong · ⏸ chờ hạn mức · ❌ lỗi · ⏹ đã dừng · 🆕 chưa có việc
// Trạng thái suy ra từ bảng việc (db.sessions) + danh sách việc đang chờ duyệt (approvals.pendingJobIds), không lưu riêng nên không bao giờ lệch.
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const ORDER = { cho: 0, lam: 1, hang: 2, moi: 5 };
const MODE_LABEL = { hoi: 'hỏi từng lần', tusua: 'tự sửa trong dự án', kehoach: 'chỉ lập kế hoạch', chay: 'toàn quyền' };

// Truy vấn bảng việc theo phiên (raw = đối tượng better-sqlite3, đọc thôi). chatId trống = mọi chat.
function queryRows(raw, chatId, limit) {
  const where = chatId ? 'WHERE chat_id = ?' : '';
  const rows = raw.prepare("SELECT chat_id AS chat, COALESCE(project,'') AS project, MAX(id) AS last_id, SUM(status = 'running') AS running, SUM(status IN ('queued','waiting')) AS queued, COUNT(*) AS total FROM jobs " + where + " GROUP BY chat_id, COALESCE(project,'') ORDER BY last_id DESC LIMIT ?").all(...(chatId ? [String(chatId)] : []), limit || 60);
  const get = raw.prepare('SELECT id, status, prompt, result, error, engine, created_at, started_at, finished_at FROM jobs WHERE id = ?');
  const runIds = raw.prepare("SELECT id FROM jobs WHERE chat_id = ? AND COALESCE(project,'') = ? AND status = 'running'");
  return rows.map((r) => Object.assign({}, r, { running: r.running || 0, queued: r.queued || 0, last: get.get(r.last_id), runningIds: runIds.all(r.chat, r.project).map((x) => x.id) }));
}

function createSessions(o) {
  const { db, projects } = o;
  const approvals = o.approvals || null, now = o.now || Date.now;
  const ago = (t) => {
    if (!t) return '';
    const m = Math.max(0, Math.round((now() - t) / 60000));
    return m < 2 ? 'vừa xong' : m < 60 ? m + ' phút trước' : m < 48 * 60 ? Math.round(m / 60) + ' giờ trước' : Math.round(m / 1440) + ' ngày trước';
  };

  // Trạng thái của một phiên (s = dòng của db.sessions hoặc null nếu dự án chưa có việc nào)
  function stateOf(s) {
    if (!s || !s.last) return { key: 'moi', icon: '🆕', label: 'chưa có việc' };
    const pend = approvals && approvals.pendingJobIds ? approvals.pendingJobIds() : new Set();
    if (s.runningIds.some((id) => pend.has(id))) return { key: 'cho', icon: '🟡', label: 'cần anh duyệt (xem tin xin quyền ở trên)' };
    if (s.running > 0) return { key: 'lam', icon: '🟢', label: 'đang làm việc #' + s.runningIds[0] + (s.last.started_at ? ' (' + ago(s.last.started_at).replace(' trước', '') + ')' : '') };
    if (s.queued > 0) return { key: 'hang', icon: '⏳', label: s.queued + ' việc đang xếp hàng' };
    const st = s.last.status;
    if (st === 'done') return { key: 'xong', icon: '✅', label: 'xong ' + ago(s.last.finished_at) };
    if (st === 'limit') return { key: 'han', icon: '⏸', label: 'chờ hạn mức AI' };
    if (st === 'error') return { key: 'loi', icon: '❌', label: 'lỗi ' + ago(s.last.finished_at) };
    return { key: 'dung', icon: '⏹', label: 'đã dừng ' + ago(s.last.finished_at) };
  }

  // Bảng phiên của một chat: các dự án người đó dùng được (kể cả chưa có việc) + chế độ chung nếu có việc. usable = danh sách dự án (projects.list đã lọc quyền).
  function list(chatId, usable) {
    const rows = db.sessions(chatId, 80), byProj = new Map(rows.map((r) => [r.project, r]));
    const out = [];
    for (const p of usable) {
      const s = byProj.get(p.id) || null;
      out.push({ id: p.id, name: p.home ? 'Chung (dự án tổng)' : p.name, project: p, s, state: stateOf(s), mode: p.mode || 'chay', at: s && s.last ? (s.last.finished_at || s.last.started_at || s.last.created_at) : p.created || 0 });
    }
    const gen = byProj.get('');
    if (gen) out.push({ id: '-', name: 'Chế độ chung (chưa gắn dự án)', project: null, s: gen, state: stateOf(gen), mode: 'chay', at: gen.last.finished_at || gen.last.created_at });
    return out.sort((a, b) => (ORDER[a.state.key] === undefined ? 3 : ORDER[a.state.key]) - (ORDER[b.state.key] === undefined ? 3 : ORDER[b.state.key]) || b.at - a.at);
  }

  function lineOf(r, cur) {
    const head = (cur && cur.id === r.id ? '▶️ ' : '') + r.state.icon + ' ' + r.name + ' — ' + r.state.label + (r.mode !== 'chay' ? ' · chế độ: ' + (MODE_LABEL[r.mode] || r.mode) : '');
    const l = r.s && r.s.last ? '\n    “' + cut(r.s.last.prompt, 70) + '”' : '';
    return head + l;
  }

  // Nội dung "xem nhanh" một phiên
  function peek(r) {
    if (!r.s || !r.s.last) return '📁 ' + r.name + '\n' + r.state.icon + ' ' + r.state.label + '\nDự án này chưa có việc nào. Bấm "▶️ Tiếp tục" rồi nhắn việc.';
    const l = r.s.last;
    const body = l.status === 'done' ? cut(l.result, 1400) : l.status === 'error' ? 'Lỗi: ' + cut(l.error, 500) : l.status === 'running' ? 'Đang chạy… (kết quả gửi về ngay khi xong)' : cut(l.result || l.error || '', 600);
    return '📁 ' + r.name + '\n' + r.state.icon + ' ' + r.state.label + (r.mode !== 'chay' ? ' · chế độ: ' + (MODE_LABEL[r.mode] || r.mode) : '') + '\nViệc #' + l.id + ': “' + cut(l.prompt, 200) + '”' + (body ? '\n→ ' + body : '');
  }

  return { stateOf, list, lineOf, peek, ago, MODE_LABEL, rowsFor: (raw, chatId, limit) => queryRows(raw, chatId, limit) };
}

module.exports = { createSessions, queryRows, MODE_LABEL };
