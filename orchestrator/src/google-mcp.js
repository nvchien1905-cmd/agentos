#!/usr/bin/env node
'use strict';
const os = require('os');
const path = require('path');
const { createGoogleAuth } = require('./googleAuth');

// MÁY CHỦ MCP GOOGLE (Lịch + Gmail) của AgentOS — thay cho các gói cộng đồng (quyền quá rộng, lỗi trên Node 20). Chạy qua stdio như mọi máy chủ MCP (xem connectors.js, khóa "google").
//  - Chỉ dùng fetch có sẵn của Node (không thư viện ngoài). Đăng nhập làm ở Cài đặt (googleAuth.js); thư mục dữ liệu = biến môi trường GOOGLE_DIR.
//  - CHỈ ĐỌC theo mặc định: công cụ ghi (tạo/sửa/xóa sự kiện, soạn nháp, gửi thư) CHỈ xuất hiện khi chủ máy đăng nhập với "cho phép ghi". Tên công cụ ghi có động từ create/update/delete/send
//    nên hàng rào của bot (policy.js) luôn HỎI chủ máy trước khi chạy.
//  - Đọc thư: chỉ lấy chữ (text/plain, hoặc text/html đã bỏ thẻ), tối đa 20.000 ký tự; không tải tệp đính kèm.
const CAL = 'https://www.googleapis.com/calendar/v3', GM = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY = 20000;
const b64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const enc = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const stripHtml = (h) => String(h).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
const hdr = (headers, n) => { const h = (headers || []).find((x) => String(x.name).toLowerCase() === n); return h ? h.value : ''; };
const noCtl = (s) => /[\r\n]/.test(String(s));

function createGoogleMcp(o) {
  const auth = o.auth, f = o.fetch || fetch;
  const origin = Object.assign({ cal: CAL, gm: GM }, o.origins || {});

  async function call(method, url, body) {
    const token = await auth.accessToken();
    const r = await f(url, { method, headers: Object.assign({ authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Google trả lỗi ' + r.status + ': ' + String((j.error && (j.error.message || j.error)) || '').slice(0, 200));
    return j;
  }
  const qs = (o2) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o2)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); const s = p.toString(); return s ? '?' + s : ''; };
  const evOut = (e) => ({ id: e.id, summary: e.summary || '(không tiêu đề)', start: (e.start && (e.start.dateTime || e.start.date)) || '', end: (e.end && (e.end.dateTime || e.end.date)) || '', location: e.location || '', status: e.status, attendees: (e.attendees || []).map((a) => a.email).slice(0, 20), link: e.htmlLink || '' });
  const when = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? { date: String(v) } : { dateTime: String(v) });

  function bodyOf(payload) {            // lấy chữ từ cây MIME
    let plain = '', html = '';
    (function walk(p) {
      if (!p) return;
      if (p.mimeType === 'text/plain' && p.body && p.body.data && !plain) plain = b64u(p.body.data);
      else if (p.mimeType === 'text/html' && p.body && p.body.data && !html) html = b64u(p.body.data);
      for (const c of p.parts || []) walk(c);
    })(payload);
    return (plain || stripHtml(html)).slice(0, MAX_BODY);
  }
  function attachments(payload) { const out = []; (function walk(p) { if (!p) return; if (p.filename) out.push(p.filename + ' (' + (p.mimeType || '?') + ')'); for (const c of p.parts || []) walk(c); })(payload); return out.slice(0, 20); }
  function raw({ to, cc, subject, body }) {
    for (const [k, v] of [['to', to], ['cc', cc], ['subject', subject]]) if (v && noCtl(v)) throw new Error('Trường ' + k + ' không được xuống dòng.');
    const lines = ['To: ' + to, cc ? 'Cc: ' + cc : null, 'Subject: =?UTF-8?B?' + Buffer.from(String(subject || ''), 'utf8').toString('base64') + '?=', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(String(body || ''), 'utf8').toString('base64')].filter((x) => x !== null);
    return enc(lines.join('\r\n'));
  }

  const READ = [
    { name: 'list_calendars', description: 'Liệt kê các lịch Google của chủ tài khoản.', input: { type: 'object', properties: {} }, run: async () => { const j = await call('GET', origin.cal + '/users/me/calendarList'); return (j.items || []).map((c) => ({ id: c.id, name: c.summary, primary: !!c.primary, role: c.accessRole, timeZone: c.timeZone })); } },
    { name: 'list_events', description: 'Liệt kê sự kiện lịch trong khoảng thời gian (RFC3339, vd 2026-11-08T00:00:00+07:00). Mặc định: lịch chính, từ bây giờ, tối đa 25.', input: { type: 'object', properties: { calendarId: { type: 'string' }, timeMin: { type: 'string' }, timeMax: { type: 'string' }, query: { type: 'string' }, maxResults: { type: 'number' } } },
      run: async (a) => { const j = await call('GET', origin.cal + '/calendars/' + encodeURIComponent(a.calendarId || 'primary') + '/events' + qs({ singleEvents: 'true', orderBy: 'startTime', timeMin: a.timeMin || new Date().toISOString(), timeMax: a.timeMax, q: a.query, maxResults: Math.min(Number(a.maxResults) || 25, 100) })); return (j.items || []).map(evOut); } },
    { name: 'get_event', description: 'Xem chi tiết một sự kiện lịch.', input: { type: 'object', properties: { calendarId: { type: 'string' }, eventId: { type: 'string' } }, required: ['eventId'] },
      run: async (a) => { const e = await call('GET', origin.cal + '/calendars/' + encodeURIComponent(a.calendarId || 'primary') + '/events/' + encodeURIComponent(a.eventId)); return Object.assign(evOut(e), { description: String(e.description || '').slice(0, 5000), organizer: e.organizer && e.organizer.email }); } },
    { name: 'search_emails', description: 'Tìm thư Gmail theo cú pháp tìm của Gmail (vd "from:abc is:unread newer_than:7d"). Trả về tiêu đề, người gửi, ngày, đoạn trích.', input: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
      run: async (a) => { const l = await call('GET', origin.gm + '/messages' + qs({ q: a.query, maxResults: Math.min(Number(a.maxResults) || 10, 25) })); const out = []; for (const m of (l.messages || []).slice(0, 25)) { const d = await call('GET', origin.gm + '/messages/' + m.id + qs({ format: 'metadata' }) + '&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date'); out.push({ id: m.id, threadId: m.threadId, subject: hdr(d.payload && d.payload.headers, 'subject'), from: hdr(d.payload && d.payload.headers, 'from'), date: hdr(d.payload && d.payload.headers, 'date'), snippet: d.snippet || '' }); } return out; } },
    { name: 'read_email', description: 'Đọc nội dung một thư Gmail (chỉ chữ, tối đa 20.000 ký tự) theo id lấy từ search_emails.', input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (a) => { const d = await call('GET', origin.gm + '/messages/' + encodeURIComponent(a.id) + '?format=full'); const h = d.payload && d.payload.headers; return { id: d.id, subject: hdr(h, 'subject'), from: hdr(h, 'from'), to: hdr(h, 'to'), cc: hdr(h, 'cc'), date: hdr(h, 'date'), labels: d.labelIds || [], attachments: attachments(d.payload), body: bodyOf(d.payload) }; } },
    { name: 'list_labels', description: 'Liệt kê nhãn Gmail.', input: { type: 'object', properties: {} }, run: async () => ((await call('GET', origin.gm + '/labels')).labels || []).map((l) => ({ id: l.id, name: l.name })) },
  ];
  const WRITE = [
    { name: 'create_event', description: 'TẠO sự kiện lịch (cần chủ máy duyệt). start/end: RFC3339 hoặc YYYY-MM-DD (cả ngày).', input: { type: 'object', properties: { calendarId: { type: 'string' }, summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, description: { type: 'string' }, location: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'start', 'end'] },
      run: async (a) => evOut(await call('POST', origin.cal + '/calendars/' + encodeURIComponent(a.calendarId || 'primary') + '/events', { summary: a.summary, description: a.description, location: a.location, start: when(a.start), end: when(a.end), attendees: (a.attendees || []).map((email) => ({ email })) })) },
    { name: 'update_event', description: 'SỬA sự kiện lịch (cần chủ máy duyệt); chỉ gửi trường cần đổi.', input: { type: 'object', properties: { calendarId: { type: 'string' }, eventId: { type: 'string' }, summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, description: { type: 'string' }, location: { type: 'string' } }, required: ['eventId'] },
      run: async (a) => { const p = {}; for (const k of ['summary', 'description', 'location']) if (a[k] !== undefined) p[k] = a[k]; if (a.start) p.start = when(a.start); if (a.end) p.end = when(a.end); return evOut(await call('PATCH', origin.cal + '/calendars/' + encodeURIComponent(a.calendarId || 'primary') + '/events/' + encodeURIComponent(a.eventId), p)); } },
    { name: 'delete_event', description: 'XÓA sự kiện lịch (cần chủ máy duyệt).', input: { type: 'object', properties: { calendarId: { type: 'string' }, eventId: { type: 'string' } }, required: ['eventId'] },
      run: async (a) => { await call('DELETE', origin.cal + '/calendars/' + encodeURIComponent(a.calendarId || 'primary') + '/events/' + encodeURIComponent(a.eventId)); return { deleted: a.eventId }; } },
    { name: 'create_draft', description: 'SOẠN NHÁP thư Gmail (chưa gửi; cần chủ máy duyệt).', input: { type: 'object', properties: { to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
      run: async (a) => { const d = await call('POST', origin.gm + '/drafts', { message: { raw: raw(a) } }); return { draftId: d.id }; } },
    { name: 'send_email', description: 'GỬI thư Gmail (cần chủ máy duyệt TỪNG LẦN). Chỉ gửi khi chủ đã đồng ý nội dung.', input: { type: 'object', properties: { to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
      run: async (a) => { const d = await call('POST', origin.gm + '/messages/send', { raw: raw(a) }); return { sent: true, id: d.id }; } },
  ];

  const tools = () => READ.concat(auth.hasWrite() ? WRITE : []);
  async function handle(m) {          // trả về phản hồi JSON-RPC (hoặc null với thông báo)
    if (!m || m.method === undefined) return null;
    const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result }), fail = (code, message) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    if (m.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agentos-google', version: '1.0.0' } });
    if (m.method === 'ping') return reply({});
    if (m.method === 'tools/list') return reply({ tools: tools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.input })) });
    if (m.method === 'tools/call') {
      const t = tools().find((x) => x.name === (m.params && m.params.name));
      if (!t) return reply({ isError: true, content: [{ type: 'text', text: 'Không có công cụ này' + (WRITE.some((x) => x.name === (m.params && m.params.name)) ? ' (chủ máy chưa bật "cho phép ghi" cho Google).' : '.') }] });
      try { const out = await t.run((m.params && m.params.arguments) || {}); return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] }); }
      catch (e) { return reply({ isError: true, content: [{ type: 'text', text: 'Lỗi: ' + e.message }] }); }
    }
    return m.id === undefined ? null : fail(-32601, 'Không hỗ trợ ' + m.method);
  }
  return { handle, tools, READ: READ.map((t) => t.name), WRITE: WRITE.map((t) => t.name) };
}

function main() {
  const dir = process.env.GOOGLE_DIR || path.join(os.homedir(), '.agentos-google');
  let test = {}; try { test = JSON.parse(process.env.GOOGLE_ORIGINS_JSON || '{}'); } catch (e) { /* bỏ */ }      // chỉ dùng khi thử nghiệm: trỏ sang máy chủ Google giả
  const srv = createGoogleMcp({ auth: createGoogleAuth({ dir, origins: test.auth }), origins: test.api });
  let buf = '';
  process.stdin.on('data', async (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      const r = await srv.handle(m); if (r) process.stdout.write(JSON.stringify(r) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

module.exports = { createGoogleMcp };
if (require.main === module) main();
