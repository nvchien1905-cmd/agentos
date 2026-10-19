#!/bin/bash
# Thu cau hinh Calamares moi (thuong hieu AgentOS, bo trang ban phim, packages.conf) trong phien LIVE ma khong can build lai ISO:
#   setxkbmap us; curl -sL https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/scripts/thu-calamares.sh -o t.sh; bash t.sh
# Roi chay: sudo calamares &>/dev/null &
set -e
R=https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main
S=/usr/share/agentos/calamares
sudo mkdir -p $S/modules $S/branding
for f in settings.conf modules/packages.conf branding/branding.desc branding/agentos-logo.svg branding/agentos-welcome.svg branding/show.qml; do
  sudo curl -sfL "$R/iso/config/includes.chroot/usr/share/agentos/calamares/$f" -o "$S/$f" || { echo "[LOI] khong tai duoc $f"; exit 1; }
done
curl -sfL "$R/iso/config/hooks/normal/0300-calamares.hook.chroot" -o /tmp/0300.sh || { echo "[LOI] khong tai duoc hook"; exit 1; }
sudo sh /tmp/0300.sh
echo "[ OK ] da ap dung cau hinh Calamares moi:"
ls /etc/calamares/branding
grep -n -E '^(branding|  - keyboard)' /etc/calamares/settings.conf || echo "(khong con trang ban phim)"
