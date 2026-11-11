@echo off
rem Lawn mower simulator launcher. Builds only when the source has changed, then runs the build.
setlocal
cd /d "%~dp0"

rem Terminals opened from VS Code may set this, which stops Electron from starting.
set ELECTRON_RUN_AS_NODE=

set "dependencies_updated="
if not exist node_modules (
  echo [start] Installing dependencies...
  call npm install
  if errorlevel 1 goto :error
  set "dependencies_updated=1"
)

rem Rebuild when the build output is missing or older than the source (e.g. after git pull).
if defined dependencies_updated goto :build
node tools\needs-build.mjs
if not errorlevel 1 goto :start

:build
echo [start] Running npm run build...
call npm run build
if errorlevel 1 goto :error

:start
rem "npm run start" would build again every time, so skip the build here.
call npx electron-vite preview --skipBuild
if errorlevel 1 goto :error
exit /b 0

:error
echo.
echo [start] An error occurred.
pause
exit /b 1
