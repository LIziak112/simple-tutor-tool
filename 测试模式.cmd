@echo off
title simple-tutor-tool 测试模式
cd /d "%~dp0"

REM ============================================================
REM  测试/开发模式启动脚本（simple-tutor-tool v2）
REM  - 与生产模式（启动服务.cmd）的区别：直接跑源码，改代码即时生效
REM    （服务端改动自动重启、前端热更新），不需要 pnpm build
REM  - 前端页面：http://localhost:5173（同一 Wi-Fi 的 iPad 也可访问）
REM  - API 由同一命令并行启动的本地服务端提供，/api 请求自动转发
REM  - 数据目录与生产模式共用仓库 data/（同一份题库与学生名单）
REM  - 停止服务：关闭本窗口或按 Ctrl+C
REM  - 注意：与生产模式共用 8787 端口，两个窗口不能同时开
REM ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 24：https://nodejs.org/
  pause
  exit /b 1
)
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 pnpm，请先执行：npm install -g pnpm
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo [错误] 依赖未安装，请先在仓库根目录执行：pnpm install
  pause
  exit /b 1
)

REM 生产服务正在运行会导致端口冲突，先提示关闭
netstat -ano | findstr /c:":8787 " | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [提示] 端口 8787 已被占用：请先关闭正在运行的「启动服务」窗口，再启动测试模式。
  pause
  exit /b 1
)

REM dev 默认会把库建到 apps/server/data；固定指向仓库 data/，与生产模式共用一份数据
set "DATA_DIR=%~dp0data"

echo [启动] 测试模式运行中：http://localhost:5173  （关闭本窗口即停止）
start "" /min cmd /c "timeout /t 3 >nul & start http://localhost:5173"
call pnpm dev
pause
