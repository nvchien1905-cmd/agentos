# Kiểm tra phần cứng (`/phancung`, `agentos-hwcheck`)

Mục đích: máy lạ thì **báo rõ phần nào, vì sao, làm gì** thay vì để người dùng gặp lỗi khó hiểu. Chỉ ĐỌC, không sửa gì máy.

## Chạy ở đâu
| Nơi | Cách |
|---|---|
| Phiên USB cài (trước khi cài) | menu ứng dụng "Kiểm tra máy có hợp không", hoặc `agentos-hwcheck` |
| Máy đã cài | Telegram `/phancung` (hoặc nút "Phần cứng" ở `/menu`); `agentos-hwcheck` ở dòng lệnh |
| Tự động | `/tuchan` và chẩn đoán định kỳ có mục "Phần cứng" (nhớ 10 phút); kết quả ghi `data/hw-report.json` |

Mã thoát của `agentos-hwcheck`: `0` = phù hợp hoặc chỉ lưu ý, `2` = có vấn đề NẶNG.

## Những gì được kiểm
| Mục | NẶNG (❌) | Lưu ý (⚠️) |
|---|---|---|
| CPU | không phải x86_64 (ARM, Raspberry Pi) | chỉ 1 nhân |
| RAM | < 2 GB | < 4 GB |
| Ổ đĩa | không thấy ổ để cài (RAID/Intel RST/VMD → đổi AHCI), < 20 GB | < 40 GB, hoặc HDD quay (máy thật) |
| Kiểu khởi động | BIOS cũ (Legacy/CSM) **khi đang ở phiên USB cài** — bản cài chuẩn bị cho UEFI nên cài xong sẽ không khởi động | BIOS cũ khi máy đã chạy |
| Card mạng/Wi-Fi | card PCI **không có driver** (nêu mã `[hãng:thiết bị]` để báo kỹ thuật viên); không có cổng mạng nào | Wi-Fi bị công tắc/rfkill chặn |
| Firmware | — | nhân đòi tệp firmware mà chưa có gói (kèm lệnh `apt install`), hoặc gói đã có mà vẫn thiếu (phần cứng quá mới → cập nhật) |
| Đồ họa | — | card không driver / chỉ driver cơ bản (AI vẫn chạy được vì dùng màn hình ảo) |
| Màn hình | — | (chỉ ghi chú: máy không màn hình là bình thường) |

Máy ảo: bỏ qua cảnh báo "HDD quay" và "không có màn hình" (ổ ảo luôn báo quay).

## Đã thử thật (máy ảo VirtualBox, 08/11/2026)
Chạy trên bản sao của máy ảo AgentOS-Test ở nhiều cấu hình; kết quả xem phần "Kết quả thử" trong `docs/an-toan.md` (bản 2026.11.08.5).

## CHƯA thử được (cần máy thật / ISO)
- **Khởi động BIOS cũ trong phiên USB cài** (cần ISO mới build; logic đã có test với dữ kiện giả: báo NẶNG).
- Card Wi-Fi/mạng thật không có driver (Realtek RTL8852BE, MediaTek MT7922...): logic phân tích `lspci -nnk` đã test với bản in mẫu, chưa thử trên máy có card đó.
- Nhận diện công tắc Wi-Fi cứng (`rfkill`) trên laptop thật.
- GPU NVIDIA/AMD đời mới (driver nouveau/amdgpu cần firmware).

## Thêm hỗ trợ cho phần cứng mới
1. Chạy `agentos-hwcheck --json` trên máy đó, gửi kết quả.
2. Thiếu driver → thêm gói vào `iso/config/package-lists/agentos.list.chroot` (hoặc ánh xạ firmware trong `FW_PKG` của `orchestrator/src/hwcheck.js`).
3. Thêm một ca thử vào `orchestrator/test/hwcheck.test.js` (dán bản in `lspci -nnk` của máy).
