#!/bin/bash
# Thêm ứng dụng vào máy AgentOS ĐÃ CÀI (không cần cài lại): Google Chrome, RustDesk, Zalo (web), KiotViet (web), Claude Code, Codex,
# kèm biểu tượng trên màn hình chính của mọi người dùng. Chạy bằng root:
#   curl -sL https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/scripts/cai-ung-dung.sh | sudo bash
# Chạy lại nhiều lần không hại (cập nhật biểu tượng/launcher, giữ nguyên /etc/agentos/apps.conf nếu đã sửa).
set -e
R=${AGENTOS_RAW:-https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main}   # AGENTOS_RAW chỉ để thử
C=iso/config/includes.chroot
[ "$(id -u)" = 0 ] || { echo "Cần chạy bằng root: thêm sudo trước bash."; exit 1; }
export DEBIAN_FRONTEND=noninteractive
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

get() { curl -fsSL "$R/$C/$1" -o "$T/f" || { echo "Không tải được $1"; exit 1; }; }
put() { # put <đường dẫn trong ISO> <đích> <quyền>
  get "$1"; mkdir -p "$(dirname "$2")"; install -m "$3" "$T/f" "$2"
}

echo "== 1/4 Google Chrome"
if [ ! -x /usr/bin/google-chrome-stable ]; then
  curl -fsSL -o "$T/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y --no-install-recommends "$T/chrome.deb"
else echo "đã có"; fi

echo "== 2/4 RustDesk (điều khiển từ xa, thay UltraViewer)"
if [ ! -x /usr/bin/rustdesk ]; then
  URL=$(curl -fsSL https://api.github.com/repos/rustdesk/rustdesk/releases/latest | grep -o 'https://[^"]*rustdesk-[0-9][0-9.]*-x86_64\.deb' | head -n 1)
  [ -n "$URL" ] || { echo "Không tìm được bản RustDesk"; exit 1; }
  curl -fsSL -o "$T/rd.deb" "$URL"
  apt-get update; apt-get install -y --no-install-recommends "$T/rd.deb"
else echo "đã có"; fi

# Chrome không hỏi "mật khẩu kho khóa mới" (gnome-keyring)
if ! grep -q -- "--password-store=basic" /usr/share/applications/google-chrome.desktop 2>/dev/null; then
  sed -i 's|^Exec=/usr/bin/google-chrome-stable|Exec=/usr/bin/google-chrome-stable --password-store=basic|' /usr/share/applications/google-chrome.desktop
fi
apt-get purge -y gnome-keyring libpam-gnome-keyring 2>/dev/null || true

echo "== 3/4 Launcher, biểu tượng, quyền mở Claude/Codex"
put usr/local/bin/agentos-app /usr/local/bin/agentos-app 755
put usr/local/bin/agentos-ai /usr/local/bin/agentos-ai 755
for n in zalo kiotviet deepseek claude codex gemini; do
  put usr/share/applications/agentos-$n.desktop /usr/share/applications/agentos-$n.desktop 644
  put usr/share/icons/hicolor/scalable/apps/agentos-$n.svg /usr/share/icons/hicolor/scalable/apps/agentos-$n.svg 644
done
[ -f /etc/agentos/apps.conf ] || put etc/agentos/apps.conf /etc/agentos/apps.conf 644
# sudoers: kiểm bằng visudo trước khi có hiệu lực
get etc/sudoers.d/91-agentos-desktop; install -m 440 "$T/f" /etc/sudoers.d/91-agentos-desktop.tmp
visudo -cf /etc/sudoers.d/91-agentos-desktop.tmp || { rm -f /etc/sudoers.d/91-agentos-desktop.tmp; echo "Tệp sudo không hợp lệ, dừng."; exit 1; }
mv /etc/sudoers.d/91-agentos-desktop.tmp /etc/sudoers.d/91-agentos-desktop
gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true
update-desktop-database /usr/share/applications 2>/dev/null || true

echo "== 4/4 Biểu tượng trên màn hình chính"
APPS="google-chrome agentos-zalo agentos-kiotviet agentos-deepseek rustdesk agentos-claude agentos-codex agentos-gemini agentos-apikey"
place() { # place <thư mục Desktop> <chủ sở hữu hoặc rỗng>
  mkdir -p "$1"
  for f in $APPS; do
    [ -f /usr/share/applications/$f.desktop ] || continue
    cp /usr/share/applications/$f.desktop "$1/$f.desktop"; chmod 755 "$1/$f.desktop"
    [ -n "$2" ] && chown "$2" "$1/$f.desktop"
  done
  [ -n "$2" ] && chown "$2" "$1"
  [ -f "$1/rustdesk.desktop" ] && sed -i 's|^Name=RustDesk$|Name=RustDesk (điều khiển từ xa)|' "$1/rustdesk.desktop" || true
}
place /etc/skel/Desktop ""                       # người dùng tạo sau này
for h in /home/*; do
  u=$(basename "$h"); id "$u" >/dev/null 2>&1 || continue
  [ "$(id -u "$u")" -ge 1000 ] || continue
  place "$h/Desktop" "$u:$(id -gn "$u")"; echo "  đã thêm cho $u"
done
echo
echo "✅ Xong. Đăng xuất rồi đăng nhập lại (hoặc đợi vài giây) để thấy biểu tượng: Google Chrome, Zalo, KiotViet, DeepSeek, RustDesk, Claude Code, Codex."
echo "   KiotViet: sửa địa chỉ cửa hàng ở /etc/agentos/apps.conf (dòng KIOTVIET_URL=)."
