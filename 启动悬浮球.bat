@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: 确保用户临时目录有效，避免非管理员权限下 Add-Type 动态编译失败
if exist "%LOCALAPPDATA%\Temp" (
    set "TEMP=%LOCALAPPDATA%\Temp"
    set "TMP=%LOCALAPPDATA%\Temp"
)

:: 确保 Node.js 路径在 PATH 中
if exist "C:\Program Files\nodejs" (
    set "PATH=C:\Program Files\nodejs;%PATH%"
)

start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Sta -File "%~dp0src\floating-ball.ps1"
