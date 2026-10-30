@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动全局使用量统计仪表盘 (Claude + Antigravity)...
node src/server.mjs --open
pause
