'use strict';

// AI TỰ SỬA LỖI MÁY: khi giám sát (healthmon) thấy một kiểm tra lỗi mà bác sĩ máy (doctor.js) không có cách sửa cố định
// (hoặc đã thử mà vẫn lỗi), thay vì chỉ nhắn "có lỗi" rồi im, giao cho AI điều tra và sửa, xong báo kết quả cho chủ máy.
// Việc chạy như việc của chủ máy ở hàng đợi chính: máy ở chế độ Toàn quyền thì AI tự làm một mạch, chế độ Bảo vệ thì lệnh cần quyền vẫn hỏi chủ máy duyệt.
// Giới hạn chống vòng lặp: mỗi lỗi tối đa MAX_PER_DAY lần/ngày, cách nhau ≥ GAP_MS; đang có việc sửa cũ chưa xong thì không giao thêm.
const MAX_PER_DAY = 2, GAP_MS = 60 * 60 * 1000;

function buildPrompt(failed) {
  const list = failed.map((r) => '- ' + r.name + ' (' + r.id + '): ' + String(r.detail || '').slice(0, 400)).join('\n');
  return [
    'Máy AgentOS vừa tự chẩn đoán và phát hiện lỗi sau. Hãy TỰ SỬA, đừng chỉ báo lại:',
    list,
    '',
    'Cách làm:',
    '1. Điều tra nguyên nhân gốc (systemctl status, journalctl -u <dịch vụ> -n 80, df -h, tệp cấu hình liên quan).',
    '2. Sửa ở mức nhỏ nhất đủ để hết lỗi. Không xóa dữ liệu của chủ máy, không tắt tính năng bảo mật, không đổi mật khẩu/khóa, không cập nhật cả hệ thống.',
    '3. Kiểm tra lại bằng chính lệnh chẩn đoán (agentos-selftest nếu có, hoặc lệnh tương ứng) xem lỗi đã hết chưa.',
    '4. Trả lời ngắn bằng tiếng Việt thường: lỗi do đâu, đã sửa gì, kết quả kiểm lại. Nếu không sửa được hoặc cần chủ máy làm gì (ví dụ cắm lại dây, nhập lại khóa), nói đúng việc cần làm, đừng bỏ lửng.',
  ].join('\n');
}

function createAiFix(o) {
  const { db, submit } = o, log = o.log || (() => {}), now = o.now || Date.now;
  const enabled = o.enabled || (() => true);
  const state = () => { try { return JSON.parse(db.kvGet('aifix_state') || '{}'); } catch (e) { return {}; } };
  const day = () => new Date(now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  // failed: [{id,name,detail}]. Trả { jobs:[{id,name,job}], notes:[chữ] }
  function repair(failed) {
    const out = { jobs: [], notes: [] };
    if (!enabled() || !failed.length) return out;
    const st = state(), today = day(), take = [];
    for (const r of failed) {
      const s = st[r.id] || { day: today, n: 0, at: 0 };
      if (s.day !== today) { s.day = today; s.n = 0; }
      if (s.n >= MAX_PER_DAY) { out.notes.push(r.name + ': AI đã thử ' + MAX_PER_DAY + ' lần hôm nay mà chưa hết lỗi, cần anh xem'); continue; }
      if (now() - s.at < GAP_MS) continue;                       // vừa giao xong, chờ AI làm
      s.n++; s.at = now(); st[r.id] = s; take.push(r);
    }
    if (!take.length) return out;
    db.kvSet('aifix_state', JSON.stringify(st));
    const job = submit(buildPrompt(take));
    for (const r of take) out.jobs.push({ id: r.id, name: r.name, job });
    log('AI tự sửa: giao việc #' + job + ' cho ' + take.map((r) => r.id).join(', '));
    return out;
  }

  return { repair, buildPrompt, MAX_PER_DAY };
}

module.exports = { createAiFix, buildPrompt, MAX_PER_DAY, GAP_MS };
