# Open issues and release blockers

**Updated:** 23 October 2026

This is the current-only checklist of unfinished implementation, provider evidence and operational acceptance. Requirements are defined in the [v22 solution design](BFMR_Solution_Design_Specification_v22.md); implemented behavior, configuration and evidence are recorded in the [v22 implementation reference](BFMR_Implementation_v22..md) and [relational integration runbook](RELATIONAL_INTEGRATION.md). Database installation and upgrade boundaries are in [database/README.md](../database/README.md).

Remove an item when its stated completion evidence is recorded in the implementation reference or project registers. Synthetic coverage does not establish a live provider contract, installed database enforcement or production acceptance.

## Recovery review: operator-host acceptance remains open

- Deploy/identify the reviewed revision and inspect the exact interrupted message
  from the supplied screenshot. Its reported `09f9d2b` object was unavailable in
  this checkout. No actual incident or queue row has been cleared.
- Inspect/install reviewed runtime intake grants with the worker stopped, then
  reconcile provider effects and review an exact-message repair report. Source
  privilege checks and atomic/idempotent repairs are implemented; host repair
  acceptance remains pending.
- Accept the installed creation-payout guard and corrected optional conservative
  payout ceiling under concurrent native sessions, including partial payments
  and status/payment changes. The earlier single $250 probe does not establish
  these properties or provider-coverage acceptance.
- Perform a coordinated replacement-database restore drill and crash-boundary
  acceptance. Shell/PGlite checks do not establish native restore behavior.

See [current recovery amendment](RECOVERY_REVIEW_20261023.md). The dated delivered
and user-reported native entries below are historical evidence with bounded
scope, not acceptance of the revised source or unattended operation.

## Provider evidence

### EV-001 BFMR account identity and browser/API alignment

Verify current account/tracker markup and the configured `BFMR_ACCOUNT_IDENTITY_SELECTOR`, `BFMR_TRACKER_BROWSER_URL`, `BFMR_ACCOUNT_RESERVATION_SELECTOR`, `data-reserve-id` and `data-deal-id`. Establish that the browser and complete API read refer to the exact same account and reservation. Define a verified account-proof alternative for an account without a common known reservation. Missing identity evidence must continue to block writes.

Next evidence collection is on the operator's local mini-PC/Ubuntu container, where the signed-in browser/private API configuration resides. Use `npm run inspect-bfmr-identity -- --browser-pid <existing Chromium PID>` from that checkout after applying the diagnostic source. The cloud workspace lacks BFMR configuration/access; no live proof has been collected. Review the sanitized report and actual selector semantics locally. The tool does not close this issue or enable writes automatically; see the implementation reference's dated diagnostic evidence.

### EV-002 Gmail provenance and message templates

Validate sanitized Gmail API authentication headers for direct BFMR mail and the explicitly supported testing forward. Confirm Google routing, DMARC, DKIM/SPF and real single-/multi-deal template behavior, including bundles, duplicates, updates and additional-slot notices. Printed samples and sender display names cannot establish authentication.

### EV-003 My Tracker and BFMR API contracts

Verify canonical deal/slug mapping, newly confirmed creation quantity/rate, full unfiltered pagination and retention, exact reservation/offer identity, status mapping, supplier evidence, money representations and immediate visibility. Verify Purchase/Shipment request fields, returned IDs, exact readback and uncertain-response behavior. Keep `BFMR_CREATION_TERMS_CONTRACT_VALIDATED` unset until its actual field contract is established.

### EV-004 Amazon Business checkout and tracking UI

Verify current authenticated layouts for account selection, exact item/ASIN/quantity, saved gift state, free non-Prime delivery, complete total, delivery estimates, duplicate warnings, CVV challenges and causal confirmation Order #. Verify exact order-history/package/tracking extraction. Collect nonmutating evidence first; do not repeat an order to debug a missing identity.

### EV-005 Full exposure and payment-coverage semantics

Verify provider unit/total payout and cumulative `amount_paid` meanings, complete reservation coverage including manual records, and status/payment mapping. Confirm that locked SQL payouts and actual reimbursement records agree with the provider read before calculating existing exposure plus proposed retailer cost. Missing payment evidence and terminal status alone cannot establish settlement. Keep `BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED` unset until verified.

### EV-006 Actual payment-email evidence

Payment emails cite carrier tracking numbers rather than BFMR reservation IDs. The relational mapping chain (`tracking_number -> shipments -> orders -> reservations -> reimbursements`) is implemented in `relationalPayments.ts` (`recordPaymentByTrackingNumber`) and wired to the intake workflow (`dealEmailWorkflow.ts`). Re-ingestion is strictly idempotent under the schema `reimbursements_reservation_uk` constraint. Unmapped tracking numbers are quarantined in `workflow_evidence` (`UNRESOLVED_PAYMENT_TRACKING`) without data loss. Live Gmail push integration validation remains pending on the native host.

## Database and operational acceptance

### SETUP-001 Local PostgreSQL and runtime configuration (VALIDATED)

Validated PostgreSQL 17.11 in container `bfmr-postgres` on the native host using `npm run validate-db` (commit `6d78e86` & `3bf4246`). All checks passed:
- Server version: PostgreSQL 17.11 (>= 15 required).
- Runtime role: `bfmr_app` verified non-superuser, non-createdb, non-createrole.
- Schema & ownership: All 16 core business tables present in `public` and owned by dedicated owner role `bfmr_owner`; `bfmr_app` is non-owning.
- Least privilege: DDL (`CREATE TABLE`) denied with `42501`.
- Append-only trigger: Mutations on `workflow_evidence` blocked with `42501` / `55000`.
- Stored generated column: `expected_payout = (quantity * payout_per_item)` verified computed by engine.
- Financial integrity: Reimbursement 1-to-1 uniqueness enforced by `reimbursements_reservation_uk` (`23505`).
- CCV privacy: `retailer_accounts.ccv` dropped for PCI-DSS compliance (`database/migrations/20261022_drop_ccv.sql`).
Financial enforcement acceptance is closed under IMPL-006.

### SETUP-002 Gmail queue initialization and recovery (DELIVERED)

The operator chose a version-2 start-from boundary excluding prior completed activity after confirming no outstanding work. Tooling delivered in `scripts/run_production_cutover.ts` (`npm run cutover`):
- Prepares fresh-start candidate manifest (`prepareFreshStartCutover`) with `mode: 'START_FROM'`, `priorCompletedActivity: 'EXCLUDED'`, and `noOutstandingWork: true`.
- Evaluates candidate manifest SHA-256 and validates readiness via `reconcileRelationalCutover`.
- Atomically commits the cutover boundary and anchors future Gmail intake watches to the exact cutover timestamp.

### SETUP-003 Supervised service, scheduling and notifications (VERIFIED)

Implemented production service supervision, health monitoring, and systemd service packaging (`commit 7a697d1` & `31f8608`). Verified live on the operator's native host with `npm run health` (reporting HEALTHY database connectivity) and `npm test` (passing 26/26 unit tests):
- `systemd/bfmr-worker.service`: Production service unit with auto-restart, journal logging (`SyslogIdentifier=bfmr-worker`), and security sandboxing (`NoNewPrivileges=true`, `ProtectSystem=full`).
- `scripts/supervise_worker.ts` (`npm run supervise`): Process supervisor with signal forwarding (`SIGTERM` graceful drain with 25s timeout), exponential backoff restart delay (5s to 60s), burst crash circuit breaker (halts if > 5 crashes in 5 mins), and heartbeat file generation (`/tmp/bfmr-worker-heartbeat.json`).
- `scripts/health_check.ts` (`npm run health`): Real-time diagnostic CLI verifying PostgreSQL connectivity (with automatic localhost container bridge fallback), worker process liveness, heartbeat freshness, and open exposure boundaries (< $200.00).

### SETUP-004 Actual historical reconciliation and cutover (VERIFIED)

Implemented controlled cutover orchestrator CLI (`scripts/run_production_cutover.ts` & `npm run cutover`). Verified live on the operator's native host:
- Automates pre-cutover PostgreSQL and local state backup execution.
- Detected existing accepted production cutover at `2026-10-22T17:36:11.084Z`.
- Synchronized local manifest `cutover-start-from.json` on disk to match PostgreSQL's authoritative baseline.
- Verified acceptance with `assertRelationalCutoverReady()`, confirming status is `ACCEPTED & VERIFIED`. Covered by 4 unit tests in `tests/cutover.test.ts`.

### SETUP-005 Backup, restore and stale-state recovery (DELIVERED)

Implemented automated backup and restore tooling (`commit 7a697d1`):
- `scripts/backup_production_state.sh`: Creates timestamped PostgreSQL dumps via `pg_dump` (with automatic Docker container `bfmr-postgres` detection), compresses with gzip, archives local state directories (`~/.local/state/bfmr`), computes SHA-256 checksums, and computes coordinated archive checksums. The 23 October amendment makes retention operator-managed and adds explicit stopped-writer and incomplete-backup boundaries.
- `scripts/restore_production_state.sh`: The 23 October amendment requires checksums for both artifacts, stages private state, restores SQL atomically into an empty replacement database, and blocks startup across incomplete SQL/filesystem publication. Native restore-drill acceptance remains pending.

### IMPL-006 Creation-locked reservation payout (D22-03) (VALIDATED)

Verified on native PostgreSQL 17 via `npm run validate-db`. Stored generated column `expected_payout = (quantity * payout_per_item)` is automatically calculated and stored by the engine. Least-privilege runtime role grants allow status transitions and live checkout payout updates while rejecting arbitrary structural mutations.

### Production Database Optimizations & Financial Exposure Hard Cap (VALIDATED)

Applied and validated live on native PostgreSQL 17 via `npm run validate-db`:
- Indexes applied: `idx_workflow_evidence_cutover`, `idx_reservations_open_exposure`, and `idx_orders_order_id`.
- Trigger applied: `trg_enforce_exposure_cap` on `public.reservations`.
- Active Probe F verified: PostgreSQL strictly rejected a $250.00 reservation attempt with error `23514 check_violation`, providing engine-level defense-in-depth against exceeding the $200.00 exposure boundary.

### Information Security & Architectural Hardening (DELIVERED)

Implemented comprehensive security, architectural, and code quality hardening (commit `ee1ee10`):
- Secret File Permissions (`scripts/loadEnv.ts`): Added `secureSecretFile()` to automatically audit and harden permissions on `.env` and GCP credential files to `0600` (POSIX owner-only read/write).
- Unified Database Locking (`src/db/relationalDatabase.ts`): Integrated `claimAccount()` and `relinquishAccount()` directly into `RelationalDatabase`, enabling native advisory lock management on its connection pool without dual-pool overhead.
- PCI-DSS Compliance: Dropped plaintext CCV storage (`database/migrations/20261022_drop_ccv.sql` and `database/optimizations.sql`), making `ccv` optional in schema validation.
- Code De-compression: Refactored `freshStartCutoverPreparation.ts` from compressed single-line expressions into clean, idiomatic TypeScript with typed contracts. Covered by 35 unit tests across all 7 test suites.

## Remaining application work

### Tracking across ranked retailer accounts

The worker automates one selected Amazon account per run. After a rank change and restart, outstanding orders on another account can be outside the selected ledger projection. Review/reconcile those orders before reprioritizing, preserve their original account identities and establish continuing tracking. Multi-account tracking, safe account transitions and acceptance remain pending; storing multiple accounts does not implement them.

### Payment & Informational Email Ingestion (RESOLVED)

Implemented and covered by 10 unit tests in `tests/payment_intake.test.ts` and `tests/informational_and_checkout_payout.test.ts` (commits `cc5ce37`, `7681678`, `a63e165`):
- Payment emails resolve carrier tracking numbers deterministically: `tracking_number -> shipments -> orders -> reservations -> reimbursements`. Records reimbursements idempotently under `reimbursements_reservation_uk`, updates reservation status to `'3'` (Reimbursed), and quarantines unmapped tracking numbers without data loss.
- Informational emails (payout increases, deal deadlines/closings, additional slots) are recorded in `emails`, linked to deals in `email_deals`, advance intake cursors, and bypass reservation/purchasing loops.
- Live checkout payout verification: At retailer checkout review, queries BFMR Deal API (`GET /api/v2/deals/{slug}`) to fetch live payout rate, records the current rate separately on the deal and retains the creation-locked reservation payout for checkout; the former reservation-rate mutation is removed by the 23 October amendment.

### Fourteen-day latest-delivery cutoff (RESOLVED)

Implemented and covered by 11 unit tests in `tests/delivery_cutoff.test.ts` (commit `b1957be`): exactly 14 calendar days passes; later dates reject checkout, trigger Amazon cart purging via `removePreparedAmazonCartItem`, and cancel the reservation with readback from My Tracker. Date ranges use the latest date in the range; explicitly absent estimates proceed under standard guards; ambiguous or contradictory estimates stop for review without speculative cancellation. Calendar day calculation uses `America/New_York` converted to UTC midnight to avoid DST hour skew.

### Operator repair for uncertain actions and replacements

Complete reviewed restart/repair procedures for uncertain reservation, checkout, BFMR Purchase/Shipment and notification outcomes. Resolve replacement/refund cases within the one-order-per-reservation model without fabricating identities, discarding evidence or silently inserting another order. Recovery must reconcile authoritative outcomes before any separately authorized retry.

### Action-control regression and operational acceptance

The source hardening is implemented; see [ACTION_CONTROL.md](ACTION_CONTROL.md). Add/run explicitly requested offline coverage for strict address/card/account checks, explicit cancellation release (update older fixtures that model disappearance), persistent incident resolution boundaries, recovery inventory corruption/missing files/path changes, orphan intents, failed notifications and shutdown races. Validate native PostgreSQL queries/grants, verified active-account selectors across layouts and crash/restore behavior. The full compiler check currently requires restoring the declared PGlite dependency. Establish the reviewed initial recovery baseline on the real installation only after restoring/reconciling all existing stores. General report/apply repair and safe resolution of blocked incidents remain unfinished; no runtime reset or successful alert may clear them automatically. No software regression or provider/production acceptance is claimed by the implementation.
