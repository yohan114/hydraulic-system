@echo off
cd /d "%~dp0dashboard"
node backup-cli.js --label manual
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Backup failed!
) else (
    echo [SUCCESS] Backup finished successfully.
)
pause
