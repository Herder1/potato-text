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
node apps\api\src\server.js
echo.
echo Server exited with code %ERRORLEVEL%.
echo Press any key to close this window.
pause >nul
