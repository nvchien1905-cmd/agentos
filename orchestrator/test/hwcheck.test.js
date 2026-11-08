'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { collect, evaluate, format, createHwCheck, parseLspci, parseLsblk, parseRfkill, parseFirmware, pkgForFirmware } = require('../src/hwcheck');

const GB = 1e9;
const base = (over) => Object.assign({ arch: 'x64', cpuModel: 'Intel(R) N100', cores: 4, ramMb: 7900, uefi: true, live: false, virt: '', disks: [{ name: 'nvme0n1', size: 256 * GB, rota: false, type: 'disk', tran: 'nvme', model: 'Samsung', removable: false }], nics: [{ name: 'enp1s0', wifi: false, up: 'up', carrier: true }, { name: 'wlp2s0', wifi: true, up: 'down', carrier: false }], pci: [{ slot: '00:02.0', cls: 'VGA compatible controller', classCode: '0300', name: 'Intel UHD', vendor: '8086', device: '46d1', driver: 'i915' }], rfkill: [], missingFirmware: [], pkgs: {}, displays: 1, tools: { lsblk: true, lspci: true } }, over || {});
const ids = (rep, st) => rep.items.filter((i) => i.status === st).map((i) => i.id);

const LSPCI = `00:02.0 VGA compatible controller [0300]: Intel Corporation Alder Lake-N [UHD Graphics] [8086:46d1] (rev 0e)
\tSubsystem: Intel Corporation Device [8086:7270]
\tKernel driver in use: i915
\tKernel modules: i915
02:00.0 Ethernet controller [0200]: Realtek Semiconductor Co., Ltd. RTL8111/8168/8411 PCI Express Gigabit Ethernet Controller [10ec:8168] (rev 15)
\tKernel driver in use: r8169
03:00.0 Network controller [0280]: Realtek Semiconductor Co., Ltd. RTL8852BE PCIe 802.11ax Wireless Network Controller [10ec:b852]
\tKernel modules: rtw89_8852be
`;

test('parseLspci: lấy lớp thiết bị, mã hãng:thiết bị và driver đang dùng (không driver -> rỗng)', () => {
  const p = parseLspci(LSPCI);
  assert.strictEqual(p.length, 3);
  assert.deepStrictEqual([p[0].classCode, p[0].driver, p[0].vendor, p[0].device], ['0300', 'i915', '8086', '46d1']);
  assert.strictEqual(p[1].driver, 'r8169');
  assert.strictEqual(p[2].classCode, '0280'); assert.strictEqual(p[2].driver, '');
});

test('parseLsblk / parseRfkill / parseFirmware', () => {
  const d = parseLsblk('NAME="sda" SIZE="500107862016" ROTA="1" TYPE="disk" TRAN="sata" MODEL="WDC WD5000 " RM="0"\nNAME="sdb" SIZE="16000000000" ROTA="0" TYPE="disk" TRAN="usb" MODEL="USB Flash" RM="1"');
  assert.strictEqual(d.length, 2); assert.strictEqual(d[0].rota, true); assert.strictEqual(d[0].model, 'WDC WD5000'); assert.strictEqual(d[1].removable, true);
  const r = parseRfkill('0: phy0: Wireless LAN\n\tSoft blocked: no\n\tHard blocked: yes\n1: hci0: Bluetooth\n\tSoft blocked: yes\n\tHard blocked: no\n');
  assert.deepStrictEqual(r.map((x) => [x.kind, x.soft, x.hard]), [['Wireless LAN', false, true], ['Bluetooth', true, false]]);
  const f = parseFirmware('kernel: iwlwifi 0000:00:14.3: Direct firmware load for iwlwifi-so-a0-gf-a0-83.ucode failed with error -2\nkernel: cfg80211: Loading compiled-in X.509 certificates for regulatory database\nkernel: platform regulatory.0: Direct firmware load for regulatory.db failed with error -2\nkernel: rtw89_8852be 0000:03:00.0: firmware: failed to load rtw89/rtw8852b_fw-1.bin (-2)\nkernel: amdgpu: Failed to load firmware amdgpu/navi10_mes.bin\n');
  assert.deepStrictEqual(f, ['iwlwifi-so-a0-gf-a0-83.ucode', 'rtw89/rtw8852b_fw-1.bin', 'amdgpu/navi10_mes.bin']);       // bỏ regulatory.db
  assert.strictEqual(pkgForFirmware('iwlwifi-so-a0.ucode'), 'firmware-iwlwifi');
  assert.strictEqual(pkgForFirmware('rtw89/x.bin'), 'firmware-realtek');
  assert.strictEqual(pkgForFirmware('mediatek/mt7921.bin'), 'firmware-mediatek');
  assert.strictEqual(pkgForFirmware('lạ/lạ.bin'), 'firmware-linux-nonfree');
});

test('mini PC bình thường: phù hợp, không lưu ý nào', () => {
  const rep = evaluate(base());
  assert.strictEqual(rep.verdict, 'ok');
  assert.deepStrictEqual(ids(rep, 'fail').concat(ids(rep, 'warn')), []);
  assert.match(format(rep), /phù hợp/);
});

test('BIOS cũ: phiên USB cài -> NẶNG (cài xong không khởi động); máy đang chạy -> chỉ lưu ý', () => {
  assert.deepStrictEqual(ids(evaluate(base({ uefi: false, live: true })), 'fail'), ['boot']);
  const run = evaluate(base({ uefi: false, live: false }));
  assert.deepStrictEqual(ids(run, 'fail'), []); assert.deepStrictEqual(ids(run, 'warn'), ['boot']);
});

test('máy yếu: RAM 1.5GB, ổ 16GB, 1 nhân -> NẶNG kèm cách xử lý; RAM 3GB/ổ HDD -> lưu ý', () => {
  const bad = evaluate(base({ ramMb: 1500, cores: 1, disks: [{ name: 'sda', size: 16 * GB, rota: false, type: 'disk', tran: 'sata', model: '', removable: false }] }));
  assert.strictEqual(bad.verdict, 'fail'); assert.deepStrictEqual(ids(bad, 'fail').sort(), ['disk', 'ram']); assert.ok(ids(bad, 'warn').includes('arch'));
  assert.match(bad.items.find((i) => i.id === 'ram').fix, /RAM/);
  const meh = evaluate(base({ ramMb: 3000, disks: [{ name: 'sda', size: 500 * GB, rota: true, type: 'disk', tran: 'sata', model: 'WDC', removable: false }] }));
  assert.strictEqual(meh.verdict, 'warn'); assert.deepStrictEqual(ids(meh, 'warn').sort(), ['disk', 'ram']);
  assert.match(meh.items.find((i) => i.id === 'disk').fix, /SSD/);
});

test('USB cài (RM=1) không bị tính là ổ để cài; không thấy ổ nào -> hướng dẫn đổi AHCI', () => {
  const usbOnly = evaluate(base({ disks: [{ name: 'sdb', size: 32 * GB, rota: false, type: 'disk', tran: 'usb', model: '', removable: true }] }));
  assert.deepStrictEqual(ids(usbOnly, 'fail'), ['disk']);
  assert.match(usbOnly.items.find((i) => i.id === 'disk').fix, /AHCI/);
  const noTool = evaluate(base({ disks: [], tools: { lsblk: false, lspci: true } }));
  assert.deepStrictEqual(ids(noTool, 'warn'), ['disk']);
});

test('CPU ARM -> NẶNG; không thấy cổng mạng nào -> NẶNG; chỉ không có Wi-Fi -> chỉ ghi chú', () => {
  assert.deepStrictEqual(ids(evaluate(base({ arch: 'arm64' })), 'fail'), ['arch']);
  assert.deepStrictEqual(ids(evaluate(base({ nics: [] })), 'fail'), ['net']);
  const noWifi = evaluate(base({ nics: [{ name: 'enp1s0', wifi: false, up: 'up', carrier: true }] }));
  assert.strictEqual(noWifi.verdict, 'ok'); assert.deepStrictEqual(ids(noWifi, 'info').includes('wifi'), true);
});

test('card Wi-Fi Realtek chưa có driver: NẶNG, nêu đúng mã [10ec:b852] và cách đi vòng bằng dây/USB Wi-Fi', () => {
  const f = base({ pci: parseLspci(LSPCI), nics: [{ name: 'enp2s0', wifi: false, up: 'up', carrier: true }] });
  const rep = evaluate(f);
  assert.strictEqual(rep.verdict, 'fail');
  const it = rep.items.find((i) => i.id.startsWith('net-driver-'));
  assert.match(it.detail, /10ec:b852/); assert.match(it.fix, /Cắm dây|USB Wi-Fi/);
  assert.deepStrictEqual(ids(rep, 'info').includes('wifi'), false);                      // không nói "máy không có Wi-Fi" vì có card nhưng thiếu driver
});

test('firmware thiếu: gói chưa cài -> lệnh apt install; gói đã cài mà vẫn thiếu -> phần cứng quá mới, cập nhật', () => {
  const missing = evaluate(base({ missingFirmware: ['iwlwifi-so-a0.ucode', 'rtw89/x.bin'], pkgs: { 'firmware-iwlwifi': false, 'firmware-realtek': true } }));
  const a = missing.items.find((i) => i.id === 'fw-firmware-iwlwifi'), b = missing.items.find((i) => i.id === 'fw-firmware-realtek');
  assert.match(a.fix, /apt install firmware-iwlwifi/); assert.strictEqual(a.status, 'warn');
  assert.match(b.detail, /quá mới/); assert.match(b.fix, /capnhat/);
});

test('Wi-Fi bị khóa công tắc / tắt mềm: nói đúng cách mở', () => {
  const hard = evaluate(base({ rfkill: [{ name: 'phy0', kind: 'Wireless LAN', soft: false, hard: true }] }));
  assert.match(hard.items.find((i) => i.id === 'rfkill-phy0').fix, /công tắc|Fn/);
  const soft = evaluate(base({ rfkill: [{ name: 'phy0', kind: 'Wireless LAN', soft: true, hard: false }] }));
  assert.match(soft.items.find((i) => i.id === 'rfkill-phy0').fix, /rfkill unblock/);
  const bt = evaluate(base({ rfkill: [{ name: 'hci0', kind: 'Bluetooth', soft: true, hard: false }] }));
  assert.strictEqual(bt.verdict, 'ok');                                                  // Bluetooth tắt không phải vấn đề
});

test('đồ họa: không driver / driver cơ bản -> lưu ý (không nặng, vì AI dùng màn hình ảo); card ảo không bị cảnh báo', () => {
  const nodrv = evaluate(base({ pci: [{ slot: '00:02.0', cls: 'VGA', classCode: '0300', name: 'NVIDIA GeForce', vendor: '10de', device: '2504', driver: '' }] }));
  assert.deepStrictEqual(ids(nodrv, 'warn'), ['gpu-00:02.0']); assert.strictEqual(nodrv.verdict, 'warn');
  const simple = evaluate(base({ pci: [{ slot: '00:02.0', cls: 'VGA', classCode: '0300', name: 'AMD', vendor: '1002', device: '1', driver: 'simpledrm' }] }));
  assert.deepStrictEqual(ids(simple, 'warn'), ['gpu-00:02.0']);
  const vm = evaluate(base({ virt: 'kvm', pci: [{ slot: '00:02.0', cls: 'VGA', classCode: '0300', name: 'Red Hat QXL', vendor: '1b36', device: '100', driver: '' }], displays: 0 }));
  assert.strictEqual(vm.verdict, 'ok');
  const none = evaluate(base({ pci: [], displays: 0 }));
  assert.strictEqual(none.verdict, 'ok'); assert.ok(ids(none, 'info').includes('display'));        // máy không màn hình là bình thường
});

test('collect() ghép dữ kiện từ lệnh + /sys giả; lệnh thiếu hoặc lỗi không làm sập', async () => {
  const files = {
    '/proc/cmdline': 'BOOT_IMAGE=/live/vmlinuz boot=live quiet',
    '/sys/class/net/enp1s0/operstate': 'up\n', '/sys/class/net/enp1s0/carrier': '1\n',
    '/sys/class/net/wlp2s0/operstate': 'down\n', '/sys/class/net/wlp2s0/carrier': '0\n',
    '/sys/class/drm/card0-HDMI-A-1/status': 'connected\n', '/sys/class/drm/card0-DP-1/status': 'disconnected\n',
  };
  const dirs = { '/sys/class/net': ['lo', 'enp1s0', 'wlp2s0', 'docker0', 'tailscale0'], '/sys/class/drm': ['card0', 'card0-HDMI-A-1', 'card0-DP-1'] };
  const present = new Set(['/sys/class/net/enp1s0/device', '/sys/class/net/wlp2s0/device', '/sys/class/net/wlp2s0/wireless', '/run/live']);
  const fsx = { exists: (p) => present.has(p), read: (p) => files[p] || '', readdir: (p) => dirs[p] || [] };
  const calls = [];
  const run = async (bin, args) => {
    calls.push(bin);
    if (bin === 'systemd-detect-virt') return { code: 1, out: 'none', missing: false };
    if (bin === 'lsblk') return { code: 0, out: 'NAME="sda" SIZE="256060514304" ROTA="0" TYPE="disk" TRAN="sata" MODEL="SSD" RM="0"\nNAME="loop0" SIZE="1000" ROTA="0" TYPE="loop" TRAN="" MODEL="" RM="0"' };
    if (bin === 'lspci') return { code: 0, out: LSPCI };
    if (bin === 'rfkill') return { code: 127, out: '', missing: true };
    if (bin === 'journalctl') return { code: 0, out: 'kernel: rtw89_8852be: firmware: failed to load rtw89/rtw8852b_fw-1.bin (-2)' };
    if (bin === 'dpkg-query') return { code: 1, out: '' };
    return { code: 1, out: '' };
  };
  const f = await collect({ run, fs: fsx, arch: 'x64', totalmem: 8 * 1024 * 1048576, cpus: () => [{ model: 'Intel N100' }, { model: 'Intel N100' }] });
  assert.strictEqual(f.live, true); assert.strictEqual(f.uefi, false); assert.strictEqual(f.ramMb, 8192); assert.strictEqual(f.cores, 2);
  assert.deepStrictEqual(f.nics.map((n) => [n.name, n.wifi, n.carrier]), [['enp1s0', false, true], ['wlp2s0', true, false]]);   // bỏ lo/docker/tailscale (không có /device)
  assert.strictEqual(f.displays, 1); assert.strictEqual(f.disks.length, 1);
  assert.deepStrictEqual(f.missingFirmware, ['rtw89/rtw8852b_fw-1.bin']); assert.strictEqual(f.pkgs['firmware-realtek'], false);
  const rep = evaluate(f);
  assert.strictEqual(rep.verdict, 'fail');                                               // phiên USB + BIOS cũ + card Wi-Fi thiếu driver
  assert.ok(ids(rep, 'fail').includes('boot'));
});

test('collect() chịu được mọi lệnh đều vắng mặt (máy tối giản)', async () => {
  const run = async () => ({ code: 127, out: '', missing: true });
  const fsx = { exists: () => false, read: () => '', readdir: () => [] };
  const rep = evaluate(await collect({ run, fs: fsx, arch: 'x64', totalmem: 4 * 1024 * 1048576, cpus: () => [{ model: 'x' }, { model: 'x' }] }));
  assert.ok(rep.items.length >= 3);                                                      // vẫn có báo cáo, không ném lỗi
  assert.ok(ids(rep, 'fail').includes('net'));
});

test('createHwCheck: nhớ tạm 10 phút, force bỏ nhớ; ghi báo cáo ra tệp', async () => {
  let n = 0, t = 1000, saved = null;
  const run = async (bin) => { if (bin === 'lsblk') n++; return { code: 127, out: '', missing: true }; };
  const fsx = { exists: () => false, read: () => '', readdir: () => [] };
  const hw = createHwCheck({ run, fs: fsx, arch: 'x64', totalmem: 8e9, cpus: () => [{ model: 'x' }, { model: 'x' }], now: () => t, save: (r) => { saved = r; } });
  await hw.report(); await hw.report(); assert.strictEqual(n, 1);
  t += 11 * 60 * 1000; await hw.report(); assert.strictEqual(n, 2);
  await hw.report(true); assert.strictEqual(n, 3);
  assert.ok(saved && saved.items);
});
