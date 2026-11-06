'use strict';
const fs = require('fs');
const path = require('path');

// QUYỀN DÙNG MÁY THEO TỪNG ID TELEGRAM. Chủ máy dùng mọi máy; ID khác CHỈ dùng máy được chủ máy giao:
//   "@local"   màn hình/bàn phím/chuột của máy chủ AgentOS này (các lệnh /manhinh /cuaso /mo /dong /go /phim /bam /timchu /bamchu /chuyen /dan)
//   "<tên máy>" máy từ xa trong kho mật khẩu (Cài đặt → Máy từ xa): ID đó gõ /vao <tên máy> và chỉ THẤY các máy của mình
// Màn hình máy chủ chỉ có MỘT bộ: ai đang dùng thì giữ "lượt dùng" (mặc định 10 phút kể từ thao tác cuối); ID khác phải chờ hoặc người đó /nhaman. Chủ máy luôn được giành lại.
// Các lệnh nguy hiểm (tắt/khóa/mở khóa máy, tự xa...) vẫn CHỈ dành cho chủ máy.
// Lưu ở một tệp JSON cạnh kho mật khẩu để cả bộ điều phối lẫn trang Cài đặt cùng đọc/ghi: { "machines": { "@local": ["123456789"], "May van phong": ["987654321"] } }
const LOCAL = '@local';
const SCREEN_CMDS = new Set(['manhinh', 'cuaso', 'mo', 'dong', 'go', 'phim', 'bam', 'timchu', 'bamchu', 'chuyen', 'dan']);
const MACHINE_CMDS = new Set([...SCREEN_CMDS, 'vao', 'nhaman']);
const noAcc = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
const normUid = (u) => String(u).trim();

function createMachineAccess(o) {
  const file = o.file, isAdmin = o.isAdmin || (() => false), now = o.now || Date.now, leaseMs = o.leaseMs || 10 * 60 * 1000;
  let cache = null, cacheKey = '';
  function read() {
    let st = null; try { st = fs.statSync(file); } catch (e) { return { machines: {} }; }
    const k = st.mtimeMs + ':' + st.size;
    if (cache && k === cacheKey) return cache;
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); cache = { machines: j && typeof j.machines === 'object' && j.machines ? j.machines : {} }; } catch (e) { cache = { machines: {} }; }
    cacheKey = k; return cache;
  }
  function write(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o640 }); fs.renameSync(tmp, file);
    if (o.chown) { try { o.chown(file); } catch (e) { /* bỏ qua */ } }
    cache = null; cacheKey = '';
  }
  const key = (name) => (/^(@local|maytinh|may tinh|man hinh|manhinh|may nay)$/.test(noAcc(name)) ? LOCAL : String(name || '').trim());
  const findKey = (data, name) => { const k = key(name); if (data.machines[k]) return k; const n = noAcc(k); return Object.keys(data.machines).find((x) => noAcc(x) === n) || k; };

  const usersOf = (name) => { const d = read(), k = findKey(d, name); return (d.machines[k] || []).slice(); };
  // Máy (và "@local") ID này được dùng
  const grants = (uid) => { const d = read(), u = normUid(uid); return Object.keys(d.machines).filter((k) => (d.machines[k] || []).includes(u)); };
  const can = (uid, name) => isAdmin(uid) || usersOf(name).includes(normUid(uid));

  // Giao máy cho nhiều ID (thay hẳn danh sách của máy đó). users rỗng = chỉ chủ máy.
  function setUsers(name, users) {
    const list = [...new Set((Array.isArray(users) ? users : String(users || '').split(/[\s,;]+/)).map(normUid).filter((u) => /^\d{3,15}$/.test(u)))];
    const d = read(), k = findKey(d, name);
    if (!k) throw new Error('Thiếu tên máy.');
    const data = { machines: Object.assign({}, d.machines) };
    if (list.length) data.machines[k] = list; else delete data.machines[k];
    write(data); return { name: k, users: list };
  }
  // Giao/thu một máy cho một ID
  function grant(uid, name, on) {
    const cur = usersOf(name), u = normUid(uid);
    if (!/^\d{3,15}$/.test(u)) throw new Error('ID Telegram phải là số.');
    return setUsers(name, on === false ? cur.filter((x) => x !== u) : [...cur, u]);
  }
  const snapshot = () => Object.assign({}, read().machines);
  // Xóa máy khỏi bảng quyền (khi xóa khỏi kho mật khẩu)
  function forget(name) { const d = read(), k = findKey(d, name); if (!d.machines[k]) return false; const data = { machines: Object.assign({}, d.machines) }; delete data.machines[k]; write(data); return true; }

  // ---- lượt dùng màn hình máy chủ ----
  let lease = null;                                    // { uid, at, admin }
  function useScreen(uid) {
    const u = normUid(uid), t = now();
    if (isAdmin(u)) { lease = { uid: u, at: t, admin: true }; return { ok: true }; }
    if (lease && lease.uid !== u && t - lease.at < leaseMs) {
      const wait = Math.max(1, Math.ceil((leaseMs - (t - lease.at)) / 60000));
      return { ok: false, holder: lease.uid, admin: !!lease.admin, wait };
    }
    lease = { uid: u, at: t, admin: false }; return { ok: true };
  }
  function releaseScreen(uid) { if (lease && lease.uid === normUid(uid)) { lease = null; return true; } return false; }

  // Lệnh này thuộc nhóm điều khiển máy mà ID này được phép chạy?
  function canRun(uid, name) {
    if (isAdmin(uid)) return true;
    if (!MACHINE_CMDS.has(name)) return false;
    const g = grants(uid);
    if (!g.length) return false;
    if (name === 'vao') return g.some((x) => x !== LOCAL);
    if (name === 'nhaman') return true;
    return g.includes(LOCAL);
  }
  // Cổng cho lệnh điều khiển máy: trả null = cho chạy (đã giữ lượt dùng màn hình), chuỗi = lý do từ chối.
  function gate(uid, name) {
    if (!MACHINE_CMDS.has(name) || name === 'nhaman') return null;
    if (!canRun(uid, name)) return 'Bạn chưa được giao máy này. Nhờ chủ máy giao ở Cài đặt → Máy từ xa (hoặc /quyenmay).';
    const r = useScreen(uid);
    if (r.ok) return null;
    return '⏳ Màn hình máy đang được ' + (r.admin ? 'chủ máy' : 'một người khác') + ' dùng, thử lại sau khoảng ' + r.wait + ' phút (người đó gõ /nhaman là dùng được ngay).';
  }
  // Danh sách máy từ xa mà ID này thấy (chủ máy thấy hết)
  const visible = (uid, list) => (isAdmin(uid) ? list : list.filter((x) => can(uid, x.name)));

  return { LOCAL, MACHINE_CMDS, grants, can, canRun, gate, visible, setUsers, grant, usersOf, snapshot, forget, useScreen, releaseScreen, isAdmin, key };
}

module.exports = { createMachineAccess, LOCAL, MACHINE_CMDS, SCREEN_CMDS };
