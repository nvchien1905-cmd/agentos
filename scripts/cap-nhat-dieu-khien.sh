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
ORCH="config.js bot.js tools.js index.js quick.js kiotviet.js desk.js onedrive.js policy.js gate.js limits.js worker.js engines/claude.js engines/gemini.js"
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

echo "== OneDrive (AI đọc dữ liệu và lưu kết quả/ghi nhớ ở /srv/onedrive, đồng bộ hai chiều)"
apt-get install -y --no-install-recommends onedrive >/dev/null 2>&1 || { apt-get update >/dev/null 2>&1; apt-get install -y --no-install-recommends onedrive; }
CI=iso/config/includes.chroot
for f in etc/systemd/system/onedrive-agentos.service etc/systemd/system/onedrive-agentos.path usr/share/applications/agentos-onedrive.desktop usr/share/icons/hicolor/scalable/apps/agentos-onedrive.svg; do
  mkdir -p "/$(dirname "$f")"
  curl -fsSL "$R/$CI/$f" -o "/$f" || { echo "Không tải được $f"; exit 1; }
done
id agentos >/dev/null 2>&1 || { echo "Thiếu người dùng agentos"; exit 1; }
mkdir -p /srv/onedrive; chown agentos:agentos /srv/onedrive; chmod 2775 /srv/onedrive
if [ ! -f /var/lib/agentos/.config/onedrive/config ]; then
  mkdir -p /var/lib/agentos/.config/onedrive
  cat > /var/lib/agentos/.config/onedrive/config <<'EOC'
sync_dir = "/srv/onedrive"
monitor_interval = "120"
classify_as_big_delete = "50"
skip_dotfiles = "true"
sync_dir_permissions = "775"
sync_file_permissions = "664"
disable_notifications = "true"
EOC
fi
chown -R agentos:agentos /var/lib/agentos/.config; chmod 700 /var/lib/agentos/.config /var/lib/agentos/.config/onedrive
systemctl --global disable onedrive.service >/dev/null 2>&1 || true      # gói tự bật dịch vụ người dùng đòi đăng nhập liên tục
printf '[Service]\nReadWritePaths=-/srv/onedrive\n' > /etc/systemd/system/agentos-orchestrator.service.d/21-onedrive.conf
systemctl daemon-reload
systemctl enable onedrive-agentos.path onedrive-agentos.service >/dev/null 2>&1 || true
systemctl start onedrive-agentos.path || true
chmod 755 /usr/share/applications/agentos-onedrive.desktop 2>/dev/null || true
gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true
mkdir -p /etc/skel/Desktop; ln -sfn /srv/onedrive /etc/skel/OneDrive
cp /usr/share/applications/agentos-onedrive.desktop /etc/skel/Desktop/agentos-onedrive.desktop; chmod 755 /etc/skel/Desktop/agentos-onedrive.desktop
for h in /home/*; do
  u=$(basename "$h"); id "$u" >/dev/null 2>&1 || continue
  [ "$(id -u "$u")" -ge 1000 ] || continue
  usermod -aG agentos "$u"                                                # để mở/ghi ~/OneDrive (hiệu lực sau khi đăng xuất, đăng nhập lại)
  ln -sfn /srv/onedrive "$h/OneDrive"; chown -h "$u:$(id -gn "$u")" "$h/OneDrive"
  mkdir -p "$h/Desktop"; cp /usr/share/applications/agentos-onedrive.desktop "$h/Desktop/agentos-onedrive.desktop"
  chmod 755 "$h/Desktop/agentos-onedrive.desktop"; chown "$u:$(id -gn "$u")" "$h/Desktop/agentos-onedrive.desktop"
  echo "  đã thêm OneDrive cho $u"
done

echo "== Gemini (AI của Google, dùng tài khoản Google)"
ENVF=/etc/agentos/orchestrator.env
setenv() { if grep -q "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else echo "$1=$2" >> "$ENVF"; fi; }
GEM=/var/lib/agentos/.local/bin/gemini
if [ ! -x "$GEM" ]; then
  runuser -u agentos -- env HOME=/var/lib/agentos PATH=/var/lib/agentos/.local/bin:/usr/bin:/bin npm install -g --prefix /var/lib/agentos/.local --no-audit --no-fund @google/gemini-cli >/dev/null 2>&1 || { echo "Không cài được @google/gemini-cli (kiểm tra mạng)"; exit 1; }
fi
# Đặt sẵn kiểu đăng nhập "Google" để lần mở đầu hiện thẳng đường dẫn đăng nhập (không phải chọn menu)
install -d -o agentos -g agentos -m 700 /var/lib/agentos/.gemini
[ -f /var/lib/agentos/.gemini/settings.json ] || { printf '{\n  "security": { "auth": { "selectedType": "oauth-personal" } }\n}\n' > /var/lib/agentos/.gemini/settings.json; chown agentos:agentos /var/lib/agentos/.gemini/settings.json; chmod 600 /var/lib/agentos/.gemini/settings.json; }
setenv GEMINI_BIN "$GEM"
if [ -f /var/lib/agentos/.gemini/oauth_creds.json ]; then
  CUR=$(grep '^ENGINE_ORDER=' "$ENVF" | head -n1 | cut -d= -f2)
  case ",$CUR," in *,gemini,*) echo "Gemini đã nằm trong ENGINE_ORDER ($CUR)";; *) setenv ENGINE_ORDER "${CUR:+$CUR,}gemini"; echo "✅ Đã bật Gemini: ENGINE_ORDER=${CUR:+$CUR,}gemini";; esac
else
  echo "Gemini đã cài, CHƯA đăng nhập: mở biểu tượng Gemini trên màn hình chính → chọn 'Sign in with Google' (nếu hỏi) → mở đường dẫn trên điện thoại/Chrome, đăng nhập, dán mã vào cửa sổ."
  echo "Xong thì chạy lại lệnh cập nhật này một lần nữa để bật Gemini trong danh sách AI."
fi

echo "== 4/4 Khởi động lại bộ điều phối"
systemctl restart agentos-orchestrator || true
sleep 6
systemctl is-active --quiet agentos-deskd && echo "✅ Trợ lý màn hình đang chạy." || echo "⚠️ Trợ lý màn hình chưa lên: journalctl -u agentos-deskd -n 20"
systemctl is-active --quiet agentos-orchestrator && echo "✅ Bộ điều phối đang chạy." || echo "⚠️ Bộ điều phối chưa lên: journalctl -u agentos-orchestrator -n 30"
echo
echo "Xong. Mở Telegram gõ /help để thấy lệnh nhanh: /manhinh /mo /dong /khoamay /khoimay /tatmay /deepseek /doanhso /ton /onedrive."
echo "OneDrive: nhắn bot  /onedrive ketnoi  rồi đăng nhập Microsoft trên điện thoại (làm một lần)."
echo "KiotViet (/doanhso, /ton) cần khóa API: chạy  curl -sL $R/scripts/dat-khoa-kiotviet.sh -o k.sh; sudo bash k.sh"
