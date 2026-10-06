# PowerShell Database Backup Runner for Hydraulic System
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path (Join-Path $ScriptDir "dashboard")

Write-Host "Running Hydraulic Database Backup..." -ForegroundColor Cyan
& node backup-cli.js @args
if ($LASTEXITCODE -eq 0) {
    Write-Host "Backup completed successfully." -ForegroundColor Green
} else {
    Write-Host "Backup failed with exit code $LASTEXITCODE." -ForegroundColor Red
}
