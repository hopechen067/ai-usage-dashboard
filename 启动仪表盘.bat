@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: 优先检测 node 命令
set "NODE_CMD=node"
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set "NODE_CMD=C:\Program Files\nodejs\node.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\node\node.exe" (
        set "NODE_CMD=%LOCALAPPDATA%\Programs\node\node.exe"
    ) else if exist "C:\Program Files (x86)\nodejs\node.exe" (
        set "NODE_CMD=C:\Program Files (x86)\nodejs\node.exe"
    ) else (
        echo ============================================================
        echo [错误] 未检测到 Node.js 环境！
        echo 本项目需要 Node.js ^>= 22.0.0，请先安装 Node.js 或将其添加到 PATH 环境变量中。
        echo 官方下载地址: https://nodejs.org/
        echo ============================================================
        pause
        exit /b 1
    )
)

echo 正在启动全局使用量统计仪表盘 (Claude + Antigravity)...
"%NODE_CMD%" src/server.mjs --open
pause
