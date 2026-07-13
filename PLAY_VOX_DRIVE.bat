@echo off
setlocal
cd /d "%~dp0"
title VOX DRIVE - Local Server

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-server.ps1"

if errorlevel 1 (
  echo.
  echo The game server could not be started.
  echo Close any other VOX DRIVE server window, then try again.
  pause
)
