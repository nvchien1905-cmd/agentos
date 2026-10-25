'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSelfTest } = require('../src/selftest');
const { createHealthMon } = require('../src/healthmon');
const { createRemote } = require('../src/remote');
const { createQuick } = require('../src/quick');
const { openDb } = require('../src/db');

const okRun = (map) => async (bin, args) => (map[bin] ? map[bin](args) : { code: 0, out: 'ok', err: '' });

function make(extra) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
  const db = openDb(':memory:');
  const tg = { call: async (m) => (m === 'getMe' ? { username: 'bot_a' } : { url: '' }) };
  const base = {
    tg, db, home, tgwatch: { state: () => ({ kind: 'ok' }) }, desk: { call: async () => ({ ok: true, user: 'chien', locked: false }) },
    tailscale: { info: async () => ({ state: 'Running', ips: ['100.1.1.1'] }) }, diskFreeMb: () => 5000, minFreeMb: 500,
    engines: [{ name: 'claude', label: 'Claude', bin: 'claude', login: ['.claude/.credentials.json'] }, { name: 'codex', label: 'Codex', bin: 'codex', login: ['.codex/auth.json'] }],
    writable: { 'thư mục làm việc': path.join(home, 'w') }, run: okRun({ systemctl: () => ({ code: 0, out: 'active\nactive\nactive\nactive', err: '' }), tesseract: () => ({ code: 0, out: 'List of available languages (2):\neng\nvie', err: '' }) }),
  };
  return { st: createSelfTest(Object.assign(base, extra || {})), db, home };
}
const by = (rs, id) => rs.find((r) => r.id === id);

test('tự chẩn đoán: máy khỏe thì tất cả ✅/⚠️ đúng chỗ; chưa đăng nhập AI chỉ là ⚠️', async () => {
  const { st } = make();
  const rs = await st.light();
  assert.equal(by(rs, 'telegram').status, 'ok'); assert.match(by(rs, 'telegram').detail, /@bot_a/);
  assert.equal(by(rs, 'services').status, 'ok'); assert.equal(by(rs, 'resources').status, 'ok'); assert.equal(by(rs, 'storage').status, 'ok');
  assert.equal(by(rs, 'engines').status, 'warn'); assert.match(by(rs, 'engines').detail, /Claude: ✅ đã đăng nhập[\s\S]*Codex: ⚠️ có phần mềm nhưng CHƯA đăng nhập/);
  const text = st.format(rs); assert.match(text, /ổn, 1 lưu ý/); assert.match(text, /⚠️ AI/);
  const full = await st.full(); assert.ok(by(full, 'tools') && by(full, 'desk') && by(full, 'network'));
  assert.equal(by(full, 'desk').status, 'ok');
});

test('tự chẩn đoán: bắt đúng các sự cố thật (xung đột token, ổ đĩa đầy, dịch vụ chết, màn hình khóa, AI không cài, thiếu tiếng Việt OCR)', async () => {
  const bad = make({
    tgwatch: { state: () => ({ kind: 'conflict' }) }, diskFreeMb: () => 100,
    desk: { call: async () => ({ ok: true, user: 'chien', locked: true }) },
    engines: [{ name: 'claude', label: 'Claude', bin: 'claude', login: [] }],
    run: okRun({ systemctl: () => ({ code: 3, out: 'inactive\nactive\nactive\ninactive', err: '' }), claude: () => ({ code: 1, out: '', err: '', missing: true }), tesseract: () => ({ code: 0, out: 'eng', err: '' }), soffice: () => ({ code: 1, missing: true, out: '', err: '' }), 'agentos-office': () => ({ code: 1, missing: true, out: '', err: '' }), xdotool: () => ({ code: 1, missing: true, out: '', err: '' }) }),
  });
  const rs = await bad.st.full();
  assert.equal(by(rs, 'telegram').status, 'fail'); assert.match(by(rs, 'telegram').detail, /409|XUNG ĐỘT/i);
  assert.equal(by(rs, 'resources').status, 'fail'); assert.match(by(rs, 'resources').detail, /ổ đĩa gần đầy/);
  assert.equal(by(rs, 'services').status, 'fail'); assert.match(by(rs, 'services').detail, /agentos-deskd/);
  assert.equal(by(rs, 'desk').status, 'warn'); assert.match(by(rs, 'desk').detail, /KHÓA/);
  assert.equal(by(rs, 'engines').status, 'fail'); assert.match(by(rs, 'engines').detail, /chưa cài/);
  assert.equal(by(rs, 'tools').status, 'fail'); assert.match(by(rs, 'tools').detail, /soffice/); assert.match(by(rs, 'tools').detail, /tesseract\(thiếu tiếng Việt\)/);
  assert.match(bad.st.format(rs), /lỗi/);
});

test('tự chẩn đoán: ghi không được thư mục / cơ sở dữ liệu hỏng thì báo; không kiểm tra nào ném lỗi', async () => {
  const f = path.join(os.tmpdir(), 'st-file-' + process.pid); fs.writeFileSync(f, 'x');
  const { st } = make({ writable: { 'thư mục làm việc': path.join(f, 'con') }, tg: { call: async () => { throw new Error('mạng lỗi'); } } });
  const rs = await st.light();
  assert.equal(by(rs, 'storage').status, 'fail'); assert.match(by(rs, 'storage').detail, /không ghi được/);
  assert.equal(by(rs, 'telegram').status, 'fail'); assert.match(by(rs, 'telegram').detail, /mạng lỗi/);
  fs.rmSync(f, { force: true });
});

test('tự chẩn đoán "ai": hỏi thử từng AI qua đường chạy thật, ghi nhận trả lời / lỗi / hết hạn mức', async () => {
  const { st } = make();
  const startFn = (name) => ({ kill() {}, done: Promise.resolve(name === 'claude' ? { ok: true, text: 'OK' } : name === 'codex' ? { ok: false, limit: true, error: 'x' } : { ok: true, text: 'xin chào' }) });
  const rs = await st.full({ ai: true, engineNames: ['claude', 'codex', 'gemini'], startFn });
  assert.equal(by(rs, 'ai-claude').status, 'ok'); assert.equal(by(rs, 'ai-codex').status, 'fail'); assert.match(by(rs, 'ai-codex').detail, /hết hạn mức/);
  assert.equal(by(rs, 'ai-gemini').status, 'warn');
});

test('giám sát chủ động: báo sự cố MỘT lần, nhắc lại sau 6 giờ, báo khi ổn lại; ⚠️ không nhắn', async () => {
  const db = openDb(':memory:'); const sent = []; let t = 1e12; let state = 'fail';
  const selftest = { light: async () => [{ id: 'telegram', name: 'Telegram', status: state, detail: 'xung đột' }, { id: 'engines', name: 'AI', status: 'warn', detail: 'chưa đăng nhập' }] };
  const mon = createHealthMon({ selftest, db, notify: async (a, m) => { sent.push([a, m]); }, admins: ['1', '2'], now: () => t, remindMs: 6 * 3600 * 1000 });
  await mon.tick(); assert.equal(sent.length, 2); assert.match(sent[0][1], /sự cố[\s\S]*❌ Telegram — xung đột/); assert.doesNotMatch(sent[0][1], /AI/);
  t += 3600 * 1000; await mon.tick(); assert.equal(sent.length, 2, 'chưa tới giờ nhắc lại');
  t += 6 * 3600 * 1000; await mon.tick(); assert.equal(sent.length, 4, 'nhắc lại sau 6 giờ');
  state = 'ok'; await mon.tick(); assert.equal(sent.length, 6); assert.match(sent[4][1], /✅ Telegram đã ổn lại/);
  await mon.tick(); assert.equal(sent.length, 6, 'ổn rồi thì im');
});

test('/tuchan và /log: ra báo cáo; nhật ký được che token/khóa/mật khẩu', async () => {
  const { st } = make();
  const exec = async (args) => ({ code: 0, out: ['-- Logs begin --', 'Oct 25 bot token 123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789ab ok', 'api_key=sk-abcdefghijklmnop12 ; password: hunter2', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'].join('\n'), err: '', args });
  const remote = createRemote({ exec });
  const lg = (await remote.logs(500)).text;
  assert.doesNotMatch(lg, /123456789:ABC|sk-abcdef|hunter2|abcdefghijklmnopqrstuvwxyz0123/); assert.match(lg, /<token-telegram>/);
  const q = createQuick({ desk: {}, selftest: st, remote });
  assert.match(await q.run('tuchan', 'nhanh'), /Chẩn đoán nhanh/);
  assert.match(await q.run('tuchan', ''), /Tự chẩn đoán[\s\S]*Công cụ văn phòng/);
  assert.match((await q.run('log', '12')).text, /nhật ký gần nhất/);
});
