# Ghi ảnh ISO AgentOS vào USB (XÓA SẠCH USB). Tự xin quyền quản trị (hộp UAC).
#   .\ghi-usb.ps1 -Iso <đường dẫn .iso> -Disk <số ổ> -Size <số byte của ổ, để chắc đúng USB> -Log <tệp nhật ký>
# Chỉ ghi khi ổ là USB, không phải ổ hệ thống/khởi động và đúng dung lượng đã xác nhận.
param([Parameter(Mandatory)][string]$Iso, [Parameter(Mandatory)][int]$Disk, [Parameter(Mandatory)][long]$Size, [string]$Log = "$env:TEMP\ghi-usb.log")

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $a = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Iso `"$Iso`" -Disk $Disk -Size $Size -Log `"$Log`""
    Start-Process powershell -Verb RunAs -ArgumentList $a -Wait
    return
}

function L($m) { ("{0:HH:mm:ss} {1}" -f (Get-Date), $m) | Tee-Object -FilePath $Log -Append | Write-Host }
try {
    Remove-Item $Log -ErrorAction SilentlyContinue
    $d = Get-Disk -Number $Disk
    if ($d.BusType -ne 'USB' -or $d.IsSystem -or $d.IsBoot -or $d.Size -ne $Size) { throw "Ổ $Disk không khớp (USB/không phải ổ hệ thống/đúng dung lượng) - dừng." }
    $len = (Get-Item $Iso).Length
    if ($len % 512) { throw "Kích thước ISO không chia hết 512." }
    L "Ghi $Iso ($([math]::Round($len/1MB)) MB) vào $($d.FriendlyName) (ổ $Disk)"
    Clear-Disk -Number $Disk -RemoveData -RemoveOEM -Confirm:$false
    Set-Disk -Number $Disk -IsOffline $false -ErrorAction SilentlyContinue
    $buf = New-Object byte[] (4MB)
    $in = [IO.File]::OpenRead($Iso)
    $out = New-Object IO.FileStream("\\.\PhysicalDrive$Disk", 'Open', 'Write', 'ReadWrite', 4MB)
    $done = 0L
    while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
        $w = [int]([math]::Ceiling($n / 512.0) * 512)
        if ($w -gt $n) { [Array]::Clear($buf, $n, $w - $n) }
        $out.Write($buf, 0, $w); $done += $n
        if (($done / 4MB) % 64 -lt 1) { L "  $([math]::Round($done/1MB)) MB" }
    }
    $out.Flush(); $out.Dispose(); $in.Dispose()
    L "Ghi xong, đang đọc lại để kiểm..."
    $a = [Security.Cryptography.SHA256]::Create(); $b = [Security.Cryptography.SHA256]::Create()
    $h1 = (Get-FileHash $Iso -Algorithm SHA256).Hash
    $r = New-Object IO.FileStream("\\.\PhysicalDrive$Disk", 'Open', 'Read', 'ReadWrite', 4MB)
    $left = $len
    while ($left -gt 0) {
        $want = [int][math]::Min($left, 4MB); $got = $r.Read($buf, 0, [int]([math]::Ceiling($want / 512.0) * 512))
        $b.TransformBlock($buf, 0, $want, $null, 0) | Out-Null; $left -= $want
    }
    $b.TransformFinalBlock($buf, 0, 0) | Out-Null; $r.Dispose()
    $h2 = [BitConverter]::ToString($b.Hash).Replace("-","")
    if ($h1 -eq $h2) { L "KIỂM OK: dữ liệu trên USB khớp ISO ($h2)"; L "HOAN TAT" } else { L "LỖI: không khớp!"; L "iso=$h1"; L "usb=$h2" }
} catch { L "LỖI: $($_.Exception.Message)" }
