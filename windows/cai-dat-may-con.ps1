# CAI DAT MAY CON WINDOWS cho Doi may AgentOS (chay bang "Run as administrator").
#   powershell -ExecutionPolicy Bypass -File cai-dat-may-con.ps1 -Ten "May van phong"
# Lam: copy chuong trinh vao %ProgramData%\AgentOS, tao khoa bi mat, mo cong 8433 CHI cho mang Tailscale (100.64.0.0/10),
#      tao tac vu tu chay khi dang nhap Windows. In ra DIA CHI + KHOA de nhap vao may dau nao (Cai dat -> Doi may, hoac /may them ...).
# Go bo: powershell -ExecutionPolicy Bypass -File cai-dat-may-con.ps1 -GoBo
param([string]$Ten = $env:COMPUTERNAME, [int]$Cong = 8433, [switch]$GoBo, [switch]$ChoPhepDoiKhoa, [switch]$KhongSSH)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:ProgramData 'AgentOS'
$task = 'AgentOS May Con'
$rule = 'AgentOS May Con (Tailscale)'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Can chay bang Run as administrator.' -ForegroundColor Red; exit 1 }

if ($GoBo) {
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*may-con-windows.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Host 'Da go may con Windows (giu lai thu muc du lieu: ' $dest ').'; exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Chua co Node.js. Cai: winget install OpenJS.NodeJS.LTS  (roi chay lai script nay)' -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $here 'may-con-windows.js') $dest -Force
Copy-Item (Join-Path $here '..\orchestrator\src\fleet.js') $dest -Force -ErrorAction SilentlyContinue
if (-not (Test-Path (Join-Path $dest 'fleet.js'))) { Copy-Item (Join-Path $here 'fleet.js') $dest -Force }
Copy-Item (Join-Path $here '..\orchestrator\src\tsowner.js') $dest -Force -ErrorAction SilentlyContinue
if (-not (Test-Path (Join-Path $dest 'tsowner.js'))) { Copy-Item (Join-Path $here 'tsowner.js') $dest -Force }

# dia chi Tailscale (neu da cai) de chi nghe tren mang Tailscale
$ts = $null; $tsExe = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $tsExe -and (Test-Path 'C:\Program Files\Tailscale\tailscale.exe')) { $tsExe = 'C:\Program Files\Tailscale\tailscale.exe' }
if ($tsExe) { $ts = (& $tsExe ip -4 2>$null | Select-Object -First 1) }
if (-not $ts) { Write-Host 'Chua thay Tailscale dang chay: cai va dang nhap Tailscale (winget install Tailscale.Tailscale) roi chay lai de may con chi nghe tren mang Tailscale. Tam thoi nghe tren moi mang noi bo.' -ForegroundColor Yellow }

# tao/giu khoa bi mat
$env:AGENTOS_FLEET_FILE = Join-Path $dest 'fleet.json'
$js = "const {createFleet}=require('./fleet');const f=createFleet({file:process.env.AGENTOS_FLEET_FILE});const a=f.enableAgent({name:process.argv[1],port:Number(process.argv[2]),host:process.argv[3]||''});console.log(a.key);"
Push-Location $dest; $key = (& $node -e $js $Ten $Cong $ts) | Select-Object -Last 1; Pop-Location

# AI chi doc: uu tien Claude Code, sau do Codex
$confFile = Join-Path $dest 'windows-agent.json'
if (-not (Test-Path $confFile)) {
  $ai = 'none'; if (Get-Command claude -ErrorAction SilentlyContinue) { $ai = 'claude' } elseif (Get-Command codex -ErrorAction SilentlyContinue) { $ai = 'codex' }
  [IO.File]::WriteAllText($confFile, (@{ ai = $ai; workdir = (Join-Path $env:USERPROFILE 'AgentOS-May-Con'); timeoutSec = 600 } | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
}

# Cho may dau nao (cung tai khoan Tailscale) SSH vao: bat OpenSSH Server (chi mang Tailscale) va nhan khoa SSH cong khai tu may dau nao (lenh /ketnoi tren Telegram).
if (-not $KhongSSH) {
  $c = (Get-Content $confFile -Raw).TrimStart([char]0xFEFF) | ConvertFrom-Json
  $c | Add-Member -NotePropertyName allowSshKey -NotePropertyValue $true -Force
  [IO.File]::WriteAllText($confFile, ($c | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))      # UTF-8 KHONG BOM (Node doc JSON co BOM se loi)
  if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null }
  Set-Service -Name sshd -StartupType Automatic; Start-Service sshd
  Get-NetFirewallRule -Name 'sshd' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Get-NetFirewallRule -DisplayName 'AgentOS SSH (Tailscale)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName 'AgentOS SSH (Tailscale)' -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress '100.64.0.0/10' -Action Allow | Out-Null
  # sshd mac dinh doc khoa tai khoan quan tri o ProgramData\ssh\administrators_authorized_keys: doi sang thu muc nguoi dung nhu tai khoan thuong
  $cfg = Join-Path $env:ProgramData 'ssh\sshd_config'
  if (Test-Path $cfg) {
    $t = Get-Content $cfg -Raw
    if ($t -match '(?m)^\s*Match\s+Group\s+administrators') {
      Copy-Item $cfg ($cfg + '.agentos-bak') -Force
      $t = [regex]::Replace($t, '(?m)^(\s*)(Match\s+Group\s+administrators)', '$1#$2')
      $t = [regex]::Replace($t, '(?m)^(\s*)(AuthorizedKeysFile\s+__PROGRAMDATA__/ssh/administrators_authorized_keys)', '$1#$2')
      Set-Content -Path $cfg -Value $t -Encoding ASCII
      Restart-Service sshd
    }
  }
}

# tuong lua: chi mang Tailscale duoc vao cong may con
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Cong -RemoteAddress '100.64.0.0/10' -Action Allow | Out-Null

# tu chay khi dang nhap Windows (an cua so)
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $dest 'may-con-windows.js') + '"') -WorkingDirectory $dest
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited | Out-Null
Start-ScheduledTask -TaskName $task

$addr = if ($ts) { $ts } else { (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress }
Write-Host ''
Write-Host '=== XONG. Nhap vao MAY DAU NAO (Cai dat -> Doi may -> Them may, hoac Telegram) ===' -ForegroundColor Green
Write-Host ('Ten  : ' + $Ten)
Write-Host ('Dia chi: http://' + $addr + ':' + $Cong)
Write-Host ('Khoa : ' + $key)
Write-Host 'CACH DON GIAN: may AgentOS dang nhap Tailscale CUNG TAI KHOAN roi go /ketnoi tren Telegram, bam Ket noi. Khong can nhap khoa.' -ForegroundColor Green
Write-Host ('(Cach thu cong neu can: /may them "' + $Ten + '" http://' + $addr + ':' + $Cong + ' <khoa trong ' + (Join-Path $dest 'fleet.json') + '>)')
Write-Host 'AI chay tren may nay (chi doc): xem ' $confFile
