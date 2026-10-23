# Recovery and operational review — 23 October 2026

This amendment supersedes conflicting payout-refresh, bulk-unblock, restore and
exposure-acceptance descriptions in the 22 October material. It records source
changes and offline evidence, not a repair of the operator's installed system.

## Implementation and publication checkpoint

The reviewed fixes are committed as **`ee183ef`** (`fix: harden incident recovery
and operational safeguards`) on `work`, based on `575f9bd`. The configured remote
is `https://github.com/z0ned/BFMR-Automation-v2.git`. The first push was rejected
by automatic approval review as an unverified external-destination transfer; it
did not publish the commit. The user then requested this documentation update
and another commit/push to that configured repository. Verify the resulting
remote `work` ref before treating any publication as successful.

This follow-up changes documentation only. The 66 passing cases below belong to
the implementation validation; they were not rerun or counted again. Publication
does not install the code, grant database privileges, resolve the screenshot's
message, or establish native/provider acceptance. The
[handoff](BFMR_Handoff.md#current-recovery-checkpoint) identifies the next host
steps without reopening the accepted start-from boundary.

## Revision and interrupted-message recovery

The supplied screenshot identifies commit `09f9d2b`; that object was unavailable
in the reviewed checkout at `575f9bd`. Its former `reconcile_incident.ts` cannot
be audited from this checkout. The screenshot reports a workflow completion
before a permission failure on `gmail_intake_work`, followed by a startup stop
for interrupted `PROCESSING` mail. That does not prove which provider effects
occurred, or whether the reported workflow update committed.

Keep the worker and supervisor stopped. On the operator host, compare the actual
checkout to the reviewed/deployed full commit SHA and run:

```sh
npm run recovery:diagnose -- --message-id <private-Gmail-ID> --expect-revision <full-reviewed-commit-SHA>
```

This command reads only the selected local environment file and SQL. It reports
Git HEAD, dirty status, a SHA-256 of the actual source/package/schema files,
connected role/capabilities, missing table/column intake grants, the exact message's queue/workflow state,
and unresolved account incident count. It does not print message content,
account identifiers, cursor values or provider/order data. An absent privilege
prevents state inspection; a good diagnostic does not establish provider outcomes.
Startup now prints the same source identity. A report/apply repair is bound to
that identity, so changing the checkout requires a new report/review.

For an existing installed operational schema, the separately reviewed
`database/runtime_intake_grants.psql` supplies idempotent SELECT and explicit
INSERT/UPDATE column grants for the four intake tables. Its `runtime_role`
psql variable defaults to `bfmr_app`; select the actual role. It grants no DELETE,
TRUNCATE, ownership or schema-creation rights. Do not rerun the fresh installer,
grant superuser, or apply SQL without checking the real baseline and backup.
The new preflight runs at intake startup and before a reviewed repair.

Use `npm run recovery:report -- --help` for exact-message report/apply arguments.
The report requires current full tracker/financial evidence and verified browser
account alignment. Review its private contents and exact hash. Application
regenerates provider evidence and requires the same plan, revision, account and
source. Workflow snapshots, local business repairs, queue transition, scoped
incident resolution and an append-only repair receipt commit in one serializable
transaction. Any failure rolls back all local changes. A repeated exact report
with a committed receipt returns `ALREADY_APPLIED` without provider work or queue
replay, including after a lost COMMIT response. A different report or unknown
provider outcome remains blocked. No automatic transaction retry is introduced.

`npm run unblock` is a compatibility entrypoint only: no arguments stop with
instructions; explicit arguments use the same report-first reconciler. There is
no bulk completion or incident reset. If an old script fabricated/corrupted a
snapshot, preserve it and obtain authoritative evidence; this tool cannot infer
missing history or safely reconstruct arbitrary state.

## Payouts and financial checks

Checkout never updates `reservations.payout_per_item`. D22-03 remains controlling:
quantity, per-item rate and generated expected payout are creation-time facts.
Current deal payout is fetched outside the transaction, checked for consistent
aliases and exact deal identity, then stored on `deals` and in append-only
checkout evidence. Purchasing uses the locked reservation total. Provider
failures, database failures, changed identities and changed creation terms stop
checkout; there is no broad catch/fallback. The unused payout-update repository
method and fresh-install UPDATE grant on that column were removed. Existing
installations retain their grants until separately reviewed maintenance; the
immutable trigger must remain installed. Runtime schema validation no longer
requires the retired `ccv` column; legacy presence does not permit reading it.

`database/optimizations.sql` now installs its changes atomically and refuses an
already-over-limit baseline. Its optional $200 ceiling is a **conservative
unreimbursed reservation-payout ceiling**, not the application's checkout formula.
It subtracts actual partial payments, clamps overpayment balances at zero and
checks reservation inserts/status updates plus reimbursement insert/update/delete.
Competing writes acquire one transaction advisory lock. READ COMMITTED takes a
fresh query snapshot after waiting; SERIALIZABLE relies on SSI and may abort;
REPEATABLE READ is refused. No automatic retries are allowed. Native concurrent
session acceptance remains required. This ceiling can reject reservations the
checkout-cost rule would allow; changing that policy requires a separate decision.

The authoritative checkout guard still requires complete, fresh provider/payment
coverage and prior unpaid exposure plus proposed complete Amazon cost <= $200.
The health CLI reports the local unpaid balance consistently, reports `UNKNOWN`
on calculation failure, and exits unsuccessfully unless worker/database/exposure
checks are healthy. It does not establish full provider coverage or readiness to
purchase. The native validator's exposure probe now uses actual schema columns,
requires the specific ceiling rejection, and reports failure rather than silently
omitting an unsuccessful probe. Applying optimizations requires an explicit Docker target or the configured
direct connection and does not retry via another connection after an uncertain
result.

## Coordinated backup and restore

Export reviewed PG* administrator connection settings, or DATABASE_URL plus
PGUSER. These scripts do not evaluate `.env` as shell code. Docker execution
requires explicit `BFMR_POSTGRES_CONTAINER`; there is no implicit container
selection. Stop every writer/supervisor and explicitly set
`BFMR_BACKUP_WORKER_STOPPED=YES` or `BFMR_RESTORE_WORKER_STOPPED=YES` as applicable.

Backup writes a private unique directory, retains an `INCOMPLETE` marker until
both SQL and local state are captured and checksummed, and creates an empty state
archive if the chosen state directory is absent. Retention is operator-managed;
backup no longer deletes older recovery evidence. Both scripts cover the selected
`BFMR_STATE_DIR` (default `~/.local/state/bfmr`); separately inventory any configured
journals outside that directory before treating the backup as complete.
Cutover stops when its required coordinated backup fails.

Restore requires exactly one database dump, the state archive and checksum
coverage for both. It verifies compressed data and stages a validated archive
before SQL, rejecting links, devices, traversal and unexpected roots. Staged
files/directories are owner-only. Restore targets an **empty replacement
database**, with required roles already provisioned; it refuses an existing
populated target. `psql -X --set=ON_ERROR_STOP=1 --single-transaction --file=-`
rolls back SQL errors and returns failure. A statement-time check rejects
connected BFMR clients; the operator must still stop other writers.

SQL commit and filesystem publication are separate boundaries. A private
`<state-directory>.restore-incomplete` marker is created before SQL. It remains
on SQL failure, lost response or failed state publication, retaining staged and
prior state for investigation. Runtime refuses startup while the default or
configured marker exists. On success the staged directory is published and prior
state is retained privately. Remove an incomplete marker only after establishing
which SQL/state pair is authoritative; never treat it as a reset switch. A real
native restore drill and crash-boundary acceptance remain pending.

## Evidence and remaining host work

Focused validation passed **66/66 cases**, with zero failures or skips:

- `npm run test:recovery`: 22/22 (10 disposable-database recovery/payout/exposure
  cases and 12 synthetic shell/health/source-identity cases).
- `node --import tsx tests/informational_and_checkout_payout.test.ts`: 5/5.
- `node --import tsx tests/database_validator.test.ts`: 2/2.
- `node --import tsx tests/postgres_gmail_intake.test.ts`: 14/14.
- `node --import tsx tests/relational_integration.test.ts`: 23/23.

`tsc --noEmit`, `npm run typecheck:recovery`, shell syntax and whitespace checks
passed. The new recovery npm commands and typed configuration are included for
repeatable focused validation. Diagnostic help was exercised; `npm run unblock`
without arguments returned the intended refusal (exit 2).

Database cases use synthetic identities, injected provider reads and disposable
PGlite 0.5.10. The missing package was restored locally using the exact lockfile
tarball and verified SHA-512; no dependency version/lockfile update or clean npm
installation was performed. Shell tests use temporary synthetic archives and
fake psql/pg_dump processes: they verify error handling and publication boundaries,
not native PostgreSQL restore semantics. Subprocess checks needed execution
outside the sandbox and passed with no provider/database credentials supplied.
The exposure test executes the actual SQL and checks partial/full boundaries,
status reopening, payment removal and isolation rejection; PGlite's single
connection does not establish competing-session lock/SSI behavior. Earlier
user-reported native checks retain their original revision and scope; they do not
validate these changes or close the screenshot incident.

Before the next separately authorized live run: install the reviewed revision,
inspect actual role grants and exact interrupted-message state, preserve a
coordinated backup, reconcile provider effects and review/apply only a ready
exact-message report. Accept the installed payout guard, revised optional ceiling
with concurrent sessions, and a replacement-database restore drill. No database,
provider, repair apply, deployment or worker invocation occurred in this work.
