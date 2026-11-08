'use strict';
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// KIỂM TRA PHẦN CỨNG: máy lạ (card mạng/Wi-Fi không có driver, thiếu firmware, khởi động BIOS cũ, RAM/ổ đĩa quá nhỏ, đồ họa chạy chế độ cơ bản...)
// thì báo RÕ "phần nào, vì sao, làm gì" thay vì để người dùng gặp lỗi khó hiểu về sau. Chỉ ĐỌC, không sửa gì.
// Hai bước tách riêng để thử được trên mọi máy: collect() gom dữ kiện thô (lspci, lsblk, /sys...), evaluate() là hàm thuần chấm điểm.
const GB = 1e9;
const ICON = { ok: '✅', info: 'ℹ️', warn: '⚠️', fail: '❌' };

// Tên tệp firmware thiếu -> gói Debian chứa nó
const FW_PKG = [
  [/^iwlwifi-|^intel\/iwlwifi/i, 'firmware-iwlwifi'],
  [/^(rtl_nic|rtlwifi|rtw88|rtw89|rtl_bt|rtl8\d)/i, 'firmware-realtek'],
  [/^(ath\d+k?|ath3k|qca|ar3k)/i, 'firmware-atheros'],
  [/^(mediatek|mt7\d)/i, 'firmware-mediatek'],
  [/^brcm/i, 'firmware-brcm80211'],
  [/^(amdgpu|radeon|amd)\b/i, 'firmware-amd-graphics'],
  [/^nvidia/i, 'firmware-nvidia-graphics'],
  [/^(i915|intel\/(ibt|sof)|intel-ucode)/i, 'firmware-misc-nonfree'],
];
const FW_IGNORE = /^regulatory\.db/i;                  // wireless-regdb: tệp này thiếu không ảnh hưởng

const pkgForFirmware = (name) => { for (const [re, pkg] of FW_PKG) if (re.test(name)) return pkg; return 'firmware-linux-nonfree'; };

// ---------- gom dữ kiện ----------
function parseLspci(text) {
  const out = []; let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (/^\S/.test(line)) {
      const m = line.match(/^(\S+)\s+(.+?) \[([0-9a-f]{4})\]: (.+?) \[([0-9a-f]{4}):([0-9a-f]{4})\]/i);
      cur = m ? { slot: m[1], cls: m[2], classCode: m[3].toLowerCase(), name: m[4], vendor: m[5].toLowerCase(), device: m[6].toLowerCase(), driver: '' } : null;
      if (cur) out.push(cur);
    } else if (cur) {
      const d = line.match(/Kernel driver in use:\s*(\S+)/); if (d) cur.driver = d[1];
    }
  }
  return out;
}
function parseLsblk(text) {
  return String(text || '').split('\n').map((l) => {
    const o = {}; l.replace(/(\w+)="([^"]*)"/g, (_, k, v) => { o[k] = v; return ''; });
    return o.NAME ? { name: o.NAME, size: Number(o.SIZE) || 0, rota: o.ROTA === '1', type: o.TYPE, tran: o.TRAN || '', model: (o.MODEL || '').trim(), removable: o.RM === '1' } : null;
  }).filter(Boolean);
}
function parseRfkill(text) {
  const out = []; let cur = null;
  for (const line of String(text || '').split('\n')) {
    const h = line.match(/^\d+:\s*(\S+):\s*(.+)$/);
    if (h) { cur = { name: h[1], kind: h[2].trim(), soft: false, hard: false }; out.push(cur); continue; }
    if (!cur) continue;
    if (/Soft blocked:\s*yes/i.test(line)) cur.soft = true;
    if (/Hard blocked:\s*yes/i.test(line)) cur.hard = true;
  }
  return out;
}
function parseFirmware(text) {
  const miss = new Set();
  for (const line of String(text || '').split('\n')) {
    let m = line.match(/Direct firmware load for (\S+) failed/i) || line.match(/firmware: failed to load (\S+?)(?: \(|,|\s|$)/i) || line.match(/Failed to (?:load|request) firmware\s*(?:image |file )?'?([^\s']+)/i);
    if (!m) continue;
    const f = m[1].replace(/[,.;:)]+$/, '');
    if (f && !FW_IGNORE.test(f.split('/').pop()) && !FW_IGNORE.test(f)) miss.add(f);
  }
  return [...miss];
}

async function collect(o) {
  o = o || {};
  const run = o.run || ((bin, args, timeout) => new Promise((res) => execFile(bin, args || [], { timeout: timeout || 8000, maxBuffer: 4 << 20 }, (e, so) => res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(so || ''), missing: !!(e && e.code === 'ENOENT') }))));
  const fsx = o.fs || { exists: (p) => fs.existsSync(p), read: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }, readdir: (p) => { try { return fs.readdirSync(p); } catch (e) { return []; } } };
  const f = { arch: o.arch || os.arch(), cpuModel: '', cores: 0, ramMb: Math.round((o.totalmem || os.totalmem()) / 1048576), uefi: false, live: false, virt: '', disks: [], nics: [], pci: [], rfkill: [], missingFirmware: [], pkgs: {}, displays: 0, tools: {} };
  try { const c = (o.cpus || os.cpus)(); f.cores = c.length; f.cpuModel = (c[0] && c[0].model || '').trim(); } catch (e) { /* bỏ qua */ }
  f.uefi = fsx.exists('/sys/firmware/efi');
  f.live = /\bboot=live\b/.test(fsx.read('/proc/cmdline')) || fsx.exists('/run/live');
  const virt = await run('systemd-detect-virt', []); f.virt = virt.code === 0 ? virt.out.trim() : '';
  const lsblk = await run('lsblk', ['-dn', '-b', '-P', '-o', 'NAME,SIZE,ROTA,TYPE,TRAN,MODEL,RM']); f.tools.lsblk = !lsblk.missing;
  f.disks = parseLsblk(lsblk.out).filter((d) => d.type === 'disk' && !/^(loop|zram|ram|sr)/.test(d.name));
  const pci = await run('lspci', ['-nnk']); f.tools.lspci = !pci.missing; f.pci = parseLspci(pci.out);
  const rf = await run('rfkill', ['list']); f.rfkill = parseRfkill(rf.out);
  for (const n of fsx.readdir('/sys/class/net')) {
    if (n === 'lo') continue;
    const base = '/sys/class/net/' + n;
    if (!fsx.exists(base + '/device')) continue;                     // cổng ảo (docker, tailscale, cầu nối) không phải phần cứng
    f.nics.push({ name: n, wifi: fsx.exists(base + '/wireless') || fsx.exists(base + '/phy80211'), up: fsx.read(base + '/operstate').trim(), carrier: fsx.read(base + '/carrier').trim() === '1' });
  }
  for (const c of fsx.readdir('/sys/class/drm')) {
    if (!/^card\d+-/.test(c)) continue;
    if (fsx.read('/sys/class/drm/' + c + '/status').trim() === 'connected') f.displays++;
  }
  let k = await run('journalctl', ['-k', '-b', '--no-pager', '-q', '-g', 'firmware'], 10000);
  if (k.code !== 0 || !k.out.trim()) { const d = await run('dmesg', [], 10000); if (d.code === 0) k = d; }
  f.missingFirmware = parseFirmware(k.out);
  for (const pkg of new Set(f.missingFirmware.map(pkgForFirmware))) {
    const r = await run('dpkg-query', ['-W', '-f=${Status}', pkg]); f.pkgs[pkg] = r.code === 0 && /install ok installed/.test(r.out);
  }
  return f;
}

// ---------- chấm điểm ----------
const FW_BAD_DRIVERS = /^(simpledrm|simplefb|efifb|vesafb|vga16fb|offb|bochs-drm|bochs|)$/i;
const VIRT_GPU = /virtio|vmware|vmsvga|qxl|bochs|cirrus|virtualbox|vbox|hyper-v/i;

function evaluate(f) {
  const items = [];
  const add = (id, name, status, detail, fix) => items.push({ id, name, status, detail: detail || '', fix: fix || '' });
  const virt = f.virt && f.virt !== 'none' ? f.virt : '';

  if (!/^(x64|x86_64|amd64)$/.test(f.arch)) add('arch', 'Loại CPU', 'fail', 'CPU kiểu ' + f.arch + ' — AgentOS chỉ chạy trên máy 64-bit Intel/AMD (x86_64).', 'Dùng mini PC/laptop Intel hoặc AMD; Raspberry Pi/máy ARM chưa được hỗ trợ.');
  else add('arch', 'CPU', f.cores < 2 ? 'warn' : 'ok', (f.cpuModel || 'x86_64') + ', ' + f.cores + ' nhân' + (virt ? ' (máy ảo ' + virt + ')' : ''), f.cores < 2 ? 'Chỉ 1 nhân sẽ rất chậm khi chạy trình duyệt, LibreOffice và AI cùng lúc. Nên dùng máy từ 2 nhân.' : '');

  const gb = (f.ramMb / 1024).toFixed(1);
  if (f.ramMb < 1800) add('ram', 'RAM', 'fail', gb + ' GB — quá ít.', 'Cần tối thiểu 2 GB, nên có 8 GB. Gắn thêm RAM.');
  else if (f.ramMb < 3600) add('ram', 'RAM', 'warn', gb + ' GB — chạy được nhưng chật.', 'Nên có 8 GB nếu dùng Chrome + LibreOffice + AI cùng lúc; máy sẽ chậm và có thể bị tắt ứng dụng giữa chừng.');
  else add('ram', 'RAM', 'ok', gb + ' GB');

  const main = (f.disks || []).filter((d) => !d.removable).sort((a, b) => b.size - a.size)[0];
  if (!main) add('disk', 'Ổ đĩa', f.tools.lsblk === false ? 'warn' : 'fail', f.tools.lsblk === false ? 'không kiểm được (thiếu lệnh lsblk)' : 'không thấy ổ đĩa nào để cài.', f.tools.lsblk === false ? '' : 'Máy dùng ổ đĩa lạ (RAID/Intel RST/VMD): vào BIOS đổi chế độ SATA từ "RAID/RST" sang "AHCI", hoặc bật NVMe/AHCI, rồi khởi động lại.');
  else {
    const size = Math.round(main.size / GB), kind = main.rota ? 'HDD (đĩa cứng quay)' : (main.tran === 'nvme' ? 'SSD NVMe' : 'SSD');
    const label = main.name + ' · ' + kind + ' · ' + size + ' GB' + (main.model ? ' · ' + main.model : '');
    if (main.size < 20 * GB) add('disk', 'Ổ đĩa', 'fail', label + ' — quá nhỏ.', 'Cần tối thiểu 20 GB, nên có 64 GB trở lên (LibreOffice, Chrome, điểm khôi phục, bản sao lưu đều chiếm chỗ).');
    else if (main.size < 40 * GB) add('disk', 'Ổ đĩa', 'warn', label + ' — nhỏ.', 'Nên có 64 GB trở lên để chứa điểm khôi phục và tệp làm việc.');
    else if (main.rota && !virt) add('disk', 'Ổ đĩa', 'warn', label, 'Ổ cứng quay chạy được nhưng chậm (khởi động và mở LibreOffice lâu). Nên thay SSD.');
    else add('disk', 'Ổ đĩa', 'ok', label);
  }

  if (f.uefi) add('boot', 'Kiểu khởi động', 'ok', 'UEFI');
  else if (f.live) add('boot', 'Kiểu khởi động', 'fail', 'BIOS cũ (Legacy/CSM). Bản cài này chuẩn bị cho UEFI nên máy cài xong sẽ KHÔNG khởi động được.', 'Vào BIOS (phím F2/Del/F10 lúc bật máy): bật UEFI, tắt "CSM/Legacy Support", lưu rồi khởi động lại USB cài.');
  else add('boot', 'Kiểu khởi động', 'warn', 'BIOS cũ (Legacy)' + (virt ? '' : ''), 'Máy đang chạy bình thường. Nếu sau này cài lại, nên bật UEFI trong BIOS.');

  // Card mạng không có driver
  const pciNet = (f.pci || []).filter((d) => d.classCode === '0200' || d.classCode === '0280');
  const noDrv = pciNet.filter((d) => !d.driver);
  for (const d of noDrv) add('net-driver-' + d.slot, d.classCode === '0280' ? 'Card Wi-Fi' : 'Card mạng dây', 'fail', d.name + ' [' + d.vendor + ':' + d.device + '] chưa có driver nên chưa dùng được.', 'Cắm dây mạng hoặc USB Wi-Fi để máy vẫn lên mạng được, rồi chạy cập nhật (/capnhat co) — bản mới có thể có driver; nếu vẫn không được, gửi mã [' + d.vendor + ':' + d.device + '] cho kỹ thuật viên.');
  const nics = f.nics || [];
  const wifi = nics.filter((n) => n.wifi), wired = nics.filter((n) => !n.wifi);
  if (!nics.length && !noDrv.length) add('net', 'Mạng', 'fail', 'Không thấy cổng mạng nào (không dây, có dây).', 'Cắm dây mạng hoặc USB Wi-Fi/USB LAN; máy phải có Internet để dùng Telegram và AI.');
  else if (nics.length) add('net', 'Mạng', 'ok', (wired.length ? wired.length + ' cổng dây' : '') + (wired.length && wifi.length ? ', ' : '') + (wifi.length ? wifi.length + ' Wi-Fi' : '') + (wired.some((n) => n.carrier) ? ' · đang cắm dây' : ''));
  if (!wifi.length && !noDrv.some((d) => d.classCode === '0280') && !virt) add('wifi', 'Wi-Fi', 'info', 'Máy không có Wi-Fi.', 'Dùng dây mạng, hoặc cắm USB Wi-Fi nếu muốn cài bằng điện thoại qua Wi-Fi.');
  for (const r of f.rfkill || []) {
    if (/wireless|wlan|wi-?fi/i.test(r.kind) && r.hard) add('rfkill-' + r.name, 'Wi-Fi bị tắt bằng công tắc', 'warn', r.kind + ' đang bị khóa bằng công tắc vật lý/phím tắt.', 'Gạt công tắc Wi-Fi hoặc bấm phím Fn có biểu tượng ăng-ten (máy bay).');
    else if (/wireless|wlan|wi-?fi/i.test(r.kind) && r.soft) add('rfkill-' + r.name, 'Wi-Fi đang tắt', 'warn', r.kind + ' đang tắt bằng phần mềm.', 'Gõ: rfkill unblock wifi');
  }

  // Firmware thiếu
  const byPkg = {};
  for (const fw of f.missingFirmware || []) (byPkg[pkgForFirmware(fw)] = byPkg[pkgForFirmware(fw)] || []).push(fw);
  for (const [pkg, files] of Object.entries(byPkg)) {
    const has = f.pkgs && f.pkgs[pkg];
    const sample = files.slice(0, 2).join(', ') + (files.length > 2 ? ' (+' + (files.length - 2) + ')' : '');
    if (has) add('fw-' + pkg, 'Firmware ' + pkg, 'warn', 'Nhân hệ điều hành đòi tệp ' + sample + ' mà gói ' + pkg + ' (đã cài) chưa có — phần cứng quá mới so với bản này.', 'Cập nhật hệ điều hành (/capnhat co) để lấy firmware mới; nếu vẫn thiếu, báo kỹ thuật viên kèm tên tệp trên.');
    else add('fw-' + pkg, 'Firmware ' + pkg, 'warn', 'Thiếu tệp ' + sample + '; một số chức năng phần cứng có thể không chạy.', 'Gõ: sudo apt install ' + pkg + ' rồi khởi động lại.');
  }

  // Đồ họa
  const gpus = (f.pci || []).filter((d) => ['0300', '0302', '0380'].includes(d.classCode));
  if (!gpus.length && !virt && f.tools.lspci !== false) add('gpu', 'Đồ họa', 'info', 'Không thấy card đồ họa trên PCI (máy không màn hình hoặc đồ họa tích hợp lạ).', 'AgentOS vẫn chạy được vì dùng màn hình ảo cho AI.');
  for (const g of gpus) {
    const isVirt = VIRT_GPU.test(g.name);
    if (!g.driver && !isVirt) add('gpu-' + g.slot, 'Đồ họa', 'warn', g.name + ' [' + g.vendor + ':' + g.device + '] chưa có driver, đang chạy đồ họa cơ bản (chậm, độ phân giải thấp).', 'AI và Telegram vẫn dùng được (màn hình ảo). Muốn dùng màn hình thật mượt: chạy cập nhật (/capnhat co) hoặc báo kỹ thuật viên mã [' + g.vendor + ':' + g.device + '].');
    else if (FW_BAD_DRIVERS.test(g.driver) && !isVirt) add('gpu-' + g.slot, 'Đồ họa', 'warn', g.name + ' đang dùng driver cơ bản (' + g.driver + ').', 'Dùng được cho việc văn phòng; không tăng tốc phần cứng.');
    else add('gpu-' + g.slot, 'Đồ họa', 'ok', g.name + (g.driver ? ' · driver ' + g.driver : ''));
  }
  if (!virt) add('display', 'Màn hình', 'info', f.displays ? f.displays + ' màn hình đang cắm' : 'Không cắm màn hình.', f.displays ? '' : 'Bình thường nếu dùng như máy chủ (điều khiển qua Telegram/RustDesk). Cắm màn hình khi cần xem trực tiếp.');

  const rank = { fail: 3, warn: 2, info: 1, ok: 0 };
  const worst = items.reduce((m, i) => Math.max(m, rank[i.status]), 0);
  const verdict = worst >= 3 ? 'fail' : worst === 2 ? 'warn' : 'ok';
  return { verdict, items, counts: { fail: items.filter((i) => i.status === 'fail').length, warn: items.filter((i) => i.status === 'warn').length }, facts: { arch: f.arch, ramMb: f.ramMb, cores: f.cores, uefi: f.uefi, virt: virt } };
}

function format(rep, title) {
  const head = (title || '🖥 Kiểm tra phần cứng') + ': ' + (rep.verdict === 'fail' ? rep.counts.fail + ' vấn đề NẶNG — máy này có thể không chạy đủ' : rep.verdict === 'warn' ? 'chạy được, ' + rep.counts.warn + ' lưu ý' : 'phù hợp');
  return head + '\n' + rep.items.map((i) => ICON[i.status] + ' ' + i.name + (i.detail ? ' — ' + i.detail : '') + (i.fix && i.status !== 'ok' ? '\n   → ' + i.fix : '')).join('\n');
}

// Dùng cho tự chẩn đoán (có nhớ tạm 10 phút vì phần cứng ít đổi)
function createHwCheck(o) {
  o = o || {};
  let cache = null, at = 0;
  const now = o.now || Date.now;
  async function report(force) {
    if (!force && cache && now() - at < 10 * 60 * 1000) return cache;
    cache = evaluate(await collect(o)); at = now();
    if (o.save) { try { o.save(cache); } catch (e) { /* bỏ qua */ } }
    return cache;
  }
  return { report, format, last: () => cache };
}

module.exports = { collect, evaluate, format, createHwCheck, parseLspci, parseLsblk, parseRfkill, parseFirmware, pkgForFirmware };
