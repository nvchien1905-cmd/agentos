# Máy Windows trong cửa hàng điều khiển được từ máy AgentOS

Ba cách (làm được cả ba, độc lập nhau). Tất cả chạy qua **Tailscale** (cùng một tài khoản Tailscale với máy AgentOS) và chỉ mở cổng cho mạng Tailscale.

| | Cách | Làm được gì | Cài bằng |
|---|---|---|---|
| C | **Máy con Đội máy** (`may-con-windows.js`) | Máy Windows hiện trong `/may` của máy đầu não: xem tình trạng, giao việc cho AI chạy TRÊN máy này (chỉ đọc), kết quả về Telegram | `cai-dat-may-con.ps1` |
| A | **RustDesk** | Xem/điều khiển cả màn hình Windows | `cai-rustdesk-va-ssh.ps1` (mục A) |
| B | **OpenSSH + Tailscale** | Chạy lệnh PowerShell, chép tệp từ máy AgentOS | `cai-rustdesk-va-ssh.ps1` (mục B) |

## Cài máy con (C)
1. Cài Tailscale trên Windows (`winget install Tailscale.Tailscale`), đăng nhập cùng tài khoản với máy AgentOS.
2. Cần Node.js (`winget install OpenJS.NodeJS.LTS`) và một AI dòng lệnh (Claude Code hoặc Codex) đã đăng nhập.
3. Mở PowerShell **Run as administrator** trong thư mục này: `powershell -ExecutionPolicy Bypass -File cai-dat-may-con.ps1 -Ten "May van phong"`.
4. Script in ra địa chỉ, khóa và lệnh `/may them ...`: gõ lệnh đó (hoặc nhập ở Cài đặt → Đội máy) trên máy đầu não.
5. Gỡ: `cai-dat-may-con.ps1 -GoBo`.

AI chạy trên Windows luôn ở **chế độ chỉ đọc** (Claude: chỉ Read/Glob/Grep; Codex: read-only); tệp cấu hình `%ProgramData%\AgentOS\windows-agent.json` chọn `ai` (`claude`/`codex`/`none`) và thư mục làm việc.
