'use strict';

// PHÂN VAI cho người dùng được phép. Chủ máy (ADMIN_USER_IDS trong cấu hình) luôn là "chu": dùng mọi lệnh, AI chạy chế độ TOÀN QUYỀN nếu đang bật.
// Người khác chỉ có các vai dưới đây, và việc của họ LUÔN chạy ở chế độ BẢO VỆ (chỉ đọc, hỏi duyệt, hộp cô lập), không bao giờ được hưởng chế độ toàn quyền:
//   xem       chỉ xem báo cáo: /doanhso /ton, không nhắn việc cho AI
//   nhanvien  /doanhso /ton /doc + nhắn AI (chỉ đọc file trong thư mục làm việc/OneDrive)
//   ketoan    nhanvien + /doi /thay /in /baocao (đọc và sửa tệp Word/Excel/PowerPoint)
// Lưu ở cơ sở dữ liệu (kv 'users' = { "<id Telegram>": "<vai>" }), thêm/bớt bằng /vaitro từ Telegram, không cần sửa tệp cấu hình.
const ROLES = {
  xem: { label: 'Chỉ xem báo cáo', quick: ['doanhso', 'ton'], ask: false },
  nhanvien: { label: 'Nhân viên', quick: ['doanhso', 'ton', 'doc'], ask: true },
  ketoan: { label: 'Kế toán', quick: ['doanhso', 'ton', 'doc', 'doi', 'thay', 'in', 'baocao'], ask: true },
};
const KEY = 'users';

function createRoles({ db, allowed, adminIds, log }) {
  log = log || (() => {});
  const fromEnv = new Set(allowed);                         // ID có sẵn trong cấu hình: /vaitro xoa không gỡ được
  const read = () => { try { const o = JSON.parse(db.kvGet(KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } };
  const write = (o) => db.kvSet(KEY, JSON.stringify(o));
  const isAdmin = (uid) => adminIds.has(String(uid));

  // Khởi động: nạp người dùng đã thêm bằng /vaitro vào danh sách được phép
  for (const uid of Object.keys(read())) if (/^\d+$/.test(uid)) allowed.add(uid);

  const roleOf = (uid) => (isAdmin(uid) ? 'chu' : (read()[String(uid)] || 'nhanvien'));
  return {
    ROLES,
    roleOf,
    label: (uid) => (isAdmin(uid) ? 'Chủ máy' : (ROLES[roleOf(uid)] || ROLES.nhanvien).label),
    canQuick: (uid, name) => isAdmin(uid) || (ROLES[roleOf(uid)] || ROLES.nhanvien).quick.includes(name),
    canAsk: (uid) => isAdmin(uid) || (ROLES[roleOf(uid)] || ROLES.nhanvien).ask,
    set(uid, role) {
      uid = String(uid).trim(); role = String(role || '').toLowerCase();
      if (!/^\d{5,15}$/.test(uid)) return { ok: false, error: 'ID Telegram phải là số (người đó gõ /id với bot để biết).' };
      if (!ROLES[role]) return { ok: false, error: 'Vai không có. Chọn: ' + Object.keys(ROLES).join(', ') + '.' };
      if (isAdmin(uid)) return { ok: false, error: 'Người này là chủ máy (đặt trong cấu hình), không đổi vai ở đây.' };
      const o = read(); o[uid] = role; write(o); allowed.add(uid);
      log('vai trò: ' + uid + ' = ' + role);
      return { ok: true };
    },
    remove(uid) {
      uid = String(uid).trim();
      if (isAdmin(uid)) return { ok: false, error: 'Không gỡ được chủ máy.' };
      const o = read(); const had = uid in o; delete o[uid]; write(o);
      if (!fromEnv.has(uid)) allowed.delete(uid);
      return { ok: true, had, kept: fromEnv.has(uid) };
    },
    list() {
      const o = read();
      const rows = [...adminIds].map((u) => ({ uid: u, role: 'chu', label: 'Chủ máy' }));
      const ids = new Set([...Object.keys(o), ...[...allowed].filter((u) => !isAdmin(u))]);
      for (const u of ids) rows.push({ uid: u, role: o[u] || 'nhanvien', label: (ROLES[o[u] || 'nhanvien'] || ROLES.nhanvien).label });
      return rows;
    },
  };
}

module.exports = { createRoles, ROLES };
