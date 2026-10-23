#!/usr/bin/env bash
set -euo pipefail
umask 077

if [ "${BFMR_BACKUP_WORKER_STOPPED:-}" != YES ]; then
    echo 'Stop all workers/supervisors and set BFMR_BACKUP_WORKER_STOPPED=YES for a coordinated backup.' >&2
    exit 1
fi
BACKUP_DIR="${BFMR_BACKUP_DIR:-$HOME/backups/bfmr}"
STATE_DIR="${BFMR_STATE_DIR:-$HOME/.local/state/bfmr}"
if [ -e "${STATE_DIR}.restore-incomplete" ]; then
    echo 'Reconcile the incomplete restore before making a new backup.' >&2
    exit 1
fi
mkdir -p "${BACKUP_DIR}"
TARGET_DIR="$(mktemp -d "${BACKUP_DIR}/$(date -u +'%Y%m%d_%H%M%S').XXXXXX")"
printf '%s\n' 'Backup incomplete; do not restore.' > "${TARGET_DIR}/INCOMPLETE"
# Use exported PostgreSQL settings; never evaluate .env as shell code or print
# a connection string. Explicit Docker selection avoids another database.
export PGDATABASE="${DATABASE_URL:-${PGDATABASE:-bfmr}}"
: "${PGUSER:?Export the reviewed backup administrator PGUSER}"
export PGUSER
DUMP=(pg_dump)
if [ -n "${BFMR_POSTGRES_CONTAINER:-}" ]; then
    DUMP=(docker exec --env PGHOST --env PGPORT --env PGUSER --env PGPASSWORD --env PGDATABASE "${BFMR_POSTGRES_CONTAINER}" pg_dump)
fi
"${DUMP[@]}" | gzip > "${TARGET_DIR}/database_bfmr.sql.gz"
if [ -d "${STATE_DIR}" ]; then
    tar -czf "${TARGET_DIR}/local_state.tar.gz" -C "$(dirname "${STATE_DIR}")" "$(basename "${STATE_DIR}")"
else
    EMPTY_STATE="$(mktemp -d)"
    trap 'rm -rf -- "${EMPTY_STATE}"' EXIT
    mkdir -p "${EMPTY_STATE}/$(basename "${STATE_DIR}")"
    tar -czf "${TARGET_DIR}/local_state.tar.gz" -C "${EMPTY_STATE}" "$(basename "${STATE_DIR}")"
    rm -rf -- "${EMPTY_STATE}"
    trap - EXIT
fi
(cd "${TARGET_DIR}" && sha256sum database_bfmr.sql.gz local_state.tar.gz > SHA256SUMS)
rm -- "${TARGET_DIR}/INCOMPLETE"
# Retention is operator-managed. Never delete recovery evidence during backup.
printf 'Coordinated backup completed: %s\n' "${TARGET_DIR}"
