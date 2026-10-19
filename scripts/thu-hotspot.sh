#!/bin/bash
# Thu Wi-Fi tam bang card Wi-Fi ao (mac80211_hwsim) tren may ao. Chay: bash thu-hotspot.sh  (ghi ket qua vao /tmp/hotspot-test.log)
# Can cat mang co day (VBoxManage controlvm AgentOS-Test setlinkstate1 off) truoc khi dich vu quyet dinh phat Wi-Fi.
exec > /tmp/hotspot-test.log 2>&1
S="sudo -S"; P=agentostestpw
echo $P | $S modprobe mac80211_hwsim radios=2; sleep 3
echo "== thiet bi"; nmcli -t device status
echo $P | $S systemctl restart agentos-wizard
echo "== cho Wi-Fi tam (45s)"; sleep 50
echo "== hotspot.json"; echo $P | $S cat /var/lib/agentos-wizard/hotspot.json
echo "== nmcli ket noi"; nmcli -t connection show --active
echo "== bang quet tu wlan1"; nmcli -t -f SSID dev wifi list ifname wlan1 --rescan yes
SSID=$(echo $P | $S python3 -c "import json;print(json.load(open('/var/lib/agentos-wizard/hotspot.json'))['ssid'])")
PSK=$(echo $P | $S python3 -c "import json;print(json.load(open('/var/lib/agentos-wizard/hotspot.json'))['psk'])")
echo "== dien thoai ao (wlan1) noi vao $SSID"; echo $P | $S nmcli dev wifi connect "$SSID" password "$PSK" ifname wlan1; sleep 8
ip -4 addr show wlan1
echo "== trang cai dat tu phia dien thoai (khong ma, phai vao duoc)"
curl -s --interface wlan1 -m 8 http://10.42.0.1:8088/api/state | head -c 400; echo
echo "== captive (ten mien bat ky -> 302 ve may)"
curl -s -i --interface wlan1 -m 8 http://captive.example.com/generate_204 | head -n 5
echo "== DNS bat ky"; getent hosts www.google.com
echo "== xong"
