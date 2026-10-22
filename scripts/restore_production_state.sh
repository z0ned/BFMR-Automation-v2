#!/usr/bin/env bash
set -euo pipefail

# BFMR Automation v2 - Production State Restore Script
if [ $# -lt 1 ]; then
    echo "Usage: $0 <path_to_backup_directory>"
    echo "Example: $0 ~/backups/bfmr/20261022_153000"
    exit 1
fi

BACKUP_DIR="$1"

if [ ! -d "${BACKUP_DIR}" ]; then
    echo "ERROR: Backup directory '${BACKUP_DIR}' does not exist."
    exit 1
fi

echo "===================================================="
echo "  BFMR Automation v2 - Production State Restore"
echo "  Source: ${BACKUP_DIR}"
echo "===================================================="

# 1. Verify Checksums
if [ -f "${BACKUP_DIR}/SHA256SUMS" ]; then
    echo "Verifying SHA-256 checksums..."
    (cd "${BACKUP_DIR}" && sha256sum -c SHA256SUMS)
    echo "Checksums verified successfully."
else
    echo "WARNING: No SHA256SUMS file found in backup directory."
fi

# Load .env if present
if [ -f ".env" ]; then
    export $(grep -v '^#' .env | xargs -d '\n')
fi

DB_NAME="${PGDATABASE:-bfmr}"
DB_USER="${PGUSER:-bfmr_owner}"
DB_HOST="${PGHOST:-localhost}"
DB_PORT="${PGPORT:-5432}"

# 2. Database Restore
SQL_GZ="$(find "${BACKUP_DIR}" -name "database_*.sql.gz" | head -n 1)"
if [ -n "${SQL_GZ}" ] && [ -f "${SQL_GZ}" ]; then
    echo "Restoring database from '${SQL_GZ}'..."
    if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q '^bfmr-postgres$'; then
        echo "Restoring into docker container 'bfmr-postgres'..."
        gunzip -c "${SQL_GZ}" | docker exec -i bfmr-postgres psql -U bfmr -d "${DB_NAME}"
    else
        echo "Restoring via native psql..."
        gunzip -c "${SQL_GZ}" | psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}"
    fi
    echo "Database restored successfully."
fi

# 3. Local State Restore
STATE_ARCHIVE="${BACKUP_DIR}/local_state.tar.gz"
if [ -f "${STATE_ARCHIVE}" ]; then
    TARGET_PARENT="${HOME}/.local/state"
    mkdir -p "${TARGET_PARENT}"
    echo "Restoring state files into '${TARGET_PARENT}'..."
    tar -xzf "${STATE_ARCHIVE}" -C "${TARGET_PARENT}"
    echo "State files restored successfully."
fi

echo "===================================================="
echo "  Restore completed successfully!"
echo "===================================================="
