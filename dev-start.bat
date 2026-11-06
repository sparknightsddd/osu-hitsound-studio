@echo off
rem ---------------------------------------------------------------
rem  osu Hitsound Studio - DEV launcher (with hot reload)
rem  Double-click this file to start the development version.
rem  Edit any file under src\ and the window updates automatically.
rem  For the standalone / distributable build use the EXE in release\.
rem ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [dev] ERROR: node was not found in PATH.
  echo [dev] Please install Node.js 18 or newer, then run this again.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [dev] ERROR: Electron runtime is missing.
  echo [dev] Please run:  npm install
  pause
  exit /b 1
)

if not exist "node_modules\.bin\vite.cmd" (
  echo [dev] ERROR: vite is missing.
  echo [dev] Please run:  npm install
  pause
  exit /b 1
)

echo [dev] Starting osu Hitsound Studio in development mode.
echo [dev] Keep this window open. Close it to quit the app.
echo.
npm run electron:dev

echo.
echo [dev] App exited.
pause
endlocal