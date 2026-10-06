#!/usr/bin/env bash
# ==============================================================================
# Emergency Database Disaster Recovery & Restore Tool for Hydraulic System
# Usage:
#   sudo ./restore-vps.sh [path/to/backup.db]
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${APP_DIR}/.." && pwd)"

# Locate live database
if [ -f "${PROJECT_ROOT}/hydraulic.db" ]; then
    LIVE_DB="${PROJECT_ROOT}/hydraulic.db"
elif [ -f "${APP_DIR}/hydraulic.db" ]; then
    LIVE_DB="${APP_DIR}/hydraulic.db"
else
    LIVE_DB="${PROJECT_ROOT}/hydraulic.db"
fi

# Locate backup directories
BACKUP_DIRS=("${PROJECT_ROOT}/backups" "${APP_DIR}/backups")
VALID_BACKUPS=()

for bdir in "${BACKUP_DIRS[@]}"; do
    if [ -d "${bdir}" ]; then
        while IFS= read -r f; do
            [ -n "${f}" ] && VALID_BACKUPS+=("${f}")
        done < <(find "${bdir}" -type f -name "*.db" 2>/dev/null | sort -r)
    fi
done

echo "============================================================"
echo " Hydraulic System: Emergency Database Restore Tool"
echo "============================================================"
echo " Live Database Target: ${LIVE_DB}"
echo ""

SELECTED_BACKUP=""

if [ "${1:-}" != "" ]; then
    if [ -f "$1" ]; then
        SELECTED_BACKUP="$1"
    else
        echo "Error: Specified backup file '$1' does not exist."
        exit 1
    fi
else
    if [ ${#VALID_BACKUPS[@]} -eq 0 ]; then
        echo "No existing .db backups found in ${BACKUP_DIRS[*]}."
        echo "Please specify a backup file manually: ./restore-vps.sh /path/to/backup.db"
        exit 1
    fi

    echo "Available Verified Snapshots:"
    index=1
    for bfile in "${VALID_BACKUPS[@]}"; do
        size=$(stat -c%s "${bfile}" 2>/dev/null || stat -f%z "${bfile}" 2>/dev/null || echo 0)
        kb=$((size / 1024))
        echo "  [${index}] $(basename "${bfile}") (${kb} KB) - ${bfile}"
        index=$((index + 1))
    done
    echo ""

    read -rp "Select snapshot number to restore [1-${#VALID_BACKUPS[@]}] or 'q' to cancel: " choice
    if [ "${choice}" = "q" ] || [ "${choice}" = "Q" ]; then
        echo "Restore cancelled."
        exit 0
    fi

    if [[ "${choice}" =~ ^[0-9]+$ ]] && [ "${choice}" -ge 1 ] && [ "${choice}" -le ${#VALID_BACKUPS[@]} ]; then
        SELECTED_BACKUP="${VALID_BACKUPS[$((choice - 1))]}"
    else
        echo "Invalid selection. Aborted."
        exit 1
    fi
fi

echo ""
echo "Selected Backup: ${SELECTED_BACKUP}"
read -rp "WARNING: This will replace the current live database. Proceed? (yes/no): " confirm
if [ "${confirm}" != "yes" ]; then
    echo "Restore aborted by user."
    exit 0
fi

echo ""
echo "[1/5] Stopping application via PM2 to ensure zero active file locks..."
if command -v pm2 >/dev/null 2>&1; then
    pm2 stop hydraulic-system 2>/dev/null || true
fi

echo "[2/5] Creating safety snapshot of current live database..."
if [ -f "${LIVE_DB}" ]; then
    cp "${LIVE_DB}" "${LIVE_DB}.prerestore-$(date +%s)"
    echo "Safety backup created at: ${LIVE_DB}.prerestore-$(date +%s)"
fi

echo "[3/5] Restoring selected database..."
cp -f "${SELECTED_BACKUP}" "${LIVE_DB}"
# Clean up any stale WAL/SHM journal files
rm -f "${LIVE_DB}-wal" "${LIVE_DB}-shm"

echo "[4/5] Verifying SQLite integrity on restored database..."
if command -v sqlite3 >/dev/null 2>&1; then
    INTEGRITY=$(sqlite3 "${LIVE_DB}" "PRAGMA integrity_check;")
    FK_CHECK=$(sqlite3 "${LIVE_DB}" "PRAGMA foreign_key_check;")
    if [ "${INTEGRITY}" != "ok" ]; then
        echo "ERROR: Restored database integrity check failed: ${INTEGRITY}"
        exit 1
    fi
    if [ -n "${FK_CHECK}" ]; then
        echo "WARNING: Foreign key violations detected in restored database:"
        echo "${FK_CHECK}"
    fi
    echo "SQLite Integrity Check: PASSED (${INTEGRITY})"
fi

echo "[5/5] Restarting application via PM2..."
if command -v pm2 >/dev/null 2>&1; then
    pm2 restart hydraulic-system
fi

echo ""
echo "============================================================"
echo " RESTORE COMPLETED SUCCESSFULLY!"
echo " The system is back online and running the restored snapshot."
echo "============================================================"
