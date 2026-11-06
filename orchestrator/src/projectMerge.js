'use strict';
const fs = require('fs');
const path = require('path');
const { createBook } = require('./book');

// GỘP DỰ ÁN: nhiều dự án (mỗi cuộc trò chuyện là một dự án) → một dự án đích.
// Làm NGAY (không cần AI, trang Cài đặt cũng chạy được): đổ sổ tay vào sổ tay đích (cùng chủ đề gom một chương, trùng ý thì thay bản cũ),
// nối chỉ dẫn, chuyển tệp (không ghi đè), chuyển lịch hẹn, gộp danh sách người dùng. Dự án nguồn được CẤT (archived + mergedInto) — thư mục gốc giữ nguyên làm bản dự phòng.
// Sau đó đánh dấu dự án đích "chờ sắp xếp lại": bộ điều phối nhờ AI xếp lại sổ tay cho hợp lý (memory.organizePending → book.reorganize).
const TEMPLATE_HEAD = /^#\s+Chỉ dẫn dự án:.*$/m;
const stripInstr = (t) => String(t || '').replace(/<!--[\s\S]*?-->/g, '').replace(TEMPLATE_HEAD, '').trim();

function moveFile(from, to) {
  try { fs.renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true });
  }
}
function uniqueName(dir, name, tag) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let n = 1, cand; do { cand = stem + ' (từ ' + tag + (n > 1 ? ' ' + n : '') + ')' + ext; n++; } while (fs.existsSync(path.join(dir, cand)));
  return cand;
}

// ids: các dự án đem gộp. into: mã dự án đích có sẵn, hoặc để trống + name để tạo dự án mới. Trả { target, merged, entries, files, schedules }.
function mergeProjects(o) {
  const P = o.projects, now = o.now || Date.now, log = o.log || (() => {});
  const ids = [...new Set((o.ids || []).map(String))];
  if (!ids.length) throw new Error('Chưa chọn dự án nào để gộp.');
  const srcs = ids.map((id) => { const p = P.get(id); if (!p) throw new Error('Không có dự án "' + id + '".'); return p; });
  let target;
  if (o.into) {
    target = P.get(String(o.into)); if (!target) throw new Error('Không có dự án đích "' + o.into + '".');
    if (target.mergedInto) throw new Error('Dự án đích đã bị gộp vào dự án khác.');
  } else {
    const name = String(o.name || '').trim(); if (name.length < 2) throw new Error('Đặt tên cho dự án mới sau khi gộp (hoặc chọn một dự án có sẵn để giữ lại).');
    target = P.create(name, o.by == null ? 'settings' : o.by);
  }
  const sources = srcs.filter((p) => p.id !== target.id);
  if (!sources.length) throw new Error('Cần chọn ít nhất một dự án khác dự án đích để gộp.');

  P.ensureDirs(target);
  const tb = createBook({ rootDir: P.bookDir(target.id), log });
  const out = { target: target.id, merged: [], entries: 0, files: 0, schedules: 0 };
  for (const s of sources) {
    // 1) sổ tay
    try { out.entries += tb.mergeFrom(createBook({ rootDir: P.bookDir(s.id), log })); } catch (e) { log('gộp sổ tay ' + s.id + ' lỗi: ' + e.message); }
    // 2) chỉ dẫn: nối vào cuối chỉ dẫn đích (có tiêu đề nguồn)
    const ins = stripInstr(P.rawInstructions(s.id));
    if (ins) { const cur = P.rawInstructions(target.id); P.setInstructions(target.id, (cur ? cur.replace(/\s+$/, '') + '\n\n' : '') + '## (Gộp từ dự án "' + s.name + '")\n' + ins + '\n'); }
    // 3) tệp tài liệu + kết quả (không ghi đè: trùng tên thì thêm "(từ <mã>)")
    for (const sub of ['TAI-LIEU', 'KET-QUA']) {
      const from = path.join(P.dirOf(s.id), sub), to = path.join(P.dirOf(target.id), sub);
      let names = []; try { names = fs.readdirSync(from); } catch (e) { continue; }
      fs.mkdirSync(to, { recursive: true });
      for (const n of names) { if (n.startsWith('.')) continue; try { moveFile(path.join(from, n), path.join(to, uniqueName(to, n, s.id))); out.files++; } catch (e) { log('chuyển tệp ' + n + ' lỗi: ' + e.message); } }
    }
    // 4) lịch hẹn + người dùng + đánh dấu nguồn đã gộp
    const fresh = P.get(s.id);
    P.update(target.id, (t) => {
      t.schedule = Array.isArray(t.schedule) ? t.schedule : [];
      for (const j of (fresh.schedule || [])) { if (t.schedule.length >= P.MAX_SCHEDULES) break; t.schedule.push(Object.assign({}, j, { id: t.schedule.reduce((m, x) => Math.max(m, x.id), 0) + 1 })); out.schedules++; }
      t.users = [...new Set([...(t.users || []), ...(fresh.users || [])])];
      if (!t.chat && fresh.chat) t.chat = fresh.chat;
    });
    P.update(s.id, (x) => { x.archived = true; x.mergedInto = target.id; x.mergedAt = now(); x.schedule = []; delete x.pendingOrganize; });
    out.merged.push(s.id);
    log('đã gộp dự án "' + s.name + '" vào "' + target.name + '"');
  }
  // 5) dự án đích chờ AI sắp xếp lại (bộ điều phối làm nền); ghi danh sách nguồn để lấy tóm tắt các cuộc trò chuyện
  P.update(target.id, (t) => { t.pendingOrganize = { since: now(), from: [...new Set([...(t.pendingOrganize ? t.pendingOrganize.from : []), ...out.merged])] }; t.autoTitle = false; });
  try { tb.tidy(); tb.numberAll(); } catch (e) { /* bỏ qua */ }
  return out;
}

module.exports = { mergeProjects };
