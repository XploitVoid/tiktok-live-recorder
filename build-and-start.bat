@echo off
setlocal
REM Build the client AND start the server in one go
REM Use this for: edit -> see results in one click
cd /d "%~dp0"
echo.
echo === [1/2] Building client ===
echo.
call npm.cmd --prefix client run build
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed
    pause
    exit /b 1
)
echo.
echo === [2/2] Starting server ===
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
