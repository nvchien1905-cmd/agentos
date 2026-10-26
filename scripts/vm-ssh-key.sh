#!/bin/bash
# CHỈ DÙNG CHO MÁY ẢO THỬ NGHIỆM (không phải mini PC của khách): bật ssh và thêm khóa công khai của máy phát triển để Claude điều khiển máy ảo.
# Gõ trong máy ảo (không dùng chữ số trong lệnh vì VBoxManage làm rơi chữ số): curl -sL <đường dẫn raw của tệp này> -o k.sh; bash k.sh
set -e
mkdir -p ~/.ssh; chmod 700 ~/.ssh
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINq9NZL2GdSkNJtg7tpJz82gJjSx7Xu6OUbLvMnVgCn+ vmtest' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys
sudo systemctl enable --now ssh >/dev/null 2>&1 || sudo systemctl start ssh
echo "da them khoa ssh"; id -un
