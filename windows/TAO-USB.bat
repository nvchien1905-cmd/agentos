@echo off
rem BAM DUP file nay (tren may cua chu) de chep bo cai MAY CON len USB. Cam USB truoc.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tao-usb.ps1" -TaiSan
echo.
pause
