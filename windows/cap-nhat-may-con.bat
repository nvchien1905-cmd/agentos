@echo off
rem Cap nhat may con Windows: cho AI dung Chrome (tro ly truc Messenger) va TOAN QUYEN (ghi tep + chay lenh theo lenh may dau nao). Bam Yes o hop thoai UAC.
rem Muon ve che do chi doc: chay cai-dat-may-con.ps1 -ChiDoc (Run as administrator).
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoExit -ExecutionPolicy Bypass -File \"%~dp0cai-dat-may-con.ps1\" -Chrome -ToanQuyen'"
