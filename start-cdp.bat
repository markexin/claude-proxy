@echo off
setlocal EnableExtensions
title Chrome CDP

rem Edit if needed. Port must match webCdpUrl in config.json (default 9222).
set "CDP_PORT=9222"
set "PROFILE=%LOCALAPPDATA%\doubao-chrome-cdp"
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"

if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo ERROR: Chrome not found. Edit CHROME in this BAT.
  pause
  exit /b 1
)

if not exist "%PROFILE%" mkdir "%PROFILE%" 2>nul

echo Starting Chrome with remote debugging on port %CDP_PORT%
echo User data dir: %PROFILE%
echo.
echo Then run manually, e.g.: node src\cli.js web-serve
echo.

start "" "%CHROME%" --remote-debugging-port=%CDP_PORT% --user-data-dir="%PROFILE%"

echo Chrome started. Close this window when done reading.
pause
endlocal
