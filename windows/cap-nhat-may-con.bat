@echo off
rem Cap nhat may con Windows (cho phep AI dung Chrome cho tro ly truc Messenger). Bam Yes o hop thoai UAC.
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoExit -ExecutionPolicy Bypass -File \"%~dp0cai-dat-may-con.ps1\" -Chrome'"
