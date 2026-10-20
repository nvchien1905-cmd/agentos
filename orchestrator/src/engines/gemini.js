'use strict';
const { runProcess, abnormal } = require('./proc');
const { classifyFailure, parseResetTime } = require('../limits');

// Gemini CLI (@google/gemini-cli): `gemini -p "" --output-format json` đọc prompt từ stdin và in MỘT đối tượng JSON:
//   thành công: { session_id, response, stats }      lỗi: { session_id, error: { type, message, code } }   (mã thoát 41 = chưa đăng nhập, 53 = quá lượt hỏi...)
// Đã kiểm trên máy thật (v0.64): chưa đăng nhập trả lỗi "Please set an Auth method..." với mã thoát 41. Dạng thành công suy từ tài liệu: đọc khoan dung.
function parseOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  let v = tryParse(text);
  if (!v) {                                    // có thể có dòng cảnh báo trước JSON: lấy từ dấu { đầu tiên ở đầu dòng
    const i = text.search(/^\{/m);
    if (i >= 0) v = tryParse(text.slice(i));
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

// opts: { bin, binArgs, cwd, prompt, resumeId, mode: 'plan' | 'yolo' | 'default', model, timeoutMs, env, wrap }
//   mode 'plan'  = CHỈ ĐỌC (không ghi tệp, không chạy lệnh): dùng ở chế độ bảo vệ vì Gemini không đi qua cổng duyệt của AgentOS;
//   mode 'yolo'  = tự chấp nhận mọi hành động: chỉ ở chế độ TOÀN QUYỀN.
function startGemini(opts) {
  const args = [].concat(opts.binArgs || [], ['-p', '', '--output-format', 'json', '--skip-trust']);
  args.push('--approval-mode', opts.mode || 'plan');
  if (opts.model) args.push('-m', opts.model);
  if (opts.resumeId) args.push('--resume', opts.resumeId);
  const p = runProcess({ bin: opts.bin, args, cwd: opts.cwd, input: opts.prompt, timeoutMs: opts.timeoutMs, env: Object.assign({ NO_COLOR: '1' }, opts.env || {}), wrap: opts.wrap });
  const done = p.done.then((r) => {
    const ab = abnormal(r, opts.bin);
    if (ab) return ab;
    const j = parseOutput(r.out);
    const errMsg = j && j.error ? (j.error.message || JSON.stringify(j.error)) : '';
    const text = j && typeof j.response === 'string' ? j.response : (j && typeof j.result === 'string' ? j.result : (j && typeof j.text === 'string' ? j.text : ''));
    const failed = !j || !!j.error || r.code !== 0;
    const hay = errMsg + '\n' + r.err + '\n' + (failed ? text : '');
    const cls = failed ? classifyFailure(hay) : { limit: false, transient: false };
    return {
      ok: !failed,
      text,
      sessionId: j && j.session_id ? String(j.session_id) : null,
      costUsd: null,
      limit: cls.limit,
      transient: cls.transient,
      resetAt: cls.limit ? parseResetTime(hay) : null,
      error: failed ? (errMsg || text || r.err.trim().slice(0, 1000) || 'Thoát với mã ' + r.code) : null,
      notLoggedIn: failed && (r.code === 41 || /Auth method|authorization is required|GEMINI_API_KEY|not logged in/i.test(hay)),
    };
  });
  return { done, kill: p.kill };
}

module.exports = { startGemini, parseOutput };
