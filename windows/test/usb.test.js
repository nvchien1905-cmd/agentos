'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const W = path.join(__dirname, '..');

test('bộ cài USB: đủ tệp, tệp .ps1/.bat chỉ ASCII (PowerShell 5.1 đọc UTF-8 không BOM sẽ vỡ chữ), .bat tự xin quyền quản trị, chạy usb-cai.ps1 với ExecutionPolicy Bypass', () => {
  for (const f of ['usb/CAI-MAY-CON.bat', 'usb/usb-cai.ps1', 'tao-usb.ps1', 'TAO-USB.bat', 'cai-dat-may-con.ps1', '../orchestrator/src/fleet.js', '../orchestrator/src/tsowner.js']) assert.ok(fs.existsSync(path.join(W, f)), 'thiếu ' + f);
  for (const f of ['usb/CAI-MAY-CON.bat', 'usb/usb-cai.ps1', 'tao-usb.ps1', 'TAO-USB.bat']) assert.ok(!/[^\x00-\x7f]/.test(fs.readFileSync(path.join(W, f), 'utf8')), f + ' có ký tự ngoài ASCII');
  const bat = fs.readFileSync(path.join(W, 'usb/CAI-MAY-CON.bat'), 'utf8');
  assert.match(bat, /-Verb RunAs/); assert.match(bat, /-ExecutionPolicy Bypass -File "%~dp0usb-cai\.ps1"/);
  const ps = fs.readFileSync(path.join(W, 'usb/usb-cai.ps1'), 'utf8');
  assert.match(ps, /windows\\cai-dat-may-con\.ps1/); assert.match(ps, /tailscale-authkey\.txt/); assert.match(ps, /cai-san/);
  assert.doesNotMatch(ps, /Write-Host[^\n]*\$key\b/, 'không in khóa Tailscale ra màn hình');
});
