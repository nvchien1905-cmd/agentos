'use strict';
const http = require('http');
const crypto = require('crypto');
const { decide, originOf } = require('./policy');

// Cổng duyệt: máy chủ HTTP chỉ nghe ở 127.0.0.1. Claude Code hỏi cổng (qua MCP gate-mcp.js và
// --permission-prompt-tool) trước mỗi lần dùng công cụ chưa được cho phép sẵn.
//   POST /gate  header x-gate-token  body {jobId, tool, input}  ->  {behavior:'allow',updatedInput} | {behavior:'deny',message}
function createGate({ db, approvals, workdir, log }) {
  log = log || (() => {});
  const token = crypto.randomBytes(24).toString('hex');
  const jobs = new Map();     // jobId -> { job, policy, state:{tainted, allowed:Set} }
  let server = null;

  function audit(jobId, tool, d, decision, source) {
    try { db.addAudit({ jobId, tool, cls: d.cls, decision, source, summary: d.summary }); } catch (e) { log('ghi nhật ký lỗi: ' + e.message); }
  }

  async function evaluate(body) {
    const entry = jobs.get(Number(body.jobId));
    if (!entry) return { behavior: 'deny', message: 'Việc không còn chạy, từ chối.' };
    const tool = String(body.tool || '');
    const input = body.input && typeof body.input === 'object' ? body.input : {};
    const d = decide({ tool, input, policy: entry.policy, workdir, state: entry.state });

    if (d.action === 'deny') {
      audit(entry.job.id, tool, d, 'deny', 'policy');
      return { behavior: 'deny', message: 'Bị chặn: ' + d.reason + '. Đừng thử lại cách này; báo người dùng nếu cần.' };
    }
    const noteVisit = () => { if (d.cls === 'browse' && input.url) { const o = originOf(input.url); if (o) entry.state.origins.add(o); } };
    if (d.action === 'allow') {
      if (d.taint) entry.state.tainted = true;
      noteVisit();
      audit(entry.job.id, tool, d, 'allow', 'auto');
      return { behavior: 'allow', updatedInput: input };
    }
    const r = await approvals.request(entry.job, tool, d);   // đã ghi nhật ký trong approvals
    if (!r.allowed) {
      const why = r.source === 'timeout' ? 'người dùng không trả lời kịp' : r.source === 'user' ? 'người dùng từ chối' : 'không xin được quyền';
      return { behavior: 'deny', message: 'Không được phép (' + why + '). Đừng thử lại; hãy báo cho người dùng và dừng bước này.' };
    }
    if (d.taint) entry.state.tainted = true;
    noteVisit();
    if (r.remember && d.canRemember) entry.state.allowed.add(tool);
    return { behavior: 'allow', updatedInput: input };
  }

  function handler(req, res) {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST' || req.url !== '/gate') return send(404, { error: 'not found' });
    const given = Buffer.from(String(req.headers['x-gate-token'] || ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(401, { error: 'unauthorized' });
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(400, { error: 'bad json' }); }
      try { send(200, await evaluate(body)); } catch (e) { log('cổng lỗi: ' + e.message); send(200, { behavior: 'deny', message: 'Lỗi nội bộ của cổng duyệt, từ chối.' }); }
    });
  }

  return {
    token,
    evaluate,
    // Gọi trước khi chạy engine / sau khi xong. `profile.policy` là chính sách của bộ công cụ.
    begin(job, profile) { jobs.set(job.id, { job, policy: profile.policy || {}, state: { tainted: false, allowed: new Set(), origins: new Set() } }); },
    end(jobId) { jobs.delete(jobId); if (approvals) approvals.cancelJob(jobId); },
    state(jobId) { const e = jobs.get(jobId); return e ? e.state : null; },
    listen(port) {
      return new Promise((resolve, reject) => {
        server = http.createServer(handler);
        server.once('error', reject);
        server.listen(port || 0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() { return new Promise((r) => (server ? server.close(() => r()) : r())); },
  };
}

module.exports = { createGate };
