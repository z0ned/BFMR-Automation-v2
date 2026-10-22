# BFMR database schema

This directory is the authoritative source for the relational business schema,
upgrade migrations and database design notes used by BFMR-Automation-v2.
PostgreSQL 15 or later is intended to run locally on the mini-PC. A second
`BFMR_DB_Schema` checkout is no longer required.

| File | Purpose |
| --- | --- |
| [schema.sql](schema.sql) | Complete 16-table fresh-install schema, lookup seeds, constraints, append-only evidence and immutable reservation-payout guard. |
| [gmail_intake.sql](gmail_intake.sql) | Separate, additive four-table operational Gmail cursor/watch/run/notification/work contract; install once only under reviewed authorization. Does not modify the pinned business schema. |
| [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) | Preserved database design rationale and dated source/validation history. Read current application evidence alongside it. |
| [migrations/20261020_sync_consistency.sql](migrations/20261020_sync_consistency.sql) | Single-use upgrade for the schema immediately preceding the sync-consistency change; requires actual scope backfill/reconciliation. |
| [migrations/20261020_reservation_payout_immutability.sql](migrations/20261020_reservation_payout_immutability.sql) | Single-use upgrade from its stated baseline to protect existing reservation creation terms. |

The design notes are preserved verbatim from the former schema repository.
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

## Production Gmail operational schema

Production watch/PubSub intake additionally requires [gmail_intake.sql](gmail_intake.sql).
It creates `gmail_intake_state`, `gmail_intake_runs`,
`gmail_intake_notifications` and `gmail_intake_work` in the same intended
PostgreSQL database. The 16-table `schema.sql` and its reviewed SHA-256 remain
unchanged. Business-schema installation does not install intake tables, and
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
merged. The following files were imported byte for byte; their upstream history
remains available in that repository. Its two-line README was replaced by this
application-specific guide. The old repository was neither deleted nor archived
by this move; future schema maintenance belongs here.

| Imported file | Original SHA-256 |
| --- | --- |
| `schema.sql` | `f7849f7cad80c26f1c46d38369e2c58ed3a17d263d71f0696753b21397e8bab3` |
| `DESIGN_DECISIONS.md` | `539035a84560df3edd2a96d347a9bfb54373cf42515c7834a10bee1f38053f62` |
| `migrations/20261020_sync_consistency.sql` | `c4e6b41c24e90199fc753313eb3743a7a873dd9800fb2e36686b698954dc3726` |
| `migrations/20261020_reservation_payout_immutability.sql` | `f26f8ab64871750a0ade168541c82ba6d5a62f0551b36250bb9add10c4f6ac80` |
