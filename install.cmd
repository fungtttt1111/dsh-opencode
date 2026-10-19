@echo off
setlocal
title dsh-opencode installer

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 20 or newer is required but "node" was not found in PATH.
  echo Install it from https://nodejs.org/ then run this installer again.
  echo.
  pause
  exit /b 1
)

node "%~dp0install.mjs" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo Installer exited with code %RC%.
pause
exit /b %RC%
