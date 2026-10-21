#!/bin/bash
# Kiem tra phan Linux cua ISO AgentOS. Chay TRONG may ao/may that da boot ISO (ban live hoac ban DA CAI):
#   curl -sL https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/scripts/kiem-tra-iso.sh -o k.sh; bash k.sh
# In moi muc mot dong [ OK ] / [LOI ] / [BO QUA]; chi doc he thong, chi ghi vao /tmp.
# Buoc can sudo: tu bo qua neu sudo doi mat khau (ban da cai); ban live khong doi.

ok()   { echo "[ OK ] $*"; }
bad()  { echo "[LOI ] $*"; FAIL=$((FAIL+1)); }
skip() { echo "[BO QUA] $*"; }
FAIL=0
chk() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
ORCH=/opt/agentos/orchestrator
if sudo -n true 2>/dev/null; then SUDO=1; else SUDO=0; fi

echo "--- he thong: $(hostname), nguoi dung $(id -un), $(. /etc/os-release; echo "$PRETTY_NAME")"
chk "nguoi dung agentos" id agentos
chk "node >= 20" bash -c 'node -e "process.exit(Number(process.versions.node.split(\".\")[0])>=20?0:1)"'
chk "bubblewrap co mat" bwrap --version
if [ $SUDO = 1 ]; then
  chk "bwrap chay duoc (nguoi dung agentos)" sudo -u agentos bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid --die-with-parent -- /bin/true
  chk "bwrap: /etc/agentos bi che" sudo -u agentos bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /etc/agentos --unshare-pid --die-with-parent -- /bin/true
else
  skip "bwrap chay duoc (can sudo khong mat khau)"
fi
chk "better-sqlite3 nap duoc" bash -c "cd $ORCH && node -e 'require(\"better-sqlite3\")'"
for u in agentos-xvfb agentos-orchestrator agentos-firstboot; do chk "unit $u da enable" systemctl is-enabled "$u"; done
chk "xvfb dang chay" systemctl is-active agentos-xvfb
chk "orchestrator chua chay (chua co /etc/agentos/orchestrator.env)" bash -c '! systemctl is-active --quiet agentos-orchestrator || test -f /etc/agentos/orchestrator.env'
chk "unit orchestrator hop le (systemd-analyze verify)" bash -c 'test -z "$(systemd-analyze verify /etc/systemd/system/agentos-orchestrator.service 2>&1)"'
chk "kernel.panic = 10" bash -c '[ "$(cat /proc/sys/kernel/panic)" = 10 ]'
chk "sleep.target bi mask (chong ngu)" bash -c '[ "$(systemctl is-enabled sleep.target 2>&1)" = masked ]'
chk "logind IdleAction=ignore" grep -q IdleAction=ignore /etc/systemd/logind.conf.d/10-agentos.conf
chk "journald co gioi han dung luong" grep -q SystemMaxUse /etc/systemd/journald.conf.d/10-agentos.conf
chk "Chromium co mat" which chromium
chk "Google Chrome co mat" test -x /usr/bin/google-chrome-stable
chk "tro ly man hinh (deskd) co mat va bat" bash -c 'test -f /opt/agentos/desk/server.js && test -x /usr/local/bin/agentos-desk && systemctl is-enabled --quiet agentos-deskd && command -v xclip scrot xdotool >/dev/null'
chk "OneDrive: goi onedrive + dich vu dong bo + thu muc /srv/onedrive (2775, nhom agentos) + cau hinh" bash -c 'command -v onedrive >/dev/null && systemctl is-enabled --quiet onedrive-agentos.path && [ "$(stat -c %a /srv/onedrive)" = 2775 ] && [ "$(stat -c %G /srv/onedrive)" = agentos ] && sudo -n grep -q "classify_as_big_delete" /var/lib/agentos/.config/onedrive/config && ! systemctl --global is-enabled --quiet onedrive.service'
chk "OneDrive: bieu tuong man hinh chinh + lien ket ~/OneDrive trong skel" bash -c 'test -x /etc/skel/Desktop/agentos-onedrive.desktop && [ "$(readlink /etc/skel/OneDrive)" = /srv/onedrive ]'
chk "tro ly man hinh dang chay va nghe o /run/agentos/desk.sock" bash -c 'systemctl is-active --quiet agentos-deskd && sudo -n test -S /run/agentos/desk.sock'
chk "RustDesk (dieu khien tu xa) co mat" test -x /usr/bin/rustdesk
chk "cong cu van phong cho AI: soffice pdftotext tesseract(vie) convert ffmpeg jq sqlite3" bash -c 'command -v soffice pdftotext tesseract convert ffmpeg jq sqlite3 >/dev/null && tesseract --list-langs 2>&1 | grep -qx vie'
chk "thu vien Python van phong (pandas openpyxl docx xlsxwriter odf reportlab)" python3 -c 'import pandas, openpyxl, docx, xlsxwriter, odf, reportlab'
chk "giong noi: venv faster-whisper + agentos-stt" bash -c 'test -x /usr/local/bin/agentos-stt && /opt/agentos/stt-venv/bin/python -c "import faster_whisper, av"'
chk "Tailscale: goi + dich vu bat + operator agentos" bash -c 'test -x /usr/bin/tailscale && systemctl is-enabled --quiet tailscaled && grep -q operator=agentos /etc/systemd/system/tailscaled.service.d/10-agentos-operator.conf'
chk "in an: CUPS bat, lp co mat, nguoi dung may thuoc lpadmin khi cai (users.conf)" bash -c 'command -v lp >/dev/null && systemctl is-enabled --quiet cups && { ! test -f /etc/calamares/modules/users.conf || grep -q "^    - lpadmin" /etc/calamares/modules/users.conf; }'
chk "cap nhat tu xa: agentos-update + khoa cong khai + VERSION + path unit bat" bash -c 'test -x /usr/local/bin/agentos-update && test -s /etc/agentos/update-pubkey.pem && test -s /opt/agentos/VERSION && test -f /opt/agentos/update/updater.js && systemctl is-enabled --quiet agentos-update.path'
chk "go tieng Viet (ibus-unikey) + giai nen (xarchiver, thunar-archive-plugin) + cau hinh dconf" bash -c 'dpkg -s ibus-unikey xarchiver thunar-archive-plugin >/dev/null 2>&1 && grep -q Unikey /etc/dconf/db/local.d/00-agentos-ibus && test -f /etc/xdg/autostart/agentos-ibus.desktop && ibus list-engine 2>/dev/null | grep -qi unikey || { ibus-daemon -drx >/dev/null 2>&1; sleep 3; ibus list-engine | grep -qi unikey; }'
chk "bieu tuong Claude (web) va ChatGPT tren man hinh chinh (skel)" bash -c 'test -x /etc/skel/Desktop/agentos-claudeweb.desktop && test -x /etc/skel/Desktop/agentos-chatgpt.desktop && grep -q chatgpt /usr/local/bin/agentos-app'
chk "Cai dat AgentOS (giao dien do hoa): dich vu bat, chi chu may (sudo) goi duoc, agentos bi tu choi" bash -c 'systemctl is-enabled --quiet agentos-settings && test -x /usr/local/bin/agentos-settings && curl -s -m 8 http://127.0.0.1:8089/api/overview | grep -q "\"version\"" && ! sudo -n -u agentos curl -s -m 8 http://127.0.0.1:8089/api/overview | grep -q "\"version\""'
chk "thanh cong cu: agentos-panel-setup + autostart + bieu tuong Cai dat (skel)" bash -c 'test -x /usr/local/bin/agentos-panel-setup && test -f /etc/xdg/autostart/agentos-panel-setup.desktop && test -x /etc/skel/Desktop/agentos-settings.desktop'
chk "sao luu hang ngay: timer 02:30 bat + script chay duoc" bash -c 'systemctl is-enabled --quiet agentos-sao-luu.timer && test -x /usr/local/bin/agentos-sao-luu && bash -n /usr/local/bin/agentos-sao-luu'
if [ $SUDO = 1 ]; then
  chk "sao luu thu: tao agentos-<ngay>.tar.gz co KHOI-PHUC.txt" bash -c 'T=$(mktemp -d); sudo ONEDRIVE_DIR=$T /usr/local/bin/agentos-sao-luu >/dev/null && f=$(ls $T/AgentOS/sao-luu/agentos-*.tar.gz) && tar tzf "$f" | grep -q KHOI-PHUC.txt; r=$?; sudo rm -rf $T; exit $r'
fi
chk "launcher Zalo/KiotViet/Claude/Codex co mat" bash -c 'test -x /usr/local/bin/agentos-app && test -x /usr/local/bin/agentos-ai && for f in agentos-zalo agentos-kiotviet agentos-deepseek agentos-claude agentos-codex agentos-gemini; do test -f /usr/share/applications/$f.desktop || exit 1; done'
chk "bieu tuong man hinh chinh (skel) co 7 ung dung va chay duoc (x)" bash -c 'for f in google-chrome agentos-zalo agentos-kiotviet agentos-deepseek rustdesk agentos-claude agentos-codex; do test -x /etc/skel/Desktop/$f.desktop || exit 1; done'
chk "sudoers mo Claude/Codex duoi agentos hop le (0440), KHONG phai root" bash -c 'sudo -n visudo -cf /etc/sudoers.d/91-agentos-desktop >/dev/null 2>&1 && sudo -n grep -q "(agentos)" /etc/sudoers.d/91-agentos-desktop && ! sudo -n grep -q "ALL=(ALL" /etc/sudoers.d/91-agentos-desktop'
chk "thu muc /var/lib/agentos thuoc agentos" bash -c '[ "$(stat -c %U /var/lib/agentos)" = agentos ]'
chk "tools.json co mat" test -f "$ORCH/tools.json"
chk "khong co unit nao bi loi (systemctl --failed)" bash -c 'test "$(systemctl --failed --no-legend | wc -l)" = 0'
chk "SSH tat mac dinh (an toan)" bash -c '! systemctl is-enabled --quiet ssh 2>/dev/null'

echo "--- ban DA CAI (bo qua o ban live)"
if grep -q boot=live /proc/cmdline; then
  skip "dang o ban live"
else
  chk "he thong boot bang EFI" test -d /sys/firmware/efi
  chk "co muc khoi dong trong /boot/efi" bash -c 'ls /boot/efi/EFI | grep -q .'
  chk "mui gio = Asia/Ho_Chi_Minh" bash -c '[ "$(timedatectl show -p Timezone --value)" = Asia/Ho_Chi_Minh ]'
  chk "ngon ngu he thong vi_VN" bash -c 'grep -q vi_VN /etc/default/locale'
  chk "goi live-boot da go" bash -c '! dpkg -s live-boot >/dev/null 2>&1'
  chk "goi live-config da go" bash -c '! dpkg -s live-config >/dev/null 2>&1'
  chk "goi calamares da go" bash -c '! dpkg -s calamares >/dev/null 2>&1'
  chk "thoi gian khoi dong < 120 giay" bash -c 'systemd-analyze | grep -q "Startup finished" && test "$(systemd-analyze | grep -o "= [0-9.]*min" | wc -l)" -le 1'
fi

echo "--- test bo dieu phoi, nguoi dung hien tai ($(id -un))"
( cd "$ORCH" && node --test test/*.test.js > /tmp/t-user.log 2>&1; echo "ma thoat: $?" )
grep -E '^# (tests|pass|fail|skipped)' /tmp/t-user.log | paste -sd' '
grep '^not ok' /tmp/t-user.log | head -8
if [ $SUDO = 1 ]; then
  echo "--- test bo dieu phoi, root (giong CI)"
  sudo bash -c "cd $ORCH && node --test test/*.test.js > /tmp/t-root.log 2>&1; echo ma thoat: \$?"
  grep -E '^# (tests|pass|fail|skipped)' /tmp/t-root.log | paste -sd' '
  grep '^not ok' /tmp/t-root.log | head -8
fi
echo "=== So muc LOI: $FAIL"
