#!/usr/bin/env bash
# ==============================================================================
# Automated Database Backup Cron Runner for Hydraulic System
# Usage: Run via cron (e.g. daily at 23:30)
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_FILE="/var/log/hydraulic-backup.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting automated database backup..." >> "${LOG_FILE}"

# Rotate log file if > 10MB
if [ -f "${LOG_FILE}" ] && [ "$(stat -c%s "${LOG_FILE}" 2>/dev/null || stat -f%z "${LOG_FILE}" 2>/dev/null || echo 0)" -gt 10485760 ]; then
    mv "${LOG_FILE}" "${LOG_FILE}.old"
fi

cd "${APP_DIR}"

if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
elif [ -f "/usr/bin/node" ]; then
    NODE_BIN="/usr/bin/node"
else
    NODE_BIN="/usr/local/bin/node"
fi

if "${NODE_BIN}" backup-cli.js --label daily >> "${LOG_FILE}" 2>&1; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Automated backup completed successfully." >> "${LOG_FILE}"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Automated backup failed!" >> "${LOG_FILE}"
    exit 1
fi
