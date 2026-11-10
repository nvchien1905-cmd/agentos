'use strict';
// HỘP THƯ GIAO VIỆC giữa bot quản lý và bot thường (Telegram không cho bot nhắn cho bot, nên đi qua thư mục trên máy).
//   <root>/<agent>/in/<mã>.json   bot quản lý (người dùng agentos) thả việc  -> bot thường nhận, làm, xóa
//   <root>/<agent>/out/<mã>.json  bot thường trả kết quả                      -> bot quản lý đọc, báo chủ máy, xóa
// Quyền thư mục do agentos-agentctl (root) đặt: in = agentos ghi, agent đọc/xóa; out = agent ghi, agentos đọc/xóa; agent khác không vào được.
// Nội dung hộp thư là DỮ LIỆU KHÔNG TIN CẬY (bot thường bị lừa cũng chỉ ghi được chữ vào out/): bên nhận kiểm lại mọi giá trị.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = '/var/lib/agentos-agents/.mail';
const JID_RE = /^[a-f0-9]{16}$/;
const NUM_RE = /^\d{1,15}$/;
const MAX_IN = 16 * 1024, MAX_OUT = 96 * 1024, MAX_TASK = 6000, MAX_TEXT = 12000;

function createMail(o) {
  o = o || {};
  const root = o.root || ROOT;
  const F = o.fs || fs;
  const now = o.now || Date.now;
  const dir = (id, sub) => path.join(root, id, sub);
  let seq = 0;                                                   // thứ tự giao trong cùng một tiến trình (tên tệp là mã ngẫu nhiên nên không dùng để xếp thứ tự)

  // Đọc một tệp hộp thư an toàn: không theo liên kết tượng trưng, một liên kết cứng, có giới hạn cỡ
  function readJson(file, max) {
    const st = F.lstatSync(file);
    if (!st.isFile() || st.nlink > 1 || st.size > max) throw new Error('tệp không hợp lệ');
    const fd = F.openSync(file, F.constants.O_RDONLY | (F.constants.O_NOFOLLOW || 0));
    try { return JSON.parse(F.readFileSync(fd, 'utf8')); } finally { F.closeSync(fd); }
  }
  function writeJson(file, obj) {
    const tmp = file + '.tmp';
    F.rmSync(tmp, { force: true });
    const fd = F.openSync(tmp, 'wx', 0o660); try { F.writeSync(fd, JSON.stringify(obj)); } finally { F.closeSync(fd); }
    try { F.chmodSync(tmp, 0o660); } catch (e) { /* bỏ qua */ }
    F.renameSync(tmp, file);
  }
  const names = (d) => { try { return F.readdirSync(d).filter((n) => /^[a-f0-9]{16}\.json$/.test(n)).sort(); } catch (e) { return []; } };

  // ---- PHÍA BOT QUẢN LÝ ----
  // Giao việc: chat = ID Telegram người giao (để báo kết quả đúng nơi), from = ID người giao (bot thường kiểm có được phép không)
  function send(agentId, { from, chat, text, by }) {
    if (!/^a\d{1,3}$/.test(String(agentId))) throw new Error('Mã bot sai');
    if (!NUM_RE.test(String(from)) || !NUM_RE.test(String(chat))) throw new Error('ID người giao sai');
    const task = String(text || '').replace(/\0/g, '').trim().slice(0, MAX_TASK);
    if (!task) throw new Error('Việc trống');
    const jid = crypto.randomBytes(8).toString('hex');
    seq++;
    const d = dir(agentId, 'in');
    if (!F.existsSync(d)) throw new Error('Bot này chưa có hộp thư (cần cập nhật AgentOS rồi chạy lại bot: Cài đặt → Bot Telegram → Khởi động lại).');
    try { writeJson(path.join(d, jid + '.json'), { jid, from: String(from), chat: String(chat), text: task, by: String(by || '').slice(0, 40), at: now(), n: seq }); }
    catch (e) { throw new Error('Không ghi được vào hộp thư của bot (' + (e.code || e.message) + ')'); }
    return jid;
  }
  // Lấy kết quả bot thường đã trả (xóa sau khi lấy)
  function collect(agentId) {
    const out = [], d = dir(agentId, 'out');
    for (const n of names(d)) {
      const f = path.join(d, n);
      try {
        const j = readJson(f, MAX_OUT);
        const chat = String(j.chat || '');
        if (j.jid !== n.slice(0, 16) || !NUM_RE.test(chat)) throw new Error('sai khuôn');
        out.push({ jid: j.jid, chat, status: ['done', 'error', 'cancelled', 'rejected'].includes(j.status) ? j.status : 'error', text: String(j.text || '').slice(0, MAX_TEXT), task: String(j.task || '').slice(0, 200), at: Number(j.at) || 0 });
      } catch (e) { /* tệp hỏng: bỏ */ }
      try { F.rmSync(f, { force: true }); } catch (e) { /* bỏ qua */ }
    }
    return out;
  }
  const pendingIn = (agentId) => names(dir(agentId, 'in')).length;

  // ---- PHÍA BOT THƯỜNG (agent) ----
  // allowed = Set ID được nhắn cho bot này; việc từ ID lạ bị từ chối (ghi vào out để bot quản lý biết)
  function take(agentId, allowed) {
    const jobs = [], d = dir(agentId, 'in'), order = new Map();
    for (const n of names(d)) {
      const f = path.join(d, n);
      let j = null;
      try { j = readJson(f, MAX_IN); } catch (e) { /* hỏng */ }
      try { F.rmSync(f, { force: true }); } catch (e) { /* bỏ qua */ }
      if (!j || j.jid !== n.slice(0, 16) || !NUM_RE.test(String(j.from)) || !NUM_RE.test(String(j.chat))) continue;
      const text = String(j.text || '').trim().slice(0, MAX_TASK);
      if (!text) continue;
      if (!allowed || !allowed.has(String(j.from))) { finish(agentId, { jid: j.jid, chat: j.chat, task: text, status: 'rejected', text: 'Bot này không nhận việc từ ID ' + j.from + ' (không nằm trong danh sách được phép). Thêm ID đó ở Cài đặt → Bot Telegram → thẻ của bot.' }); continue; }
      jobs.push({ jid: j.jid, from: String(j.from), chat: String(j.chat), text, by: String(j.by || '').slice(0, 40) });
      order.set(j.jid, [Number(j.at) || 0, Number(j.n) || 0]);
    }
    return jobs.sort((a, b) => { const x = order.get(a.jid), y = order.get(b.jid); return x[0] - y[0] || x[1] - y[1]; });      // việc giao trước làm trước
  }
  function finish(agentId, { jid, chat, task, status, text }) {
    writeJson(path.join(dir(agentId, 'out'), jid + '.json'), { jid, chat: String(chat), task: String(task || '').slice(0, 200), status, text: String(text || '').slice(0, MAX_TEXT), at: now() });
  }

  return { send, collect, pendingIn, take, finish, root };
}

module.exports = { createMail, ROOT, MAX_TASK };
