# Kế hoạch AgentOS (đã chốt 19/10/2026)

Quyết định của chủ dự án:
1. Bán mini PC cài sẵn (phần cứng cố định, ít rủi ro driver/Secure Boot).
2. Nền Debian 13 (trixie) + live-build + Calamares.
3. Thử trên máy ảo trước.

## Nguyên tắc
- Mỗi người dùng tài khoản của chính họ, đăng nhập bằng CLI chính thức (Claude Code, Codex). Hệ thống KHÔNG đọc/lưu/chuyển token.
- Không xoay nhiều tài khoản cùng hãng. Chỉ chuyển giữa các dịch vụ khác nhau người dùng đều có; dự phòng bằng API key của họ.
- Việc không đảo ngược được phải duyệt qua Telegram. Chỉ nhận lệnh từ ID Telegram đã đăng ký.

## Giai đoạn
| GĐ | Việc | Xong khi |
|---|---|---|
| 0 | Kết luận điều khoản (docs/gd0-phap-ly.md); chốt mẫu mini PC | Có văn bản kết luận; chọn 1–2 mẫu máy |
| 1 | Bộ điều phối: bot Telegram -> `claude -p` -> trả kết quả; SQLite lưu việc | 5 việc mẫu chạy đúng |
| 2 | Thêm Codex; phát hiện hết hạn mức; chuyển động cơ; hàng đợi chờ reset | Mô phỏng hết hạn mức: tự chuyển/tự chạy lại |
| 3 | Công cụ: MCP, Playwright, màn hình ảo, computer use | 10 quy trình thật không cần người ngồi cạnh |
| 4 | An toàn: cổng duyệt, phân quyền, chống prompt injection, sandbox | Qua bài kiểm tra tấn công |
| 5 | Độ bền: systemd, watchdog, chống ngủ, tự phục hồi | 7 ngày liên tục không treo |
| 6a | Pipeline ISO (live-build) chạy được trong CI, boot trên VM | ISO boot, vào bảng điều khiển |
| 6b | Calamares, mã hóa ổ đĩa, trình hướng dẫn lần đầu, chế độ kiosk | Người ngoài cài xong < 30 phút |
| 6c | Kho apt riêng + ký GPG + unattended-upgrades + snapshot (btrfs/snapper) + tự lùi | Cố ý phát bản lỗi, máy tự lùi |
| 6d | Cài sẵn lên mini PC chọn; quy trình nhân bản máy hàng loạt | Cài 5 máy giống nhau |
| 6e | Kênh beta/stable, trang tải ISO, tài liệu khôi phục | Quy trình phát hành lặp lại được |
| 7 | Thử kín 5–10 người dùng | Việc thành công >= 85%, không sự cố an toàn |

## Việc làm trước tiên (tuần này)
1. GĐ 0 pháp lý (làm tay, không code).
2. Cài VirtualBox trên Windows để thử ISO (xem docs/thu-tren-may-ao.md).
3. Đẩy thư mục này lên GitHub để CI build ISO lần đầu.
