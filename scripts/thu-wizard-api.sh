#!/bin/bash
# Thu cac buoc AI cua trinh huong dan lan dau bang cach goi thang API (can trinh huong dan dang chay tren may da cai):
#   curl -sL https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/scripts/thu-wizard-api.sh -o w.sh; bash w.sh [claude|codex] [login]
# Cai CLI bang npm CHINH THUC vao /var/lib/agentos/.local (nguoi dung agentos), kiem tra, tuy chon mo cua so dang nhap.
ENG=${1:-claude}
API=http://127.0.0.1:8088/api
post() { curl -s -H 'x-agentos-wizard: 1' -H 'content-type: application/json' -d "$2" "$API/$1"; echo; }

echo "--- trang thai ban dau"; curl -s $API/state | head -c 400; echo
echo "--- cai $ENG"; post engine/install "{\"engine\":\"$ENG\"}"
for i in $(seq 1 80); do
  S=$(curl -s $API/state | grep -o "\"install-$ENG\":{[^}]*}")
  case "$S" in *running*) sleep 8;; *) break;; esac
done
echo "ket qua cai: $S"
echo "--- kiem tra $ENG (chua dang nhap thi bao 'chua dang nhap')"; post engine/check "{\"engine\":\"$ENG\"}"
echo "--- file da cai"; ls -l /var/lib/agentos/.local/bin 2>/dev/null
if [ "$2" = login ]; then echo "--- mo cua so dang nhap"; post engine/login "{\"engine\":\"$ENG\"}"; fi
