'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createUnlock } = require('../src/unlock');

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const RP = 'chien.tail1234.ts.net', ORIGIN = 'https://' + RP;
// mã hóa CBOR tối thiểu cho bộ xác thực giả
const cbU = (mt, n) => (n < 24 ? Buffer.from([(mt << 5) | n]) : n < 256 ? Buffer.from([(mt << 5) | 24, n]) : Buffer.from([(mt << 5) | 25, n >> 8, n & 255]));
const cbBytes = (b) => Buffer.concat([cbU(2, b.length), b]);
const cbText = (s) => Buffer.concat([cbU(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cbInt = (n) => (n >= 0 ? cbU(0, n) : cbU(1, -1 - n));

function authenticator() {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = kp.publicKey.export({ format: 'jwk' });
  const id = crypto.randomBytes(32); let count = 0;
  const cose = Buffer.concat([cbU(5, 5), cbInt(1), cbInt(2), cbInt(3), cbInt(-7), cbInt(-1), cbInt(1), cbInt(-2), cbBytes(Buffer.from(jwk.x, 'base64url')), cbInt(-3), cbBytes(Buffer.from(jwk.y, 'base64url'))]);
  const cd = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin: origin || ORIGIN }));
  return {
    id,
    create(challenge, o) {
      o = o || {}; const flags = o.flags === undefined ? 0x45 : o.flags;
      const ad = Buffer.concat([sha(o.rp || RP), Buffer.from([flags]), Buffer.from([0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([id.length >> 8, id.length & 255]), id, cose]);
      const att = Buffer.concat([cbU(5, 3), cbText('fmt'), cbText('none'), cbText('attStmt'), cbU(5, 0), cbText('authData'), cbBytes(ad)]);
      return { id: b64u(id), clientDataJSON: b64u(cd('webauthn.create', challenge, o.origin)), attestationObject: b64u(att) };
    },
    get(challenge, o) {
      o = o || {}; count = o.count === undefined ? count + 1 : o.count; const flags = o.flags === undefined ? 0x05 : o.flags;
      const c4 = Buffer.alloc(4); c4.writeUInt32BE(count);
      const ad = Buffer.concat([sha(o.rp || RP), Buffer.from([flags]), c4]), cdj = cd('webauthn.get', challenge, o.origin);
      const sig = crypto.sign('sha256', Buffer.concat([ad, sha(cdj)]), kp.privateKey);
      return { id: b64u(id), clientDataJSON: b64u(cdj), authenticatorData: b64u(ad), signature: b64u(o.badSig ? Buffer.alloc(sig.length, 1) : sig) };
    },
  };
}

function mk(extra) {
  const kv = new Map(), sent = [], logs = []; let t = 1700000000000;
  const db = { kvGet: (k) => (kv.has(k) ? kv.get(k) : null), kvSet: (k, v) => kv.set(k, v) };
  const calls = [];
  const exec = async (bin, args) => { calls.push([bin].concat(args).join(' ')); return { code: 0, out: '', err: '' }; };
  const u = createUnlock(Object.assign({ db, log: (m) => logs.push(m), now: () => t, exec, hostName: async () => RP, notify: async (c, m) => { sent.push([c, m]); }, port: 0 }, extra || {}));
  return { u, db, sent, logs, calls, adv: (ms) => { t += ms; } };
}
// gọi trang như điện thoại
async function call(u, link, step, body) {
  const tok = /\/u\/([0-9a-f]{48})\//.exec(link)[1]; let status = 0, text = '';
  const req = { url: '/u/' + tok + '/' + step, method: 'POST', on(ev, fn) { if (ev === 'data' && body) fn(JSON.stringify(body)); if (ev === 'end') fn(); return this; }, destroy() {} };
  const res = { writeHead(c) { status = c; }, end(b) { text = b; } };
  await u._handle(req, res); return { status, json: (() => { try { return JSON.parse(text); } catch (e) { return text; } })() };
}
const linkOf = (s) => /https:\/\/\S+/.exec(s)[0];

test('khóa vân tay: đăng ký → bật → khóa sau 24 giờ → quét vân tay mở lại; lệnh nguy hiểm bị chặn khi đang khóa', async () => {
  const { u, sent, adv, calls } = mk(); const dev = authenticator();
  try {
    assert.equal(u.isLocked(1), false, 'mặc định tắt');
    assert.match(await u.command('/khoa bat', 1), /Chưa có vân tay/, 'không cho bật khi chưa đăng ký (tránh tự khóa mình)');
    const rl = linkOf(await u.command('/khoa dangky', 1)); assert.ok(calls.some((c) => /^tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:/.test(c)) && !calls.some((c) => /funnel/.test(c)), 'chỉ serve trong tailnet, không funnel');
    const o = (await call(u, rl, 'options')).json; assert.equal(o.kind, 'reg'); assert.equal(o.rpId, RP);
    assert.deepEqual((await call(u, rl, 'finish', dev.create(o.challenge))).json, { ok: true });
    assert.equal((await call(u, rl, 'options')).status, 404, 'liên kết dùng 1 lần');
    assert.match(sent[0][1], /Đã đăng ký vân tay/);
    assert.match(await u.command('/khoa bat', 1), /Đã BẬT/); assert.equal(u.isLocked(1), false, 'vừa bật thì đang mở');
    assert.equal(await u.gate('/trangthai', 1), null);
    adv(24 * 3600 * 1000 + 1); assert.equal(u.isLocked(1), true);
    assert.match(await u.gate('/may', 1), /đang khóa/); assert.match(await u.gate('xóa hết dữ liệu', 1), /đang khóa/);
    for (const x of ['/khoa dangky', '/khoa tat', '/khoa xoa', '/khoa gio 168', '/khoa bat']) assert.match(await u.gate(x, 1), /đang khóa/, x + ' phải bị chặn khi khóa');
    assert.equal(await u.gate('/mokhoa', 1), null, 'được xin liên kết mở khóa');
    const al = linkOf(await u.command('/mokhoa', 1)); const ao = (await call(u, al, 'options')).json; assert.equal(ao.kind, 'auth'); assert.deepEqual(ao.ids, [b64u(dev.id)]);
    assert.deepEqual((await call(u, al, 'finish', dev.get(ao.challenge))).json, { ok: true });
    assert.equal(u.isLocked(1), false); assert.match(sent[1][1], /Đã mở khóa 24 giờ/);
    assert.match(await u.command('/khoa', 1), /Đã khóa/); assert.equal(u.isLocked(1), true);
  } finally { u.stop(); }
});

test('khóa vân tay: từ chối chữ ký sai, thiếu xác minh vân tay (UV), sai tên miền/địa chỉ, thử thách cũ, bộ đếm lùi, thiết bị lạ', async () => {
  const { u } = mk(); const dev = authenticator(), evil = authenticator();
  try {
    const reg = async (d, o) => { const l = linkOf(await u.command('/khoa dangky', 1)); const op = (await call(u, l, 'options')).json; return call(u, l, 'finish', d.create(op.challenge, o)); };
    assert.match((await reg(dev, { flags: 0x41 })).json.error, /UV|vân tay/, 'không UV thì không đăng ký');
    assert.match((await reg(dev, { rp: 'evil.com' })).json.error, /rpId|tên miền/);
    assert.match((await reg(dev, { origin: 'https://evil.com' })).json.error, /địa chỉ/);
    assert.deepEqual((await reg(dev)).json, { ok: true });
    await u.command('/khoa bat', 1); const c = u._load(); c.users = {}; u._save(c);
    const tryAuth = async (d, o) => { const l = linkOf(await u.command('/mokhoa', 1)); const op = (await call(u, l, 'options')).json; return { r: await call(u, l, 'finish', d.get(o && o.oldChallenge ? 'cu' : op.challenge, o)), l }; };
    assert.match((await tryAuth(dev, { badSig: true })).r.json.error, /chữ ký/); assert.equal(u.isLocked(1), true);
    assert.match((await tryAuth(dev, { flags: 0x01 })).r.json.error, /UV|vân tay/);
    assert.match((await tryAuth(dev, { oldChallenge: true })).r.json.error, /thử thách/);
    assert.match((await tryAuth(evil, {})).r.json.error, /chưa đăng ký/, 'thiết bị lạ');
    assert.deepEqual((await tryAuth(dev, { count: 5 })).r.json, { ok: true }); const c2 = u._load(); c2.users = {}; u._save(c2);
    assert.match((await tryAuth(dev, { count: 5 })).r.json.error, /bộ đếm/, 'bộ đếm không tăng = nghi sao chép');
    assert.equal(u.isLocked(1), true);
  } finally { u.stop(); }
});

test('khóa vân tay: liên kết hết hạn sau 10 phút; UNLOCK_DISABLE=1 tắt hẳn (cứu khi mất điện thoại); /khoa trangthai', async () => {
  const m = mk(); const dev = authenticator();
  try {
    const l = linkOf(await m.u.command('/khoa dangky', 1)); m.adv(10 * 60 * 1000 + 1);
    assert.equal((await call(m.u, l, 'options')).status, 404);
    const l2 = linkOf(await m.u.command('/khoa dangky', 1)); const o = (await call(m.u, l2, 'options')).json; await call(m.u, l2, 'finish', dev.create(o.challenge));
    await m.u.command('/khoa bat', 1); m.adv(25 * 3600 * 1000); assert.equal(m.u.isLocked(1), true);
    assert.match(await m.u.command('/khoa trangthai', 1), /BẬT · 1 thiết bị.*đang khóa/);
    const d = createUnlockWith({ UNLOCK_DISABLE: '1' }, m.db); assert.equal(d.isLocked(1), false, 'UNLOCK_DISABLE=1 thì không khóa');
  } finally { m.u.stop(); }
});
function createUnlockWith(env, db) { return require('../src/unlock').createUnlock({ db, env, now: () => 1700000000000 + 100 * 3600 * 1000, port: 0 }); }

test('khóa vân tay: vân tay của ai đăng ký cũng mở được, nhưng chỉ mở cho tài khoản Telegram đang xin; người kia vẫn bị khóa', async () => {
  const { u, adv } = mk(); const devA = authenticator(), devB = authenticator();
  try {
    for (const d of [devA, devB]) { const l = linkOf(await u.command('/khoa dangky', 1, 1)); const o = (await call(u, l, 'options')).json; await call(u, l, 'finish', d.create(o.challenge)); }
    await u.command('/khoa bat', 1, 1); assert.equal(u.isLocked(1), false, 'người bật thì đang mở'); assert.equal(u.isLocked(2), true, 'người kia bị khóa ngay');
    assert.match(await u.gate('/may', 2, 2), /đang khóa/); assert.equal(await u.gate('/may', 1, 1), null);
    const l = linkOf(await u.command('/mokhoa', 2, 2)); const o = (await call(u, l, 'options')).json;
    assert.deepEqual((await call(u, l, 'finish', devA.get(o.challenge))).json, { ok: true }, 'người 2 quét bằng vân tay đã đăng ký của người 1 vẫn được');
    assert.equal(u.isLocked(2), false); assert.equal(u.isLocked(1), false);
    await u.command('/khoa', 1, 1); assert.equal(u.isLocked(1), true, 'người 1 khóa lại'); assert.equal(u.isLocked(2), false, 'người 2 không bị ảnh hưởng');
    adv(24 * 3600 * 1000 + 1); assert.equal(u.isLocked(2), true);
  } finally { u.stop(); }
});
