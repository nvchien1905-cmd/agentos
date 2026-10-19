#!/bin/bash
# CHI DE THU TREN MAY AO: bat SSH va nhan khoa thu (khoa vo danh sinh rieng cho may ao, khong dung o dau khac).
#   setxkbmap us; curl -sL https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/scripts/thu-ssh.sh -o s.sh; bash s.sh
mkdir -p ~/.ssh; chmod 700 ~/.ssh
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINq9NZL2GdSkNJtg7tpJz82gJjSx7Xu6OUbLvMnVgCn+ vmtest' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
echo agentostestpw | sudo -S systemctl start ssh
echo "SSH da bat"
