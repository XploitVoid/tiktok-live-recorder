@echo off
REM Build the React client (frontend) into client/dist
REM Use this after editing files in client/src/
echo.
echo === Building client ===
echo.
cd /d "%~dp0client"
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed
    pause
    exit /b 1
)
echo.
echo === Build complete ===
echo.
pause
