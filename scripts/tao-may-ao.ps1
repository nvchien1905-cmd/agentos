# Tạo máy ảo VirtualBox để thử ISO AgentOS.
#   .\scripts\tao-may-ao.ps1 -Iso "C:\duong-dan\agentos.iso"
# Cần đã cài VirtualBox. Không xóa/ghi đè gì ngoài máy ảo "AgentOS-Test" (nếu đã có thì dừng lại, không tạo đè).
param(
  [Parameter(Mandatory = $true)][string]$Iso,
  [string]$Name = 'AgentOS-Test',
  [int]$MemoryMb = 4096,
  [int]$Cpus = 2,
  [int]$DiskMb = 40960
)
$ErrorActionPreference = 'Stop'
$vbm = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
if (-not (Test-Path $vbm)) { throw 'Chưa cài VirtualBox (không thấy VBoxManage.exe).' }
if (-not (Test-Path $Iso)) { throw "Không thấy file ISO: $Iso" }
$existing = & $vbm list vms
if ($existing -match "`"$Name`"") { throw "Máy ảo '$Name' đã tồn tại. Xóa nó trong VirtualBox hoặc dùng -Name khác." }

& $vbm createvm --name $Name --ostype Debian_64 --register | Out-Null
$dir = Split-Path (& $vbm showvminfo $Name --machinereadable | Select-String '^CfgFile=' | ForEach-Object { ($_ -split '=', 2)[1].Trim('"') })
$disk = Join-Path $dir "$Name.vdi"

# EFI bật (giống mini PC thật); mạng NAT + chuyển cổng 2222 -> 22 để SSH vào máy ảo từ Windows: ssh -p 2222 <user>@127.0.0.1
& $vbm modifyvm $Name --memory $MemoryMb --cpus $Cpus --firmware efi --graphicscontroller vmsvga --vram 64 `
  --nic1 nat --natpf1 'ssh,tcp,127.0.0.1,2222,,22' --audio-driver none --boot1 dvd --boot2 disk --boot3 none --boot4 none
& $vbm createmedium disk --filename $disk --size $DiskMb --format VDI | Out-Null
& $vbm storagectl $Name --name SATA --add sata --controller IntelAhci
& $vbm storageattach $Name --storagectl SATA --port 0 --device 0 --type hdd --medium $disk
& $vbm storageattach $Name --storagectl SATA --port 1 --device 0 --type dvddrive --medium $Iso

Write-Host "Đã tạo máy ảo '$Name' ($MemoryMb MB RAM, $Cpus CPU, $($DiskMb/1024) GB đĩa, EFI). Khởi động:"
Write-Host "  & `"$vbm`" startvm $Name"
