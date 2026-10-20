'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { createDesk } = require('../server');

// Bảng phiên thật chụp từ máy ảo thử (20/10/2026): phiên đồ họa của người dùng có Active=no tạm thời, còn màn hình đăng nhập lightdm (greeter) Active=yes.
const TABLE = {
  '1': 'Type=tty\nActive=no\nDisplay=\nName=user\nClass=user',
  '3': 'Type=x11\nActive=no\nDisplay=:0\nName=user\nClass=user',
  'c2': 'Type=x11\nActive=yes\nDisplay=:1\nName=lightdm\nClass=greeter',
  '54': 'Type=tty\nActive=yes\nDisplay=\nName=user\nClass=user',
};
const LIST = ' 1 1000 user seat0 1202 user tty1 yes\n 3 1000 user seat0 1264 user - no\n54 1000 user - 11644 user - yes\nc2 106 lightdm seat0 10151 greeter - no\n';

const fakeRun = (list, table) => async (cmd, args) => {
  if (cmd === 'loginctl' && args[0] === 'list-sessions') return { code: 0, out: list, err: '' };
  if (cmd === 'loginctl' && args[0] === 'show-session') return { code: 0, out: table[args[1]] + '\n', err: '' };
  if (cmd === 'getent') return { code: 0, out: 'user:x:1000:1000:,,,:/home/user:/bin/bash\n', err: '' };
  return { code: 0, out: '', err: '' };
};

test('tìm phiên màn hình chính: bỏ màn hình đăng nhập (greeter) và phiên chữ, chọn phiên x11 của người dùng kể cả khi Active tạm sai', async () => {
  const desk = createDesk({ run: fakeRun(LIST, TABLE), detach: () => 1, outDir: os.tmpdir() });
  assert.deepEqual(await desk.handle({ cmd: 'who' }), { ok: true, user: 'user', display: ':0', locked: true });
});

test('tìm phiên màn hình chính: ưu tiên phiên Active khi có nhiều phiên x11 của người dùng', async () => {
  const table = Object.assign({}, TABLE, { '3': 'Type=x11\nActive=no\nDisplay=:0\nName=a\nClass=user', '7': 'Type=x11\nActive=yes\nDisplay=:2\nName=b\nClass=user' });
  const list = LIST + ' 7 1001 b seat0 999 user - yes\n';
  const desk = createDesk({ run: fakeRun(list, table), detach: () => 1, outDir: os.tmpdir() });
  assert.deepEqual(await desk.handle({ cmd: 'who' }), { ok: true, user: 'b', display: ':2', locked: false });
});

test('tìm phiên màn hình chính: chỉ có màn hình đăng nhập thì không ai ngồi máy -> báo lỗi', async () => {
  const desk = createDesk({ run: fakeRun('c2 106 lightdm seat0 10151 greeter - no\n', TABLE), detach: () => 1, outDir: os.tmpdir() });
  const r = await desk.handle({ cmd: 'who' });
  assert.equal(r.ok, false); assert.match(r.error, /đăng nhập/);
});
