#!/bin/bash
# Cập nhật máy AgentOS ĐÃ CÀI để ra lệnh MỌI THỨ qua Telegram (không cần cài lại): trợ lý màn hình + lệnh nhanh (/manhinh /mo /dong /khoamay /khoimay
# /tatmay /deepseek /doanhso /ton) + AI nhìn/bấm màn hình thật. Chạy bằng root:
#   curl -sL https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/scripts/cap-nhat-dieu-khien.sh | sudo bash
# Có sao lưu mã cũ; mỗi tệp được kiểm cú pháp trước khi thay. Chạy lại nhiều lần không hại.
set -e
R=${AGENTOS_RAW:-https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main}   # AGENTOS_RAW chỉ để thử
[ "$(id -u)" = 0 ] || { echo "Cần chạy bằng root: thêm sudo trước bash."; exit 1; }
[ -d /opt/agentos/orchestrator ] || { echo "Máy chưa cài AgentOS (không có /opt/agentos/orchestrator)."; exit 1; }
export DEBIAN_FRONTEND=noninteractive
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

echo "== 1/4 Gói cần thêm (xclip, scrot, xdotool)"
apt-get install -y --no-install-recommends xclip scrot xdotool >/dev/null 2>&1 || { apt-get update >/dev/null 2>&1; apt-get install -y --no-install-recommends xclip scrot xdotool; }

echo "== 2/4 Mã bộ điều phối + trợ lý màn hình"
B=/root/agentos-bak-$(date +%Y%m%d-%H%M%S); mkdir -p "$B"; cp -a /opt/agentos/orchestrator/src "$B/"; [ -d /opt/agentos/desk ] && cp -a /opt/agentos/desk "$B/" || true
echo "Đã sao lưu mã cũ vào $B"
ORCH="config.js bot.js tools.js index.js quick.js kiotviet.js desk.js engines/claude.js"
for f in $ORCH; do
  mkdir -p "$T/orchestrator/src/$(dirname "$f")"
  curl -fsSL "$R/orchestrator/src/$f" -o "$T/orchestrator/src/$f" || { echo "Không tải được orchestrator/src/$f"; exit 1; }
  node --check "$T/orchestrator/src/$f" || { echo "Tệp $f lỗi cú pháp, dừng (chưa đổi gì)"; exit 1; }
done
mkdir -p "$T/desk"
for f in server.js cli.js; do
  curl -fsSL "$R/desk/$f" -o "$T/desk/$f" || { echo "Không tải được desk/$f"; exit 1; }
  node --check "$T/desk/$f" || { echo "Tệp desk/$f lỗi cú pháp, dừng"; exit 1; }
done
for f in $ORCH; do cat "$T/orchestrator/src/$f" > "/opt/agentos/orchestrator/src/$f" 2>/dev/null || { mkdir -p "/opt/agentos/orchestrator/src/$(dirname "$f")"; cat "$T/orchestrator/src/$f" > "/opt/agentos/orchestrator/src/$f"; }; done
mkdir -p /opt/agentos/desk; install -m 755 "$T/desk/server.js" /opt/agentos/desk/server.js; install -m 755 "$T/desk/cli.js" /opt/agentos/desk/cli.js

echo "== 3/4 Dịch vụ trợ lý màn hình"
curl -fsSL "$R/iso/config/includes.chroot/etc/systemd/system/agentos-deskd.service" -o /etc/systemd/system/agentos-deskd.service
curl -fsSL "$R/iso/config/includes.chroot/usr/local/bin/agentos-desk" -o /usr/local/bin/agentos-desk; chmod 755 /usr/local/bin/agentos-desk
mkdir -p /etc/systemd/system/agentos-orchestrator.service.d
cat > /etc/systemd/system/agentos-orchestrator.service.d/20-deskd.conf <<'EOS'
[Unit]
After=agentos-deskd.service
Wants=agentos-deskd.service
EOS
systemctl daemon-reload
systemctl enable --now agentos-deskd.service
systemctl restart agentos-deskd.service

echo "== 4/4 Khởi động lại bộ điều phối"
systemctl restart agentos-orchestrator || true
sleep 6
systemctl is-active --quiet agentos-deskd && echo "✅ Trợ lý màn hình đang chạy." || echo "⚠️ Trợ lý màn hình chưa lên: journalctl -u agentos-deskd -n 20"
systemctl is-active --quiet agentos-orchestrator && echo "✅ Bộ điều phối đang chạy." || echo "⚠️ Bộ điều phối chưa lên: journalctl -u agentos-orchestrator -n 30"
echo
echo "Xong. Mở Telegram gõ /help để thấy lệnh nhanh: /manhinh /mo /dong /khoamay /khoimay /tatmay /deepseek /doanhso /ton."
echo "KiotViet (/doanhso, /ton) cần khóa API: chạy  curl -sL $R/scripts/dat-khoa-kiotviet.sh -o k.sh; sudo bash k.sh"
