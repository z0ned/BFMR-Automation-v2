# Separate production and testing environments

**23 October 2026 — source implementation and operator setup.** Production and
live testing select separate databases, private configuration, browser profiles,
local journals, heartbeat files and backup roots. No database has been created or
connected to from this development workspace. No worker/provider action was run.

## Create the requested database copy

On the computer/container where you normally run BFMR, from the updated checkout:

```sh
npm run database:clone-test
```

On a Windows host in PowerShell (no WSL/Bash required):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\clone_test_database.ps1
```

Docker Desktop must be running. Run on the host, outside the BFMR app container.
The PowerShell wrapper sends the same clone body to Bash inside PostgreSQL and
normalizes Windows line endings; it does not need Bash installed on Windows.

This uses the existing `bfmr-postgres` Docker container's local `postgres`
administrator. If its name differs, set BFMR_POSTGRES_CONTAINER to that container
name for this command. No password is requested or printed. The command:

- Takes a consistent `pg_dump` snapshot of `bfmr`, including schema, data,
  sequences and installed triggers/functions; production remains running.
- Creates `bfmr_test` and restores that snapshot in one transaction. Existing
  `bfmr_test` is refused; no database is dropped, cleared or overwritten.
- Excludes production ownership/ACL grants. The clone is administrator-owned,
  has PUBLIC access revoked and connection limit 0, so no ordinary worker can
  immediately use copied production records.
- Removes the private temporary dump. A failed restore leaves the new database
  offline for inspection, rather than retrying or deleting evidence.

This is a point-in-time copy, not continuous replication. It contains private
production records, including copied Gmail cursors/workflows and retailer account
identities. It does not copy the external providers or browser/local journals.
Do not replay copied production work or erase its recovery history to force a run.

For a server outside Docker, `npm run database:clone-test:remote` uses a privately
configured BFMR_DATABASE_ADMIN_URL explicitly addressing `bfmr`, plus matching
local `pg_dump`/`pg_restore` tools. It follows the same no-overwrite/offline policy.
No URL/password belongs in command arguments, Git or shared logs.

## Configuration and launch commands

| Command | Mode | Configuration | Required database URL |
| --- | --- | --- | --- |
| `npm run config:prod` | production | `.env.production`, legacy `.env` if absent | DATABASE_URL_PRODUCTION |
| `npm run config:test` | testing | `.env.testing` only | DATABASE_URL_TEST |
| `npm run start:prod` | production | same production selection | DATABASE_URL_PRODUCTION |
| `npm run start:test` | testing | same testing selection | DATABASE_URL_TEST |

`config:*` reads settings and prints only mode, variable and target fingerprint;
it never connects or changes file permissions. `supervise:prod`, `supervise:test`,
`health:prod` and `health:test` select the same boundaries. Health does connect.
The existing `npm start` defaults to production unless BFMR_INTAKE_MODE is set.
The accepted alternate mode spelling is `testing`, not `test`; NODE_ENV does not
select a database. The mode must be chosen before the configuration file is read.
A file that declares a conflicting mode is refused.

Use `.env.example` as the production template and
[config/testing.env.example](../config/testing.env.example) for `.env.testing`.
Keep both private, mode 0600. An explicit BFMR_ENV_FILE selects exactly one file;
missing explicit files fail. Shell values win. No home-directory environment
files are merged and testing never falls back to `.env` or production credentials.

The common database selector is `src/db/databaseConfig.ts`: no legacy
DATABASE_URL, PG* defaults or opposite-mode fallback. URLs require an explicit
host/database without target overrides. When both URLs are supplied, identical
normalized targets are refused even with different credentials. Distinct DNS
aliases can still address the same server; this check is not physical isolation.
Recovery reports bind their database mode/target and source content; old reports
must be regenerated after changing these settings/source.

## Test runtime role and account provisioning

The clone intentionally cannot immediately run a worker. Review/install its
separate runtime role from `database/provision_test_runtime.psql`, privately as
the existing administrator. For the default Docker deployment:

```sh
docker cp database/provision_test_runtime.psql bfmr-postgres:/tmp/provision_test_runtime.psql
docker exec -it --user postgres bfmr-postgres psql -X -U postgres -d bfmr -f /tmp/provision_test_runtime.psql
```

The script creates `bfmr_test_app` without ownership/admin privileges, checks it
cannot connect to/read/write production, grants the same narrow application
columns in the clone, prompts privately for its own password and permits test
connections. Existing roles are refused for review. It does not modify production
ACLs, account rows or workflow state. A partial provisioning failure remains an
operator inspection task; rerunning the script is not an automatic repair.

Set DATABASE_URL_TEST to the `bfmr_test` URL with this role/password, retaining the
same server/port as appropriate to the app's network. Test startup additionally
rejects administrator/object-owner roles and a username shared with the supplied
production URL. Provision and review the separate test Amazon account and accepted
cutover before launch; copied production account selections are rejected. Do not
change historical order-account identities or backfill completed email workflows.

Test provider settings use explicit `_TEST` suffixes. Production accepts legacy
unsuffixed settings or `_PRODUCTION` overrides. Testing discards unsuffixed
provider credentials, identity/proof settings and operational approval flags.
A live test worker requires:

- Separate BFMR account/API credentials and a dedicated browser login/profile.
- Separate Gmail mailbox/OAuth token, Pub/Sub topic/subscription and explicit
  service-account credential file. Do not share a production subscription: both
  workers would compete for messages. Use separate IAM/service accounts with
  access restricted to their environment; do not rely on application selection
  to constrain an administrator credential.
- Separate test Amazon identity, selected from the test database. Set
  AMAZON_EXPECTED_ACCOUNT_TEST to that identity. BFMR_EXPECTED_ACCOUNT_PRODUCTION,
  GMAIL_ACCOUNT_EMAIL_PRODUCTION and AMAZON_EXPECTED_ACCOUNT_PRODUCTION are
  required identity strings for comparison; they contain no credentials.
- Separate Telegram bot/chat settings for environment-specific alerts. Known
  identical configured credential/topic/subscription/chat values are refused.

These are **live external accounts**, not provider sandboxes or a dry run.
Testing can reserve, cancel and purchase under the existing workflow rules.
Application configuration cannot prove that two API keys or credential files
belong to different external accounts; verify provider/browser alignment and IAM.
If separate provider accounts are unavailable, use offline software tests and
keep the live test worker stopped. Gmail OAuth setup now binds loopback callbacks,
checks callback state and exact mailbox, saves only the selected token key/file,
and does not register a watch against a hardcoded production topic.

## Private state, browser and process boundaries

| Resource | Production default | Testing default |
| --- | --- | --- |
| Local journals/screenshots | `~/.local/state/bfmr` | `~/.local/state/bfmr-testing` |
| Chromium profile | `~/.config/bfmr/chromium-profile` | `~/.config/bfmr-testing/chromium-profile` |
| Heartbeat | state root `/worker-heartbeat.json` | test state root `/worker-heartbeat.json` |
| Backups | `~/backups/bfmr` | `~/backups/bfmr-testing` |

Production journal/profile locations are preserved. The heartbeat moves from the
shared `/tmp/bfmr-worker-heartbeat.json`; health and supervisor now agree on the
selected private location. Test restore checks only its own incomplete boundary;
production retains its legacy default marker as well as a configured state root.

Path overrides support `_PRODUCTION`/`_TEST` suffixes. Journal overrides must
remain within the selected state root. Canonical/symlink-resolved paths that
overlap the known opposite defaults or configured opposite roots are rejected.
Use absolute, environment-specific paths; do not point both private files at an
unrecorded shared override. Existing-browser CDP attachment verifies the exact
canonical user-data-dir against the selected profile before attaching. Supervisors
no longer kill Chromium globally by process name.

For host-enforced separation, provision different OS users/private homes and use
the `systemd/bfmr-worker@.service` instances `production` and `testing`. The template
expects `/opt/bfmr/BFMR-Automation-v2`, private `/etc/bfmr/<instance>.env`, users
`bfmr-production`/`bfmr-testing`, separate `/var/lib/bfmr-<instance>` homes, private
temporary directories and separate journal identifiers. Install/configure this
explicitly; the old single production service is not migrated automatically.
Stop the old service before enabling its replacement. SQL account locks are
per database and do not prevent two databases from operating one provider account.

Backup/restore shell scripts read **exported** selected settings, never execute
`.env` as shell code, and require Node/tsx plus stopped-writer assertions. Each
new backup includes a checksummed ENVIRONMENT label; restore refuses cross-mode
backups. Unlabelled legacy backups remain production-only. The selected maintenance
URL must contain approved administrator credentials; PGUSER cannot replace an
embedded URL username. The clone command is the deliberate separate copy path;
ordinary restore is not an environment conversion tool.

## Existing recovery and validation

The original interrupted work remains in the original database and journals.
Creating a copy does not reconcile the original item or the outstanding
FULL_ACCOUNT_COVERAGE_CONFLICT. Preserve production recovery evidence. No
historical provider exclusions or uncertain external retries are added here.

`npm run test:database-selection`: 9/9 passed.
`npm run test:environment-isolation`: 10/10 passed (6 configuration/path/provider
cases and 4 synthetic clone success/refusal/failure cases).
`npm run test:recovery`: 33/33 passed (17 SQL/recovery and 16 operations cases).
Scoped TypeScript, shell syntax and whitespace checks passed.

These offline checks cover URL selection, suffix/path isolation, symlink rejection,
provider identity prerequisites, selected file loading, atomic recovery and
mode-labelled backup/restore using synthetic PostgreSQL shell commands/PGlite.
Native clone, grants, provider/account provisioning, service deployment and both
host startup acceptance checks remain unexecuted. See the current implementation
reference for exact validation counts. BFMR_TEST_DATABASE_URL remains the separate
opt-in native software-test fixture setting, not the live DATABASE_URL_TEST.
