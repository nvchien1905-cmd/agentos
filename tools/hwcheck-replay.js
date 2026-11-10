#!/usr/bin/env node
// Chấm điểm phần cứng từ tệp may-that.txt (do tools/thu-may-that.sh tạo ra trên máy thật).
// node tools/hwcheck-replay.js may-that.txt [--json]
const fs = require('fs');
const path = require('path');
const hw = require(path.join(__dirname, '..', 'orchestrator', 'src', 'hwcheck.js'));

const file = process.argv[2];
if (!file) { console.error('Dùng: node tools/hwcheck-replay.js may-that.txt [--json]'); process.exit(1); }
const text = fs.readFileSync(file, 'utf8');
const sec = {};
let cur = null;
for (const line of text.split('\n')) {
  const m = line.match(/^=== (\S+) ===$/);
  if (m) { cur = m[1]; sec[cur] = []; continue; }
  if (cur) sec[cur].push(line);
}
const body = (k) => (sec[k] || []).join('\n').replace(/^\n+|\n+$/g, '');

// Dựng lại "hệ thống tệp" và "lệnh" từ bản ghi
const nicLines = (sec.nics || []).filter((l) => l.trim());
const drmLines = (sec.drm || []).filter((l) => l.trim());
const files = { '/proc/cmdline': body('cmdline') };
const dirs = { '/sys/class/net': [], '/sys/class/drm': [] };
const exists = new Set();
if (body('uefi') === 'yes') exists.add('/sys/firmware/efi');
if (body('live') === 'yes') exists.add('/run/live');
for (const l of nicLines) {
  const m = l.match(/^(\S+) wifi=(\d) up=(\S*) carrier=(\S*)/);
  if (!m) continue;
  const b = '/sys/class/net/' + m[1];
  dirs['/sys/class/net'].push(m[1]);
  exists.add(b + '/device');
  if (m[2] === '1') exists.add(b + '/wireless');
  files[b + '/operstate'] = m[3];
  files[b + '/carrier'] = m[4];
}
for (const l of drmLines) {
  const m = l.match(/^(\S+) (\S+)/);
  if (!m) continue;
  dirs['/sys/class/drm'].push(m[1]);
  files['/sys/class/drm/' + m[1] + '/status'] = m[2];
}

const cmds = {
  'systemd-detect-virt': { out: body('virt'), code: body('virt') ? 0 : 1 },
  lsblk: { out: body('lsblk'), code: 0 },
  lspci: { out: body('lspci'), code: 0 },
  rfkill: { out: body('rfkill'), code: 0 },
  journalctl: { out: body('firmware'), code: 0 },
  dmesg: { out: body('firmware'), code: 0 },
};

const run = async (bin) => {
  const c = cmds[bin];
  if (c) return { code: c.code, out: c.out + '\n', missing: false };
  // dpkg-query: không biết gói nào đã cài trên USB → coi như chưa cài
  return { code: 1, out: '', missing: false };
};
const fsx = {
  exists: (p) => exists.has(p),
  read: (p) => (p in files ? files[p] : ''),
  readdir: (p) => dirs[p] || [],
};

(async () => {
  const cores = parseInt(body('cores'), 10) || 1;
  const facts = await hw.collect({
    run, fs: fsx,
    arch: body('arch') || 'x64',
    totalmem: (parseInt(body('ramkb'), 10) || 0) * 1024,
    cpus: () => Array.from({ length: cores }, () => ({ model: body('cpumodel') })),
  });
  if (/aarch64|arm/.test(body('arch'))) facts.arch = 'arm64';
  const rep = hw.evaluate(facts);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(rep, null, 2)); return; }
  console.log('Máy: ' + body('dmi').replace(/\n/g, ' · '));
  console.log('Hệ điều hành đang chạy: ' + body('distro') + '\n');
  console.log(hw.format(rep));
  process.exit(rep.verdict === 'fail' ? 2 : 0);
})();
