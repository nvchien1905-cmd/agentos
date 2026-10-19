#!/bin/bash
# Kiem tra phan Linux cua ISO AgentOS. Chay TRONG may ao/may that da boot ISO (ban live hoac ban da cai):
#   curl -sL https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/scripts/kiem-tra-iso.sh -o k.sh; bash k.sh
# In moi muc mot dong [ OK ] / [LOI ]; chi doc he thong, chi ghi vao /tmp. Dung sudo cho vai buoc (ban live: khong can mat khau).

ok()  { echo "[ OK ] $*"; }
bad() { echo "[LOI ] $*"; FAIL=$((FAIL+1)); }
FAIL=0
chk() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
ORCH=/opt/agentos/orchestrator

chk "nguoi dung agentos" id agentos
chk "node >= 20" bash -c 'node -e "process.exit(Number(process.versions.node.split(\".\")[0])>=20?0:1)"'
chk "bubblewrap co mat" bwrap --version
chk "bwrap chay duoc (nguoi dung agentos)" sudo -u agentos bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid --die-with-parent -- /bin/true
chk "bwrap: /etc/agentos bi che" sudo -u agentos bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /etc/agentos --unshare-pid --die-with-parent -- /bin/true
chk "better-sqlite3 nap duoc" bash -c "cd $ORCH && node -e 'require(\"better-sqlite3\")'"
for u in agentos-xvfb agentos-orchestrator agentos-firstboot; do chk "unit $u da enable" systemctl is-enabled "$u"; done
chk "xvfb dang chay" systemctl is-active agentos-xvfb
chk "unit orchestrator hop le (systemd-analyze verify)" bash -c 'test -z "$(systemd-analyze verify /etc/systemd/system/agentos-orchestrator.service 2>&1)"'
chk "kernel.panic = 10" bash -c '[ "$(cat /proc/sys/kernel/panic)" = 10 ]'
chk "sleep.target bi mask (chong ngu)" bash -c '[ "$(systemctl is-enabled sleep.target 2>&1)" = masked ]'
chk "logind IdleAction=ignore" grep -q IdleAction=ignore /etc/systemd/logind.conf.d/10-agentos.conf
chk "journald co gioi han dung luong" grep -q SystemMaxUse /etc/systemd/journald.conf.d/10-agentos.conf
chk "Calamares co mat" which calamares
chk "Chromium co mat" which chromium
chk "thu muc /var/lib/agentos thuoc agentos" bash -c '[ "$(stat -c %U /var/lib/agentos)" = agentos ]'
chk "tools.json co mat" test -f "$ORCH/tools.json"
echo "--- test bo dieu phoi, nguoi dung hien tai ($(id -un))"
( cd "$ORCH" && node --test test/*.test.js > /tmp/t-user.log 2>&1; echo "ma thoat: $?" )
grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/t-user.log | paste -sd' '
grep '^✖' /tmp/t-user.log | head -8
echo "--- test bo dieu phoi, root (giong CI)"
sudo bash -c "cd $ORCH && node --test test/*.test.js > /tmp/t-root.log 2>&1; echo ma thoat: \$?"
grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/t-root.log | paste -sd' '
grep '^✖' /tmp/t-root.log | head -8
echo "=== So muc LOI: $FAIL (log day du: /tmp/t-user.log /tmp/t-root.log)"
