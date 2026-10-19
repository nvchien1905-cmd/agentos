#!/bin/bash
# Chan doan dang nhap AI tren may that (chay bang root, KHONG in token):
#   curl -sL https://raw.githubusercontent.com/nvchien1905-cmd/agentos/main/scripts/chan-doan-ai.sh | sudo bash
B=/var/lib/agentos/.local/bin; H=/var/lib/agentos
E="HOME=$H PATH=$B:/usr/local/bin:/usr/bin:/bin"
echo "=== phien ban"; runuser -u agentos -- env $E $B/claude --version 2>&1 | tail -n 1; runuser -u agentos -- env $E $B/codex --version 2>&1 | tail -n 1
echo; echo "=== CODEX: trang thai dang nhap"
runuser -u agentos -- env $E $B/codex login status 2>&1 | tail -n 5; echo "(ma thoat: ${PIPESTATUS[0]})"
echo "--- tep dang nhap Codex:"; ls -l $H/.codex/auth.json 2>&1
echo "--- thu hoi dap Codex:"
echo 'Tra loi dung mot tu: OK' | timeout 100 runuser -u agentos -- env $E $B/codex exec --skip-git-repo-check --sandbox read-only - 2>&1 | tail -n 10
echo; echo "=== CLAUDE: token da luu o trinh huong dan?"
STATE=$(ls /var/lib/agentos-wizard/*.json 2>/dev/null | grep -v hotspot | head -n 1)
T=""; [ -n "$STATE" ] && T=$(python3 -c "import json,sys;print(json.load(open('$STATE')).get('claudeToken') or '')" 2>/dev/null)
echo "tep trang thai: ${STATE:-khong thay}"; echo "co token: $([ -n "$T" ] && echo CO || echo KHONG) (do dai ${#T}, 12 ky tu dau: ${T:0:12}...)"
echo "--- thu hoi dap Claude co token:"
echo 'Tra loi dung mot tu: OK' | timeout 100 runuser -u agentos -- env $E CLAUDE_CODE_OAUTH_TOKEN="$T" $B/claude -p --output-format json --max-turns 1 2>&1 | sed "s/$T/[token]/g" | tail -n 6
echo "--- thu hoi dap Claude khong token:"
echo 'Tra loi dung mot tu: OK' | timeout 100 runuser -u agentos -- env $E $B/claude -p --output-format json --max-turns 1 2>&1 | tail -n 4
echo; echo "=== xong"
