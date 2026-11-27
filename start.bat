@echo off
setlocal
REM Start the server (port 3000)
REM If you've edited client/src/* files, run build.bat first
cd /d "%~dp0"
echo.
echo === Starting Live Stream Recorder ===
echo Open: http://localhost:3000
echo Press Ctrl+C to stop
echo.
node server.js
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Server exited with code %EXIT_CODE%
    pause
)
exit /b %EXIT_CODE%
