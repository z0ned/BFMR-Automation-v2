# Fresh Ubuntu installation and Docker rehearsal

Use **Ubuntu 24.04 LTS** (amd64 mini-PC or arm64). Run the same
`scripts/bootstrap_ubuntu.sh` as root in a clean Ubuntu Docker container today,
then with sudo on the mini-PC. The installer uses native PostgreSQL inside that
machine/container; Docker is not required on the mini-PC and no Docker-in-Docker
or WSL is required for the Windows rehearsal.

## Rehearse today from Windows PowerShell

With Docker Desktop running, open the existing BFMR checkout:

```powershell
git pull
docker run --name bfmr-ubuntu-test --shm-size=1g -it --mount "type=bind,source=$($PWD.Path),target=/source,readonly" ubuntu:24.04 bash
```

Then, inside the Ubuntu shell:

```sh
bash /source/scripts/bootstrap_ubuntu.sh --container --source-dir /source
```

The mount is read-only. Only committed code is copied; your existing private
configuration/browser data is not imported. Keep this Ubuntu shell open after
installation. To return to a stopped rehearsal later:

```powershell
docker start -ai bfmr-ubuntu-test
```

Then start its local PostgreSQL cluster (normally version 16; `pg_lsclusters`
shows the actual version):

```sh
pg_ctlcluster 16 main start
```

No systemd is needed. The retained container includes generated private database
passwords; do not export/share it or publish a snapshot image.

Use a new container name for a genuinely fresh retry. A partial installation is
preserved for inspection; the installer never clears a database to retry.

## Install on the mini-PC

Install Ubuntu 24.04 LTS, connect it to the Internet, then open Terminal:

```sh
sudo apt-get update
sudo apt-get install -y git ca-certificates
git clone https://github.com/z0ned/BFMR-Automation-v2.git
cd BFMR-Automation-v2
sudo bash scripts/bootstrap_ubuntu.sh
```

If GitHub requests authentication, use your normal private Git access; never put
a token into the repository URL, scripts or shared logs. If you already have the
checkout, update it and run the last command. The script requires an actual
running systemd on the mini-PC; `--container` is only for the rehearsal.

## Installed resources

- Apt prerequisites, PostgreSQL 16+ and its client, official checksum-verified
  latest Node 22 LTS, locked worker dependencies, Playwright Chromium and Linux
  browser dependencies. This installs the automation worker, not the unrelated
  React/Vite scaffold development server.
- Root-owned application at `/opt/bfmr/BFMR-Automation-v2`, runtime dependencies
  at `/opt/bfmr/runtime`, Node at `/opt/bfmr/node`, shared read-only browser binaries
  at `/opt/bfmr/browsers`. A separate non-login `bfmr-build` user installs npm/
  browser packages before the installed code is made root-owned.
- Separate locked-password OS users `bfmr-production` and `bfmr-testing`, with
  private homes `/var/lib/bfmr-production` and `/var/lib/bfmr-testing`; each has
  private Chromium profile, journals and backup directories. Profiles are empty:
  existing authenticated sessions are not copied or fabricated.
- Local `bfmr` and `bfmr_test`, each with the canonical business schema,
  Gmail operational schema, exposure hardening, a separate NOLOGIN owner role
  and a separate non-owning runtime role (`bfmr_app` / `bfmr_test_app`). PUBLIC
  access is revoked; each runtime role can connect only to its own BFMR database.
  No old migrations or hardcoded legacy account/CCV seed is run.
- Different randomly generated SCRAM database passwords, written only to each
  user's 0600 `/etc/bfmr/production.env` or `/etc/bfmr/testing.env`. Opposite-mode
  credentials are not copied between files. No password is printed.
- Native role/schema/Gmail-grant checks, using the actual runtime credentials;
  no Gmail, BFMR, Amazon or Telegram connection is made.
- On a real host, the systemd template is installed and reloaded. Both workers
  remain **stopped and disabled**. In a normal Ubuntu container no service unit
  or systemd enable/start is attempted.

The installer detects a completed setup and exits without modifications.
Existing/partial BFMR directories, OS users, roles or databases cause refusal.
It never overwrites private configuration, upgrades an installed schema, drops
or truncates databases, resets recovery work or enables live trading/purchases.
A failure marker remains at `/var/lib/bfmr-bootstrap/incomplete`; inspect it before
attempting recovery. A finished marker records code revision and install mode.
`--skip-browsers` is available only for a dependency/schema rehearsal; its result
is explicitly marked as an incomplete browser installation.

## Complete private setup after installation

Edit the separate `/etc/bfmr/<mode>.env` files with `sudoedit`. Database passwords
are already populated; preserve them. Add your provider credentials and the
separate production/test identities described in [DATABASE_MODES.md](DATABASE_MODES.md).
Put provider JSON credentials in the corresponding private home with mode 0600,
owned by that environment's OS user. The test environment requires explicit
`_TEST` credentials, different provider accounts and production identity strings
for comparison. The installer cannot create external BFMR/Amazon/Gmail accounts,
OAuth consent, Pub/Sub IAM or an authenticated browser profile for you.

Provision each database's actual retailer/account records and explicitly reviewed
ranked Amazon identity before cutover. No synthetic account or fake payment data
is seeded. Complete browser login/MFA manually on the Ubuntu desktop; the installed
users have private profiles and can run the existing `auth_bfmr.ts`/Gmail OAuth
setup with that mode and `/etc/bfmr/<mode>.env`. Desktop display access must be
granted to the exact environment user; a headless Docker rehearsal does not prove
headed login/MFA or hardware browser behavior.

The databases are initially empty business stores. This **does not transfer your
current production reservations, Gmail cursors, incidents, workflow evidence or
cutover**. Move existing operation only with a coordinated reviewed backup/restore
and the original durable private state. Keep the old worker stopped during the
actual transfer. Do not accept a fresh baseline to bypass the unresolved original
incident. An intentionally fresh test environment requires its own account/
provider/cutover acceptance; a copied production database is not that acceptance.

Recheck infrastructure without starting a worker:

```sh
cd /opt/bfmr/BFMR-Automation-v2
sudo -u bfmr-production env BFMR_INTAKE_MODE=production BFMR_ENV_FILE=/etc/bfmr/production.env node --import tsx scripts/verify_installation.ts
sudo -u bfmr-testing env BFMR_INTAKE_MODE=testing BFMR_ENV_FILE=/etc/bfmr/testing.env node --import tsx scripts/verify_installation.ts
```

Only after the relevant account/provider/cutover/recovery checks pass, explicitly
start the chosen worker on the real host with `sudo systemctl start
bfmr-worker@production` (or `@testing`). Enabling automatic boot startup is a
separate operator step. Review current [open issues](OPEN_ISSUES.md); infrastructure
installation does not establish live provider or production acceptance.

## Validation evidence

Source, shell and native Docker rehearsal results are recorded in the current
[v22 implementation reference](BFMR_Implementation_v22..md). A container rehearsal
cannot establish mini-PC systemd boot, desktop login, hardware behavior or external
provider acceptance. Downloads require Internet access with valid CA trust; no
TLS checks are disabled by the installer.
