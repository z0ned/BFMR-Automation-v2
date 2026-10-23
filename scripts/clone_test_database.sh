#!/usr/bin/env bash
set -euo pipefail
# Explicit operator command. This uses the existing PostgreSQL container's local
# administrator login, so no password/connection URL belongs on the command line.
CONTAINER="${BFMR_POSTGRES_CONTAINER:-bfmr-postgres}"
docker exec -i --user postgres "${CONTAINER}" bash -s <<'CLONE'
set -euo pipefail
umask 077
WORK="$(mktemp -d /tmp/bfmr-test-clone.XXXXXX)"
CREATED=0
cleanup() {
    if [ "${CREATED}" = 1 ]; then
        echo 'Clone failed after creating bfmr_test. Keep it offline; no database was dropped or retried.' >&2
    fi
    rm -rf -- "${WORK}"
}
trap cleanup EXIT
# The OS user postgres and the SQL administrator role are different identities.
# Official images can initialize a custom SQL superuser through POSTGRES_USER.
export PGUSER="${BFMR_CLONE_ADMIN_ROLE:-${POSTGRES_USER:-postgres}}" PGDATABASE=bfmr
if ! ADMIN="$(psql -X -At --set=ON_ERROR_STOP=1 --command='SELECT rolsuper FROM pg_roles WHERE rolname=current_user')"; then
    echo 'Cannot connect to bfmr as the configured administrator. No database was created.' >&2; exit 1
fi
if [ "${ADMIN}" != t ]; then
    echo 'Clone requires the PostgreSQL administrator role. No database was created.' >&2; exit 1
fi
# A second invocation cannot overwrite a target: CREATE DATABASE refuses
# existing names even when two administrators race after the initial check.
# No production sessions are terminated; pg_dump takes a consistent snapshot.
if ! EXISTS="$(psql -X -At --set=ON_ERROR_STOP=1 --command="SELECT count(*) FROM pg_database WHERE datname='bfmr_test'")"; then
    echo 'Could not check whether bfmr_test exists. No database was created.' >&2; exit 1
fi
if [ "${EXISTS}" != 0 ]; then
    echo 'bfmr_test already exists; nothing was overwritten.' >&2; exit 1
fi
if ! pg_dump --format=custom --no-owner --no-acl --file="${WORK}/snapshot.dump" 2>"${WORK}/private.log"; then
    echo 'Could not snapshot bfmr. Check PostgreSQL access privately.' >&2; exit 1
fi
if ! psql -X --set=ON_ERROR_STOP=1 --command='CREATE DATABASE bfmr_test TEMPLATE template0 CONNECTION LIMIT 0' > /dev/null 2>"${WORK}/private.log"; then
    echo 'Could not create bfmr_test. It may already exist or creation privileges are missing.' >&2; exit 1
fi
CREATED=1
psql -X --set=ON_ERROR_STOP=1 --command='REVOKE ALL ON DATABASE bfmr_test FROM PUBLIC' > /dev/null
if ! pg_restore --dbname=bfmr_test --single-transaction --exit-on-error --no-owner --no-acl "${WORK}/snapshot.dump" 2>"${WORK}/private.log"; then
    echo 'Restoring bfmr_test failed. Keep the administrator-only clone offline.' >&2; exit 1
fi
CREATED=0
printf '%s\n' 'Created bfmr_test with the bfmr schema and data. Production was not changed.'
printf '%s\n' 'The copy is administrator-only and has connection limit 0. Separate test role/provider/account provisioning is required before starting its worker.'
CLONE
