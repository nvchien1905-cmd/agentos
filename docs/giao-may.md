# Danh sách việc trước khi giao máy cho khách

Làm theo thứ tự. Mục 1 là việc DUY NHẤT không thể tự động hóa bằng phần mềm.

## 1. BIOS/UEFI (làm một lần trên từng máy, trước khi cài)
- **AC Power Recovery / Restore on AC Power Loss / After Power Failure → `Power On`.** Thiếu mục này thì mất điện xong máy nằm im, bot ngừng trả lời cho tới khi có người ra bấm nút nguồn. Tên mục khác nhau theo hãng (thường nằm ở Advanced → Power, hoặc Boot).
- Secure Boot: để bật được (ISO dùng shim đã ký) hoặc tắt nếu máy khó tính.
- Wake on LAN: bật nếu muốn đánh thức máy từ xa trong mạng nhà.

## 2. Sau khi cài xong (khách hoặc kỹ thuật viên)
| Việc | Cách làm |
|---|---|
| Đăng nhập AI | trình hướng dẫn lần đầu (điện thoại) → Claude / Codex / Gemini |
| OneDrive | Telegram: `/onedrive ketnoi` |
| Tailscale (đường vào dự phòng) | Telegram: `/tailscale ketnoi` rồi đăng nhập |
| KiotViet (doanh số, tồn) | `sudo bash dat-khoa-kiotviet.sh` (3 giá trị) |
| Báo cáo hằng ngày | mặc định 21:30; đổi bằng `/baocao gio 20:00`, tắt bằng `/baocao tat` |
| Máy in | trình duyệt trên máy → http://localhost:631 → Administration → Add Printer (một lần) |

## 3. Nhắc cho khách
- Mất điện/khởi động lại: bot nhắn "AgentOS đã khởi động" trong khoảng 2 phút.
- Sao lưu: mỗi ngày 02:30 lên OneDrive (`AgentOS/sao-luu`). **Bản sao lưu không chứa mật khẩu/token**; cài lại máy phải đăng nhập lại.
- Tin nhắn thoại: hiểu nhanh các cụm "doanh số hôm nay", "tồn kho …", "chụp màn hình", "khóa máy", "báo cáo"; câu khác giao cho AI. Lần dùng đầu máy tải mô hình nhận dạng (~500MB, cần mạng, mất vài phút).
- Lệnh nguy hiểm (`/tatmay`, `/khoimay`, `/toanquyen`) chỉ làm được khi gõ chữ.
