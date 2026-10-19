# Build ISO và thử trên máy ảo

Máy dev hiện tại: Windows 10 Home, 16GB RAM, ~150GB trống, ảo hóa trong BIOS đã BẬT.
Windows 10 Home không có Hyper-V Manager -> dùng **VirtualBox**. Chưa cài WSL/VirtualBox.

## 1. Build ISO (cần Linux, không build trên Windows trực tiếp)
Cách đơn giản nhất: GitHub Actions.
1. Tạo repo GitHub (private) chứa thư mục `agentos/` làm gốc.
2. Tab Actions -> `build-iso` -> Run workflow (~20-40 phút lần đầu).
3. Tải artifact `agentos-iso` (file `.iso`).
Lần build đầu CHƯA từng chạy thử: có thể phải sửa lỗi gói/cấu hình theo log.

Cách khác: WSL2 + Debian -> `sudo apt install live-build` -> `cd iso && sudo lb config && sudo lb build`
(build trong ổ ảo của WSL, không build trong thư mục OneDrive).

## 2. Thử bằng VirtualBox
1. Cài VirtualBox (bản chính thức từ virtualbox.org).
2. Máy ảo mới: Linux / Debian 64-bit, RAM 4GB, 2-4 CPU, đĩa 40GB, **bật EFI** (Settings -> System -> Enable EFI).
3. Gắn ISO vào ổ CD, khởi động -> thấy màn hình live -> chạy Calamares cài vào đĩa ảo.
4. Khởi động lại từ đĩa ảo, kiểm tra: mạng, `systemctl status agentos-firstboot`, không tự ngủ.

## Tạo máy ảo bằng script
`.\scripts\tao-may-ao.ps1 -Iso "C:\duong-dan\agentos.iso"` (VirtualBox đã cài). Tạo máy ảo `AgentOS-Test`, bật EFI, 4 GB RAM,
40 GB đĩa, mạng NAT, chuyển cổng 2222→22 để SSH từ Windows.

## Kiểm phần Linux sau khi cài vào đĩa ảo
```bash
id agentos && ls /opt/agentos/orchestrator && node -v && bwrap --version
systemctl is-enabled agentos-xvfb agentos-orchestrator
systemctl status agentos-xvfb --no-pager
sudo -u agentos bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid -- /bin/true && echo "bwrap OK"
systemctl cat agentos-orchestrator | head -30     # unit có Type=notify, WatchdogSec
sudo systemd-analyze verify /etc/systemd/system/agentos-orchestrator.service
cat /etc/systemd/logind.conf.d/10-agentos.conf; sysctl kernel.panic
```

## Tiêu chí 6a
ISO boot được trên VM (UEFI) và vào được môi trường live; cài xong boot lại được.
