#!/usr/bin/env node
'use strict';
// CHỈ CHẠY TRÊN MÁY CỦA CHỦ DỰ ÁN (cần khóa riêng). Tạo gói cập nhật đã ký để đẩy lên GitHub (thư mục updates/).
//   node update/keygen.js <đường-dẫn-khóa-riêng.pem>                  (làm một lần; GIỮ KHÓA RIÊNG AN TOÀN, mất khóa = máy khách không cập nhật được nữa)
//   node update/build-bundle.js --key <khóa-riêng.pem> --version 2026.10.21.1 --notes "Nội dung ngắn" [--apply update/apply.sh]
// Kết quả: updates/agentos-update-<ver>.tar.gz + updates/manifest.json + updates/manifest.json.sig, và ghi VERSION ở gốc kho mã (ISO mới dùng cùng số phiên bản).
// Sau đó: git add -A && git commit && git push  — máy khách tự thấy bản mới (Telegram báo, /capnhat co để cài).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar';   // Windows: bsdtar có sẵn (tar của Git Bash hiểu nhầm C: là máy từ xa)
const arg = (name) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : undefined; };

const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };
function walk(dir, filter) {
  const out = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(test|node_modules|data|work)$/.test(e.name)) rec(p); }
      else if (!filter || filter(p, e.name)) out.push(p);
    }
  })(dir);
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// Danh sách (nguồn trong kho mã -> đường dẫn đích tính từ gốc hệ thống)
function plan(version, applyFile) {
  const map = [];
  const add = (src, dest) => map.push([src, dest]);
  const INC = path.join(ROOT, 'iso/config/includes.chroot');
  for (const p of walk(path.join(ROOT, 'orchestrator/src'))) add(p, 'opt/agentos/orchestrator/src/' + rel(p).slice('orchestrator/src/'.length));
  for (const p of walk(path.join(ROOT, 'wizard'), (q, n) => !/\.(log|tmp)$/.test(n))) add(p, 'opt/agentos/wizard/' + rel(p).slice('wizard/'.length));
  for (const p of walk(path.join(ROOT, 'desk'), (q, n) => /\.js$/.test(n))) add(p, 'opt/agentos/desk/' + rel(p).slice('desk/'.length));
  for (const n of ['lib.js', 'updater.js']) add(path.join(ROOT, 'update', n), 'opt/agentos/update/' + n);
  const pick = (dirRel, re, destDir) => {
    const d = path.join(INC, dirRel);
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isFile() && re.test(e.name)) add(path.join(d, e.name), destDir + e.name);
  };
  pick('usr/local/bin', /^agentos-[\w-]+$/, 'usr/local/bin/');
  pick('usr/local/sbin', /^agentos-[\w-]+$/, 'usr/local/sbin/');
  pick('etc/systemd/system', /^(agentos-[\w.-]+|onedrive-agentos\.[\w.-]+)$/, 'etc/systemd/system/');
  pick('etc/systemd/system/tailscaled.service.d', /^[\w.-]+$/, 'etc/systemd/system/tailscaled.service.d/');
  pick('etc/xdg/autostart', /^agentos-[\w-]+\.desktop$/, 'etc/xdg/autostart/');
  pick('usr/share/applications', /^agentos-[\w-]+\.desktop$/, 'usr/share/applications/');
  pick('usr/share/icons/hicolor/scalable/apps', /^agentos-[\w-]+\.svg$/, 'usr/share/icons/hicolor/scalable/apps/');
  if (applyFile) map.push([path.resolve(applyFile), 'apply.sh']);
  return map;
}

function main() {
  const key = arg('key'), version = arg('version'), notes = arg('notes') || '';
  if (!key || !version) { console.error('Dùng: node update/build-bundle.js --key <khóa-riêng.pem> --version 2026.10.21.1 --notes "..." [--apply tệp.sh]'); return 2; }
  if (!/^\d+(\.\d+){1,3}$/.test(version)) { console.error('Phiên bản phải dạng 2026.10.21.1'); return 2; }
  const outDir = path.resolve(arg('out') || path.join(ROOT, 'updates'));
  const privateKey = crypto.createPrivateKey(fs.readFileSync(key));
  if (!process.env.AGENTOS_BUILD_NO_VERSION_FILE) fs.writeFileSync(path.join(ROOT, 'VERSION'), version + '\n');   // test đặt biến này để không ghi đè VERSION thật

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-bundle-'));
  try {
    const map = plan(version, arg('apply'));
    for (const [src, dest] of map) {
      const to = path.join(stage, ...dest.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(src, to);
    }
    const v = path.join(stage, 'opt/agentos/VERSION');
    fs.mkdirSync(path.dirname(v), { recursive: true });
    fs.writeFileSync(v, version + '\n');
    fs.mkdirSync(outDir, { recursive: true });
    const file = 'agentos-update-' + version + '.tar.gz';
    const tops = fs.readdirSync(stage);
    const r = cp.spawnSync(TAR, ['-czf', file, '-C', stage, ...tops], { encoding: 'utf8', cwd: outDir })   // cwd=outDir + tên tương đối: bsdtar trên Windows không mở được đường dẫn có dấu tiếng Việt;
    if (r.status !== 0) throw new Error('tar lỗi: ' + (r.stderr || r.error));
    const buf = fs.readFileSync(path.join(outDir, file));
    const manifest = { version, file, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), date: new Date().toISOString().slice(0, 10), notes };
    const mbuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(outDir, 'manifest.json'), mbuf);
    fs.writeFileSync(path.join(outDir, 'manifest.json.sig'), crypto.sign(null, mbuf, privateKey).toString('base64') + '\n');
    // giữ 2 gói gần nhất
    const olds = fs.readdirSync(outDir).filter((x) => /^agentos-update-.*\.tar\.gz$/.test(x) && x !== file).sort().reverse().slice(1);
    for (const x of olds) fs.rmSync(path.join(outDir, x), { force: true });
    console.log('Đã tạo ' + file + ' (' + (buf.length / 1024).toFixed(0) + ' KB, ' + map.length + ' tệp), ký xong. Phiên bản ' + version + '.');
    return 0;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (require.main === module) { try { process.exit(main()); } catch (e) { console.error('Lỗi: ' + e.message); process.exit(1); } }
module.exports = { plan };
