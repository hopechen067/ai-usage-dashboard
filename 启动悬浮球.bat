@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Sta -File "%~dp0src\floating-ball.ps1"
