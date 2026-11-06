'use strict';
const crypto = require('crypto');

// GHÉP ID BẰNG MÃ (giống cách kênh Telegram của Claude Code thêm người gửi): người lạ nhắn bot thì bot trả lời một MÃ GHÉP ĐÔI; chủ máy nhận tin có nút Cho phép / Từ chối kèm đúng mã đó
// (hỏi người kia đọc mã để chắc đúng người). Cho phép = cấp vai Nhân viên (đổi sau bằng /vaitro); Từ chối = bỏ qua ID đó 24 giờ. Không cần gõ số ID bằng tay.
// Chống spam: mỗi ID chỉ một yêu cầu còn hạn (30 phút) và bot chỉ trả lời một lần mỗi 10 phút; tối đa 30 yêu cầu chờ; tối đa 20 thông báo cho chủ máy mỗi giờ. Tắt hẳn: /ghepdoi tat.
const KEY = 'pairing', OFF_KEY = 'pairing_off';
const TTL_MS = 30 * 60000, REPLY_GAP_MS = 10 * 60000, BLOCK_MS = 24 * 3600000, MAX_PENDING = 30, MAX_NOTIFY_PER_HOUR = 20;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';        // bỏ ký tự dễ nhầm (0/O, 1/I)

function createPairing(o) {
  const { db, roles } = o;
  const adminIds = (o.adminIds || []).map(String), send = o.send || (async () => {}), now = o.now || Date.now, log = o.log || (() => {});
  const load = () => { try { const j = JSON.parse(db.kvGet(KEY) || '{}'); return { pending: j.pending || {}, blocked: j.blocked || {}, notified: j.notified || [] }; } catch (e) { return { pending: {}, blocked: {}, notified: [] }; } };
  const save = (st) => db.kvSet(KEY, JSON.stringify(st));
  const enabled = () => db.kvGet(OFF_KEY) !== '1';
  const code = () => Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join('');
  const clean = (st) => {
    const t = now();
    for (const [u, p] of Object.entries(st.pending)) if (t - p.at > TTL_MS) delete st.pending[u];
    for (const [u, until] of Object.entries(st.blocked)) if (t > until) delete st.blocked[u];
    st.notified = st.notified.filter((x) => t - x < 3600000);
    return st;
  };
  const label = (p) => (p.name || 'Không rõ tên') + (p.username ? ' (@' + p.username + ')' : '') + ' · ID ' + p.uid;

  // Người lạ nhắn bot. Trả chuỗi trả lời cho họ, hoặc null (im lặng).
  function request(msg) {
    if (!enabled() || !msg || !msg.from || (msg.chat && msg.chat.type && msg.chat.type !== 'private') || msg.from.is_bot) return null;
    const uid = String(msg.from.id), st = clean(load()), t = now();
    if (st.blocked[uid]) return null;
    let p = st.pending[uid];
    if (p) {
      if (t - (p.repliedAt || 0) < REPLY_GAP_MS) return null;
      p.repliedAt = t; save(st);
      return 'Bạn chưa được cấp quyền dùng bot này. Mã ghép đôi của bạn vẫn là ' + p.code + '. Hãy đọc mã này cho chủ bot để được cho phép.';
    }
    if (Object.keys(st.pending).length >= MAX_PENDING) return null;
    p = { uid, code: code(), name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ').slice(0, 60), username: String(msg.from.username || '').slice(0, 40), at: t, repliedAt: t };
    st.pending[uid] = p;
    let notify = st.notified.length < MAX_NOTIFY_PER_HOUR;
    if (notify) st.notified.push(t);
    save(st);
    if (notify) {
      const text = '🔔 Có người muốn dùng bot: ' + label(p) + '\nMã ghép đôi: ' + p.code + '\nHỏi người đó đọc đúng mã này trước khi cho phép (mã hiệu lực 30 phút). Cho phép sẽ cấp vai Nhân viên, đổi sau bằng /vaitro.';
      const buttons = [[{ text: '✅ Cho phép', data: 'pr:ok:' + uid }, { text: '🚫 Từ chối', data: 'pr:no:' + uid }]];
      for (const a of adminIds) Promise.resolve(send(a, { text, buttons })).catch((e) => log('ghép ID: không báo được cho chủ máy ' + a + ': ' + e.message));
    }
    return 'Xin chào! Bạn chưa được cấp quyền dùng bot này.\nMã ghép đôi của bạn: ' + p.code + '\nHãy đọc mã này cho chủ bot để được cho phép (mã hiệu lực 30 phút).';
  }

  function isCallback(d) { return /^pr:(ok|no):\d+$/.test(String(d || '')); }
  // Chủ máy bấm nút. Trả chữ hiện lại cho người bấm.
  async function answer(data, fromId) {
    if (!adminIds.includes(String(fromId))) return 'Chỉ chủ bot được duyệt.';
    const m = String(data).match(/^pr:(ok|no):(\d+)$/); if (!m) return null;
    const st = clean(load()), p = st.pending[m[2]];
    if (!p) return 'Yêu cầu này đã hết hạn hoặc đã được xử lý.';
    delete st.pending[m[2]];
    if (m[1] === 'no') { st.blocked[m[2]] = now() + BLOCK_MS; save(st); return 'Đã từ chối ' + label(p) + ' (bỏ qua 24 giờ).'; }
    save(st);
    const r = roles.set(m[2], 'nhanvien');
    if (!r.ok) return '⚠️ ' + r.error;
    Promise.resolve(send(m[2], '✅ Chủ bot đã cho phép bạn dùng bot. Gõ /help để xem cách dùng.')).catch(() => {});
    log('ghép ID: đã cấp vai nhân viên cho ' + label(p));
    return 'Đã cho phép ' + label(p) + ' (vai Nhân viên).';
  }

  // /ghepdoi (chủ máy): xem yêu cầu đang chờ · /ghepdoi tat|bat
  function command(arg) {
    const a = String(arg || '').trim().toLowerCase();
    if (a === 'tat' || a === 'tắt') { db.kvSet(OFF_KEY, '1'); return '🔕 Đã TẮT ghép ID bằng mã: người lạ nhắn bot sẽ không được trả lời. Bật lại: /ghepdoi bat'; }
    if (a === 'bat' || a === 'bật') { db.kvDel(OFF_KEY); return '🔔 Đã BẬT ghép ID bằng mã.'; }
    const st = clean(load()); save(st);
    const rows = Object.values(st.pending);
    return '🔗 Ghép ID bằng mã: ' + (enabled() ? 'ĐANG BẬT' : 'đang tắt') + '\n' + (rows.length ? rows.map((p) => '• ' + label(p) + ' — mã ' + p.code).join('\n') : 'Không có yêu cầu nào đang chờ.') + '\n\nBật/tắt: /ghepdoi bat | /ghepdoi tat';
  }

  return { request, isCallback, answer, command, enabled, list: () => Object.values(clean(load()).pending) };
}

module.exports = { createPairing, TTL_MS };
