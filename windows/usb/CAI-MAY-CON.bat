@echo off
rem BAM DUP file nay tren may Windows can bien thanh MAY CON. Se hien hop xin quyen quan tri: bam Yes.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0usb-cai.ps1"
echo.
pause
