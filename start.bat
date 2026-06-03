@echo off
REM Start the server (port 3000)
REM If you've edited client/src/* files, run build.bat first
cd /d "%~dp0"
echo.
echo === Starting TikTok LIVE Tools ===
echo Open: http://localhost:3000
echo Press Ctrl+C to stop
echo.
node server.js
pause
