#!/usr/bin/env bash
set -euo pipefail
umask 077

# Restore into an EMPTY replacement database with every writer stopped.
# SQL and filesystem publication cannot form one transaction. A failure marker
# survives if SQL commits but local-state publication fails; never restart then.
if [ "$#" -ne 1 ]; then
    echo 'Usage: BFMR_RESTORE_WORKER_STOPPED=YES scripts/restore_production_state.sh <backup-directory>' >&2
    exit 1
fi
if [ "${BFMR_RESTORE_WORKER_STOPPED:-}" != YES ]; then
    echo 'Stop every worker/supervisor first and set BFMR_RESTORE_WORKER_STOPPED=YES.' >&2
    exit 1
fi
BACKUP_DIR="$(realpath "$1")"
if [ -e "${BACKUP_DIR}/INCOMPLETE" ]; then
    echo 'The backup is incomplete; restore refused.' >&2
    exit 1
fi
STATE_DIR="${BFMR_STATE_DIR:-$HOME/.local/state/bfmr}"
STATE_PARENT="$(dirname "${STATE_DIR}")"
mkdir -p "${STATE_PARENT}"
MARKER="${STATE_DIR}.restore-incomplete"
if [ -e "${MARKER}" ]; then
    echo 'An earlier restore is incomplete. Reconcile its database and state before retry.' >&2
    exit 1
fi
if [ ! -f "${BACKUP_DIR}/SHA256SUMS" ] || [ ! -f "${BACKUP_DIR}/local_state.tar.gz" ]; then
    echo 'A checksummed database dump and local-state archive are required.' >&2
    exit 1
fi
shopt -s nullglob
DUMPS=("${BACKUP_DIR}"/database_*.sql.gz)
if [ "${#DUMPS[@]}" -ne 1 ]; then
    echo 'Expected exactly one database dump.' >&2
    exit 1
fi
SQL_GZ="${DUMPS[0]}"
# Require manifest coverage for BOTH artifacts, not just whatever was listed.
python3 - "${BACKUP_DIR}/SHA256SUMS" "$(basename "${SQL_GZ}")" <<'PY'
import re, sys
entries = {}
for line in open(sys.argv[1]):
    match = re.fullmatch(r'([0-9a-f]{64}) [ *]([^/\n]+)\n?', line)
    if not match or match[2] in entries or match[2] in ('.', '..'):
        raise SystemExit('Invalid checksum manifest.')
    entries[match[2]] = match[1]
if set(entries) != {sys.argv[2], 'local_state.tar.gz'}:
    raise SystemExit('Checksum manifest must cover exactly database and local state.')
PY
(cd "${BACKUP_DIR}" && sha256sum --status -c SHA256SUMS)
gzip -t "${SQL_GZ}"
STAGING="$(mktemp -d "${STATE_PARENT}/.bfmr-restore.XXXXXX")"
DB_COMMITTED=0
cleanup() {
    if [ "${DB_COMMITTED}" -eq 0 ]; then
        rm -rf -- "${STAGING}"
    else
        echo "Restore incomplete: retain staged state at ${STAGING}; keep all workers stopped." >&2
    fi
}
trap cleanup EXIT
# Stage and fully validate the archive BEFORE touching SQL. No links/devices,
# traversal, duplicate entries or unexpected top-level names are accepted.
python3 - "${BACKUP_DIR}/local_state.tar.gz" "${STAGING}" "$(basename "${STATE_DIR}")" <<'PY'
import os, pathlib, sys, tarfile
archive, staging, name = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as tar:
    seen = set()
    members = tar.getmembers()
    for entry in members:
        p = pathlib.PurePosixPath(entry.name)
        if (not p.parts or p.is_absolute() or '..' in p.parts or p.parts[0] != name
                or not (entry.isdir() or entry.isfile()) or entry.name in seen):
            raise SystemExit('Unsafe or unexpected state archive member.')
        seen.add(entry.name)
    tar.extractall(staging, members=members, filter='data')
for directory, _, files in os.walk(staging):
    os.chmod(directory, 0o700)
    for file in files:
        os.chmod(pathlib.Path(directory) / file, 0o600)
if not (pathlib.Path(staging) / name).is_dir():
    raise SystemExit('State root is missing.')
PY
# Use EXPORTED PG* credentials (or DATABASE_URL), never evaluate .env as shell.
# Explicit container selection avoids accidentally restoring another database.
PSQL=(psql -X --set=ON_ERROR_STOP=1 --single-transaction --file=-)
if [ -n "${BFMR_POSTGRES_CONTAINER:-}" ]; then
    PSQL=(docker exec -i --env PGHOST --env PGPORT --env PGUSER --env PGPASSWORD --env PGDATABASE "${BFMR_POSTGRES_CONTAINER}" "${PSQL[@]}")
fi
export PGDATABASE="${DATABASE_URL:-${PGDATABASE:-bfmr}}"
: "${PGUSER:?Export the reviewed restore administrator PGUSER}"
export PGUSER
# Record the boundary BEFORE SQL; even a lost COMMIT response must stop restart.
( set -o noclobber; printf '%s\n' 'Restore in progress; reconcile SQL and staged state before worker startup.' > "${MARKER}" )
DB_COMMITTED=1
{
    cat <<'SQL'
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')) THEN
   RAISE EXCEPTION 'Restore requires an empty replacement database';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datname=current_database()
            AND pid<>pg_backend_pid() AND application_name LIKE 'bfmr:%') THEN
   RAISE EXCEPTION 'BFMR database clients must be stopped before restore';
 END IF;
END $$;
SQL
    gzip -dc "${SQL_GZ}"
} | "${PSQL[@]}"
# Keep the old state as evidence. Publish the staged directory on the same FS.
if [ -e "${STATE_DIR}" ]; then
    mv -- "${STATE_DIR}" "${STAGING}/previous-state"
fi
mv -- "${STAGING}/$(basename "${STATE_DIR}")" "${STATE_DIR}"
rm -- "${MARKER}"
DB_COMMITTED=0
# Preserve previous state privately instead of deleting recovery evidence.
trap - EXIT
printf 'Restore completed. Previous state/staging retained at %s. Validate the replacement database and provider state before restart.\n' "${STAGING}"
