#!/bin/bash
# Thử agentos-display bằng xrandr giả (số liệu thật chụp từ máy của chủ: eDP-1 + HDMI-2). Chạy: bash scripts/test-man-hinh.sh
S="$(cd "$(dirname "$0")/.." && pwd)/iso/config/includes.chroot/usr/local/bin/agentos-display"
T=$(mktemp -d); LOG=$T/calls
cat > $T/xrandr <<'X'
#!/bin/bash
if [ "$1" = "--query" ]; then cat "$FAKE"; else echo "$*" >> "$LOG"; fi
X
chmod +x $T/xrandr; export LOG AGENTOS_XRANDR=$T/xrandr FAKE=$T/q
fail=0; ok() { echo "[ OK ] $1"; }; bad() { echo "[LOI] $1"; fail=1; }
run() { : > $LOG; sh "$S"; }

# 1) Máy của chủ: eDP-1 (1920x1080 + 1366x768) và HDMI-2 (1920x1080 + 1280x720); DP-1, HDMI-1 không nối
cat > $T/q <<'X'
Screen 0: minimum 320 x 200, current 3840 x 1080, maximum 16384 x 16384
eDP-1 connected 1920x1080+0+0 (normal left inverted right x axis y axis) 519mm x 324mm
   1920x1080     60.00*+  48.00
   1366x768      59.79
DP-1 disconnected (normal left inverted right x axis y axis)
HDMI-1 disconnected (normal left inverted right x axis y axis)
HDMI-2 connected 1920x1080+1920+0 (normal left inverted right x axis y axis) 476mm x 268mm
   1920x1080     60.00*+ 100.00
   1280x720      60.00
X
run
grep -q -- "--output HDMI-2 --mode 1920x1080 --pos 0x0 --rotate normal --primary" $LOG && ok "HDMI-2 là màn hình chính, về 0x0" || bad "HDMI-2 chưa thành chính: $(cat $LOG)"
grep -q -- "--output eDP-1 --mode 1920x1080 --pos 0x0 --rotate normal" $LOG && ok "eDP-1 nhân bản cùng độ phân giải, cùng vị trí 0x0" || bad "eDP-1 chưa nhân bản"
grep -q -- "--primary" <(grep eDP $LOG) && bad "eDP-1 không được là màn hình chính" || ok "eDP-1 không phải màn hình chính"

# 2) Không có độ phân giải chung -> chỉ dùng màn hình ngoài, tắt màn hình trong
cat > $T/q <<'X'
eDP-1 connected 1366x768+0+0 (normal) 1mm x 1mm
   1366x768      59.79*+
HDMI-1 connected 1920x1080+1366+0 (normal) 1mm x 1mm
   1920x1080     60.00*+
X
run
grep -q -- "--output eDP-1 --off" $LOG && grep -q -- "--output HDMI-1 --auto --pos 0x0 --primary" $LOG && ok "không có chung độ phân giải: tắt màn hình trong, dùng HDMI-1" || bad "nhánh không có chung: $(cat $LOG)"

# 3) Một màn hình
cat > $T/q <<'X'
HDMI-1 connected primary 1920x1080+0+0 (normal) 1mm x 1mm
   1920x1080     60.00*+
DP-1 disconnected (normal)
X
run
grep -q -- "--output HDMI-1 --auto --primary" $LOG && [ "$(wc -l < $LOG)" = 1 ] && ok "một màn hình: chỉ bật và đặt chính" || bad "một màn hình: $(cat $LOG)"

# 4) Chỉ có màn hình trong (laptop không cắm gì thêm)
cat > $T/q <<'X'
eDP-1 connected primary 1920x1080+0+0 (normal) 1mm x 1mm
   1920x1080     60.00*+
X
run
grep -q -- "--output eDP-1 --auto --primary" $LOG && ok "chỉ có eDP-1: giữ nguyên" || bad "chỉ eDP: $(cat $LOG)"

# 5) xrandr không chạy được -> thoát im lặng
AGENTOS_XRANDR=/khong/co sh "$S" && ok "không có xrandr: thoát bình thường" || bad "không có xrandr: lỗi"
rm -rf $T; exit $fail
