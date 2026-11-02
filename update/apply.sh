#!/bin/bash
# Chạy bằng root sau khi tệp của bản cập nhật đã được ghi (nằm trong phần được ký).
# Bản này: bộ gõ tiếng Việt, giải nén tệp, ứng dụng Claude/ChatGPT trên màn hình chính.
set -e
# Dọn tệp của tính năng đã gỡ (bản cập nhật chỉ thêm/ghi đè tệp, không tự xóa): khóa vân tay đã bỏ ở 2026.10.28.21.
rm -f /opt/agentos/orchestrator/src/unlock.js
chmod 755 /usr/local/sbin/agentos-desktop-setup
/usr/local/sbin/agentos-desktop-setup
# Nạp lại định nghĩa dịch vụ: gói cập nhật có thể đổi file .service (VD bỏ RestrictSUIDSGID để hộp cô lập AI hoạt động); trình cập nhật khởi động lại bộ điều phối SAU bước này.
systemctl daemon-reload >/dev/null 2>&1 || true
# Cài đặt AgentOS và trình hướng dẫn lần đầu (nếu đang chạy) không nằm trong danh sách dịch vụ mà trình cập nhật tự khởi động lại, nên cứ chạy mã cũ tới khi khởi động lại máy.
# (agentos-deskd: trợ lý màn hình của root có danh sách ứng dụng mới sau mỗi bản cập nhật, ví dụ fbbot cho trợ lý Facebook.)
# Khởi động lại sau vài giây (trì hoãn để không cắt ngang chính phiên cập nhật nếu được bấm từ cửa sổ Cài đặt).
for u in agentos-settings agentos-wizard agentos-deskd; do
  systemctl is-active --quiet $u.service && systemd-run --on-active=6 --unit=$u-restart-$(date +%s) systemctl restart $u.service >/dev/null 2>&1 || true
done
