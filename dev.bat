@echo off
REM Development mode with hot reload
REM Opens 2 terminals: backend (port 3000) + Vite dev server (port 5173)
REM Use http://localhost:5173 for frontend with hot reload
cd /d "%~dp0"
echo.
echo === Starting DEV mode ===
echo Backend:  http://localhost:3000
echo Frontend: http://localhost:5173  (use this for hot reload)
echo.
start "Backend (port 3000)" cmd /k "set ALLOWED_HOSTS=localhost:5173,127.0.0.1:5173&& node server.js"
timeout /t 2 /nobreak >nul
start "Frontend dev (port 5173)" cmd /k "cd client && npm run dev"
echo.
echo Two windows opened. Close them to stop.
timeout /t 3 /nobreak >nul
