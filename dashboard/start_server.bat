@echo off
title Hydraulic Hose Repair Dashboard Server
echo ===================================================
echo Starting Hydraulic Hose Repair Dashboard Server...
echo ===================================================
echo.
cd /d "%~dp0"
node server.js
echo.
echo Server has stopped.
pause
