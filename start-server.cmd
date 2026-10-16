@echo off
cd /d "%~dp0"
title Shukao API - 127.0.0.1:3212
echo ============================================================
echo  Shukao local API and admin server
echo    admin : http://127.0.0.1:3212/admin/
echo    health: http://127.0.0.1:3212/health
echo  Keep this window open. Close it to stop the server.
echo ============================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node was not found in PATH.
    echo         Install Node.js 22+ or add it to PATH, then retry.
    echo.
    pause
    exit /b 1
)
rem 让服务端出站也走本机代理：Node 的内置 fetch 默认不读 Windows 系统代理，
rem 上游按地区限制时报 451（浏览器/Codex++ 能连、后台连不上就是这个原因）。
rem 这里复用 apps/api/src/outbound-proxy.js 的解析逻辑生成环境变量。
for /f "usebackq delims=" %%p in (`node scripts\tools\print-proxy-env.js`) do %%p
node apps\api\src\server.js
echo.
echo Server exited with code %ERRORLEVEL%.
echo Press any key to close this window.
pause >nul
