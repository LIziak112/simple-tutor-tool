@echo off
setlocal
title simple-tutor-tool 测试模式
cd /d "%~dp0"

REM ============================================================
REM  测试/演示模式启动脚本（simple-tutor-tool v2）
REM  注意：本文件必须保持 GBK 编码 + CRLF 换行，双击运行才不乱码
REM  - 测试模式：双击本 .cmd 启动，直接用源码，改代码即时生效，
REM    不需要 pnpm build
REM  - 前端页面：http://localhost:5173（同一 Wi-Fi 下 iPad 也可访问）
REM  - API 由同一命令启动的本地服务提供，/api 请求自动转发
REM  - 数据目录：测试模式用仓库 data/（同一套数据，教学不会中断）
REM  - 停止服务：关闭本窗口或 Ctrl+C，结束时自动检测残留进程
REM
REM  启动加固（2026-10-08 排查后新增）：
REM   1. 端口 8787/5173 被占时列出占用进程，可选择清理后继续
REM   2. PORT 钉死 8787：防止外部注入的 PORT 环境变量（如某些
REM      工具会注入 PORT=前端端口）把后端端口带偏后崩溃
REM   3. stdin 接 NUL：tsx watch 在"开着但无数据的管道 stdin"环境
REM      下会整体卡死（表现为后端永远起不来），接 NUL 免疫
REM   4. 浏览器改为等后端健康检查通过后再打开（最多等 30 秒），
REM      不再盲等 3 秒
REM   5. 服务停止后检测 8787 残留监听：Windows 下结束外层命令
REM      不一定连带杀掉 node 子进程，残留会占用端口导致下次起不来
REM   6. 设置环境变量 TUTOR_NO_BROWSER=1 可跳过自动打开浏览器
REM ============================================================

REM 子任务入口：本脚本自我调用，负责"等后端就绪再开浏览器"
if /i "%~1"=="/openbrowser" goto openbrowser

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 24（https://nodejs.org/）
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
  echo [错误] 依赖未安装，请先在仓库目录执行：pnpm install
  pause
  exit /b 1
)

REM 端口预检：被占时显示占用者，可选择清理（也可能是别的测试模式
REM 窗口在跑，看清楚再决定，默认 N 不动它）
call :checkport 8787 || exit /b 1
call :checkport 5173 || exit /b 1

REM dev 默认会把库建在 apps/server/data，固定指向仓库 data/，
REM 保持测试模式数据同一套
set "DATA_DIR=%~dp0data"
REM 端口钉死，理由见文件头加固说明第 2 条
set "PORT=8787"

echo [提示] 测试模式启动中，就绪后自动打开 http://localhost:5173
echo [提示] 关闭本窗口（或 Ctrl+C）即停止服务
if not defined TUTOR_NO_BROWSER start "" /min cmd /c ""%~f0" /openbrowser"

REM 用嵌套 cmd /c 的形式而不是 "call pnpm dev <nul"：call+行内重定向的
REM 组合不能可靠地把 NUL stdin 传导给 tsx watch 深层子进程（2026-10-08
REM 实测三种环境对照）；嵌套形式在双击/前台/后台均验证通过
cmd /c "pnpm dev < NUL"

echo.
echo [提示] 服务已停止，正在检查残留进程…
call :sweepport 8787
echo [提示] 全部结束，可以关闭本窗口。
pause
exit /b 0

REM ---------- 子过程：端口占用检查（列出占用者，可选清理） ----------
:checkport
netstat -ano | findstr /c:":%~1 " | findstr "LISTENING" >nul 2>nul
if errorlevel 1 exit /b 0
echo [提示] 端口 %~1 已被占用，占用进程：
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%~1 " ^| findstr "LISTENING"') do (
  echo   - PID %%p：
  tasklist /fi "PID eq %%p" /fo table /nh 2>nul
)
echo   （可能是其他测试模式窗口在跑，也可能是上次异常退出的残留进程）
choice /c YN /t 15 /d N /m "是否结束上述进程并继续启动"
if errorlevel 2 (
  echo [错误] 端口 %~1 被占用，请先自行处理后再启动。
  pause
  exit /b 1
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%~1 " ^| findstr "LISTENING"') do taskkill /f /pid %%p >nul 2>nul
ping -n 3 127.0.0.1 >nul
netstat -ano | findstr /c:":%~1 " | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [错误] 端口 %~1 清理后仍被占用，无法启动。
  pause
  exit /b 1
)
echo [提示] 端口 %~1 已清理，继续。
exit /b 0

REM ---------- 子过程：停止后残留清扫（默认 Y，10 秒无操作自动清） ----------
:sweepport
netstat -ano | findstr /c:":%~1 " | findstr "LISTENING" >nul 2>nul
if errorlevel 1 (
  echo [提示] 端口 %~1 已释放，无残留。
  exit /b 0
)
echo [提示] 端口 %~1 仍有监听（外层命令结束后子进程可能残留）：
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%~1 " ^| findstr "LISTENING"') do (
  echo   - PID %%p：
  tasklist /fi "PID eq %%p" /fo table /nh 2>nul
)
choice /c YN /t 10 /d Y /m "是否结束残留进程"
if errorlevel 2 exit /b 0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%~1 " ^| findstr "LISTENING"') do taskkill /f /pid %%p >nul 2>nul
ping -n 2 127.0.0.1 >nul
echo [提示] 残留已清理，端口已释放。
exit /b 0

REM ---------- 子任务：等后端健康检查通过后打开浏览器 ----------
:openbrowser
title 测试模式-等待服务就绪
for /l %%i in (1,1,30) do (
  curl -s -o nul -m 2 http://127.0.0.1:8787/api/public/health && goto opened
  ping -n 2 127.0.0.1 >nul
)
exit /b 0
:opened
start "" http://localhost:5173
exit /b 0
