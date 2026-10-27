'use strict';
const fs = require('fs');
const path = require('path');

// XỬ LÝ CHỨNG TỪ TỰ ĐỘNG cho dự án bật chế độ "chứng từ" (hóa đơn, phiếu nhập/xuất, phiếu thu/chi):
//  - ảnh/PDF gửi vào Telegram lúc đang ở dự án, HOẶC tệp bỏ vào thư mục <dự án>/CHUNG-TU-MOI (tải từ điện thoại/Kho tệp riêng/OneDrive),
//  - AI (bất kỳ AI nào) ĐỌC chứng từ rồi gọi công cụ cố định `agentos-chungtu add`: công cụ kiểm số học, chống trùng, ghi vào KET-QUA/chung-tu.xlsx.
//  - Chỗ nào không chắc: AI hỏi lại chủ máy, không tự sửa số.
const WATCH_DIR = 'CHUNG-TU-MOI', DONE_DIR = 'CHUNG-TU-DA-NHAN';
const FILE_RE = /\.(jpe?g|png|webp|pdf|heic|heif|tiff?)$/i;
const SETTLE_MS = 30000;               // tệp vừa được ghi (đang đồng bộ) thì đợi

function promptFor(p, files, caption) {
  const list = (files || []).map((f) => '- ' + f).join('\n');
  return '[CHỨNG TỪ — dự án "' + p.name + '"] Đọc chứng từ (hóa đơn/phiếu) rồi ghi sổ. ' + (list ? 'Tệp:\n' + list + '\n' : '') +
    'CÁCH LÀM: (1) Đọc tệp bằng công cụ Read (xem được cả ảnh và PDF); KHÔNG chạy lệnh nào khác ngoài agentos-chungtu (mọi lệnh khác bị chặn và làm hỏng việc). ' +
    '(2) Trích đúng những gì NHÌN THẤY, chỗ nào không đọc được hoặc không chắc thì để null, TUYỆT ĐỐI không bịa số. ' +
    '(3) Ghi JSON ra tệp ' + p.dir + '/KET-QUA/.tam-chung-tu.json theo mẫu: {"loai":"hoa-don-mua|hoa-don-ban|phieu-thu|phieu-chi|phieu-nhap|phieu-xuat|khac","ngay":"YYYY-MM-DD","so":"","ky_hieu":"",' +
    '"ben_ban":{"ten":"","mst":""},"ben_mua":{"ten":"","mst":""},"tong_chua_thue":0,"thue_suat":0,"tien_thue":0,"tong_thanh_toan":0,"lines":[{"ten":"","dvt":"","so_luong":0,"don_gia":0,"thanh_tien":0}]}. ' +
    '(4) Chạy: `agentos-chungtu add --project-dir ' + p.dir + ' --file ' + p.dir + '/KET-QUA/.tam-chung-tu.json --source <tệp gốc>` (mỗi chứng từ một lần). Công cụ tự kiểm số học và chống trùng. ' +
    '(5) Kết quả: status "added" → báo MỘT dòng (ngày · bên bán · tổng tiền); "duplicate" → báo đã có; "needs_review" → liệt kê từng điểm nghi ngờ (issues) và HỎI chủ máy số đúng, không tự sửa. ' +
    'Bảng tổng hợp: KET-QUA/chung-tu.xlsx. Không gửi chứng từ ra ngoài.' + (caption ? '\nGhi chú của chủ máy: ' + caption : '');
}

function createChungTu(o) {
  const { projects, submit } = o;
  const log = o.log || (() => {}), now = o.now || Date.now;
  const settle = o.settleMs === undefined ? SETTLE_MS : o.settleMs;
  let timer = null;

  // Quét thư mục CHUNG-TU-MOI của các dự án đang bật chế độ chứng từ; mỗi tệp thành một việc. Trả số tệp đã giao.
  function scan() {
    let n = 0;
    for (const p of projects.list()) {
      if (!p.chungtu) continue;
      const inbox = path.join(p.dir, WATCH_DIR), done = path.join(p.dir, DONE_DIR);
      let names = []; try { names = fs.readdirSync(inbox); } catch (e) { continue; }
      for (const name of names) {
        if (name.startsWith('.') || !FILE_RE.test(name)) continue;
        const f = path.join(inbox, name);
        let st; try { st = fs.statSync(f); } catch (e) { continue; }
        if (!st.isFile() || now() - st.mtimeMs < settle) continue;
        let dest = path.join(done, name);
        try {
          fs.mkdirSync(done, { recursive: true });
          if (fs.existsSync(dest)) dest = path.join(done, path.basename(name, path.extname(name)) + '-' + now() + path.extname(name));
          fs.renameSync(f, dest);                                                        // chuyển TRƯỚC khi giao việc: không giao lặp
        } catch (e) { log('chứng từ: không chuyển được ' + name + ': ' + e.message); continue; }
        try { submit(promptFor(p, [dest], ''), p.id); n++; log('chứng từ: đã giao "' + name + '" của dự án ' + p.id + ' cho AI'); } catch (e) { log('chứng từ: giao việc lỗi: ' + e.message); }
      }
    }
    return n;
  }
  // Thư mục nhận chứng từ phải tồn tại để người dùng bỏ tệp vào (Kho tệp riêng/OneDrive thấy thư mục)
  function ensureInbox(p) { try { fs.mkdirSync(path.join(p.dir, WATCH_DIR), { recursive: true, mode: 0o2775 }); } catch (e) { /* bỏ qua */ } }
  return {
    scan, ensureInbox, promptFor, WATCH_DIR, DONE_DIR,
    start(ms) { timer = setInterval(() => { try { scan(); } catch (e) { log('quét chứng từ lỗi: ' + e.message); } }, ms || 60000); if (timer.unref) timer.unref(); },
    stop() { clearInterval(timer); },
  };
}

// Cổng duyệt: dự án bật chế độ chứng từ — AI được ghi ĐÚNG tệp tạm KET-QUA/.tam-chung-tu.json và chạy ĐÚNG lệnh agentos-chungtu add của dự án đó mà không phải hỏi từng lần
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function autoAllowFor(projects) {
  return (job, tool, input) => {
    if (!job.project) return false;
    const p = projects.get(job.project); if (!p || !p.chungtu) return false;
    const tmpf = path.join(p.dir, 'KET-QUA', '.tam-chung-tu.json');
    if (tool === 'Write') return path.resolve(String((input || {}).file_path || '')) === tmpf;
    if (tool === 'Bash') return new RegExp('^agentos-chungtu add --project-dir ' + reEsc(p.dir) + ' --file ' + reEsc(tmpf) + '( --source [\\w./-]+)?$').test(String((input || {}).command || '').trim());
    return false;
  };
}

module.exports = { createChungTu, promptFor, autoAllowFor, WATCH_DIR, DONE_DIR };
