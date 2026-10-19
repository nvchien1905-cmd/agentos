# Tao may ao VirtualBox de thu ISO AgentOS.
#   .\scripts\tao-may-ao.ps1 -Iso "C:\duong-dan\agentos.iso"
# Can da cai VirtualBox. Khong xoa/ghi de gi ngoai may ao "AgentOS-Test" (neu da co thi dung lai, khong tao de).
# Ghi chu: file nay luu UTF-8 co BOM de Windows PowerShell 5.1 doc dung; VBoxManage in tien trinh ra stderr nen khong dung -ErrorAction Stop cho no.
param(
  [Parameter(Mandatory = $true)][string]$Iso,
  [string]$Name = 'AgentOS-Test',
  [int]$MemoryMb = 4096,
  [int]$Cpus = 2,
  [int]$DiskMb = 40960
)
$vbmExe = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
if (-not (Test-Path $vbmExe)) { throw 'Chua cai VirtualBox (khong thay VBoxManage.exe).' }
if (-not (Test-Path $Iso)) { throw "Khong thay file ISO: $Iso" }

# Chay VBoxManage, bo qua tien trinh (stderr), nem loi neu ma thoat khac 0.
function Vbm {
  $out = & $vbmExe @args 2>&1
  if ($LASTEXITCODE -ne 0) { throw ("VBoxManage " + ($args -join ' ') + " loi:`n" + ($out | Out-String)) }
  return $out
}

$existing = Vbm list vms
if ($existing -match ('"' + [regex]::Escape($Name) + '"')) { throw "May ao '$Name' da ton tai. Xoa no trong VirtualBox hoac dung -Name khac." }

Vbm createvm --name $Name --ostype Debian_64 --register | Out-Null
$cfg = (Vbm showvminfo $Name --machinereadable | Select-String '^CfgFile=' | ForEach-Object { ($_ -split '=', 2)[1].Trim('"') })
$dir = Split-Path $cfg
$disk = Join-Path $dir "$Name.vdi"

# EFI bat (giong mini PC that); mang NAT + chuyen cong 2222 -> 22 de SSH vao may ao tu Windows
Vbm modifyvm $Name --memory $MemoryMb --cpus $Cpus --firmware efi --graphicscontroller vmsvga --vram 64 `
  --nic1 nat --natpf1 'ssh,tcp,127.0.0.1,2222,,22' --audio-driver none --boot1 dvd --boot2 disk --boot3 none --boot4 none | Out-Null
Vbm createmedium disk --filename $disk --size $DiskMb --format VDI | Out-Null
Vbm storagectl $Name --name SATA --add sata --controller IntelAhci | Out-Null
Vbm storageattach $Name --storagectl SATA --port 0 --device 0 --type hdd --medium $disk | Out-Null
Vbm storageattach $Name --storagectl SATA --port 1 --device 0 --type dvddrive --medium $Iso | Out-Null

Write-Host "Da tao may ao '$Name' ($MemoryMb MB RAM, $Cpus CPU, $([int]($DiskMb/1024)) GB dia, EFI). Khoi dong:"
Write-Host "  & `"$vbmExe`" startvm $Name"
