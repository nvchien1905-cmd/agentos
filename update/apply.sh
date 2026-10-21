#!/bin/bash
# Chạy bằng root sau khi tệp của bản cập nhật đã được ghi (nằm trong phần được ký).
# Bản này: bộ gõ tiếng Việt, giải nén tệp, ứng dụng Claude/ChatGPT trên màn hình chính.
set -e
chmod 755 /usr/local/sbin/agentos-desktop-setup
/usr/local/sbin/agentos-desktop-setup
