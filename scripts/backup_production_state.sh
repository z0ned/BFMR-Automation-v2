#!/usr/bin/env bash
set -euo pipefail

# BFMR Automation v2 - Production State Backup Script
BACKUP_DIR="${BFMR_BACKUP_DIR:-$HOME/backups/bfmr}"
TIMESTAMP="$(date +'%Y%m%d_%H%M%S')"
TARGET_DIR="${BACKUP_DIR}/${TIMESTAMP}"
mkdir -p "${TARGET_DIR}"

echo "===================================================="
echo "  BFMR Automation v2 - Starting Production Backup"
echo "  Timestamp: ${TIMESTAMP}"
echo "  Target:    ${TARGET_DIR}"
echo "===================================================="

# Load .env if present in current directory
if [ -f ".env" ]; then
    echo "Loading environment from .env..."
    export $(grep -v '^#' .env | xargs -d '\n')
fi

DB_NAME="${PGDATABASE:-bfmr}"
DB_USER="${PGUSER:-bfmr_owner}"
DB_HOST="${PGHOST:-localhost}"
DB_PORT="${PGPORT:-5432}"

# 1. PostgreSQL Database Dump
echo "Dumping PostgreSQL database '${DB_NAME}'..."
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q '^bfmr-postgres$'; then
    echo "Detected running docker container 'bfmr-postgres', exporting via docker exec..."
    docker exec bfmr-postgres pg_dump -U bfmr -d "${DB_NAME}" | gzip > "${TARGET_DIR}/database_${DB_NAME}.sql.gz"
else
    echo "Dumping via native pg_dump..."
    pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" | gzip > "${TARGET_DIR}/database_${DB_NAME}.sql.gz"
fi

echo "Database dump created: ${TARGET_DIR}/database_${DB_NAME}.sql.gz"

# 2. Local State Directory Backup
STATE_DIR="${BFMR_STATE_DIR:-$HOME/.local/state/bfmr}"
if [ -d "${STATE_DIR}" ]; then
    echo "Backing up local state directory '${STATE_DIR}'..."
    tar -czf "${TARGET_DIR}/local_state.tar.gz" -C "$(dirname "${STATE_DIR}")" "$(basename "${STATE_DIR}")"
    echo "Local state archive created: ${TARGET_DIR}/local_state.tar.gz"
fi

# 3. Compute Checksums
echo "Generating SHA-256 checksums..."
cd "${TARGET_DIR}" && sha256sum * > SHA256SUMS
echo "Checksums saved to ${TARGET_DIR}/SHA256SUMS"

# 4. Retention (keep last 14 backups)
echo "Pruning older backups (retaining latest 14)..."
ls -dt "${BACKUP_DIR}"/20* 2>/dev/null | tail -n +15 | xargs -r rm -rf

echo "===================================================="
echo "  Backup completed successfully!"
echo "===================================================="
