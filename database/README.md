# BFMR database schema

## 23 October 2026 — existing-runtime recovery

See the [recovery amendment](../docs/RECOVERY_REVIEW_20261023.md) before changing
an installed system. `runtime_intake_grants.psql` is a separately reviewed,
idempotent column-grant repair for the four existing Gmail tables, with psql
`runtime_role` defaulting to `bfmr_app`. Startup and repair check these privileges
without applying grants. The fresh installer no longer grants payout updates;
creation terms remain protected by the immutable trigger. `optimizations.sql`
now installs an atomic, partial-payment-aware conservative payout ceiling with
serialized competing writes; it is distinct from checkout's provider-coverage
and proposed-order-cost check. Do not rerun the fresh installer on an existing
database. No installed SQL was applied by this amendment.


This directory is the authoritative source for the relational business schema,
upgrade migrations and database design notes used by BFMR-Automation-v2.
PostgreSQL 15 or later is intended to run locally on the mini-PC. A second
`BFMR_DB_Schema` checkout is no longer required.

| File | Purpose |
| --- | --- |
| [schema.sql](schema.sql) | Complete 16-table fresh-install schema, including explicit per-retailer account ranking, lookup seeds, append-only evidence and immutable reservation-payout guard. |
| [seed_amazon_account.psql](seed_amazon_account.psql) | Requested initial Amazon retailer and account at rank 1, with required CCV supplied privately at installation. |
| [bfmr-postgres-db-install.psql](bfmr-postgres-db-install.psql) | Fresh-install roles, schema, initial Amazon seed and least-privilege application grants. |
| [gmail_intake.sql](gmail_intake.sql) | Separate, additive four-table operational Gmail cursor/watch/run/notification/work contract; install once only under reviewed authorization. Does not modify the pinned business schema. |
| [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) | Preserved database design rationale and dated source/validation history. Read current application evidence alongside it. |
| [migrations/20261020_sync_consistency.sql](migrations/20261020_sync_consistency.sql) | Single-use upgrade for the schema immediately preceding the sync-consistency change; requires actual scope backfill/reconciliation. |
| [migrations/20261020_reservation_payout_immutability.sql](migrations/20261020_reservation_payout_immutability.sql) | Single-use upgrade from its stated baseline to protect existing reservation creation terms. |
| [migrations/20261022_retailer_account_ranking_prepare.sql](migrations/20261022_retailer_account_ranking_prepare.sql) | Ranking stage 1: add a nullable integer rank and per-retailer uniqueness; assigns no existing ranks. |
| [migrations/20261022_retailer_account_ranking_finalize.sql](migrations/20261022_retailer_account_ranking_finalize.sql) | Ranking stage 2: validate the prepared/backfilled baseline and require a non-null rank; assigns no ranks. |

The original design notes were preserved verbatim at consolidation; subsequent
application-owned amendments are recorded alongside that dated history.
Their relative installation examples assume `database/` as the working
directory; the application-root example is below. Their dated source-only and
pending-integration evidence describes the original schema task, superseded by
the current application runbook's later offline evidence and integration status.

## Installation and upgrades

Startup validates the installed contract; it does not install SQL, apply
migrations, create roles or import historical data. Copying these files into the
application repository does not change any installed database.

For a separately reviewed and authorized **fresh, empty** database, use
`database/schema.sql` alone. For example, from the repository root, with private
PostgreSQL connection settings already configured:

```sh
psql -X --set=ON_ERROR_STOP=1 --file=database/schema.sql
```

This is operator documentation, not a command executed by this consolidation.
The SQL creates objects in `public` within an existing database; it does not
create the database or grant runtime permissions. Use a non-owning runtime role
and reviewed grants as described in the application runbook.

For an existing installation, inspect its actual baseline, back up and reconcile
its real records, and select only the applicable reviewed upgrade. Do not run
every migration in filename order, rerun the fresh-install schema, or apply
upgrade scripts after installing the current schema. The migrations are not a
general automatic migration runner and must not invent creation terms, scopes
or provider outcomes.

`src/db/migrations/001_initial_schema.sql` is the historical v1.5 design;
`src/db/migrations/002_runtime_state.sql` belongs to the separate legacy JSONB
orchestration engine. Neither installs this relational business schema.

## Requested initial records

The operator-requested initial Amazon retailer/account rows are in
`seed_amazon_account.psql`, separate from reusable DDL and ranking upgrades.
The script inserts the requested account with explicit rank 1 and required CCV;
it never updates existing ranks/accounts, changes grants or reassigns orders.
Exact repeat input is idempotent; conflicting retailer/account/rank/CCV data
stops the seed transaction. It requires the finalized non-null ranking schema.

PostgreSQL string literals use single quotes, the retailer table is `retailers`,
and the CCV column is text. Supply CCV privately through the client process's
`BFMR_INITIAL_ACCOUNT_CCV` environment variable, not a literal in committed SQL
or a command argument. Client-side `\copy ... FROM PROGRAM` validates 3–4 ASCII
digits and transfers the value as data through a temporary table. No CCV is
returned or placed in SQL text/error messages; the temporary table drops at
commit. The seed is an owner-only installation operation; worker CCV SELECT
and account/rank INSERT/UPDATE permissions remain denied.

The creation installer includes the seed immediately after the business and
Gmail schemas while `SET ROLE bfmr_owner` remains in effect. It also grants
the application SELECT on ranking, without CCV access or account writes.
From the repository root, copy the installation files:

```powershell
docker cp .\database\bfmr-postgres-db-install.psql bfmr-postgres:/tmp/bfmr-install.psql
docker cp .\database\schema.sql bfmr-postgres:/tmp/bfmr-schema.sql
docker cp .\database\gmail_intake.sql bfmr-postgres:/tmp/bfmr-gmail-intake.sql
docker cp .\database\seed_amazon_account.psql bfmr-postgres:/tmp/bfmr-seed-amazon-account.psql
```

The installer applies only to its reviewed fresh/empty baseline and requires
that its application roles do not already exist. On an already-installed
database, do not rerun the full installer;
apply only reviewed upgrades and invoke the seed separately as the owner after
ranking finalization.

For the separately authorized fresh installation, supply the required CCV
locally with a masked PowerShell prompt and remove it afterward:

```powershell
$secret = Read-Host 'Initial account CCV' -AsSecureString
try {
    $env:BFMR_INITIAL_ACCOUNT_CCV = [System.Net.NetworkCredential]::new('', $secret).Password
    docker exec -it --env BFMR_INITIAL_ACCOUNT_CCV bfmr-postgres psql -X -U bfmr -d bfmr -v ON_ERROR_STOP=1 -f /tmp/bfmr-install.psql
}
finally {
    Remove-Item Env:BFMR_INITIAL_ACCOUNT_CCV -ErrorAction SilentlyContinue
    $secret.Dispose()
}
```

Use the actual database administrator if its name differs from `bfmr`. The
installer must run the seed while `SET ROLE bfmr_owner` remains in effect. This
installation variable is not persistent worker configuration or an `.env` entry.

These files have not been applied to an installed database. Offline synthetic
SQL/input validation is recorded below; no provider action occurred.

## Retailer account ranking and existing-database upgrade

A retailer can have multiple `retailer_accounts` rows. Each row requires an
explicit `retailer_account_ranking integer NOT NULL`, unique within its
`retailer_id` through `retailer_accounts_retailer_ranking_uk`. The worker selects
the lowest integer rank for the retailer and pins that exact account for the
run; it does not select by account ID, email order or an arbitrary first row.
Negative, zero and positive integers are allowed. There is no default rank or
automatic assignment, and uniqueness is per retailer rather than global.

For a fresh, empty database, the current `schema.sql` already has the completed
ranking contract. Do not apply either ranking upgrade after fresh installation.
For an existing pre-ranking database, prepare these separate operator-reviewed
stages without starting the worker between them:

1. Stop the worker, inspect the actual baseline and preserve coordinated backups.
   Apply only `20261022_retailer_account_ranking_prepare.sql` when separately
   authorized. It adds the nullable integer column and unique constraint while
   leaving all existing ranks unassigned (`NULL`).
2. Review all retailer account rows and assign each intended integer rank through
   separately reviewed administrator updates. Every account must receive a rank,
   and ranks must be unique within each retailer. The migration provides no
   backfill command or ordering inference: actual preference is an operator
   decision, not something to derive from IDs or current row order.
3. Apply `20261022_retailer_account_ranking_finalize.sql` only after that explicit
   backfill is reviewed. It validates the prepared integer/no-default column and
   unique constraint, refuses any remaining `NULL`, then sets `NOT NULL`.
   Failure rolls back finalization without changing supplied ranks; earlier
   stage-1/operator changes remain for correction.
4. Verify the completed installed contract and account choices before a separately
   authorized worker run. Runtime validation must reject the incomplete nullable
   stage; it never assigns ranks or applies either upgrade automatically.

The non-owning worker role needs `SELECT` access to the rank alongside the
already-approved account ID/retailer/email fields. Rank assignment and changes
belong to an administrator; do not grant the worker retailer-account INSERT or
UPDATE privileges for ranking. This source work applies no SQL to an installed
database. Offline evidence is recorded below; native upgrade/data acceptance remains
pending.

## Production Gmail operational schema

Production watch/PubSub intake additionally requires [gmail_intake.sql](gmail_intake.sql).
It creates `gmail_intake_state`, `gmail_intake_runs`,
`gmail_intake_notifications` and `gmail_intake_work` in the same intended
PostgreSQL database. It is separate from the 16-table business schema and does
not change that schema's contract or hash. Business-schema installation does not install intake tables, and
intake installation does not install business objects or accepted cutover data.

Review the actual baseline and coordinated backups before a separately
authorized one-time installation. Runtime performs read-only catalog validation,
never DDL. Its non-owning role needs SELECT, INSERT and UPDATE on the four
operational tables; do not grant schema management or table deletion/truncation.
The tables contain private queued message bodies/headers and actual identifiers.
Back them up and restore them together with the other private recovery stores.

An existing JSON Gmail queue requires the reviewed report-first
`scripts/import_gmail_intake.ts` path; no automatic import, cursor reset or empty
replacement is performed. Native SQL/schema/grant and provider acceptance remain
pending: the implementation work did not install SQL, import actual state, run
new software tests, establish a watch or invoke a live worker. See the
[production Gmail runbook](../docs/GMAIL_PRODUCTION_INTAKE.md) for configuration,
exact import controls, production-versus-test startup and remaining acceptance.

## Offline account ranking validation — 22 October 2026

The user authorized focused offline tests after implementation. Run
`npm run test:retailer-accounts`: **14/14 passed**, with zero failures/skips.
The existing `npm run test:relational` suite also passed **23/23** against the
updated canonical schema. These are separate suites, not additions to historical
test aggregates. Both TypeScript checks and `git diff --check` passed.

The focused suite uses disposable PGlite and synthetic account identities. It
covers lowest-rank selection across 1:M accounts, missing/duplicate retailers,
missing accounts, changed run-pinned selection, required/per-retailer unique
ranks and required CCV, schema-validator stops, unassigned upgrade preparation,
failed/partial/manual-backfill finalization and unintended defaults. Seed cases
cover exact reruns, leading zeros, unfinished ranking, missing/malformed private
input and conflicting CCV/rank/homepage/retailer records without overwrites.

Seed tests execute the actual SQL with only the requested email replaced by a
synthetic identity and psql COPY replaced by a parameterized temporary-table
insert. The exact private-input shell program runs with a clean synthetic
environment; the sandbox blocked its subprocess, so the successful run used
approved execution outside that sandbox. This does **not** verify native psql
parsing/COPY, installer roles/grants, native PostgreSQL upgrades, real account
data or production/provider operation. No installed database was changed.

## Offline checks

`npm run test:gmail-intake` validates the separate operational intake contract
with synthetic providers and disposable PGlite. Current results and limits are
recorded in the [intake runbook](../docs/GMAIL_PRODUCTION_INTAKE.md#offline-validation--22-october-2026).

With the application's development dependencies installed:

```sh
npm run test:relational
npm run typecheck:all
```

The relational suite resolves `database/schema.sql` relative to its helper
module, validates the reviewed SHA-256 and uses disposable PGlite. It never uses
a private `DATABASE_URL`. `BFMR_SCHEMA_SQL_PATH` remains an optional test-only
override for an identical reviewed file; it is not required and cannot bypass
the schema hash check. Future intentional SQL changes must update that reviewed
hash and the relevant regression/contract evidence together.

The database design notes retain their original dated evidence. Current runtime
integration, offline results and remaining native PostgreSQL/provider/production
acceptance gates are documented in
[RELATIONAL_INTEGRATION.md](../docs/RELATIONAL_INTEGRATION.md), the
[v22 design](../docs/BFMR_Solution_Design_Specification_v22.md) and the
[v22 implementation reference](../docs/BFMR_Implementation_v22..md).

## Origin and preservation

Consolidated on 21 October 2026 from
[`z0ned/BFMR_DB_Schema`](https://github.com/z0ned/BFMR_DB_Schema) `main` at
`a67a0715ef040b0dd65de17ce63a0a5e34898699`, after the payout-guard branch was
merged. The following files were imported byte for byte at that checkpoint;
the hashes below are historical provenance, not promises that subsequently
amended local files remain byte-identical. Their upstream history remains
available in that repository. Its two-line README was replaced by this
application-specific guide. The old repository was neither deleted nor archived
by this move; future schema maintenance belongs here.

| Imported file | Original SHA-256 |
| --- | --- |
| `schema.sql` | `f7849f7cad80c26f1c46d38369e2c58ed3a17d263d71f0696753b21397e8bab3` |
| `DESIGN_DECISIONS.md` | `539035a84560df3edd2a96d347a9bfb54373cf42515c7834a10bee1f38053f62` |
| `migrations/20261020_sync_consistency.sql` | `c4e6b41c24e90199fc753313eb3743a7a873dd9800fb2e36686b698954dc3726` |
| `migrations/20261020_reservation_payout_immutability.sql` | `f26f8ab64871750a0ade168541c82ba6d5a62f0551b36250bb9add10c4f6ac80` |

The local retailer-account ranking amendment intentionally changes `schema.sql`
and appends current rationale to `DESIGN_DECISIONS.md`; it leaves the original
upgrades and the provenance hashes above intact. The relational test helper's
current reviewed schema hash must track this amendment. Earlier offline results
remain evidence for their dated pre-ranking source, not validation of this new
column or staged upgrade.

Current ranking-schema SHA-256:
`6c7c2707e854d9f5d07c9db073b5508792800ef5c57b6dcb5d19e2c445682af6`.
