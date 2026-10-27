'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { openDb } = require('../src/db');
const { createDoctor, RULES } = require('../src/doctor');
const { createHealthMon } = require('../src/healthmon');
const { createSelfTest } = require('../src/selftest');
const { createBot } = require('../src/bot');

const ROOT = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bs-'));
const R = (id, name, status, detail) => ({ id, name, status, detail: detail || '' });

// "Bác sĩ máy" giả: thấy tệp yêu cầu thì xóa tệp, ghi kết quả
function fakeHealer(dir, behave) {
  const req = path.join(dir, 'req'), res = path.join(dir, 'res.json'); const seen = [];
  const t = setInterval(() => {
    if (!fs.existsSync(req)) return;
    const lines = fs.readFileSync(req, 'utf8').split('\n').filter(Boolean); fs.rmSync(req); seen.push(lines);
    const out = behave ? behave(lines) : lines.map((l) => ({ action: l, rc: 0, out: l + ' đã chạy lại' }));
    fs.writeFileSync(res, JSON.stringify({ ts: Math.floor(Date.now() / 1000), ok: true, results: out }));
  }, 20); t.unref();
  return { req, res, seen, stop: () => clearInterval(t) };
}

test('bác sĩ máy: luật — dịch vụ chết → xin khởi động lại ĐÚNG dịch vụ đó (tên lạ bị bỏ), ổ đầy → dọn, lỗi khác → không có luật', () => {
  assert.deepEqual(RULES.services(R('services', 'Dịch vụ', 'fail', 'không chạy: agentos-deskd, agentos-settings')), ['restart agentos-deskd', 'restart agentos-settings']);
  assert.deepEqual(RULES.services(R('services', 'Dịch vụ', 'fail', 'không chạy: ok; rm -rf /')), ['restart ok'].slice(0, 0).concat(RULES.services(R('services', 'x', 'fail', 'không chạy: ok; rm -rf /'))), 'tên có ký tự lạ bị loại');
  assert.ok(!RULES.services(R('services', 'x', 'fail', 'không chạy: a;b $(x)')).some((a) => /[;$()]/.test(a)));
  assert.deepEqual(RULES.resources(R('resources', 'Tài nguyên', 'fail', 'ổ đĩa gần đầy (còn 300 MB)')), ['free-space']); assert.deepEqual(RULES.resources(R('resources', 'Tài nguyên', 'fail', 'nóng 90°C')), []);
  assert.deepEqual(RULES.cloud(), ['cloud']); assert.equal(RULES.telegram, undefined);
});

test('bác sĩ máy: xin sửa → đợi kết quả → kiểm tra lại; giới hạn 3 lần/ngày và cách nhau 20 phút; không phản hồi thì báo rõ', async () => {
  const dir = tmp(), db = openDb(':memory:'); const H = fakeHealer(dir); let t = Date.parse('2026-10-27T10:00:00+07:00'); let svc = 'fail';
  const selftest = { checks: { services: async () => R('services', 'Dịch vụ', svc, svc === 'fail' ? 'không chạy: agentos-deskd' : 'ổn') } };
  const D = createDoctor({ selftest, db, now: () => t, requestFile: H.req, resultFile: H.res, waitMs: 3000, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) });
  try {
    const bad = [R('services', 'Dịch vụ', 'fail', 'không chạy: agentos-deskd')];
    svc = 'ok'; let out = await D.heal(bad);                                            // sau khi sửa, kiểm tra lại thấy ổn
    assert.equal(out.length, 1); assert.equal(out[0].fixed, true); assert.deepEqual(H.seen[0], ['restart agentos-deskd']); assert.match(out[0].note, /đã chạy lại/);
    svc = 'fail'; assert.deepEqual(await D.heal(bad), [], 'vừa sửa xong, chờ 20 phút');
    t += 25 * 60000; out = await D.heal(bad); assert.equal(out[0].fixed, false); assert.match(out[0].note, /vẫn lỗi/);
    t += 25 * 60000; await D.heal(bad); t += 25 * 60000; out = await D.heal(bad); assert.match(out[0].note, /đã tự sửa 3 lần hôm nay/); assert.equal(out[0].tried, false);
    t += 24 * 3600000; out = await D.heal(bad); assert.equal(out[0].tried, true, 'sang ngày mới được thử lại');
    assert.deepEqual(await D.heal([R('telegram', 'Telegram', 'fail', 'x')]), [], 'lỗi chưa biết cách sửa: bỏ qua');
  } finally { H.stop(); }
  const D2 = createDoctor({ selftest, db: openDb(':memory:'), now: () => t, requestFile: path.join(dir, 'r2'), resultFile: path.join(dir, 'khong-co.json'), waitMs: 200, sleep: () => new Promise((r) => setTimeout(r, 20)) });
  const o2 = await D2.heal([R('services', 'Dịch vụ', 'fail', 'không chạy: agentos-deskd')]); assert.equal(o2[0].fixed, false); assert.match(o2[0].note, /không trả lời/);
  const D3 = createDoctor({ selftest, db: openDb(':memory:'), now: () => t, requestFile: path.join(dir, 'khong-co-thu-muc', 'r'), resultFile: path.join(dir, 'x') });
  assert.match((await D3.heal([R('services', 'Dịch vụ', 'fail', 'không chạy: agentos-deskd')]))[0].note, /chưa được cài/);
});

test('giám sát: lỗi đã tự sửa được báo "TỰ SỬA" (không báo sự cố); sửa không được thì báo sự cố kèm ghi chú của bác sĩ', async () => {
  const db = openDb(':memory:'), sent = []; let svc = 'fail';
  const selftest = { light: async () => [R('services', 'Dịch vụ', svc, svc === 'fail' ? 'không chạy: agentos-deskd' : 'ổn'), R('queue', 'Hàng đợi', 'ok', '')], checks: {} };
  const doctor = { heal: async (f) => f.map((r) => ({ id: r.id, name: r.name, tried: true, fixed: true, note: 'agentos-deskd đã chạy lại' })) };
  const M = createHealthMon({ selftest, db, notify: async (c, m) => { sent.push(m); }, admins: ['1'], doctor });
  await M.tick(); assert.equal(sent.length, 1); assert.match(sent[0], /🩺 Đã TỰ SỬA: Dịch vụ — agentos-deskd đã chạy lại/); assert.ok(!sent.some((s) => /phát hiện sự cố/.test(s)));
  sent.length = 0; const M2 = createHealthMon({ selftest, db: openDb(':memory:'), notify: async (c, m) => { sent.push(m); }, admins: ['1'], doctor: { heal: async (f) => f.map((r) => ({ id: r.id, name: r.name, tried: true, fixed: false, note: 'đã thử nhưng vẫn lỗi' })) } });
  await M2.tick(); assert.match(sent[0], /phát hiện sự cố[\s\S]*Dịch vụ[\s\S]*bác sĩ máy: đã thử nhưng vẫn lỗi/);
});

test('tự chẩn đoán: kho tệp riêng — chưa cài thì ổn, đã cài mà không trả lời thì lỗi (để bác sĩ máy bật lại)', async () => {
  const dir = tmp(), marker = path.join(dir, 'cloud-installed');
  const st = createSelfTest({ engines: [], run: async () => ({ code: 0, out: '' }), cloudMarker: marker, cloudUrl: 'http://127.0.0.1:1/status.php' });
  assert.equal((await st.checks.cloud()).status, 'ok'); fs.writeFileSync(marker, '');
  const r = await st.checks.cloud(); assert.equal(r.status, 'fail'); assert.match(r.detail, /không trả lời/);
});

test('/bacsi: chỉ chủ máy; ổn thì không tốn AI; có lỗi thì giao AI phân tích CHỈ ĐỌC (việc chung, không thuộc dự án)', async () => {
  const db = openDb(':memory:');
  const worker = { wake() {}, engineNames: () => ['claude'], currentJobId: () => null, engineStatus: () => [], cancelRunning: () => false };
  let bad = 0; const diagnose = async () => ({ bad, report: 'BÁO CÁO', prompt: '[BÁC SĨ MÁY — chỉ đọc] có lỗi' });
  const bot = createBot({ db, worker, allowed: new Set(['111', '222']), profiles: [], isAdmin: (u) => String(u) === '111', quietAck: true, diagnose });
  const say = (u, t) => bot.handle({ from: { id: u }, chat: { id: u, type: 'private' }, text: t });
  assert.match(await say(222, '/bacsi'), /Chỉ chủ máy/); assert.match(await say(111, '/bacsi'), /mọi thứ ổn/); assert.equal(db.recentJobs('111', 1).length, 0);
  bad = 2; assert.match(await say(111, '/bacsi'), /2 mục có vấn đề/); const j = db.recentJobs('111', 1)[0]; assert.match(j.prompt, /BÁC SĨ MÁY/); assert.equal(j.project, null);
});

test('tập lệnh agentos-heal: chỉ danh sách cố định (cú pháp đúng, có giới hạn tần suất, không nhận lệnh tùy ý); dịch vụ khởi động bằng tệp yêu cầu', { skip: process.platform === 'win32' }, () => {
  const f = path.join(ROOT, 'iso/config/includes.chroot/usr/local/sbin/agentos-heal'); execFileSync('bash', ['-n', f]);
  const t = fs.readFileSync(f, 'utf8');
  for (const must of ['UNITS="agentos-deskd', 'không nằm trong danh sách cho phép', 'MAXH=8', 'việc không biết', 'free-space', 'cloud)']) assert.ok(t.includes(must), 'thiếu ' + must);
  assert.ok(!/\beval\b/.test(t) && !/\$\(\s*\$/.test(t), 'không eval/thực thi chuỗi tùy ý');
  const p = fs.readFileSync(path.join(ROOT, 'iso/config/includes.chroot/etc/systemd/system/agentos-heal.path'), 'utf8'); assert.match(p, /PathExists=\/var\/lib\/agentos\/heal-request/);
});
