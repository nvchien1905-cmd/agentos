'use strict';
const fs = require('fs');

// BÁC SĨ MÁY: khi tự chẩn đoán (healthmon) thấy lỗi mà đã biết cách sửa AN TOÀN thì tự sửa rồi báo kết quả, thay vì chỉ báo lỗi.
// Bộ điều phối chạy bằng người dùng thường nên KHÔNG tự sửa hệ thống: nó ghi yêu cầu vào /var/lib/agentos/heal-request, dịch vụ root agentos-heal
// (danh sách việc CỐ ĐỊNH: khởi động lại dịch vụ trong danh sách, bật lại kho tệp riêng, dọn ổ đĩa) làm rồi ghi kết quả; doctor kiểm tra lại rồi báo.
// Giới hạn: mỗi lỗi tự sửa tối đa 3 lần/ngày và cách nhau ≥ 20 phút (không vòng lặp). Lỗi chưa biết cách sửa: chỉ báo như cũ; /bacsi nhờ AI chẩn đoán (chỉ đọc).
const MAX_PER_DAY = 3, GAP_MS = 20 * 60 * 1000, WAIT_MS = 90 * 1000;
const UNIT_OK = /^[A-Za-z0-9@._-]{3,60}$/;

// Mỗi luật: (kết quả kiểm tra bị lỗi) -> danh sách việc xin agentos-heal (mỗi việc là một dòng "restart <dịch-vụ>" | "cloud" | "free-space")
const RULES = {
  services: (r) => { const m = String(r.detail || '').match(/không chạy: (.+)$/); return m ? m[1].split(/[,\s]+/).filter((u) => UNIT_OK.test(u)).slice(0, 4).map((u) => 'restart ' + u) : []; },
  resources: (r) => (/ổ đĩa gần đầy/.test(r.detail || '') ? ['free-space'] : []),
  cloud: () => ['cloud'],
};

function createDoctor(o) {
  const { selftest, db } = o, log = o.log || (() => {}), now = o.now || Date.now;
  const clock = o.clock || Date.now;           // đồng hồ thật để đợi kết quả (now có thể là giờ giả khi thử)
  const reqFile = o.requestFile || '/var/lib/agentos/heal-request', resFile = o.resultFile || '/var/lib/agentos/heal-result.json';
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const waitMs = o.waitMs === undefined ? WAIT_MS : o.waitMs;
  const rules = Object.assign({}, RULES, o.rules || {});
  const state = () => { try { return JSON.parse(db.kvGet('doctor_state') || '{}'); } catch (e) { return {}; } };
  const saveState = (s) => db.kvSet('doctor_state', JSON.stringify(s));
  const day = () => new Date(now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const readResult = () => { try { return JSON.parse(fs.readFileSync(resFile, 'utf8')); } catch (e) { return null; } };

  // Xin agentos-heal làm các việc; đợi kết quả mới (ts > lúc gửi). Trả { ok, results } hoặc { ok:false, error }
  async function ask(actions) {
    const sent = Math.floor(clock() / 1000) - 1;
    try { fs.writeFileSync(reqFile, actions.join('\n') + '\n'); } catch (e) { return { ok: false, error: 'không gửi được yêu cầu (' + e.code + '): bác sĩ máy chưa được cài trên máy này?' }; }
    const end = clock() + waitMs;
    for (;;) {
      const r = readResult();
      if (r && r.ts >= sent && !fs.existsSync(reqFile)) return r;
      if (clock() >= end) { try { fs.rmSync(reqFile, { force: true }); } catch (e) { /* bỏ qua */ } return { ok: false, error: 'bác sĩ máy không trả lời trong ' + Math.round(waitMs / 1000) + ' giây' }; }
      await sleep(500);
    }
  }

  // Thử tự sửa các kiểm tra đang lỗi. Trả mảng { id, name, tried, fixed, note }.
  async function heal(failed) {
    const out = [], st = state(), today = day();
    for (const r of failed) {
      const rule = rules[r.id]; if (!rule) continue;
      const actions = rule(r); if (!actions.length) continue;
      const s = st[r.id] || { day: today, n: 0, at: 0 };
      if (s.day !== today) { s.day = today; s.n = 0; }
      if (s.n >= MAX_PER_DAY) { out.push({ id: r.id, name: r.name, tried: false, fixed: false, note: 'đã tự sửa ' + MAX_PER_DAY + ' lần hôm nay mà vẫn lỗi: cần anh xem' }); continue; }
      if (now() - s.at < GAP_MS) continue;                          // vừa sửa xong, chờ xem có ổn không
      s.n++; s.at = now(); st[r.id] = s; saveState(st);
      const res = await ask(actions);
      const again = res.ok !== undefined && !res.error ? await selftest.checks[r.id]().catch(() => null) : null;
      const fixed = !!again && again.status !== 'fail';
      const what = (res.results || []).map((x) => x.out).filter(Boolean).join('; ');
      out.push({ id: r.id, name: r.name, tried: true, fixed, note: res.error ? res.error : (fixed ? what || 'đã sửa' : 'đã thử (' + (what || actions.join(', ')) + ') nhưng vẫn lỗi: ' + (again ? again.detail : '')) });
      log('bác sĩ máy: ' + r.id + ' → ' + (fixed ? 'đã sửa' : 'chưa sửa được'));
    }
    return out;
  }

  return { heal, ask, RULES, MAX_PER_DAY };
}

module.exports = { createDoctor, RULES, UNIT_OK };
