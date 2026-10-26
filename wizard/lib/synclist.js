'use strict';
const fs = require('fs');
const path = require('path');

// ĐỒNG BỘ CHỌN LỌC OneDrive. Mặc định phần mềm onedrive kéo TOÀN BỘ OneDrive về máy (đo trên tài khoản thật: hơn 25.000 mục chỉ ở bước liệt kê, có thể hàng chục
// hay hàng trăm GB làm đầy ổ đĩa và nghẽn mạng). AgentOS chỉ cần thư mục AgentOS (dữ liệu AI đọc + kết quả + sổ tay), nên MẶC ĐỊNH chỉ đồng bộ thư mục /AgentOS;
// chủ máy thêm thư mục khác (VD /Kế toán) hoặc chọn đồng bộ tất cả ở Cài đặt → Kết nối. Danh sách nằm ở tệp sync_list trong thư mục cấu hình của onedrive.
const DEFAULT = ['/AgentOS'];

function file(conf) { return path.join(conf, 'sync_list'); }

// Trả { all, folders }: all=true khi KHÔNG có tệp sync_list (đồng bộ toàn bộ)
function read(conf) {
  let t;
  try { t = fs.readFileSync(file(conf), 'utf8'); } catch (e) { return { all: true, folders: [] }; }
  const folders = t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
  return { all: false, folders };
}

// Kiểm đầu vào của chủ máy: mỗi dòng một thư mục bắt đầu bằng "/", không có ".." hay ký tự điều khiển/ký tự đặc biệt của mẫu lọc
function clean(list) {
  const out = [];
  for (let raw of Array.isArray(list) ? list : String(list || '').split('\n')) {
    raw = String(raw).trim();
    if (!raw) continue;
    if (!raw.startsWith('/')) raw = '/' + raw;
    raw = raw.replace(/\/+$/, '').replace(/\/{2,}/g, '/');
    if (raw === '' || raw === '/') throw new Error('Muốn đồng bộ TOÀN BỘ OneDrive hãy tích ô "Đồng bộ tất cả", đừng gõ dấu /.');
    if (/\.\.|[\u0000-\u001f*?\[\]{}\\]/.test(raw) || raw.length > 200) throw new Error('Tên thư mục không hợp lệ: ' + raw.slice(0, 60));
    if (!out.includes(raw)) out.push(raw);
  }
  if (out.length > 100) throw new Error('Tối đa 100 thư mục.');
  // luôn có thư mục AgentOS: AI lưu kết quả và sổ tay ở đó
  if (!out.some((p) => p.toLowerCase() === '/agentos')) out.unshift('/AgentOS');
  return out;
}

function write(conf, folders) {
  fs.mkdirSync(conf, { recursive: true });
  fs.writeFileSync(file(conf), '# Do Cài đặt AgentOS tạo: chỉ đồng bộ các thư mục này của OneDrive\n' + folders.join('\n') + '\n', { mode: 0o644 });
}
function removeAll(conf) { try { fs.rmSync(file(conf), { force: true }); } catch (e) { /* chưa có */ } }

module.exports = { DEFAULT, read, clean, write, removeAll, file };
