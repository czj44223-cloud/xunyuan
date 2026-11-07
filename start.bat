@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js 22.22.2+（22.x）、24.15.0+（24.x）或26+：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 正在安装依赖，请稍候...
  call npm ci --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo.
echo 正在启动 寻源 · 信息收集台
echo 浏览器打开：http://127.0.0.1:8787
echo 关闭此窗口即可停止服务。
echo.
node src/server.js
pause

