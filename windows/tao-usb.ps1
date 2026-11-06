# TAO-USB: chep bo cai may con len USB (chay tren MAY CUA CHU, khong can quyen quan tri).
#   powershell -ExecutionPolicy Bypass -File tao-usb.ps1            (hoi chon USB)
#   powershell -ExecutionPolicy Bypass -File tao-usb.ps1 -Usb E: -TaiSan -AuthKey tskey-auth-xxxx
# -TaiSan : tai san Node.js + Tailscale vao USB de cai duoc khi may kia khong co mang (them ~100 MB).
# -AuthKey: khoa Tailscale (tao o login.tailscale.com/admin/settings/keys, tick "Reusable", han 7 ngay) de may con vao mang khong can dang nhap.
#           Khoa nam trong file tailscale-authkey.txt tren USB: lam mat USB thi xoa khoa do tren trang Tailscale.
param([string]$Usb = '', [switch]$TaiSan, [string]$AuthKey = '', [switch]$Force)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProgressPreference = 'SilentlyContinue'

if (-not $Usb) {
  $dr = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' -ErrorAction SilentlyContinue)
  if (-not $dr.Count) { Write-Host 'Khong thay USB nao. Cam USB vao roi chay lai.' -ForegroundColor Red; exit 1 }
  Write-Host 'USB dang cam:'; $dr | ForEach-Object { Write-Host ('  ' + $_.DeviceID + '  ' + $_.VolumeName + '  (' + [math]::Round($_.Size / 1GB, 1) + ' GB)') }
  $Usb = Read-Host 'Go ky tu o USB (vi du E:)'
}
$Usb = $Usb.Trim().TrimEnd('\'); if ($Usb.Length -eq 1) { $Usb += ':' }
if ($Usb -notmatch '^[A-Za-z]:$') { Write-Host 'O dia khong hop le, vi du E:' -ForegroundColor Red; exit 1 }
$disk = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $Usb.ToUpper() + "'") -ErrorAction SilentlyContinue
if (-not $disk) { Write-Host ('Khong thay o ' + $Usb) -ForegroundColor Red; exit 1 }
if ($disk.DriveType -ne 2 -and -not $Force) { Write-Host ('O ' + $Usb + ' khong phai USB/o thao roi (dung -Force neu chac chan).') -ForegroundColor Red; exit 1 }
$root = $Usb + '\'

# Chep chuong trinh (chi GHI THEM tren USB, khong xoa gi cua anh)
$w = Join-Path $root 'windows'; New-Item -ItemType Directory -Force -Path $w | Out-Null
foreach ($f in 'cai-dat-may-con.ps1', 'cai-rustdesk-va-ssh.ps1', 'may-con-windows.js', 'mo-messenger.ps1', 'cap-nhat-may-con.bat') { Copy-Item (Join-Path $here $f) $w -Force }
foreach ($f in 'fleet.js', 'tsowner.js') { $src = Join-Path $here ('..\orchestrator\src\' + $f); if (-not (Test-Path $src)) { Write-Host ('Thieu ' + $src) -ForegroundColor Red; exit 1 }; Copy-Item $src $w -Force }
Copy-Item (Join-Path $here 'usb\CAI-MAY-CON.bat') $root -Force
Copy-Item (Join-Path $here 'usb\usb-cai.ps1') $root -Force

$huongDan = @"
CAI MAY CON AGENTOS TU USB
==========================
1. Cam USB nay vao may Windows can bien thanh MAY CON (may van phong, may kho...).
2. Mo USB, bam dup file  CAI-MAY-CON.bat  -> bam Yes khi Windows hoi quyen quan tri.
3. Go ten goi may (hoac Enter). Neu USB khong co khoa Tailscale, trinh duyet se mo: dang nhap Tailscale bang tai khoan cua hang.
4. Cho den khi hien "XONG". Rut USB.
5. Tren dien thoai: Telegram -> bot hien the "Ket noi" -> bam nut. Roi go /vao <ten may> de dieu khien.

Luu y: Windows khong cho USB tu chay khi cam (de tranh virus), nen phai bam dup file o buoc 2.
Neu loi, xem file nhat ky: %TEMP%\agentos-usb-cai.log
"@
[IO.File]::WriteAllText((Join-Path $root 'HUONG-DAN.txt'), $huongDan, (New-Object Text.UTF8Encoding $false))

if ($AuthKey) {
  if ($AuthKey -notmatch '^tskey-[A-Za-z0-9-]{10,200}$') { Write-Host 'Khoa Tailscale phai co dang tskey-auth-...' -ForegroundColor Red; exit 1 }
  [IO.File]::WriteAllText((Join-Path $root 'tailscale-authkey.txt'), $AuthKey, (New-Object Text.UTF8Encoding $false))
  Write-Host 'Da ghi khoa Tailscale vao USB (tailscale-authkey.txt).' -ForegroundColor Yellow
}

if ($TaiSan) {
  $cs = Join-Path $root 'cai-san'; New-Item -ItemType Directory -Force -Path $cs | Out-Null
  Write-Host 'Tai Node.js LTS...'
  $idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $v = ($idx | Where-Object { $_.lts } | Select-Object -First 1).version
  Invoke-WebRequest ('https://nodejs.org/dist/' + $v + '/node-' + $v + '-x64.msi') -OutFile (Join-Path $cs ('node-' + $v + '-x64.msi')) -UseBasicParsing
  Write-Host 'Tai Tailscale...'
  Invoke-WebRequest 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi' -OutFile (Join-Path $cs 'tailscale-setup-latest-amd64.msi') -UseBasicParsing
}

Write-Host ''
Write-Host ('XONG. USB ' + $Usb + ' da san sang. Cam vao may can cai, bam dup CAI-MAY-CON.bat.') -ForegroundColor Green
if (-not $AuthKey) { Write-Host 'Khong co khoa Tailscale: moi may se mo trinh duyet de anh dang nhap Tailscale mot lan.' }
