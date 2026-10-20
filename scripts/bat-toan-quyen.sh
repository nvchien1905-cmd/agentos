#!/bin/bash
# Bật / tắt chế độ TOÀN QUYỀN trên máy AgentOS ĐÃ CÀI (chủ máy tự chạy, bằng root):
#   curl -sL https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/scripts/bat-toan-quyen.sh | sudo bash            # BẬT
#   curl -sL https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/scripts/bat-toan-quyen.sh | sudo bash -s tat     # TẮT
#
# BẬT = (1) cập nhật mã bộ điều phối lên bản có chế độ toàn quyền (có sao lưu bản cũ), (2) cho người dùng hệ thống `agentos` dùng sudo
# không mật khẩu, (3) gỡ giới hạn gia cố của systemd cho dịch vụ điều phối, (4) FULL_ACCESS=1 trong /etc/agentos/orchestrator.env.
# Sau đó AI tự làm một mạch, KHÔNG hỏi xin phép, có sudo. Chỉ tài khoản Telegram trong ALLOWED_USER_IDS ra lệnh được.
# Đổi nhanh bằng Telegram: /baove (AI hỏi trước + sandbox), /toanquyen (không hỏi).
# RỦI RO: nếu AI đọc phải trang web/tệp có cài lệnh giả thì lệnh đó cũng chạy với quyền cao. Chỉ bật cho máy cá nhân của chính bạn.
set -e
R=${AGENTOS_RAW:-https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main}   # AGENTOS_RAW chỉ để thử
D=/opt/agentos/orchestrator
ENV=/etc/agentos/orchestrator.env
SUD=/etc/sudoers.d/90-agentos-toan-quyen
DROPD=/etc/systemd/system/agentos-orchestrator.service.d
DROP=$DROPD/10-toan-quyen.conf

[ "$(id -u)" = 0 ] || { echo "Cần chạy bằng root: thêm sudo trước bash."; exit 1; }
[ -f "$ENV" ] || { echo "Máy chưa được cài xong (không có $ENV)."; exit 1; }

setenv() {   # setenv KHOA GIATRI: đặt hoặc thêm dòng trong tệp cấu hình
  if grep -q "^$1=" "$ENV"; then sed -i "s|^$1=.*|$1=$2|" "$ENV"; else echo "$1=$2" >> "$ENV"; fi
}

if [ "${1:-}" = tat ]; then
  rm -f "$SUD" "$DROP"
  setenv FULL_ACCESS 0; setenv JOB_TIMEOUT_SEC 900
  systemctl daemon-reload; systemctl restart agentos-orchestrator || true
  echo "✅ Đã TẮT chế độ toàn quyền: AI hỏi bạn trước khi ghi file/chạy lệnh, chạy trong hộp cô lập, không còn sudo."
  exit 0
fi

# 1) cập nhật mã bộ điều phối (mỗi tệp được kiểm cú pháp trước khi thay)
B=/root/agentos-orchestrator-bak-$(date +%Y%m%d-%H%M%S); mkdir -p "$B"; cp -a "$D/src" "$B/"
echo "Đã sao lưu mã cũ vào $B"
T=$(mktemp -d)
for f in config.js bot.js tools.js index.js engines/claude.js; do
  mkdir -p "$T/$(dirname "$f")"
  curl -fsSL "$R/orchestrator/src/$f" -o "$T/$f" || { echo "Không tải được $f"; exit 1; }
  node --check "$T/$f" || { echo "Tệp $f tải về bị lỗi cú pháp, dừng (chưa đổi gì)"; exit 1; }
done
for f in config.js bot.js tools.js index.js engines/claude.js; do cat "$T/$f" > "$D/src/$f"; done   # giữ nguyên chủ sở hữu/quyền tệp
rm -rf "$T"

# 2) sudo không mật khẩu cho agentos (kiểm bằng visudo trước khi có hiệu lực)
cat > "$SUD.tmp" <<'EOS'
# AgentOS - chế độ TOÀN QUYỀN: người dùng hệ thống `agentos` (chạy bộ điều phối + AI) dùng sudo không cần mật khẩu.
# Gỡ: curl ... bat-toan-quyen.sh | sudo bash -s tat
agentos ALL=(ALL:ALL) NOPASSWD: ALL
EOS
chmod 0440 "$SUD.tmp"
visudo -cf "$SUD.tmp" || { rm -f "$SUD.tmp"; echo "Tệp sudo không hợp lệ, dừng."; exit 1; }
mv "$SUD.tmp" "$SUD"

# 3) gỡ giới hạn gia cố của systemd (NoNewPrivileges chặn sudo; ProtectSystem=strict chặn ghi hệ thống)
mkdir -p "$DROPD"
cat > "$DROP" <<'EOS'
[Service]
NoNewPrivileges=no
ProtectSystem=no
RestrictSUIDSGID=no
PrivateTmp=no
ProtectKernelTunables=no
ProtectControlGroups=no
EOS

# 4) bật chế độ + cho việc chạy lâu hơn (1 giờ)
setenv FULL_ACCESS 1; setenv JOB_TIMEOUT_SEC 3600
systemctl daemon-reload
systemctl restart agentos-orchestrator || true
sleep 6
systemctl is-active --quiet agentos-orchestrator && echo "✅ Bộ điều phối đang chạy." || { echo "⚠️ Bộ điều phối chưa lên, xem: journalctl -u agentos-orchestrator -n 30"; exit 1; }
sudo -n -u agentos sudo -n true && echo "✅ Người dùng agentos có sudo không mật khẩu." || echo "⚠️ agentos chưa dùng được sudo."
echo
echo "⚡ ĐÃ BẬT chế độ TOÀN QUYỀN. Mở Telegram, nhắn bot: bot tự làm một mạch, không hỏi xin phép."
echo "   /trangthai xem chế độ · /baove bật lại hỏi duyệt · /toanquyen bật lại không hỏi · gỡ hẳn: chạy lại script này với 'tat'."
