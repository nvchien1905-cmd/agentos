'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, SAFE, NORMAL, DANGER } = require('../src/cmdTool');

test('phân loại lệnh của bot: xem / làm / nhạy cảm; cách dùng nhạy cảm của lệnh thường; sai cú pháp và lệnh lạ bị từ chối', () => {
  const L = (t) => { const c = classify(t); return c.ok ? c.level + ':' + c.name : 'x'; };
  for (const [t, exp] of [['/doanhso hôm nay', 'safe:doanhso'], ['/ton nồi chiên', 'safe:ton'], ['/trangthai', 'safe:trangthai'], ['/viec 5', 'safe:viec'], ['/tim nồi', 'safe:tim'], ['/manhinh', 'safe:manhinh'], ['/capnhat', 'safe:capnhat'],
    ['/mo webbot', 'normal:mo'], ['/hen 08:00 báo cáo', 'normal:hen'], ['/nho cửa hàng nghỉ chủ nhật', 'normal:nho'], ['/daily', 'normal:daily'], ['/daily them 123:ABC', 'normal:daily'], ['/giao a1 làm báo cáo', 'normal:giao'], ['/nen việc dài', 'normal:nen'], ['/ai codex', 'normal:ai'],
    ['/tatmay co', 'danger:tatmay'], ['/khoimay co', 'danger:khoimay'], ['/toanquyen', 'danger:toanquyen'], ['/baove', 'danger:baove'], ['/lenh rm -rf x', 'danger:lenh'], ['/capnhat co', 'danger:capnhat'], ['/capnhat tudong bat', 'danger:capnhat'],
    ['/daily xoa a1', 'danger:daily'], ['/agent sudo a1', 'danger:agent'], ['/vaitro dat 5 banhang', 'danger:vaitro'], ['/hoantac', 'danger:hoantac'], ['/khoamay', 'danger:khoamay'], ['/chiphi tran claude 100', 'danger:chiphi'], ['/chiphi tuan', 'safe:chiphi'],
    ['/DOANHSO', 'safe:doanhso'], ['/doanhso@mybot hôm nay', 'safe:doanhso']]) assert.equal(L(t), exp, t);
  for (const t of ['', '   ', 'doanh số', 'doanhso', '/', '/ ton', '/khongco', '/' + 'a'.repeat(30), 'x'.repeat(2001), '/ton ' + 'x'.repeat(2000)]) assert.equal(classify(t).ok, false, t.slice(0, 20));
  assert.equal(classify('/doanhso hôm nay\n/tatmay co').level, 'safe', 'lệnh thứ hai trong cùng tin KHÔNG được chạy: chỉ một lệnh, phần sau là đối số');
  // mọi lệnh phải thuộc đúng MỘT nhóm
  for (const n of SAFE) { assert.ok(!NORMAL.has(n) && !DANGER[n], n); } for (const n of NORMAL) assert.ok(!DANGER[n], n);
  assert.ok(SAFE.size >= 15 && NORMAL.size >= 40 && Object.keys(DANGER).length >= 10);
});
