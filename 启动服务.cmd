@echo off
title simple-tutor-tool 服务
cd /d "%~dp0"

REM ============================================================
REM  生产模式启动脚本（simple-tutor-tool v2）
REM  - 产物缺失时自动先执行 pnpm build（需要 Node.js 24 + pnpm）
REM  - 产物已存在时会询问是否重新构建（改过代码后选 Y）
REM  - 单进程托管：API + 前端页面 + /api/public/spec/*，端口 8787
REM  - 数据目录：仓库 data/（自动建库；首次访问 /t 进入教师设置向导）
REM  - 停止服务：关闭本窗口或按 Ctrl+C
REM ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 24：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "apps\web\dist\index.html" goto mustbuild
if not exist "apps\server\dist\index.js" goto mustbuild

REM 产物已存在：改过代码后输入 Y 重新构建生效；直接回车用现有产物快速启动
set "REBUILD=N"
set /p "REBUILD=启动前重新构建最新代码？[Y/N]（直接回车=N，用现有产物启动）: "
if /i "%REBUILD%"=="Y" goto build
goto run

:mustbuild
echo [启动] 构建产物缺失，需要先构建（首次约 1-2 分钟）...

:build
echo [启动] 开始构建...
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 pnpm，请先执行：npm install -g pnpm
  pause
  exit /b 1
)
call pnpm build
if errorlevel 1 (
  echo [错误] 构建失败，请在仓库根目录手动运行 pnpm build 排查
  pause
  exit /b 1
)

:run
echo [启动] 服务运行中：http://localhost:8787  （关闭本窗口即停止）
set "NODE_ENV=production"
start "" /min cmd /c "timeout /t 2 >nul & start http://localhost:8787"
node apps\server\dist\index.js
pause
