# MO CUA SO "MESSENGER TRUC" - cua so Chrome RIENG chi co mot tab Messenger (may con Windows doc so tin chua doc tu tieu de cua so nay).
#   powershell -ExecutionPolicy Bypass -File mo-messenger.ps1            mo cua so (lan dau: dang nhap Facebook mot lan)
#   powershell -ExecutionPolicy Bypass -File mo-messenger.ps1 -TaoLoiTat tao bieu tuong "Messenger truc" tren man hinh nen (khong mo)
# Tu chon ho so Chrome co tien ich Claude in Chrome (de AI dung duoc); chon ho so khac: -Profile "Profile 1".
# Giu cua so nay mo (thu nho cung duoc) va chi de MOT tab Messenger trong do. Khong dong, khong chuyen tab khac len truoc.
param([string]$Profile = '', [switch]$TaoLoiTat)
$ErrorActionPreference = 'Stop'
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Host 'Khong thay Google Chrome tren may nay.' -ForegroundColor Red; exit 1 }

if (-not $Profile) {
  $ud = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  foreach ($d in (Get-ChildItem $ud -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(Default|Profile \d+)$' })) {
    $ext = Join-Path $d.FullName 'Extensions'; if (-not (Test-Path $ext)) { continue }
    foreach ($e in (Get-ChildItem $ext -Directory)) {
      $m = Get-ChildItem $e.FullName -Directory | Select-Object -First 1; if (-not $m) { continue }
      $j = Join-Path $m.FullName 'manifest.json'; if (-not (Test-Path $j)) { continue }
      try { $n = (Get-Content $j -Raw -Encoding UTF8 | ConvertFrom-Json).name } catch { continue }
      if ($n -match '^Claude') { $Profile = $d.Name }
    }
  }
  if (-not $Profile) { $Profile = 'Default'; Write-Host 'Khong thay tien ich Claude in Chrome trong ho so nao: dung ho so Default. Cai tien ich tai https://claude.ai/chrome roi chay lai.' -ForegroundColor Yellow }
}
$args2 = '--profile-directory="' + $Profile + '" --new-window https://www.messenger.com/'

if ($TaoLoiTat) {
  $sh = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Messenger truc.lnk'))
  $sh.TargetPath = $chrome; $sh.Arguments = $args2; $sh.WorkingDirectory = Split-Path $chrome; $sh.IconLocation = $chrome + ',0'; $sh.Description = 'Cua so Messenger cho tro ly truc AgentOS'; $sh.Save()
  Write-Host 'Da tao bieu tuong "Messenger truc" tren man hinh nen (ho so Chrome: ' $Profile ').' -ForegroundColor Green
  exit 0
}
Start-Process $chrome -ArgumentList $args2
Write-Host ('Da mo Messenger (ho so Chrome: ' + $Profile + '). Dang nhap Facebook mot lan neu duoc hoi, roi de cua so nay mo.') -ForegroundColor Green
