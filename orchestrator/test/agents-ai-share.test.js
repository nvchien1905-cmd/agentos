'use strict';
// Đăng nhập AI một lần ở bot quản lý → MỌI bot phụ dùng được (Claude + Codex + Gemini + khóa API), đăng xuất thì thu lại.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgentCtl } = require('../src/agentctl');

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const RID = 'a1b2c3d4e5f60718';
function world(envExtra) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agai-'));
  const p = { ctl: d + '/ctl', homes: d + '/homes', mail: d + '/homes/.mail', bin: d + '/homes/.bin', etc: d + '/etc', units: d + '/units', mainEnv: d + '/etc/orchestrator.env', mainHome: d + '/main', appDir: '/opt/agentos/orchestrator', node: '/usr/bin/node', poolFile: d + '/etc/pool.json', meminfo: d + '/meminfo' };
  for (const x of [p.etc, p.units, p.mainHome + '/.local/bin', p.mainHome + '/.local/lib/node_modules/@openai/codex/bin', p.mainHome + '/.local/lib/node_modules/@google/gemini-cli/bundle', p.mainHome + '/.claude', p.mainHome + '/.codex', p.mainHome + '/.gemini']) fs.mkdirSync(x, { recursive: true });
  fs.writeFileSync(p.poolFile, JSON.stringify({ enabled: false })); fs.writeFileSync(p.meminfo, 'MemTotal: 8388608 kB\n');
  fs.writeFileSync(p.mainHome + '/.local/bin/claude', 'ELF');
  const nm = p.mainHome + '/.local/lib/node_modules';
  fs.writeFileSync(nm + '/@openai/codex/package.json', '{"name":"@openai/codex","version":"1.0.0"}');
  fs.writeFileSync(nm + '/@openai/codex/bin/codex.js', '// codex');
  fs.writeFileSync(nm + '/@google/gemini-cli/package.json', '{"name":"@google/gemini-cli","version":"2.0.0"}');
  fs.writeFileSync(nm + '/@google/gemini-cli/bundle/gemini.js', '// gemini');
  const setEnv = (extra) => fs.writeFileSync(p.mainEnv, ['TELEGRAM_TOKEN=555555555:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'ALLOWED_USER_IDS=1', 'CLAUDE_BIN=' + p.mainHome + '/.local/bin/claude', 'CODEX_BIN=' + nm + '/@openai/codex/bin/codex.js', 'GEMINI_BIN=' + nm + '/@google/gemini-cli/bundle/gemini.js'].concat(extra, ['']).join('\n'));
  setEnv(envExtra || ['ENGINE_ORDER=claude,codex,gemini']);
  const cmds = [];
  const run = async (bin, args) => { cmds.push([bin].concat(args).join(' ')); return { code: bin === 'id' ? 1 : 0, out: '' }; };
  const ctl = createAgentCtl({ run, paths: p, now: () => 1800000000000 });
  const loginClaude = () => { fs.writeFileSync(p.mainHome + '/.claude/.credentials.json', '{"claudeAiOauth":{"accessToken":"AT1"}}'); fs.writeFileSync(p.mainHome + '/.claude.json', JSON.stringify({ theme: 'x', oauthAccount: { accountUuid: 'U1', emailAddress: 'a@b.c' } })); };
  const loginCodex = () => fs.writeFileSync(p.mainHome + '/.codex/auth.json', '{"tokens":{"account_id":"C1","access_token":"CT1"}}');
  const loginGemini = () => { fs.writeFileSync(p.mainHome + '/.gemini/oauth_creds.json', '{"access_token":"G1"}'); fs.writeFileSync(p.mainHome + '/.gemini/google_accounts.json', '{"active":"g@x.y"}'); };
  const agentEnv = (id) => fs.readFileSync(p.etc + '/agents/' + id + '.env', 'utf8');
  const sync = () => ctl.handle({ rid: RID, action: 'sync' });
  const create = (id) => ctl.handle({ rid: RID, action: 'create', id, token: TOKEN.replace('123456789', id === 'a1' ? '123456789' : '987654321'), name: 'Bot ' + id, owners: ['1'], ramMb: 1024, cpuPct: 100 });
  return { p, cmds, ctl, setEnv, loginClaude, loginCodex, loginGemini, agentEnv, sync, create };
}

test('đã đăng nhập Claude + Codex + Gemini ở bot quản lý: bot phụ MỚI tạo dùng được cả 3 (tệp đăng nhập, chương trình, ENGINE_ORDER)', async () => {
  const w = world(); w.loginClaude(); w.loginCodex(); w.loginGemini();
  const r = await w.create('a1'); assert.equal(r.ok, true, r.msg);
  const home = w.p.homes + '/a1', env = w.agentEnv('a1');
  assert.match(env, /^ENGINE_ORDER=claude,codex,gemini$/m);
  assert.match(env, /^CODEX_BIN=.*[\\/]codex$/m);
  assert.match(env, /^GEMINI_BIN=.*[\\/]gemini$/m);
  assert.match(fs.readFileSync(home + '/.claude/.credentials.json', 'utf8'), /AT1/);
  assert.equal(JSON.parse(fs.readFileSync(home + '/.claude.json', 'utf8')).oauthAccount.accountUuid, 'U1');
  assert.match(fs.readFileSync(home + '/.codex/auth.json', 'utf8'), /CT1/);
  assert.match(fs.readFileSync(home + '/.gemini/oauth_creds.json', 'utf8'), /G1/);
  assert.match(fs.readFileSync(home + '/.gemini/google_accounts.json', 'utf8'), /g@x\.y/);
  // chương trình Codex/Gemini nằm trong chỗ dùng chung, chạy được qua liên kết (đúng tệp thật)
  assert.equal(fs.readFileSync(w.p.bin + '/codex', 'utf8'), '// codex');
  assert.equal(fs.readFileSync(w.p.bin + '/gemini', 'utf8'), '// gemini');
  assert.ok(w.cmds.some((c) => /^chown -R root:root .*pkg[\\/]codex$/.test(c)), 'chủ chương trình phải là root');
});

test('đăng nhập thêm SAU khi bot phụ đã tạo: sync chép sang mọi bot, thêm Codex vào ENGINE_ORDER và khởi động lại bot đó', async () => {
  const w = world(); w.loginClaude();
  await w.create('a1'); await w.create('a2');
  assert.match(w.agentEnv('a1'), /^ENGINE_ORDER=claude$/m);           // mới chỉ Claude
  assert.equal(fs.existsSync(w.p.homes + '/a1/.codex/auth.json'), false);
  w.cmds.length = 0;
  w.loginCodex();                                                      // chủ máy đăng nhập Codex ở trang Cài đặt
  const r = await w.sync(); assert.equal(r.ok, true, r.msg);
  assert.deepEqual(r.changed, ['a1', 'a2']);
  for (const id of ['a1', 'a2']) {
    assert.match(w.agentEnv(id), /^ENGINE_ORDER=claude,codex$/m, id);
    assert.match(fs.readFileSync(w.p.homes + '/' + id + '/.codex/auth.json', 'utf8'), /CT1/, id);
    assert.ok(w.cmds.some((c) => c === 'systemctl restart agentos-agent-' + id), 'khởi động lại ' + id);
  }
  // chạy lại khi không có gì đổi: KHÔNG khởi động lại bot
  w.cmds.length = 0;
  const r2 = await w.sync(); assert.deepEqual(r2.changed, []); assert.ok(!w.cmds.some((c) => /restart/.test(c)));
});

test('đăng xuất ở bot quản lý: thu lại đăng nhập của đúng AI đó ở mọi bot (giữ AI khác và phần còn lại của ~/.claude.json)', async () => {
  const w = world(); w.loginClaude(); w.loginCodex();
  await w.create('a1');
  const cj = w.p.homes + '/a1/.claude.json';
  fs.writeFileSync(cj, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(cj, 'utf8')), { botSetting: 7 })));
  // đăng xuất Claude ở bot quản lý (xóa tệp + oauthAccount) rồi đồng bộ
  fs.rmSync(w.p.mainHome + '/.claude/.credentials.json'); fs.writeFileSync(w.p.mainHome + '/.claude.json', JSON.stringify({ theme: 'x' }));
  const r = await w.sync(); assert.deepEqual(r.changed, ['a1']);
  assert.equal(fs.existsSync(w.p.homes + '/a1/.claude/.credentials.json'), false);
  const after = JSON.parse(fs.readFileSync(cj, 'utf8')); assert.equal(after.oauthAccount, undefined); assert.equal(after.botSetting, 7);
  assert.match(fs.readFileSync(w.p.homes + '/a1/.codex/auth.json', 'utf8'), /CT1/);   // Codex vẫn còn
  // đăng xuất nốt Codex → ENGINE_ORDER chỉ còn claude (không bắt bot gọi AI không có đăng nhập)
  fs.rmSync(w.p.mainHome + '/.codex/auth.json');
  await w.sync();
  assert.equal(fs.existsSync(w.p.homes + '/a1/.codex/auth.json'), false);
  assert.match(w.agentEnv('a1'), /^ENGINE_ORDER=claude$/m);
});

test('khóa API của mọi AI dùng chung; AI chỉ có khóa (DeepSeek) vào ENGINE_ORDER; CLAUDE_ONLY ép chỉ Claude; thứ tự theo bot quản lý', async () => {
  const w = world(['ENGINE_ORDER=deepseekapi,codex,claude', 'AGENTOS_KEY_CLAUDE=sk-ant-api03-claudekey', 'AGENTOS_KEY_DEEPSEEK=sk-deepseekkey', 'AGENTOS_KEY_CODEX=sk-codexkey']);
  await w.create('a1');
  const env = w.agentEnv('a1');
  assert.match(env, /^AGENTOS_KEY_CLAUDE=sk-ant-api03-claudekey$/m);
  assert.match(env, /^AGENTOS_KEY_DEEPSEEK=sk-deepseekkey$/m);
  assert.match(env, /^AGENTOS_KEY_CODEX=sk-codexkey$/m);
  assert.match(env, /^ENGINE_ORDER=deepseekapi,codex,claude$/m);
  assert.doesNotMatch(env, /TELEGRAM_TOKEN=555555555/);              // không lộ token bot quản lý
  w.setEnv(['ENGINE_ORDER=claude,codex', 'CLAUDE_ONLY=1', 'AGENTOS_KEY_CLAUDE=sk-ant-api03-claudekey']);
  await w.sync();
  assert.match(w.agentEnv('a1'), /^ENGINE_ORDER=claude$/m);
});

test('token Claude tự làm mới trong bot (bản mới hơn, cùng tài khoản) → chép ngược về bot quản lý; tài khoản khác thì bot quản lý thắng', async () => {
  const w = world(); w.loginClaude();
  await w.create('a1');
  const as = w.p.homes + '/a1/.claude/.credentials.json', ms = w.p.mainHome + '/.claude/.credentials.json';
  fs.writeFileSync(as, '{"claudeAiOauth":{"accessToken":"AT2-REFRESHED"}}');
  const future = new Date(Date.now() + 60000); fs.utimesSync(as, future, future);
  await w.sync();
  assert.match(fs.readFileSync(ms, 'utf8'), /AT2-REFRESHED/);
  assert.match(fs.readFileSync(as, 'utf8'), /AT2-REFRESHED/);
  // chủ máy đổi sang tài khoản Claude KHÁC ở bot quản lý → bản của bot bị ghi đè dù mới hơn
  fs.writeFileSync(ms, '{"claudeAiOauth":{"accessToken":"OTHER"}}'); fs.writeFileSync(w.p.mainHome + '/.claude.json', JSON.stringify({ oauthAccount: { accountUuid: 'U2' } }));
  fs.writeFileSync(as, '{"claudeAiOauth":{"accessToken":"STALE"}}'); fs.utimesSync(as, new Date(Date.now() + 120000), new Date(Date.now() + 120000));
  await w.sync();
  assert.match(fs.readFileSync(as, 'utf8'), /OTHER/);
  assert.equal(JSON.parse(fs.readFileSync(w.p.homes + '/a1/.claude.json', 'utf8')).oauthAccount.accountUuid, 'U2');
});

test('token Claude: so GIỜ HẾT HẠN, không so giờ sửa tệp (bản làm mới thắng dù tệp có giờ sửa cũ; bản cũ không đè bản mới)', async () => {
  const w = world(); w.loginClaude();
  await w.create('a1'); await w.create('a2');
  const ms = w.p.mainHome + '/.claude/.credentials.json', a1 = w.p.homes + '/a1/.claude/.credentials.json', a2 = w.p.homes + '/a2/.claude/.credentials.json';
  const tok = (name, exp) => JSON.stringify({ claudeAiOauth: { accessToken: name, expiresAt: exp } });
  fs.writeFileSync(ms, tok('MAIN-OLD', 1000));
  // a1 vừa làm mới (hết hạn muộn hơn) nhưng giờ sửa tệp CŨ HƠN bot quản lý → vẫn phải thắng và chia cho a2
  fs.writeFileSync(a1, tok('A1-NEW', 9000)); fs.utimesSync(a1, new Date(Date.now() - 600000), new Date(Date.now() - 600000));
  fs.writeFileSync(a2, tok('A2-STALE', 1000));
  await w.sync();
  for (const f of [ms, a1, a2]) assert.match(fs.readFileSync(f, 'utf8'), /A1-NEW/);
  // bot quản lý làm mới (hết hạn muộn hơn) còn a1 có giờ sửa mới hơn nhưng hết hạn sớm → bot quản lý thắng, không bị đè bản cũ
  fs.writeFileSync(ms, tok('MAIN-NEWER', 20000));
  fs.writeFileSync(a1, tok('A1-OLDER', 9000)); fs.utimesSync(a1, new Date(Date.now() + 90000), new Date(Date.now() + 90000));
  await w.sync();
  for (const f of [ms, a1, a2]) assert.match(fs.readFileSync(f, 'utf8'), /MAIN-NEWER/);
});

test('kho tài khoản web: bot quản lý lưu → mọi bot phụ nhận bản sao (tệp + khóa, 0600); bot quản lý xóa kho → bot phụ bị rút', async () => {
  const w = world(); w.loginClaude();
  await w.create('a1'); await w.create('a2');
  fs.mkdirSync(w.p.mainHome + '/data', { recursive: true });
  fs.writeFileSync(w.p.mainHome + '/data/weblogin.enc', Buffer.from('ENC1')); fs.writeFileSync(w.p.mainHome + '/weblogin.key', Buffer.from('KEY1'));
  await w.sync();
  for (const id of ['a1', 'a2']) { assert.equal(fs.readFileSync(w.p.homes + '/' + id + '/data/weblogin.enc', 'utf8'), 'ENC1'); assert.equal(fs.readFileSync(w.p.homes + '/' + id + '/weblogin.key', 'utf8'), 'KEY1'); }
  fs.writeFileSync(w.p.mainHome + '/data/weblogin.enc', Buffer.from('ENC2')); await w.sync();
  assert.equal(fs.readFileSync(w.p.homes + '/a1/data/weblogin.enc', 'utf8'), 'ENC2');
  fs.rmSync(w.p.mainHome + '/data/weblogin.enc'); await w.sync();
  assert.equal(fs.existsSync(w.p.homes + '/a1/data/weblogin.enc'), false); assert.equal(fs.existsSync(w.p.homes + '/a2/weblogin.key'), false);
});

test('sync không có bot phụ: không lỗi; cập nhật Codex mới (phiên bản đổi) thì chép lại chương trình', async () => {
  const w0 = world(); const r0 = await w0.sync(); assert.equal(r0.ok, true);
  const w = world(); w.loginClaude(); w.loginCodex(); await w.create('a1');
  const nm = w.p.mainHome + '/.local/lib/node_modules/@openai/codex';
  fs.writeFileSync(nm + '/package.json', '{"name":"@openai/codex","version":"1.1.0"}');
  fs.writeFileSync(nm + '/bin/codex.js', '// codex v2');
  await w.sync();
  assert.equal(fs.readFileSync(w.p.bin + '/codex', 'utf8'), '// codex v2');
});
