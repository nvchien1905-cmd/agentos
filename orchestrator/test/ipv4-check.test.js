'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSelfTest } = require('../src/selftest');
const { RULES } = require('../src/doctor');

const mk = (map) => createSelfTest({ run: async (bin, args) => (map[bin] ? map[bin](args) : { code: 1, out: '', err: '', missing: true }) });
const route = async () => ({ code: 0, out: 'default via 192.168.2.1 dev enp1s0 proto dhcp\n' });

test('mạng IPv4: cổng không trả lời + không ra Internet → lỗi, bác sĩ máy xin khởi động lại NetworkManager; ra được thì ổn; chỉ cổng ổn thì cảnh báo', async () => {
  const bad = await mk({ ip: route, ping: async () => ({ code: 1, out: '' }), curl: async () => ({ code: 7, out: '000' }) }).checks.ipv4();
  assert.equal(bad.status, 'fail'); assert.match(bad.detail, /192\.168\.2\.1/);
  assert.deepEqual(RULES.ipv4(bad), ['restart NetworkManager']);
  assert.equal((await mk({ ip: route, ping: async () => ({ code: 1, out: '' }), curl: async () => ({ code: 0, out: '302' }) }).checks.ipv4()).status, 'ok', 'ra được Internet (dù router chặn ping) thì ổn');
  assert.equal((await mk({ ip: route, ping: async () => ({ code: 0, out: '' }), curl: async () => ({ code: 7, out: '000' }) }).checks.ipv4()).status, 'warn', 'router ổn nhưng modem/nhà mạng lỗi: chỉ cảnh báo, không khởi động lại');
  assert.equal((await mk({ ip: async () => ({ code: 0, out: '' }) }).checks.ipv4()).status, 'ok', 'mạng chỉ IPv6: bỏ qua, không khởi động lại');
});
