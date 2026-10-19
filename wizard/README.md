# Trình hướng dẫn lần đầu (wizard)

Chạy ở lần đăng nhập đầu tiên sau khi cài AgentOS (không chạy ở bản live), hiện trong Chromium toàn màn hình tại `http://127.0.0.1:8088/`.
4 bước: **mạng** (Wi-Fi bằng nmcli, hoặc dây LAN) -> **Telegram** (dán token bot; nhắn bot một tin để máy tự lấy ID chủ) ->
**AI** (cài Claude Code / Codex từ npm chính thức cho người dùng `agentos`, mở cửa sổ để người dùng tự đăng nhập, kiểm tra bằng một câu hỏi ngắn) ->
**hoàn tất** (ghi `/etc/agentos/orchestrator.env` quyền 600, bật `agentos-orchestrator`, nhắn chủ máy qua Telegram, tự tắt và tự vô hiệu hóa).

## Cấu trúc
```
server.js          máy chủ HTTP 127.0.0.1 (root), các hành động, chống DNS rebinding + tiêu đề X-AgentOS-Wizard
lib/nm.js          nmcli: quét/nối Wi-Fi (tham số truyền mảng, không qua shell)
lib/telegram.js    getMe, chờ chủ máy nhắn tin (getUpdates), gửi tin xác nhận
lib/engines.js     cài/kiểm tra CLI bằng runuser -u agentos (không đọc/lưu token đăng nhập)
lib/envfile.js     dựng và ghi orchestrator.env
public/index.html  giao diện tiếng Việt (cũng dùng được trên điện thoại)
test/              8 test (nmcli, Telegram, envfile, engines, máy chủ đầy đủ luồng) - chạy: node --test test/*.test.js
```
ISO: `agentos-wizard.service` (điều kiện: không phải live và chưa có orchestrator.env) + `/etc/xdg/autostart/agentos-wizard.desktop`.
CI chép thư mục này vào `/opt/agentos/wizard`.

## Đã thử thật (19/10/2026, máy ảo VirtualBox, ISO cài từ GitHub Actions)
- Tự hiện toàn màn hình ở lần đăng nhập đầu, đọc đúng trạng thái mạng thật; token sai báo lỗi đúng.
- `scripts/thu-wizard-api.sh claude login`: cài Claude Code 2.1.303 bằng npm vào /var/lib/agentos/.local, kiểm tra báo "chưa đăng nhập", mở cửa sổ đăng nhập dưới người dùng agentos.
## Chưa thử
- Bước Telegram với token bot thật; đăng nhập Claude/Codex thật; Codex (`codex login`); Wi-Fi thật (VirtualBox không có Wi-Fi).
- Chạy hoàn tất (finish) trên máy thật: ghi env, bật dịch vụ, tin xác nhận.

## Ý tưởng tiếp theo: cài đặt bằng điện thoại
Máy phát Wi-Fi tạm (NetworkManager hotspot) + trang cài đặt tự mở trên điện thoại (captive portal), nhãn QR trên thân máy; token dán từ BotFather
ngay trên điện thoại; các bước sau đó làm trong chat Telegram (mã ghép đôi dùng một lần). Đợt 1 (qua mã QR/agentos.local trong cùng mạng) thử được trong máy ảo;
đợt 2 (phát Wi-Fi) cần mini PC có card Wi-Fi hỗ trợ chế độ AP.
