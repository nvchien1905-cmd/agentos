'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');
const { createGoogleAuth, SCOPES } = require('../src/googleAuth');
const { createGoogleMcp } = require('../src/google-mcp');
const { createConnectors } = require('../src/connectors');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gg-'));
const CLIENT = { installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-for-tests', redirect_uris: ['http://localhost'] } };
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Máy chủ Google giả: /token (đổi mã + làm mới), /revoke, /cal/…, /gm/…
async function fakeGoogle() {
  const log = { token: [], revoke: 0, cal: [], gm: [], sent: [] };
  let challenge = '', scopeGranted = '', tokenN = 0;
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'); const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/token') {
        const p = new URLSearchParams(body); log.token.push(Object.fromEntries(p));
        if (p.get('grant_type') === 'authorization_code') {
          if (p.get('code') === 'bad') return send(400, { error: 'invalid_grant', error_description: 'mã sai' });
          if (b64u0(crypto.createHash('sha256').update(p.get('code_verifier')).digest()) !== challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE sai' });
          return send(200, Object.assign({ access_token: 'at-' + (++tokenN), expires_in: 3600, scope: scopeGranted }, p.get('code') === 'norefresh' ? {} : { refresh_token: 'rt-1' }));
        }
        return send(200, { access_token: 'at-' + (++tokenN), expires_in: 3600 });
      }
      if (u.pathname === '/revoke') { log.revoke++; return send(200, {}); }
      if (req.headers.authorization !== 'Bearer at-' + tokenN && !/^Bearer at-\d+$/.test(req.headers.authorization || '')) return send(401, { error: { message: 'no auth' } });
      if (u.pathname.startsWith('/cal/')) {
        log.cal.push(req.method + ' ' + u.pathname + u.search);
        if (u.pathname === '/cal/users/me/calendarList') return send(200, { items: [{ id: 'a@x.com', summary: 'Lịch chính', primary: true, accessRole: 'owner', timeZone: 'Asia/Ho_Chi_Minh' }] });
        if (u.pathname.endsWith('/events') && req.method === 'GET') return send(200, { items: [{ id: 'e1', summary: 'Họp', start: { dateTime: '2026-11-08T09:00:00+07:00' }, end: { dateTime: '2026-11-08T10:00:00+07:00' }, attendees: [{ email: 'b@x.com' }] }] });
        if (u.pathname.endsWith('/events') && req.method === 'POST') return send(200, Object.assign({ id: 'new1' }, JSON.parse(body)));
        if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
        return send(404, { error: { message: 'không có' } });
      }
      if (u.pathname.startsWith('/gm/')) {
        log.gm.push(req.method + ' ' + u.pathname + u.search);
        if (u.pathname === '/gm/messages' && req.method === 'GET') return send(200, { messages: [{ id: 'm1', threadId: 't1' }] });
        if (u.pathname === '/gm/messages/m1') return send(200, u.searchParams.get('format') === 'full'
          ? { id: 'm1', labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: 'Chào' }, { name: 'From', value: 'Ai đó <a@x.com>' }, { name: 'To', value: 'tôi' }], mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64u('Xin chào,\nnội dung thư') } }, { mimeType: 'text/html', body: { data: b64u('<p>HTML</p>') } }] }, { filename: 'bang.xlsx', mimeType: 'application/vnd.ms-excel', body: {} }] } }
          : { id: 'm1', snippet: 'đoạn trích', payload: { headers: [{ name: 'Subject', value: 'Chào' }, { name: 'From', value: 'a@x.com' }, { name: 'Date', value: 'hôm nay' }] } });
        if (u.pathname === '/gm/messages/send') { log.sent.push(JSON.parse(body)); return send(200, { id: 'sent1' }); }
        if (u.pathname === '/gm/drafts') { log.sent.push(JSON.parse(body)); return send(200, { id: 'draft1' }); }
        if (u.pathname === '/gm/labels') return send(200, { labels: [{ id: 'INBOX', name: 'INBOX' }] });
      }
      send(404, { error: { message: 'không có ' + u.pathname } });
    });
  });
  const b64u0 = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  return { base, log, close: () => new Promise((r) => srv.close(r)), setChallenge: (c, s) => { challenge = c; scopeGranted = s; }, origins: { auth: { auth: base + '/auth', token: base + '/token', revoke: base + '/revoke' }, api: { cal: base + '/cal', gm: base + '/gm' } } };
}

async function login(G, dir, write, code) {
  const auth = createGoogleAuth({ dir, origins: G.origins.auth });
  assert.equal(auth.saveClient(CLIENT).ok, true);
  const s = auth.start({ write, redirectUri: 'http://127.0.0.1:8089/google/callback' });
  const u = new URL(s.url);
  G.setChallenge(u.searchParams.get('code_challenge'), u.searchParams.get('scope'));
  const r = await auth.finish({ code: code || 'ok', state: s.state });
  return { auth, s, u, r };
}

test('đăng nhập Google: khóa client (nhận JSON của Google), PKCE, mặc định CHỈ ĐỌC, bật ghi mới xin thêm quyền hẹp, từ chối địa chỉ lạ/ mã lạ', async () => {
  const G = await fakeGoogle(); const dir = tmp();
  try {
    const auth = createGoogleAuth({ dir, origins: G.origins.auth });
    assert.equal(auth.clientSet(), false); assert.equal(auth.start({ write: false, redirectUri: 'http://127.0.0.1:8089/google/callback' }).ok, false, 'chưa có khóa');
    assert.equal(auth.saveClient({ client_id: 'sai', client_secret: 'GOCSPX-secret-for-tests' }).ok, false); assert.equal(auth.saveClient({ client_id: CLIENT.installed.client_id, client_secret: 'x y' }).ok, false);
    assert.equal(auth.saveClient(JSON.stringify(CLIENT)).ok, true); assert.equal(auth.clientSet(), true);
    assert.equal(fs.statSync(path.join(dir, 'client.json')).mode & 0o777, 0o600);
    assert.equal(auth.start({ write: false, redirectUri: 'https://evil.example/cb' }).ok, false, 'chỉ nhận loopback');
    const ro = new URL(auth.start({ write: false, redirectUri: 'http://127.0.0.1:8089/google/callback' }).url).searchParams;
    assert.deepEqual(ro.get('scope').split(' '), SCOPES.read); assert.equal(ro.get('code_challenge_method'), 'S256'); assert.ok(ro.get('state').length >= 20); assert.equal(ro.get('access_type'), 'offline');
    assert.doesNotMatch(ro.get('scope'), /gmail\.modify|settings\.basic|auth\/calendar$/, 'không xin quyền rộng');
    const rw = new URL(auth.start({ write: true, redirectUri: 'http://127.0.0.1:8089/google/callback' }).url).searchParams.get('scope').split(' ');
    assert.deepEqual(rw, SCOPES.read.concat(SCOPES.write)); assert.ok(rw.includes('https://www.googleapis.com/auth/gmail.compose') && rw.includes('https://www.googleapis.com/auth/calendar.events'));
    assert.equal((await auth.finish({ code: 'ok', state: 'khong-co' })).ok, false, 'state lạ bị từ chối');
  } finally { await G.close(); }
});

test('đăng nhập Google: đổi mã lấy token (kiểm PKCE), lưu 0600, trạng thái; lỗi Google và thiếu refresh token được báo rõ; ngắt kết nối thu hồi + xóa', async () => {
  const G = await fakeGoogle(); const dir = tmp();
  try {
    const { auth, r } = await login(G, dir, false);
    assert.equal(r.ok, true); assert.equal(fs.statSync(path.join(dir, 'tokens.json')).mode & 0o777, 0o600);
    let st = auth.status(); assert.equal(st.connected, true); assert.equal(st.write, false); assert.equal(st.clientSet, true); assert.doesNotMatch(JSON.stringify(st), /rt-1|at-1|GOCSPX/, 'status không lộ khóa/token');
    assert.equal(G.log.token[0].grant_type, 'authorization_code'); assert.equal(G.log.token[0].client_secret, 'GOCSPX-secret-for-tests');
    const bad = await login(G, tmp(), false, 'bad'); assert.equal(bad.r.ok, false); assert.match(bad.r.error, /mã sai/);
    const nr = await login(G, tmp(), false, 'norefresh'); assert.equal(nr.r.ok, false); assert.match(nr.r.error, /refresh token/);
    const w = await login(G, tmp(), true); assert.equal(w.auth.status().write, true);
    await auth.revoke(); assert.equal(G.log.revoke, 1); assert.equal(auth.status().connected, false); assert.equal(fs.existsSync(path.join(dir, 'tokens.json')), false);
    await assert.rejects(() => auth.accessToken(), /Chưa đăng nhập/);
  } finally { await G.close(); }
});

test('token tự làm mới khi sắp hết hạn, chỉ một lần dù nhiều yêu cầu cùng lúc', async () => {
  const G = await fakeGoogle(); const dir = tmp(); let t = 1800000000000;
  try {
    const auth = createGoogleAuth({ dir, origins: G.origins.auth, now: () => t });
    auth.saveClient(CLIENT); const s = auth.start({ write: false, redirectUri: 'http://127.0.0.1:8089/google/callback' }); G.setChallenge(new URL(s.url).searchParams.get('code_challenge'), 'x');
    await auth.finish({ code: 'ok', state: s.state });
    const a1 = await auth.accessToken(); assert.equal(a1, 'at-1'); assert.equal(await auth.accessToken(), 'at-1', 'còn hạn thì dùng lại');
    t += 3590 * 1000;                                                  // còn < 60 giây → làm mới
    const [x, y, z] = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    assert.deepEqual([x, y, z], ['at-2', 'at-2', 'at-2']); assert.equal(G.log.token.filter((p) => p.grant_type === 'refresh_token').length, 1);
  } finally { await G.close(); }
});

test('máy chủ MCP Google: mặc định CHỈ có công cụ đọc; đọc lịch/thư thật (qua máy chủ giả); công cụ ghi bị từ chối rõ ràng khi chưa bật', async () => {
  const G = await fakeGoogle(); const dir = tmp();
  try {
    const { auth } = await login(G, dir, false);
    const mcp = createGoogleMcp({ auth, origins: G.origins.api });
    const names = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
    assert.deepEqual(names.sort(), mcp.READ.slice().sort()); for (const w of mcp.WRITE) assert.equal(names.includes(w), false, w + ' không được lộ khi chỉ đọc');
    const call = async (name, args) => { const r = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args || {} } }); return { err: !!r.result.isError, text: r.result.content[0].text }; };
    assert.match((await call('list_calendars')).text, /Lịch chính/);
    const ev = await call('list_events', { timeMin: '2026-11-08T00:00:00+07:00', query: 'họp' }); assert.match(ev.text, /"summary": "Họp"/); assert.match(G.log.cal.join('\n'), /singleEvents=true/); assert.match(G.log.cal.join('\n'), /q=h%E1%BB%8Dp/);
    const se = JSON.parse((await call('search_emails', { query: 'is:unread', maxResults: 3 })).text); assert.deepEqual([se[0].id, se[0].subject, se[0].snippet], ['m1', 'Chào', 'đoạn trích']);
    const re = JSON.parse((await call('read_email', { id: 'm1' })).text); assert.equal(re.body, 'Xin chào,\nnội dung thư', 'lấy phần chữ, không lấy HTML'); assert.deepEqual(re.attachments, ['bang.xlsx (application/vnd.ms-excel)']);
    const w = await call('send_email', { to: 'a@x.com', subject: 's', body: 'b' }); assert.equal(w.err, true); assert.match(w.text, /cho phép ghi/);
    assert.equal(G.log.sent.length, 0, 'không có thư nào bị gửi'); assert.equal((await call('khong_co')).err, true);
    const bad = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'foo' }); assert.equal(bad.error.code, -32601); assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  } finally { await G.close(); }
});

test('máy chủ MCP Google: khi chủ máy bật GHI thì có thêm công cụ tạo/sửa/xóa sự kiện, soạn nháp, gửi thư; thư mã hóa UTF-8, chặn chèn tiêu đề thư', async () => {
  const G = await fakeGoogle(); const dir = tmp();
  try {
    const { auth } = await login(G, dir, true);
    const mcp = createGoogleMcp({ auth, origins: G.origins.api });
    const call = async (name, args) => { const r = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }); return { err: !!r.result.isError, text: r.result.content[0].text }; };
    const names = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
    for (const w of ['create_event', 'update_event', 'delete_event', 'create_draft', 'send_email']) assert.ok(names.includes(w), w);
    assert.match((await call('create_event', { summary: 'Ăn trưa', start: '2026-11-09', end: '2026-11-10', attendees: ['b@x.com'] })).text, /new1/);
    assert.match((await call('delete_event', { eventId: 'e1' })).text, /deleted/);
    const s = await call('send_email', { to: 'a@x.com', subject: 'Báo giá tháng 11', body: 'Xin chào\nđây là nội dung' }); assert.equal(s.err, false);
    const raw = Buffer.from(G.log.sent[0].raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    assert.match(raw, /^To: a@x\.com\r\nSubject: =\?UTF-8\?B\?/); assert.match(raw, /Content-Type: text\/plain; charset=UTF-8/);
    assert.equal(Buffer.from(raw.split('\r\n\r\n')[1], 'base64').toString('utf8'), 'Xin chào\nđây là nội dung');
    const inj = await call('send_email', { to: 'a@x.com', subject: 'x\r\nBcc: ke-xau@x.com', body: 'b' }); assert.equal(inj.err, true); assert.match(inj.text, /xuống dòng/); assert.equal(G.log.sent.length, 1);
    assert.equal((await call('create_draft', { to: 'a@x.com', subject: 'n', body: 'b' })).err, false); assert.equal(G.log.sent.length, 2);
  } finally { await G.close(); }
});

test('hàng rào bot: công cụ ghi của Google luôn HỎI chủ máy, công cụ đọc thì không', () => {
  const { decideGuard } = require('../src/policy');
  const ask = (tool) => decideGuard({ tool: 'mcp__c_google__' + tool, input: {}, policy: {}, workdir: '/w', state: { tainted: false, allowed: new Set(), origins: new Set() } }).action;
  for (const w of ['create_event', 'update_event', 'delete_event', 'create_draft', 'send_email']) assert.equal(ask(w), 'ask', w);
  for (const r of ['list_calendars', 'list_events', 'get_event', 'search_emails', 'read_email', 'list_labels']) assert.notEqual(ask(r), 'ask', r);
});

test('qua stdio như một máy chủ MCP thật: initialize → tools/list → tools/call; danh mục kết nối có mục "google" với thư mục dữ liệu riêng', async () => {
  const G = await fakeGoogle(); const dir = tmp();
  try {
    await login(G, dir, false);
    const child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'src', 'google-mcp.js')], { env: Object.assign({}, process.env, { GOOGLE_DIR: dir, GOOGLE_ORIGINS_JSON: JSON.stringify({ auth: G.origins.auth, api: G.origins.api }) }), stdio: ['pipe', 'pipe', 'inherit'] });
    const got = []; let buf = ''; const done = new Promise((res) => child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); if (got.length === 3) res(); } }));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_calendars', arguments: {} } }) + '\n');
    await done; child.kill();
    assert.equal(got[0].result.serverInfo.name, 'agentos-google'); assert.ok(got[1].result.tools.length >= 5); assert.match(got[2].result.content[0].text, /Lịch chính/);
  } finally { await G.close(); }
  const data = tmp(); const c = createConnectors({ file: path.join(data, 'connectors.json') });
  assert.ok(c.catalog().some((x) => x.key === 'google')); assert.equal(c.addFromCatalog('google').ok, true);
  const raw = JSON.parse(fs.readFileSync(path.join(data, 'connectors.json'), 'utf8')).items[0];
  assert.equal(raw.env.GOOGLE_DIR, path.join(data, 'google')); assert.equal(raw.command, 'node'); assert.match(raw.args[0], /google-mcp\.js$/);
  assert.equal(c.setEnabled('google', true).ok, true);
});
