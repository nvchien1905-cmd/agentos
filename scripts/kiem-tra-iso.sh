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
