@echo off
rem dsh-opencode supervisor: watches the relay and restarts it if it stops.
title dsh-opencode relay (OpenCode Zen free tier)
:loop
curl.exe -s --max-time 2 -o NUL "http://127.0.0.1:9360/healthz"
if %errorlevel%==0 (
  timeout /t 15 /nobreak >nul
  goto loop
)
node "%~dp0zen-relay.mjs" >> "%~dp0relay-stdout.log" 2>&1
timeout /t 3 /nobreak >nul
goto loop
