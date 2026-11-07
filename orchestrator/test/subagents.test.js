'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createProjects } = require('../src/projects');
const { createSubagents, BASE_ID } = require('../src/subagents');
const { createGate } = require('../src/gate');
const subcli = require('../src/subcli');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
const PARENT = { id: 7, chat_id: '111', project: 'du-an', profile: 'p1', lane: 'main' };

// Engine giả: mỗi lần start ghi lại việc ảo, trả về lời giải khi test gọi finish()
function fakeEngines(names) {
  const calls = [], eng = {};
  for (const n of names) eng[n] = { start: (a) => {
    let res; const done = new Promise((r) => { res = r; }); const c = { engine: n, job: a.job, prompt: a.prompt, killed: false, finish: (x) => res(x), kill() { c.killed = true; res({ ok: false, cancelled: true, error: 'đã hủy' }); } };
    calls.push(c); return { kill: () => c.kill(), done };
  } };
  return { eng, calls };
}

test('trợ lý phụ: giao song song, chạy như việc ảo CÙNG chat/dự án/bộ công cụ, gom kết quả bằng wait', async () => {
  const { eng, calls } = fakeEngines(['claude', 'codex']);
  const S = createSubagents({ engines: eng, log() {}, candidates: () => ['claude', 'codex'] });
  S.register(PARENT);
  const a = S.spawn(7, 'Tra giá nồi chiên ở 3 cửa hàng đối thủ'), b = S.spawn(7, 'Kiểm tồn kho 5 mã hàng', 'codex');
  assert.ok(a.ok && b.ok); assert.equal(a.engine, 'claude'); assert.equal(b.engine, 'codex');
  assert.equal(calls.length, 2, 'cả hai chạy cùng lúc, không chờ nhau');
  const j = calls[0].job; assert.equal(j.lane, 'sub'); assert.equal(j.chat_id, '111'); assert.equal(j.project, 'du-an'); assert.equal(j.profile, 'p1'); assert.ok(j.id > BASE_ID);
  assert.match(calls[0].prompt, /TRỢ LÝ PHỤ[\s\S]*Tra giá nồi chiên/);
  const w1 = await S.wait(7, [], 1); assert.equal(w1.pending, 2);               // chưa xong -> hết hạn chờ, báo còn chạy
  calls[0].finish({ ok: true, text: 'Nồi A 1tr, nồi B 1,2tr' }); calls[1].finish({ ok: false, error: 'hết hạn mức' });
  const w2 = await S.wait(7, [], 5); assert.equal(w2.pending, 0);
  assert.equal(w2.subs[0].status, 'done'); assert.match(w2.subs[0].text, /Nồi A/); assert.equal(w2.subs[1].status, 'error'); assert.match(w2.subs[1].error, /hạn mức/);
});

test('trợ lý phụ: giới hạn, không đệ quy, chỉ AI chính đang chạy; AI chính xong thì trợ lý bị dừng theo', async () => {
  const { eng, calls } = fakeEngines(['claude']);
  const S = createSubagents({ engines: eng, log() {}, cfg: { perJob: 2, total: 3 }, candidates: () => ['claude'] });
  assert.equal(S.spawn(7, 'việc khi chưa đăng ký').ok, false);
  S.register(PARENT); S.register({ id: BASE_ID + 1, chat_id: '111', lane: 'sub' });
  assert.equal(S.isParent(BASE_ID + 1), false, 'trợ lý phụ không giao được tiếp');
  assert.ok(S.spawn(7, 'việc số một').ok); assert.ok(S.spawn(7, 'việc số hai').ok);
  assert.match(S.spawn(7, 'việc số ba').error, /2 trợ lý phụ đang chạy/);
  assert.equal(S.spawn(7, 'ab').ok, false);
  S.register({ id: 8, chat_id: '222', lane: 'main' }); assert.ok(S.spawn(8, 'việc của việc khác').ok); assert.match(S.spawn(8, 'việc vượt tổng').error, /tối đa 3/);
  S.unregister(7); assert.equal(calls[0].killed, true); assert.equal(calls[1].killed, true); assert.equal(calls[2].killed, false);
  assert.equal(S.cancel(8, 3).ok, true); assert.equal(calls[2].killed, true);
  assert.equal(S.cancel(8, 1).ok, false, 'không hủy được trợ lý của việc khác');
});

test('trợ lý phụ: chọn AI theo danh sách được phép + không nghỉ hạn mức; tắt hẳn được', () => {
  const { eng } = fakeEngines(['claude', 'codex', 'gemini']);
  const S = createSubagents({ engines: eng, log() {}, candidates: () => ['claude', 'codex'], available: (e) => e !== 'claude' });
  S.register(PARENT);
  assert.equal(S.spawn(7, 'xin ý kiến hai').engine, 'codex');
  assert.equal(S.spawn(7, 'dùng gemini', 'gemini').engine, 'codex', 'AI không được phép thì chọn AI khác');
  const off = createSubagents({ engines: eng, log() {}, cfg: { enabled: false } }); off.register(PARENT);
  assert.equal(off.enabled(), false); assert.match(off.spawn(7, 'việc bất kỳ').error, /tắt/);
});

test('cổng nội bộ /sub + lệnh subcli: AI chính giao việc, chờ, nhận kết quả; mã sai bị từ chối', async () => {
  const { eng, calls } = fakeEngines(['claude']);
  const S = createSubagents({ engines: eng, log() {}, candidates: () => ['claude'] });
  S.register(PARENT);
  const gate = createGate({ db: { addAudit() {} }, approvals: { request: async () => ({ allowed: true }), cancelJob() {} }, workdir: tmp(), log() {}, sub: S });
  const port = await gate.listen(0);
  const saved = { u: process.env.AGENTOS_GATE_URL, t: process.env.AGENTOS_GATE_TOKEN, j: process.env.AGENTOS_JOB_ID };
  const out = []; const log = console.log, err = console.error; console.log = (...x) => out.push(x.join(' ')); console.error = (...x) => out.push('ERR ' + x.join(' '));
  try {
    Object.assign(process.env, { AGENTOS_GATE_URL: 'http://127.0.0.1:' + port, AGENTOS_GATE_TOKEN: gate.token, AGENTOS_JOB_ID: '7' });
    assert.equal(await subcli.main(['spawn', 'Đọc', 'bảng', 'giá', 'tháng', '11']), 0); assert.match(out.join('\n'), /Đã giao trợ lý #1/);
    assert.equal(calls.length, 1); assert.match(calls[0].prompt, /Đọc bảng giá tháng 11/);
    out.length = 0; assert.equal(await subcli.main(['wait', '--sec', '1']), 0); assert.match(out.join('\n'), /CHƯA XONG/);
    calls[0].finish({ ok: true, text: 'Giá tháng 11: 100k' });
    out.length = 0; assert.equal(await subcli.main(['wait', '1', '--sec', '5']), 0); assert.match(out.join('\n'), /Trợ lý #1 \(claude\) — xong[\s\S]*Giá tháng 11: 100k/);
    out.length = 0; assert.equal(await subcli.main(['list']), 0); assert.match(out.join('\n'), /#1 \[done\]/);
    process.env.AGENTOS_JOB_ID = '999'; out.length = 0; assert.equal(await subcli.main(['spawn', 'việc từ việc lạ']), 1); assert.match(out.join('\n'), /AI chính/);
    process.env.AGENTOS_GATE_TOKEN = 'sai'; out.length = 0; assert.equal(await subcli.main(['list']).catch(() => 1), 1);
    assert.equal(await subcli.main([]), 2);
  } finally {
    console.log = log; console.error = err;
    for (const [k, v] of [['AGENTOS_GATE_URL', saved.u], ['AGENTOS_GATE_TOKEN', saved.t], ['AGENTOS_JOB_ID', saved.j]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await gate.close();
  }
});

test('dự án: AGENTS.md / CLAUDE.md và kỹ năng (KY-NANG, .agentos/skills, .claude/skills) được đưa vào chỉ dẫn; CHI-DAN.md vẫn đứng đầu', () => {
  const db = openDb(':memory:'), dir = tmp(); let t = 1;
  const P = createProjects({ db, baseDir: dir, now: () => t++ });
  const p = P.create('Bán hàng', '111');
  assert.equal(P.instructions(p.id), '');
  fs.writeFileSync(path.join(p.dir, 'CLAUDE.md'), 'Luôn báo giá đã gồm VAT.');
  assert.match(P.instructions(p.id), /Từ tệp CLAUDE\.md[\s\S]*VAT/);
  fs.writeFileSync(path.join(p.dir, 'AGENTS.md'), 'Xưng em, gọi khách là anh/chị.');
  const x = P.instructions(p.id); assert.match(x, /Từ tệp AGENTS\.md[\s\S]*Xưng em/); assert.doesNotMatch(x, /VAT/, 'chỉ lấy một tệp, ưu tiên AGENTS.md');
  P.setInstructions(p.id, 'Chỉ dẫn chính của dự án.'); assert.ok(P.instructions(p.id).startsWith('Chỉ dẫn chính của dự án.\n\n(Từ tệp AGENTS.md'));
  fs.mkdirSync(path.join(p.dir, 'KY-NANG')); fs.writeFileSync(path.join(p.dir, 'KY-NANG', 'bao-gia.md'), '---\nname: bao-gia\ndescription: Cách lập báo giá cho khách sỉ\n---\nBước 1…');
  fs.mkdirSync(path.join(p.dir, 'KY-NANG', 'x')); fs.writeFileSync(path.join(p.dir, 'KY-NANG', 'chot-ca.md'), '# Chốt ca cuối ngày\nĐối chiếu tiền mặt…');
  fs.mkdirSync(path.join(p.dir, '.claude', 'skills', 'nhap-hang'), { recursive: true }); fs.writeFileSync(path.join(p.dir, '.claude', 'skills', 'nhap-hang', 'SKILL.md'), '---\nname: nhap-hang\ndescription: Nhập hàng từ file Excel của nhà cung cấp\n---\n…');
  const sk = P.skillsOf(p.id).map((s) => s.name).sort(); assert.deepEqual(sk, ['bao-gia', 'chot-ca', 'nhap-hang']);
  const full = P.instructions(p.id); assert.match(full, /KỸ NĂNG CỦA DỰ ÁN/); assert.match(full, /bao-gia: Cách lập báo giá cho khách sỉ → /); assert.match(full, /chot-ca: Chốt ca cuối ngày → /); assert.match(full, /nhap-hang: Nhập hàng từ file Excel/);
});
