# Fresh Ubuntu installation and Docker rehearsal

Use **Ubuntu 24.04 LTS** (amd64 mini-PC or arm64). Run the same
`scripts/bootstrap_ubuntu.sh` as root in a clean Ubuntu Docker container today,
then with sudo on the mini-PC. The installer uses native PostgreSQL inside that
machine/container; Docker is not required on the mini-PC and no Docker-in-Docker
or WSL is required for the Windows rehearsal.

## Rehearse today from Windows PowerShell

With Docker Desktop running, open PowerShell in the updated BFMR checkout and
run one command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap_ubuntu.ps1
```

The launcher locates the checkout itself, creates a uniquely named clean Ubuntu
24.04 container, mounts the source read-only, automatically normalizes Windows
line endings and runs the bootstrap. No WSL, host Bash or manual commands inside
Ubuntu are needed. It streams installation progress and leaves the container and
PostgreSQL running afterward; both live workers stay stopped. The container name
and optional shell-access command are printed when installation completes.

To use a specific name, append `-ContainerName bfmr-ubuntu-test`. Existing names
are refused rather than reused, deleted or reset. A failed installation is also
preserved for inspection. The retained container contains private generated DB
passwords: do not export/share it or publish a snapshot image.

The Ubuntu mini-PC still uses the native single-command bootstrap below.

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
and the original durable private state. Restore into a separately named empty
replacement database and update the production URL after review; the installer
has already populated the new bfmr schema, so ordinary restore correctly refuses
to overwrite it. Keep the old worker stopped during the
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

A clean Ubuntu 24.04 amd64 container rehearsal completed with `--container
--skip-browsers`: Node 22.23.4, PostgreSQL 16.15, lockfile-matched dependencies,
Chromium Linux dependencies, both real database schemas and runtime grants.
Actual cross-database login attempts were denied in both directions (SQLSTATE
42501). Opposite private configuration/home access was denied, code was immutable
to runtime users, source identity worked, and a completed rerun preserved configs.
No systemd worker unit or live worker was started in the container.

The default Chromium download was attempted first, but this development
workspace blocked cdn.playwright.dev with HTTP 403 Domain forbidden. No TLS/network
policy was bypassed. Browser download/launch and real host systemd/desktop remain
unverified; the distributed default still downloads Chromium and fails safely
if it cannot. The skip flag is for limited rehearsals, not live readiness.
Shell syntax, scoped TypeScript and documentation/whitespace checks passed.

Source, shell and native Docker rehearsal results are recorded in the current
[v22 implementation reference](BFMR_Implementation_v22..md). A container rehearsal
cannot establish mini-PC systemd boot, desktop login, hardware behavior or external
provider acceptance. Downloads require Internet access with valid CA trust; no
TLS checks are disabled by the installer.
