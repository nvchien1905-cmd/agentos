#!/bin/bash
# Nhập khóa API KiotViet cho bot (để dùng /doanhso và /ton). Chạy trong terminal, KHÔNG dùng "curl | bash" (cần gõ khóa):
#   curl -sL https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/scripts/dat-khoa-kiotviet.sh -o k.sh; sudo bash k.sh
# Ba giá trị lấy ở KiotViet: Thiết lập cửa hàng -> Thiết lập kết nối API: Client ID, Secret key, và Tên cửa hàng (retailer).
# Khóa chỉ có quyền ĐỌC mà bot dùng; được ghi vào /etc/agentos/orchestrator.env (chỉ root đọc được), không in ra màn hình.
set -e
ENV=/etc/agentos/orchestrator.env
[ "$(id -u)" = 0 ] || { echo "Cần chạy bằng root: sudo bash k.sh"; exit 1; }
[ -f "$ENV" ] || { echo "Máy chưa cài xong (không có $ENV)."; exit 1; }
[ -t 0 ] || { echo "Cần chạy trong terminal thường (bạn phải gõ khóa)."; exit 1; }
read -r -p "Tên cửa hàng KiotViet (retailer, VD tencuahang): " RET
read -r -s -p "Client ID (gõ/dán, không hiện): " CID; echo
read -r -s -p "Client Secret (gõ/dán, không hiện): " SEC; echo
[ -n "$RET" ] && [ -n "$CID" ] && [ -n "$SEC" ] || { echo "Thiếu giá trị, dừng."; exit 1; }
case "$RET$CID$SEC" in *$'\n'*|*' '*) echo "Giá trị không được chứa khoảng trắng hoặc xuống dòng."; exit 1;; esac
setenv() { if grep -q "^$1=" "$ENV"; then sed -i "s|^$1=.*|$1=$2|" "$ENV"; else echo "$1=$2" >> "$ENV"; fi; }
setenv KIOTVIET_RETAILER "$RET"; setenv KIOTVIET_CLIENT_ID "$CID"; setenv KIOTVIET_CLIENT_SECRET "$SEC"
chmod 600 "$ENV"
# Thử thật (chỉ đọc) trước khi khởi động lại
TOK=$(curl -s -m 20 -d "scopes=PublicApi.Access&grant_type=client_credentials&client_id=$CID&client_secret=$SEC" https://id.kiotviet.vn/connect/token | grep -o '"access_token"' || true)
if [ -n "$TOK" ]; then echo "✅ KiotViet nhận khóa."; else echo "⚠️ KiotViet từ chối khóa (hoặc không có mạng). Kiểm tra lại Client ID / Secret rồi chạy lại."; fi
systemctl restart agentos-orchestrator || true
echo "Xong. Nhắn bot: /doanhso   hoặc   /ton nồi chiên"
