#!/bin/sh
# Thu thập thông tin phần cứng của máy THẬT để gửi cho AgentOS chấm điểm.
# Chỉ ĐỌC, không cài, không sửa gì, không gửi gì ra mạng. Chạy được trên mọi USB Linux (Ubuntu/Debian live).
# Cách dùng:  sh thu-may-that.sh      → tạo tệp may-that.txt cùng thư mục, gửi tệp đó lại.
# Tệp KHÔNG chứa mật khẩu, khóa hay dữ liệu cá nhân (chỉ model phần cứng, dung lượng, tên card).

OUT="${1:-may-that.txt}"
sec() { printf '\n=== %s ===\n' "$1"; }

{
  sec arch;       uname -m
  sec ramkb;      awk '/^MemTotal:/ {print $2}' /proc/meminfo
  sec cores;      nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo
  sec cpumodel;   awk -F': ' '/^model name/ {print $2; exit}' /proc/cpuinfo
  sec uefi;       [ -d /sys/firmware/efi ] && echo yes || echo no
  sec cmdline;    cat /proc/cmdline
  sec live;       [ -d /run/live ] && echo yes || echo no
  sec virt;       systemd-detect-virt 2>/dev/null || true
  sec lsblk;      lsblk -dn -b -P -o NAME,SIZE,ROTA,TYPE,TRAN,MODEL,RM 2>/dev/null || true
  sec lspci;      lspci -nnk 2>/dev/null || echo "(khong co lspci)"
  sec rfkill;     rfkill list 2>/dev/null || true
  sec nics
  for n in /sys/class/net/*; do
    b=$(basename "$n"); [ "$b" = lo ] && continue
    [ -e "$n/device" ] || continue
    w=0; { [ -e "$n/wireless" ] || [ -e "$n/phy80211" ]; } && w=1
    echo "$b wifi=$w up=$(cat "$n/operstate" 2>/dev/null) carrier=$(cat "$n/carrier" 2>/dev/null)"
  done
  sec drm
  for c in /sys/class/drm/card*-*; do
    [ -e "$c/status" ] && echo "$(basename "$c") $(cat "$c/status")"
  done
  sec firmware
  { journalctl -k -b --no-pager -q 2>/dev/null || dmesg 2>/dev/null; } | grep -i firmware | head -60
  sec distro;     . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"
  sec dmi
  for f in sys_vendor product_name bios_version bios_date; do
    printf '%s=' "$f"; cat "/sys/class/dmi/id/$f" 2>/dev/null || echo
  done
} > "$OUT" 2>&1

echo "Xong. Đã ghi: $OUT ($(wc -c < "$OUT") byte). Hãy gửi tệp này lại."
