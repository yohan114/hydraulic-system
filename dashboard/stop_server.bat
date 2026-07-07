@echo off
title Stop Dashboard Server
echo ===================================================
echo Stopping Hydraulic Hose Repair Dashboard Server...
echo ===================================================
echo.
taskkill /F /IM node.exe
echo.
echo Server processes have been terminated!
ping 127.0.0.1 -n 4 > nul
