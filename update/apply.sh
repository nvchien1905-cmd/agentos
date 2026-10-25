#!/bin/bash
# Chạy bằng root sau khi tệp của bản cập nhật đã được ghi (nằm trong phần được ký).
# Bản này: bộ gõ tiếng Việt, giải nén tệp, ứng dụng Claude/ChatGPT trên màn hình chính.
set -e
chmod 755 /usr/local/sbin/agentos-desktop-setup
/usr/local/sbin/agentos-desktop-setup
# Cài đặt AgentOS (agentos-settings) không nằm trong danh sách dịch vụ mà trình cập nhật tự khởi động lại: tự khởi động lại sau vài giây
# (trì hoãn để không cắt ngang chính phiên cập nhật nếu được bấm từ cửa sổ Cài đặt) để mã mới có hiệu lực, không còn trang mới + máy chủ cũ.
systemd-run --on-active=6 --unit=agentos-settings-restart-$(date +%s) systemctl restart agentos-settings.service >/dev/null 2>&1 || true
