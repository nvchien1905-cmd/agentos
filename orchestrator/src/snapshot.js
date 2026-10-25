'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// ĐIỂM KHÔI PHỤC CẤU HÌNH trước khi làm việc nguy hiểm: nén /etc (cấu hình hệ thống, dịch vụ, mạng, người dùng) + dữ liệu AgentOS
// vào một tệp .tar.gz quyền 600, giữ `keep` bản mới nhất. KHÔNG phải sao lưu cả ổ đĩa (không chứa tệp cá nhân, OneDrive, chương trình đã cài):
// đủ để lấy lại cấu hình bị sửa hỏng (sudo tar -xzf <tệp> -C /). Dùng từ bot (/saoluu), tự chạy trước /lenh nguy hiểm, và AI gọi bằng
//   node /opt/agentos/orchestrator/src/snapshot.js <nhãn>
function createSnapshot(o) {
  o = o || {};
  const dir = o.dir || '/var/lib/agentos/snapshots';
  const keep = o.keep || 5;
  const paths = o.paths || ['/etc', '/var/lib/agentos/data/db.json'].filter((p) => fs.existsSync(p));
  const useSudo = o.sudo === undefined ? process.platform === 'linux' && process.getuid && process.getuid() !== 0 : o.sudo;
  const exec = o.exec || ((bin, args) => new Promise((res) => execFile(bin, args, { timeout: 180000, maxBuffer: 1 << 20 }, (e, so, se) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, err: String(se || '').trim() }))));
  const stamp = () => { const d = new Date(Date.now() + 7 * 3600 * 1000); return d.toISOString().replace(/[-:T]/g, '').slice(0, 14); };

  function list() {
    try { return fs.readdirSync(dir).filter((n) => /^snap-.*\.tar\.gz$/.test(n)).sort().map((n) => { const st = fs.statSync(path.join(dir, n)); return { name: n, file: path.join(dir, n), size: st.size, at: st.mtimeMs }; }); }
    catch (e) { return []; }
  }

  async function create(label) {
    const slug = String(label || 'tay').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'tay';
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { return { ok: false, error: 'Không tạo được thư mục ' + dir + ': ' + e.message }; }
    const file = path.join(dir, 'snap-' + stamp() + '-' + slug + '.tar.gz');
    const args = ['-czf', file, '--ignore-failed-read', '--warning=no-file-changed'].concat(paths);
    const r = useSudo ? await exec('sudo', ['-n', 'tar'].concat(args)) : await exec('tar', args);
    // tar trả mã 1 khi vài tệp đổi giữa chừng nhưng vẫn tạo được bản lưu: chỉ coi là lỗi khi không có tệp
    if (!fs.existsSync(file) || (r.code > 1)) { try { fs.rmSync(file, { force: true }); } catch (e) { /* không có */ } return { ok: false, error: 'tar lỗi: ' + (r.err || 'mã ' + r.code).slice(0, 200) }; }
    try { if (useSudo) await exec('sudo', ['-n', 'chown', String(process.getuid()), file]); fs.chmodSync(file, 0o600); } catch (e) { /* bỏ qua */ }
    const all = list();
    for (const old of all.slice(0, Math.max(0, all.length - keep))) { try { fs.rmSync(old.file, { force: true }); } catch (e) { /* bỏ qua */ } }
    return { ok: true, file, size: fs.statSync(file).size };
  }

  return { create, list, dir };
}

module.exports = { createSnapshot };

if (require.main === module) {
  createSnapshot().create(process.argv[2] || 'ai').then((r) => { console.log(r.ok ? 'Đã tạo điểm khôi phục: ' + r.file : 'LỖI: ' + r.error); process.exit(r.ok ? 0 : 1); });
}
