# USB-CAI: chay tu USB (qua CAI-MAY-CON.bat), bien may Windows nay thanh MAY CON cua AgentOS.
# Lam lan luot: (1) Node.js  (2) Tailscale + vao mang cua hang  (3) cai may con (windows\cai-dat-may-con.ps1: cong 8433 chi mang Tailscale, SSH, RustDesk mat khau ngau nhien)
# Co san file cai trong thu muc cai-san\ tren USB thi dung (chay duoc khi khong co mang); khong co thi tai bang winget.
# File tailscale-authkey.txt tren USB (neu co) = khoa Tailscale de vao mang KHONG can dang nhap.
param([string]$Ten = '', [switch]$KhongHoi)
$ErrorActionPreference = 'Stop'
$usb = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $env:TEMP 'agentos-usb-cai.log'
try { Start-Transcript -Path $log -Force | Out-Null } catch { }
function Buoc($t) { Write-Host ''; Write-Host ('>> ' + $t) -ForegroundColor Cyan }
function Loi($t) { Write-Host ('LOI: ' + $t) -ForegroundColor Red }
function LamMoiPath { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function CaiSan($mau) { $f = Get-ChildItem -Path (Join-Path $usb 'cai-san') -Filter $mau -ErrorAction SilentlyContinue | Select-Object -First 1; if ($f) { $f.FullName } else { $null } }

try {
  if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Can quyen quan tri: dong cua so nay va bam dup lai CAI-MAY-CON.bat, chon Yes khi Windows hoi.' }

  # --- Ten may ---
  if (-not $Ten) {
    $mac = $env:COMPUTERNAME
    if ($KhongHoi) { $Ten = $mac } else { $in = Read-Host ('Ten de goi may nay trong cua hang (vi du: May van phong). Bam Enter de dung "' + $mac + '"'); $Ten = if ($in) { $in } else { $mac } }
  }
  $Ten = (($Ten -replace '[^A-Za-z0-9 _-]', '').Trim()); if ($Ten.Length -gt 30) { $Ten = $Ten.Substring(0, 30) }; if (-not $Ten) { $Ten = 'May-con' }
  Write-Host ('Ten may: ' + $Ten) -ForegroundColor Green

  # --- 1. Node.js ---
  Buoc '1/3 Node.js'
  LamMoiPath
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $msi = CaiSan 'node-*.msi'
    if ($msi) { Write-Host 'Cai Node.js tu USB...'; Start-Process msiexec.exe -ArgumentList ('/i "' + $msi + '" /qn /norestart') -Wait }
    else { Write-Host 'Cai Node.js bang winget (can mang)...'; winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null }
    LamMoiPath
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Khong cai duoc Node.js. Kiem tra mang roi chay lai, hoac chep file node-*.msi vao thu muc cai-san tren USB.' }
  }
  Write-Host ('Node.js ' + (node --version)) -ForegroundColor Green

  # --- 2. Tailscale ---
  Buoc '2/3 Tailscale (mang rieng cua cua hang)'
  $tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
  if (-not (Test-Path $tsExe)) {
    $ins = CaiSan 'tailscale-*.msi'
    if ($ins) { Write-Host 'Cai Tailscale tu USB...'; Start-Process msiexec.exe -ArgumentList ('/i "' + $ins + '" /qn /norestart') -Wait }
    else { $exe = CaiSan 'tailscale-*.exe'; if ($exe) { Write-Host 'Cai Tailscale tu USB...'; Start-Process $exe -ArgumentList '/quiet' -Wait } else { Write-Host 'Cai Tailscale bang winget (can mang)...'; winget install --id Tailscale.Tailscale -e --silent --accept-package-agreements --accept-source-agreements | Out-Null } }
    for ($i = 0; $i -lt 30 -and -not (Test-Path $tsExe); $i++) { Start-Sleep 2 }
    if (-not (Test-Path $tsExe)) { throw 'Khong cai duoc Tailscale.' }
  }
  Start-Service -Name Tailscale -ErrorAction SilentlyContinue
  function TsTrangThai { try { (& $tsExe status --json 2>$null | Out-String | ConvertFrom-Json) } catch { $null } }
  $st = TsTrangThai
  if (-not $st -or $st.BackendState -ne 'Running') {
    $keyFile = Join-Path $usb 'tailscale-authkey.txt'
    $key = if (Test-Path $keyFile) { (Get-Content $keyFile -Raw).Trim() } else { '' }
    $host1 = ($Ten.ToLower() -replace '[^a-z0-9-]', '-').Trim('-')
    if ($key) {
      Write-Host 'Vao mang Tailscale bang khoa tren USB (khong can dang nhap)...'
      & $tsExe up --auth-key=$key --unattended --hostname=$host1 | Out-Null
    } else {
      Write-Host 'Mo trinh duyet de DANG NHAP Tailscale bang tai khoan cua hang (dung tai khoan cua may dau nao)...' -ForegroundColor Yellow
      $job = Start-Job -ScriptBlock { param($e, $h) & $e up --unattended --hostname=$h } -ArgumentList $tsExe, $host1
      $opened = $false
      for ($i = 0; $i -lt 150; $i++) {
        Start-Sleep 2; $st = TsTrangThai
        if ($st -and $st.BackendState -eq 'Running') { break }
        if (-not $opened -and $st -and $st.AuthURL) { Start-Process $st.AuthURL; $opened = $true; Write-Host ('Neu trinh duyet khong tu mo, vao: ' + $st.AuthURL) }
      }
      Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue
    }
    $st = TsTrangThai
    if (-not $st -or $st.BackendState -ne 'Running') { throw 'Chua vao duoc mang Tailscale (chua dang nhap?). Chay lai CAI-MAY-CON.bat va dang nhap trong vong 5 phut.' }
  }
  $ip = (& $tsExe ip -4 2>$null | Select-Object -First 1)
  Write-Host ('Tailscale dang chay, dia chi ' + $ip) -ForegroundColor Green

  # --- 3. Cai may con ---
  Buoc '3/3 Cai may con AgentOS'
  $cai = Join-Path $usb 'windows\cai-dat-may-con.ps1'
  if (-not (Test-Path $cai)) { throw 'Thieu windows\cai-dat-may-con.ps1 tren USB. Tao lai USB bang TAO-USB.bat.' }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $cai -Ten $Ten
  if ($LASTEXITCODE -ne 0) { throw ('Cai may con bao loi (ma ' + $LASTEXITCODE + ').') }

  Write-Host ''
  Write-Host '=============================================' -ForegroundColor Green
  Write-Host (' XONG. May nay da thanh MAY CON: ' + $Ten) -ForegroundColor Green
  Write-Host '=============================================' -ForegroundColor Green
  Write-Host ' Buoc cuoi (tren dien thoai, 5 giay): mo Telegram, bot se hien the "Ket noi" cho may nay -> bam nut Ket noi. Neu chua thay the, go /ketnoi.'
  Write-Host ' Sau do go /vao ' $Ten ' de nhin va dieu khien man hinh may nay.'
  Write-Host ' Co the rut USB ra.'
} catch {
  Loi $_.Exception.Message
  Write-Host ('Nhat ky chi tiet: ' + $log)
  try { Stop-Transcript | Out-Null } catch { }
  exit 1
}
try { Stop-Transcript | Out-Null } catch { }
exit 0
