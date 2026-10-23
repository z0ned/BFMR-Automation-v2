#!/usr/bin/env bash
# Fresh Ubuntu 24.04 only. Never run against an existing BFMR installation.
set -euo pipefail
umask 077
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER=0
SKIP_BROWSERS=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --container) CONTAINER=1; shift ;;
        --skip-browsers) SKIP_BROWSERS=1; shift ;;
        --source-dir) SOURCE_DIR="${2:?--source-dir requires a local checkout}"; shift 2 ;;
        --help) cat <<'HELP'
Usage: sudo bash scripts/bootstrap_ubuntu.sh [--container] [--source-dir /checkout]
Installs a fresh Ubuntu 24.04 BFMR host with native PostgreSQL, Node 22,
Playwright Chromium, separate production/testing users, databases and profiles.
Workers remain stopped/disabled. Existing installation/databases/roles are refused.
--container: rehearsal without systemd; start PostgreSQL with pg_ctlcluster.
--skip-browsers: dependency/schema rehearsal only; not a complete browser install.
HELP
            exit 0 ;;
        *) echo "Unknown installer argument: $1" >&2; exit 2 ;;
    esac
done
[ "$(id -u)" = 0 ] || { echo 'Run with sudo (or as root inside a clean Ubuntu container).' >&2; exit 1; }
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || {
    echo 'Use a clean Ubuntu 24.04 LTS installation/image.' >&2; exit 1;
}
if [ "$CONTAINER" = 0 ] && [ ! -d /run/systemd/system ]; then
    echo 'No running systemd detected. Use --container for a Docker rehearsal.' >&2; exit 1
fi
APP=/opt/bfmr/BFMR-Automation-v2
RUNTIME=/opt/bfmr/runtime
BROWSERS=/opt/bfmr/browsers
MARKERS=/var/lib/bfmr-bootstrap
if [ -e "$MARKERS/complete" ]; then
    echo 'BFMR bootstrap already completed. No configuration or database was changed.'
    exit 0
fi
if [ -e "$MARKERS/incomplete" ] || [ -e /opt/bfmr ] || [ -e /etc/bfmr ]; then
    echo 'Existing/partial BFMR installation found. Refusing to overwrite it; inspect before retry.' >&2; exit 1
fi
for account in bfmr-build bfmr-production bfmr-testing; do
    if getent passwd "$account" >/dev/null; then
        echo "Existing $account user found. Use a fresh host/container." >&2; exit 1
    fi
done
[ -f "$SOURCE_DIR/package-lock.json" ] && [ -d "$SOURCE_DIR/.git" ] || {
    echo '--source-dir must be a complete Git checkout of BFMR-Automation-v2.' >&2; exit 1;
}
install -d -m 0700 "$MARKERS"
printf '%s\n' 'Installation incomplete. Preserve all files; do not start workers.' > "$MARKERS/incomplete"
trap 'echo "Bootstrap stopped before completion. Keep workers stopped; inspect /var/lib/bfmr-bootstrap/incomplete. No automatic rollback/deletion is performed." >&2' ERR
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git xz-utils python3 openssl \
    postgresql postgresql-client postgresql-contrib sudo x11-xserver-utils fonts-liberation
update-ca-certificates
# Install official Node 22 LTS, verified against its HTTPS SHA256 manifest.
case "$(dpkg --print-architecture)" in amd64) NODE_ARCH=x64 ;; arm64) NODE_ARCH=arm64 ;;
    *) echo 'Only Ubuntu amd64 and arm64 are supported.' >&2; exit 1 ;; esac
NODE_WORK="$(mktemp -d /tmp/bfmr-node.XXXXXX)"
curl --fail --silent --show-error --location --retry 3 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$NODE_WORK/SHASUMS256.txt"
NODE_TAR="$(awk -v arch="$NODE_ARCH" '$2 ~ ("^node-v22\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$NODE_WORK/SHASUMS256.txt")"
[ -n "$NODE_TAR" ] && [ "$(printf '%s\n' "$NODE_TAR" | wc -l)" = 1 ] || { echo 'Cannot select a single official Node 22 archive.' >&2; exit 1; }
curl --fail --silent --show-error --location --retry 3 "https://nodejs.org/dist/latest-v22.x/$NODE_TAR" -o "$NODE_WORK/$NODE_TAR"
(cd "$NODE_WORK" && grep -F "  $NODE_TAR" SHASUMS256.txt | sha256sum --check --status)
install -d -m 0755 /opt/bfmr/node
# Extract only the checksum-verified official distribution.
tar -xJf "$NODE_WORK/$NODE_TAR" --strip-components=1 -C /opt/bfmr/node
for command in node npm npx; do ln -s /opt/bfmr/node/bin/"$command" /usr/local/bin/"$command"; done
rm -rf -- "$NODE_WORK"
for mode in production testing; do
    useradd --system --user-group --create-home --home-dir "/var/lib/bfmr-$mode" --shell /bin/bash "bfmr-$mode"
    chmod 0700 "/var/lib/bfmr-$mode"
    resource=bfmr; [ "$mode" != testing ] || resource=bfmr-testing
    for directory in ".local/state/$resource" ".config/$resource/chromium-profile" "backups/$resource"; do
        install -d -o "bfmr-$mode" -g "bfmr-$mode" -m 0700 "/var/lib/bfmr-$mode/$directory"
    done
done
useradd --system --user-group --create-home --home-dir /var/lib/bfmr-build --shell /usr/sbin/nologin bfmr-build
chmod 0700 /var/lib/bfmr-build
# Git copies committed code only: no source .env, credentials, browser or state files.
# Git's local upload-pack must also trust a differently owned bind mount.
# Use exact root-global paths rather than a wildcard or command-scoped config
# that Git's local transport does not retain.
git config --global --add safe.directory "$SOURCE_DIR"
git config --global --add safe.directory "$SOURCE_DIR/.git"
git clone --no-hardlinks -- "$SOURCE_DIR" "$APP"
git -C "$APP" remote set-url origin https://github.com/z0ned/BFMR-Automation-v2.git
chmod 0755 /opt/bfmr "$APP"
install -d -o bfmr-build -g bfmr-build -m 0755 "$RUNTIME" "$BROWSERS"
# The repository's UI scaffold manifest differs from its worker lockfile.
# Construct the matching worker manifest, preserving every locked version/hash.
python3 - "$APP/package-lock.json" "$RUNTIME" <<'PY'
import json, pathlib, shutil, sys
lock = json.loads(pathlib.Path(sys.argv[1]).read_text())
root = lock['packages']['']
manifest = {key: root[key] for key in ('name', 'version', 'dependencies', 'devDependencies') if key in root}
manifest['private'] = True
manifest['type'] = 'module'
pathlib.Path(sys.argv[2], 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
shutil.copyfile(sys.argv[1], pathlib.Path(sys.argv[2], 'package-lock.json'))
PY
chown -R bfmr-build:bfmr-build "$RUNTIME"
runuser -u bfmr-build -- env HOME=/var/lib/bfmr-build npm --prefix "$RUNTIME" ci --include=dev --no-audit --no-fund
ln -s "$RUNTIME/node_modules" "$APP/node_modules"
node "$RUNTIME/node_modules/playwright/cli.js" install-deps chromium
if [ "$SKIP_BROWSERS" = 0 ]; then
    runuser -u bfmr-build -- env HOME=/var/lib/bfmr-build PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" \
        node "$RUNTIME/node_modules/playwright/cli.js" install chromium
fi
chown -R root:root /opt/bfmr
chmod -R a+rX /opt/bfmr
chmod -R go-w /opt/bfmr
# Services read root-owned code; trust only this exact immutable checkout.
for mode in production testing; do
    runuser -u "bfmr-$mode" -- env HOME="/var/lib/bfmr-$mode" git config --global --add safe.directory "$APP"
done
# Ubuntu's package creates a local PostgreSQL cluster. Start it without Docker.
PG_VERSION="$(pg_lsclusters --no-header | awk '$2 == "main" {print $1}')"
[ -n "$PG_VERSION" ] && [ "$(printf '%s\n' "$PG_VERSION" | wc -l)" = 1 ] || {
    echo 'Expected exactly one Ubuntu main PostgreSQL cluster; inspect pg_lsclusters.' >&2; exit 1;
}
if ! pg_lsclusters --no-header | awk '$2 == "main" {print $4}' | grep -qx online; then
    pg_ctlcluster "$PG_VERSION" main start
fi
# Bind every administrator command to this machine's Unix socket, regardless of
# connection settings inherited from the installer caller.
export PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres PGCONNECT_TIMEOUT=10
unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGPASSFILE
[ "$(pg_lsclusters --no-header | awk '$2 == "main" {print $3}')" = 5432 ] || {
    echo 'Expected the fresh main cluster on port 5432; inspect PostgreSQL configuration.' >&2; exit 1;
}
# Never reinterpret existing databases or roles as a fresh installation.
EXISTING="$(runuser -u postgres -- psql -X -At -v ON_ERROR_STOP=1 -d postgres -c "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname IN ('bfmr','bfmr_test')) OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('bfmr_owner','bfmr_app','bfmr_test_owner','bfmr_test_app'))")"
[ "$EXISTING" = f ] || { echo 'BFMR databases/roles already exist. No schema or account data was changed.' >&2; exit 1; }
# Passwords remain private: only SCRAM verifiers enter administrator SQL; cleartext
# URLs are written directly to each separate user's 0600 configuration file.
install -d -m 0755 /etc/bfmr
SQL_WORK="$(mktemp -d /tmp/bfmr-schema.XXXXXX)"
chmod 0700 "$SQL_WORK"
python3 - "$APP" "$SQL_WORK" <<'PY'
import base64, hashlib, hmac, pathlib, secrets, sys
app, work = map(pathlib.Path, sys.argv[1:])
sql = ["SET password_encryption = 'scram-sha-256';"]
for mode, database, owner, role, template in [
 ('production','bfmr','bfmr_owner','bfmr_app',app/'.env.example'),
 ('testing','bfmr_test','bfmr_test_owner','bfmr_test_app',app/'config/testing.env.example')]:
 password = secrets.token_hex(32)
 salt = secrets.token_bytes(16)
 salted = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 4096)
 client = hmac.digest(salted, b'Client Key', 'sha256')
 b64 = lambda value: base64.b64encode(value).decode()
 verifier = 'SCRAM-SHA-256$4096:' + b64(salt) + '$' + b64(hashlib.sha256(client).digest()) + ':' + b64(hmac.digest(salted, b'Server Key', 'sha256'))
 sql += [f'CREATE ROLE {owner} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;',
         f"CREATE ROLE {role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{verifier}';"]
 content = template.read_text()
 values = {'BFMR_INTAKE_MODE':mode, 'DATABASE_URL_PRODUCTION' if mode=='production' else 'DATABASE_URL_TEST':f'postgresql://{role}:{password}@127.0.0.1:5432/{database}',
           'PLAYWRIGHT_BROWSERS_PATH':'/opt/bfmr/browsers'}
 lines = content.splitlines()
 for key, value in values.items():
  lines = [line for line in lines if not line.startswith(key+'=')]
  lines.append(key+'='+value)
 config = pathlib.Path('/etc/bfmr',mode+'.env')
 config.write_text('\n'.join(lines)+'\n'); config.chmod(0o600)
(work/'roles.sql').write_text('\n'.join(sql)+'\n')
PY
chown postgres:postgres "$SQL_WORK" "$SQL_WORK/roles.sql"
runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d postgres -f "$SQL_WORK/roles.sql"
rm -- "$SQL_WORK/roles.sql"
for mode in production testing; do
    database=bfmr; owner=bfmr_owner; role=bfmr_app
    if [ "$mode" = testing ]; then database=bfmr_test; owner=bfmr_test_owner; role=bfmr_test_app; fi
    runuser -u postgres -- createdb --template=template0 --owner="$owner" "$database"
    runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d "$database" \
        -c "REVOKE ALL ON DATABASE $database FROM PUBLIC; GRANT CONNECT ON DATABASE $database TO $role; ALTER SCHEMA public OWNER TO $owner; REVOKE ALL ON SCHEMA public FROM PUBLIC; SET ROLE $owner; ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;" \
        -f "$APP/database/schema.sql" -f "$APP/database/gmail_intake.sql" -f "$APP/database/optimizations.sql" \
        -v "runtime_role=$role" -f "$APP/database/runtime_grants.psql" \
        -c "RESET ROLE; ALTER ROLE $role IN DATABASE $database SET search_path = pg_catalog, public;"
    chown "bfmr-$mode:bfmr-$mode" "/etc/bfmr/$mode.env"
done
# Both targets must exist before checking cross-database CONNECT isolation.
for mode in production testing; do
    # Read-only native validation with the actual non-owning runtime credentials.
    (cd "$APP" && runuser -u "bfmr-$mode" -- env HOME="/var/lib/bfmr-$mode" \
        BFMR_INTAKE_MODE="$mode" BFMR_ENV_FILE="/etc/bfmr/$mode.env" \
        node --import tsx scripts/verify_installation.ts)
done
rmdir "$SQL_WORK"
if [ "$CONTAINER" = 0 ]; then
    install -m 0644 "$APP/systemd/bfmr-worker@.service" /etc/systemd/system/bfmr-worker@.service
    systemctl daemon-reload
    # Do not enable/start either live worker during infrastructure installation.
fi
printf '%s\n' "revision=$(git -C "$APP" rev-parse HEAD)" "container=$CONTAINER" "browsers_skipped=$SKIP_BROWSERS" > "$MARKERS/complete"
rm -- "$MARKERS/incomplete"
trap - ERR
printf '\nBFMR infrastructure installed. Both workers remain STOPPED and disabled.\n'
printf 'Code: %s\nPrivate configuration: /etc/bfmr/production.env and /etc/bfmr/testing.env\n' "$APP"
printf 'Databases: bfmr and bfmr_test (fresh schema; no production data imported).\n'
printf 'Finish provider credentials, retailer accounts, browser login and cutover using docs/UBUNTU_INSTALL.md.\n'
if [ "$SKIP_BROWSERS" = 1 ]; then printf 'Browser download was SKIPPED: this is an incomplete browser rehearsal.\n'; fi
