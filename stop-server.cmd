@echo off
setlocal enabledelayedexpansion
set "SRVPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:"LISTENING" ^| findstr /c:":3212 " ') do set "SRVPID=%%p"
if not defined SRVPID (
    echo No process is listening on port 3212.
    echo.
    pause
    exit /b 0
)
echo Stopping server PID !SRVPID! ...
taskkill /PID !SRVPID! /T /F
echo.
pause
