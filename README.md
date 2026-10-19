# AgentOS

Bản Linux (Debian 13 + Calamares) bán kèm mini PC. Người dùng cắm máy, đăng nhập tài khoản AI của chính họ,
treo máy và nhắn Telegram để AI làm việc. Cập nhật tự động, tự quay lui nếu bản mới lỗi.

> Thư mục này nằm tạm trong dự án Mở Quà để dễ mở. Khi muốn tách riêng: chép cả thư mục `agentos/` sang chỗ khác
> và `git init` ở đó. Nó không dùng chung mã với Mở Quà.

## Cấu trúc
```
agentos/
  docs/ke-hoach.md              kế hoạch các giai đoạn
  docs/gd0-phap-ly.md           danh sách việc phải kết luận về điều khoản TRƯỚC khi nhúng CLI vào máy bán
  docs/thu-tren-may-ao.md       cách build ISO và thử trên VirtualBox
  iso/                          cấu hình live-build (ISO cài bằng USB)
  .github/workflows/build-iso.yml   build ISO trên máy chủ Linux (GitHub Actions)
  orchestrator/                 bộ điều phối: bot Telegram, hàng đợi, Claude + Codex, chuyển engine khi hết hạn mức,
                                bộ công cụ MCP (trình duyệt), gửi file về Telegram (GĐ 1-3)
```

## Trạng thái
- [x] Khung cấu hình ISO (chưa build thử lần nào — cần chạy trên Linux/CI)
- [ ] GĐ 0: kết luận điều khoản (docs/gd0-phap-ly.md)
- [x] GĐ 1: bộ điều phối (Telegram + claude -p + SQLite) — 28 test qua, đã chạy thật với claude
- [x] GĐ 2: engine Codex (chưa thử với Codex thật), chuyển engine khi hết hạn mức, chờ reset
- [x] GĐ 3: bộ công cụ MCP + Playwright (đã thử thật với Claude), hộp thư ra gửi file; dịch vụ Xvfb/systemd cho ISO viết nhưng chưa build
- [x] GĐ 4: cổng duyệt (hook PreToolUse) + chính sách + phân quyền + chống prompt injection — 48 test, thử thật với Claude; xem docs/an-toan.md. Chưa thử nút bấm Telegram thật
- [x] GĐ 5: độ bền — giết cả cây tiến trình, tự thử lại lỗi tạm thời, watchdog + heartbeat, khôi phục/sao lưu/dọn dữ liệu, chặn đầy ổ, thông báo khởi động, cô lập AI bằng bubblewrap, unit systemd/chống ngủ cho ISO; 67 test (1 bỏ qua trên Windows). Phần Linux/systemd/bwrap CHƯA chạy thử; xem docs/do-ben.md
- [ ] GĐ 3b: điều khiển ứng dụng đồ họa (xdotool/scrot) — cần Linux để làm và kiểm
- [ ] Calamares tùy biến (thương hiệu, mã hóa ổ đĩa)
- [ ] Kho gói apt riêng + cập nhật tự động + snapshot quay lui
