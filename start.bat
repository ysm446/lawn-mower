@echo off
rem Lawn mower simulator launcher (development mode).
setlocal
cd /d "%~dp0"

rem Terminals opened from VS Code may set this, which stops Electron from starting.
set ELECTRON_RUN_AS_NODE=

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

call npm run dev
if errorlevel 1 (
  echo The app exited with an error.
  pause
  exit /b 1
)
endlocal
