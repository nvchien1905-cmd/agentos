'use strict';
const fs = require('fs');
const path = require('path');

// ĐIỀU KHIỂN TỪNG VIỆC từ trang Cài đặt → Nhật ký. Trang Cài đặt chạy bằng root và chỉ ĐỌC cơ sở dữ liệu, nên nó không sửa việc trực tiếp:
// nó thả một tệp yêu cầu JSON vào thư mục điều khiển; bộ điều phối (người dùng agentos) đọc, thực hiện, rồi xóa tệp. Chỉ nhận danh sách hành động cố định.
//   job.cancel {id}              hủy việc (đang xếp hàng hoặc đang chạy)
//   job.hold {id} / job.release {id}   tạm dừng việc đang xếp hàng (giữ lại, không chạy) / cho chạy tiếp
//   job.rerun {id}               chạy lại việc đã kết thúc (tạo việc mới cùng nội dung)
//   job.project {id, project}    đổi dự án của việc chưa chạy hoặc đã xong ('' = bỏ dự án)
//   sched.pause {scope, id} / sched.resume {scope, id} / sched.remove {scope, id}   việc định kỳ: tạm dừng / bật lại / xóa
//   sched.project {id, project}  chuyển việc hẹn giờ chung vào một dự án
//   sched.removeMatching {text}  xóa việc định kỳ có nội dung chứa đoạn chữ này và hủy các việc đang chờ/chạy cùng nội dung
const ACTIONS = ['approval.answer', 'job.submit', 'job.cancel', 'job.hold', 'job.release', 'job.pause', 'job.resume', 'review.run', 'job.project', 'job.rerun', 'sched.pause', 'sched.resume', 'sched.remove', 'sched.project', 'sched.removeMatching'];
const MAX_BYTES = 10000;

function createControl(o) {
  const { db, worker, schedule, projects } = o, dir = o.dir, log = o.log || (() => {});
  const approvals = o.approvals || null, adminId = o.adminId || null;

  function apply(req) {
    const a = String(req.action || '');
    const id = Number(req.id);
    const projectOk = (p) => !p || (projects && projects.get(String(p)));
    switch (a) {
      // Duyệt từ trang Cài đặt (như bấm nút trên Telegram): decision y = cho phép, r = cho phép cả việc, n = từ chối
      case 'approval.answer': {
        if (!approvals || !adminId || !/^\w{1,40}$/.test(String(req.approval)) || !/^[yrn]$/.test(String(req.decision))) return false;
        approvals.answer('ap:' + req.approval + ':' + req.decision, adminId).catch(() => {}); return true;
      }
      // Giao việc mới từ trang Cài đặt (cho chủ máy), có thể gắn dự án
      case 'job.submit': {
        const text = String(req.text || '').trim().slice(0, 4000);
        if (!text || !adminId || !projectOk(req.project)) return false;
        db.addJob(adminId, text, null, null, 'main', req.project ? projects.get(String(req.project)).id : null); if (worker) setImmediate(() => worker.wake()); return true;
      }
      case 'job.cancel': {
        if (!Number.isInteger(id)) return false;
        if (db.cancelJobById(id)) return true;
        return worker && worker.cancelJob ? worker.cancelJob(id) : false;
      }
      case 'job.hold': return Number.isInteger(id) && db.holdJob(id);
      case 'job.pause': return Number.isInteger(id) && !!worker && !!worker.pauseJob && worker.pauseJob(id);
      case 'job.resume': return Number.isInteger(id) && !!worker && !!worker.resumeJob && worker.resumeJob(id);
      case 'review.run': { if (!o.review || !/^[a-z0-9]{1,12}$/.test(String(req.bot)) || !Number.isInteger(id)) return false; o.review.run(String(req.bot), id).catch((e) => log('đánh giá lệnh lỗi: ' + e.message)); return true; }
      case 'job.release': { if (!Number.isInteger(id)) return false; const ok = db.releaseJob(id); if (ok && worker) setImmediate(() => worker.wake()); return ok; }
      case 'job.rerun': {                      // chạy lại: tạo việc MỚI cùng nội dung/dự án/AI (chỉ việc đã kết thúc)
        if (!Number.isInteger(id)) return false;
        const j = db.getJob(id); if (!j || !['done', 'error', 'limit', 'cancelled', 'interrupted'].includes(j.status)) return false;
        db.addJob(j.chat_id, j.prompt, j.engine_pref, j.profile, j.lane === 'bg' ? 'bg' : 'main', j.project, j.council); if (worker) setImmediate(() => worker.wake()); return true;
      }
      case 'job.project': {
        if (!Number.isInteger(id) || !projectOk(req.project)) return false;
        return db.setJobProject(id, req.project ? projects.get(String(req.project)).id : null);
      }
      case 'sched.pause': case 'sched.resume': return Number.isInteger(id) && schedule.setPaused(String(req.scope || ''), id, a === 'sched.pause');
      case 'sched.remove': return Number.isInteger(id) && schedule.removeJob(String(req.scope || ''), id);
      case 'sched.project': return Number.isInteger(id) && !!req.project && schedule.moveToProject(id, String(req.project));
      case 'sched.removeMatching': {
        const text = String(req.text || '').trim(); if (text.length < 8) return false;     // đoạn chữ quá ngắn có thể trùng nhầm nhiều việc khác
        let n = schedule.removeMatching(text);
        for (const j of db.raw.prepare("SELECT id, status FROM jobs WHERE status IN ('queued','waiting','running') AND instr(prompt, ?) > 0").all(text)) {
          if (j.status === 'running' ? (worker && worker.cancelJob && worker.cancelJob(j.id)) : db.cancelJobById(j.id)) n++;
        }
        return n > 0;
      }
      default: return false;
    }
  }

  // Gọi định kỳ (vài giây/lần). Trả số yêu cầu đã xử lý.
  function tick() {
    let names; try { names = fs.readdirSync(dir).filter((n) => /^[\w.-]+\.json$/.test(n)).sort(); } catch (e) { return 0; }
    let done = 0;
    for (const n of names) {
      const f = path.join(dir, n);
      let req = null;
      try { const st = fs.statSync(f); if (st.size <= MAX_BYTES) req = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* hỏng: bỏ */ }
      try { fs.unlinkSync(f); } catch (e) { continue; }                      // xóa trước khi làm: lỗi giữa chừng cũng không lặp lại
      if (!req || !ACTIONS.includes(req.action)) { log('điều khiển: bỏ yêu cầu không hợp lệ ' + n); continue; }
      let ok = false; try { ok = !!apply(req); } catch (e) { log('điều khiển ' + req.action + ' lỗi: ' + e.message); }
      log('điều khiển: ' + req.action + (req.id != null ? ' #' + req.id : '') + (ok ? ' xong' : ' không áp dụng được')); done++;
    }
    return done;
  }

  return { tick, apply, ACTIONS };
}

module.exports = { createControl, ACTIONS };
