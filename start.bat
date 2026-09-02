@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo rss-feed-extractor needs Node.js 18.17 or newer.
  echo Download the LTS installer from https://nodejs.org/ and run this again.
  echo.
  pause
  exit /b 1
)

node src\cli.js %*
if errorlevel 1 pause
