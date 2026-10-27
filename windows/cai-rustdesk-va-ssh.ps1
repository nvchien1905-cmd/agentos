# CAI HAI CACH DIEU KHIEN KHAC cho may Windows (chay bang "Run as administrator"; moi muc hoi lai truoc khi lam):
#   A. RustDesk  - dieu khien MAN HINH tu may AgentOS (hoac dien thoai)
#   B. OpenSSH Server - chay LENH / chep tep, chi cho mang Tailscale (100.64.0.0/10)
#   C. Cho phep may dau nao AgentOS chep khoa SSH (lenh /ketnoi)
#   powershell -ExecutionPolicy Bypass -File cai-rustdesk-va-ssh.ps1
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Can chay bang Run as administrator.' -ForegroundColor Red; exit 1 }
function Hoi($c) { return ((Read-Host ($c + ' (y/n)')) -match '^[yY]') }

if (Hoi 'A. Cai RustDesk (dieu khien man hinh)') {
  winget install --id RustDesk.RustDesk -e --accept-package-agreements --accept-source-agreements
  Write-Host 'Mo RustDesk > bieu tuong bi mat khau > dat MAT KHAU CO DINH. Ghi lai ID RustDesk. Tren may AgentOS mo RustDesk va ket noi toi ID do.' -ForegroundColor Green
}
if (Hoi 'B. Bat OpenSSH Server (chi mang Tailscale)') {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
  Set-Service -Name sshd -StartupType Automatic; Start-Service sshd
  Get-NetFirewallRule -Name 'sshd' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Get-NetFirewallRule -DisplayName 'AgentOS SSH (Tailscale)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName 'AgentOS SSH (Tailscale)' -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress '100.64.0.0/10' -Action Allow | Out-Null
  Write-Host 'Da bat SSH (chi mang Tailscale). Them KHOA CONG KHAI cua may AgentOS (lay: cat ~/.ssh/id_ed25519.pub, tao bang ssh-keygen -t ed25519 neu chua co) vao:' -ForegroundColor Green
  Write-Host '  - tai khoan thuong: %USERPROFILE%\.ssh\authorized_keys' ; Write-Host '  - tai khoan quan tri: C:\ProgramData\ssh\administrators_authorized_keys (icacls chi cho Administrators + SYSTEM)'
  Write-Host 'Thu tu may AgentOS: ssh <ten-nguoi-dung>@<dia-chi-tailscale-may-nay>' -ForegroundColor Green
}
if (Hoi 'C. Cho phep may dau nao AgentOS tu chep KHOA SSH CONG KHAI sang may nay (lenh /ketnoi tren Telegram; khong can go mat khau)') {
  $dir = Join-Path $env:ProgramData 'AgentOS'; New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $f = Join-Path $dir 'windows-agent.json'
  $c = if (Test-Path $f) { Get-Content $f -Raw | ConvertFrom-Json } else { [pscustomobject]@{ ai = 'none' } }
  $c | Add-Member -NotePropertyName allowSshKey -NotePropertyValue $true -Force
  ($c | ConvertTo-Json) | Set-Content -Encoding UTF8 $f
  # Tai khoan quan tri: sshd mac dinh doc khoa o ProgramData\ssh\administrators_authorized_keys (can quyen quan tri de ghi). Doi sang doc khoa trong thu muc nguoi dung nhu tai khoan thuong.
  $cfg = Join-Path $env:ProgramData 'ssh\sshd_config'
  if (Test-Path $cfg) {
    $t = Get-Content $cfg -Raw
    if ($t -match '(?m)^\s*Match\s+Group\s+administrators') {
      Copy-Item $cfg ($cfg + '.agentos-bak') -Force
      $t = [regex]::Replace($t, '(?m)^(\s*)(Match\s+Group\s+administrators)', '$1#$2')
      $t = [regex]::Replace($t, '(?m)^(\s*)(AuthorizedKeysFile\s+__PROGRAMDATA__/ssh/administrators_authorized_keys)', '$1#$2')
      Set-Content -Path $cfg -Value $t -Encoding ASCII
      Restart-Service sshd
      Write-Host 'Da doi sshd doc khoa trong thu muc nguoi dung (ban sao cu: sshd_config.agentos-bak).' -ForegroundColor Green
    }
  }
  Write-Host 'Xong. Tren Telegram cua may AgentOS go: /ketnoi <ten may nay trong Doi may>, bam "Cho phep".' -ForegroundColor Green
}
