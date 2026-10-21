# AgentOS — hướng dẫn thử cho người test

AgentOS là hệ điều hành (Debian 13) cài cho mini PC: bạn nhắn việc cho máy bằng Telegram, AI (Claude / Codex / Gemini / DeepSeek qua tài khoản hoặc khóa API của chính bạn) làm giúp. Đây là **bản thử**, có thể còn lỗi — mọi lỗi/ảnh chụp màn hình gửi lại cho người gửi bạn tệp này.

## Cần chuẩn bị
- 1 USB từ 8 GB (**sẽ bị xóa sạch**) và phần mềm ghi USB: Rufus (Windows) hoặc balenaEtcher.
- Máy thử: mini PC / PC hỗ trợ UEFI. **Cài thử vào máy ảo (VirtualBox, bật EFI) an toàn hơn.** Nếu cài vào máy thật, tính năng "Xóa đĩa" sẽ xóa toàn bộ ổ cài đặt.
- Mạng Internet. Một bot Telegram (tạo ở @BotFather, lấy token) và ít nhất một AI: tài khoản Claude/Codex/Gemini hoặc khóa API.

## Các bước
1. Giải nén tệp .zip nhận được ra tệp `.iso`. Kiểm tra SHA256 (nếu người gửi có đưa).
2. Ghi tệp `.iso` ra USB bằng Rufus (chọn "DD Image" nếu hỏi) hoặc balenaEtcher.
3. Cắm USB vào máy thử, bật máy, bấm phím chọn thiết bị khởi động (F7/F11/F12/Esc), chọn USB **dạng UEFI**.
4. Ở menu chọn **Live system (amd64)**. Đợi vào màn hình nền.
5. Bấm biểu tượng **Install AgentOS** → làm theo trình cài đặt (chọn xóa đĩa, đặt tên và mật khẩu).
6. Khởi động lại, rút USB. Máy tự mở **trình hướng dẫn lần đầu** (Wi-Fi → Telegram → đăng nhập AI → hoàn tất).
   - Nếu màn hình **trắng trơn**: bấm Ctrl+Alt+F3, đăng nhập, chạy `sudo agentos-update apply` rồi `sudo reboot` (cần mạng). Không được thì báo lại.
7. Xong, nhắn bot trên Telegram: `/help` để xem lệnh.

## Nên thử
- Nhắn một câu hỏi bình thường, `/trangthai`, `/manhinh` (chụp màn hình máy).
- Gửi **tin nhắn thoại** ("chụp màn hình").
- Biểu tượng **Khóa API (AI)** trên màn hình nền: thêm khóa của một hãng.
- `/capnhat` (xem phiên bản và bản cập nhật mới, không cần cài lại).
- `/baocao`, `/hen 08:00 <việc>`.

## Lưu ý an toàn
- Mặc định bot ở chế độ **bảo vệ** (hỏi trước khi ghi tệp/chạy lệnh). Chỉ bật `/toanquyen` khi hiểu rõ: AI sẽ tự làm không hỏi và có quyền quản trị.
- Đừng dán khóa/mật khẩu vào nơi công khai; nếu lỡ lộ, thu hồi ở trang của hãng.
