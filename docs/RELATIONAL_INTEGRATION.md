# Relational business persistence — 20 October 2026

This runbook describes the application integration source authorized on 20 October 2026, with the 22 October ranked-account selection amendment below. PostgreSQL is intended to run locally on the mini-PC. The authoritative 16-table contract lives in [database/schema.sql](../database/schema.sql), including `deal_retailers`, the immutable-payout guard and required account ranking. Upgrades and preserved design notes are beside it; [database/README.md](../database/README.md) records current/historical hashes and installation boundaries. Consolidation on 21 October copied the original files unchanged from former `BFMR_DB_Schema` main at `a67a0715ef040b0dd65de17ce63a0a5e34898699`; the ranking source now changes that schema and adds a two-stage upgrade. No second checkout is required. The current v22 pair describes this contract; older conceptual fields and order-linked multiple-payment examples are superseded.

The application does not install that schema, apply migrations, or import historical records at startup. A deployed schema/cutover and provider-contract acceptance remain separate from source implementation. No live provider or production database was invoked for this work. User-authorized offline results are recorded below, dated 21 October 2026.

## Source responsibilities

| Source | Responsibility |
| --- | --- |
| `database/schema.sql`, `database/migrations/`, `database/DESIGN_DECISIONS.md`, `database/README.md` | Canonical business schema, upgrade sources, preserved rationale and consolidation provenance, maintained with the application. |
| `src/db/relationalTypes.ts` | Row/input types using the schema's actual fields; PostgreSQL bigint and numeric values remain strings at the boundary. |
| `src/db/relationalRepositories.ts` | Parameterized reservation, order, shipment, reimbursement, email/deal, observation, workflow-evidence and sync-run operations; exact idempotency checks; integer-cent conversion. |
| `src/db/relationalDatabase.ts` | Read-only schema-contract inspection and single-client serializable business transactions; account ownership verification; no automatic DDL or transaction retry. |
| `src/db/postgresDatabase.ts` | Dedicated `PostgresAccountOwnership` advisory-lock path plus the separately retained legacy orchestration aggregate implementation. |
| `src/services/relationalRuntime.ts` | Startup validation of schema, account ownership, accepted cutover/source hash, and the uniquely selected database Amazon retailer/account. |
| `src/services/relationalDealTerms.ts`, `relationalTrackerTerms.ts`, `relationalReservations.ts` | Independently observed current deal terms, exact new-reservation financial capture, durable reservation intent/confirmation, supplier eligibility and confirmed cancellation evidence. |
| `src/services/bfmrRelationalSync.ts`, `relationalExposure.ts` | Complete-read reconciliation and retained conflicts; immutable creation payouts; fresh provider/payment coverage before exposure calculation. |
| `src/services/relationalOrderLedger.ts` | Relational order/shipment records exposed through the existing ledger interface; append-only operational snapshots and exact provider IDs. |
| `src/services/relationalPayments.ts` | Actual, previously authenticated and contract-validated payment notices linked to the reservation and payment email; no inferred cumulative-payment transactions. |
| `src/services/relationalCutover.ts`, `scripts/reconcile_relational_cutover.ts` | Private manifest reconciliation, default report mode, and explicit transactional import/acceptance without provider actions. |
| `scripts/test_real_email_e2e.ts`, `scripts/live_test_startup.ts` | Existing runner/startup workflows connected to relational persistence while preserving their identity, quantity, financial and uncertainty guards. |

The active email runner uses SQL business records instead of the private Amazon order JSON ledger. Tracking submission and daily status services accept the ledger abstraction. A single order belongs to a reservation, a single shipment/tracking number belongs to an order, and a single reimbursement belongs to a reservation. Multiple orders across separate reservations for the same retailer account/deal remain allowed. A provider report of multiple shipments or tracking numbers is retained for review; it is not collapsed into the single shipment row.

## Operational state remains explicit

Gmail cursor/work/notification/run state now uses the separate four-table `database/gmail_intake.sql` contract through the push worker source. This does not alter the pinned 16-table business schema. Legacy Gmail JSON requires explicit reviewed import; multi-deal progress, startup/post-reservation recovery and status/alert journals remain private files. Historical JSON/status evidence is preserved. The legacy JSONB engine aggregate is also retained for its existing orchestration compatibility; the relational live startup path does not initialize or use it as the business-record store.

These stores remain behind explicit store interfaces. They are not one database transaction with provider actions or with each other. An evidence row is not a runnable command queue or permission to retry. Gmail gaps and interrupted `PROCESSING` work still stop for review. Broader command/retry and alert-outbox migration remains separate work; see [production intake runbook](GMAIL_PRODUCTION_INTAKE.md) for the new Gmail store and its unverified installation/import boundary.

## Startup prerequisites and configuration

1. Install/review the schema and payout guard separately on the local PostgreSQL database. The startup validator checks required columns/types, keys, relevant checks, lookup mappings, the stored generated payout expression and the enabled `ALWAYS` immutable-input trigger. Missing or altered contract objects stop startup; there is no automatic repair.
2. Use a non-owning application role with the required read/insert/permitted-update grants. Do not grant schema/trigger management, reservation deletion/truncation, or reservation identity reassignment. Provisioning roles and grants is outside the startup code.
3. Reconcile historical records and accept a cutover manifest through the controlled path below. Startup requires exactly one matching `RELATIONAL_CUTOVER` / `CONFIRMED` / `ACCEPTED` workflow marker, including account and legacy ledger hash. Missing/multiple/conflicting markers or changed source bytes stop the writer.
4. Require exactly one `retailers` row where `name = 'Amazon'`, then select its account with `WHERE retailer_id = <selected retailer ID> ORDER BY retailer_account_ranking ASC LIMIT 1`. Multiple accounts are valid; zero linked accounts stop startup. The database supplies IDs, stored email and rank without retailer-account environment values. Startup validates required integer/non-null/per-retailer unique ranking with no default/generated value, and the approved HTTPS Amazon homepage. Selection reads only account `id`, `retailer_id`, `email` and `retailer_account_ranking`; it neither creates accounts/assigns ranks nor selects `ccv`. Existing provider/browser identity guards remain independent.
5. Preserve the dedicated account advisory lock. Ownership loss stops processing and closes the controlled browser. All provider identity, provenance and layout contracts remain independent release gates.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Private connection configuration for the intended local mini-PC PostgreSQL database. Do not log or commit it. |
| `BFMR_EXPECTED_ACCOUNT` | Existing exact BFMR account identity; normalized for account-lock/cutover association. Browser/API alignment must still be proved. |
| `BFMR_CREATION_TERMS_CONTRACT_VALIDATED` | Leave unset until the canonical deal and newly confirmed reservation financial-field contracts are verified. Only `YES` enables the creation-term adapter. |
| `BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED` | Existing gate, unchanged: only `YES` permits action-driving exposure after verified full tracker/payment semantics. |
| `BFMR_AMAZON_ORDER_LEDGER_PATH` | Existing private legacy order file used as a cutover source/hash boundary. Preserve its accepted bytes; it is not the active email runner's business writer after cutover. |

Existing Gmail queue, batch, status, browser, notification and credential configuration remains required. None of these variables grants authority to invoke a purchase, reservation, cancellation or provider update.

**22 October 2026 selection update:** The ranked database lookup replaces the former environment-selected identity and the interim exactly-one-account requirement. Startup pins the selected account for the run; ledger operations, supplier associations, reservation submissions and Amazon checkout revalidate it and stop if the chosen identity changes, without switching to another account. Stop the worker before changing accounts/ranks: these checks do not make SQL reads and provider actions atomic. Ranking source remains uninstalled; [offline ranking evidence](../database/README.md#offline-account-ranking-validation--22-october-2026) records user-authorized synthetic tests without installed database/provider actions. The dated offline evidence below applies to its recorded schema/source revision.

The worker automates one selected account per run, not tracking across every account. After a priority change and restart, orders on the previously selected account can be outside the current ledger projection. Existing orders retain their original retailer-account identity; never relabel them to the new selection. Before changing priorities, review and reconcile outstanding orders on every affected account and establish how their continuing tracking will be handled. Multi-account tracking and acceptance remain open.

The creation adapter uses the canonical trusted `GET /api/v2/deals/{slug}` read, matching deal ID, slug when present, and the normalized visible title. Supported current per-item payout aliases are `reimbursement_amount`, `payout_price` and `payout`; all supplied values must agree. Current deal terms and reservation creation terms are independent facts. The tracker normalizer checks quantity/status aliases, unit payout and whole-reservation totals for agreement. Unsupported or ambiguous fields stop capture; it does not substitute today's deal rate for missing legacy creation terms.

## Retailer account ranking upgrade — 22 October 2026

`retailer_accounts.retailer_account_ranking` is an integer, `NOT NULL`, with `UNIQUE (retailer_id, retailer_account_ranking)`. The lowest value wins; ranks need not be positive or consecutive, and different retailers may reuse a rank. Multiple accounts per retailer are supported. There is no default, generated rank, ID-based inference or automatic assignment.

For a fresh database, review the current full schema before separately authorized installation; account provisioning must supply actual reviewed ranks. For an existing database, stop the worker, preserve backups and review the actual baseline before these separately authorized stages:

1. Apply [20261022_retailer_account_ranking_prepare.sql](../database/migrations/20261022_retailer_account_ranking_prepare.sql): add nullable ranking plus per-retailer uniqueness. This does not assign any priorities.
2. Review every existing account and explicitly backfill its intended integer priority through operator maintenance. Resolve every NULL and within-retailer duplicate; preserve exact historical account/order associations.
3. Apply [20261022_retailer_account_ranking_finalize.sql](../database/migrations/20261022_retailer_account_ranking_finalize.sql): refuse unresolved NULLs and enforce `NOT NULL`. Worker schema validation refuses startup until this final contract is installed.

Existing least-privilege application roles additionally need `SELECT (retailer_account_ranking)` on `retailer_accounts`. Keep account/rank maintenance outside the application role; do not grant it permission to update rankings or select `ccv`. Installed roles, constraints and reviewed account/rank data still need separately scoped acceptance. Neither these instructions nor source presence applies SQL or authorizes a live worker.

For an existing application role named `bfmr_app`, the additional reviewed grant is below; adapt the role name to the actual installation before separately authorized application:

```sql
GRANT SELECT (retailer_account_ranking) ON public.retailer_accounts TO bfmr_app;
```

## Creation, reconciliation and payments

Reservation intent is committed before the website form action. Confirmation captures the exact new reservation's quantity and per-item rate once, retaining the creation observation and workflow correlation. Startup's temporary reservation can have a null source email and still receives intent/confirmation evidence before its existing exact cancellation flow. No fabricated email or reservation ID is introduced.

Startup performs a full account reconciliation before creating its temporary reservation or recovering a pending legacy task. Recovery requires existing locked creation terms and exact identity before any mutation. An uncertain reservation capture stops the email batch before eligibility evaluation, cancellation or checkout. The separately invoked local PDF workflow records an explicit PDF source/hash with a null canonical email association; a printout is not authenticated Gmail evidence.

Later sync updates only permitted current fields, such as status. It does not rewrite creation quantity/rate. Exact repeated capture verifies the existing terms without reverting a deal's newer rate to an old creation snapshot. A conflicting provider payout remains observation/review evidence. An immutable-input or identity rejection does not automatically retry the rejected write; review evidence is retained in a separate successful transaction when the original statement/transaction has rolled back.

For a complete, account- and field-contract-validated My Tracker read, reconciliation validates all rows before promoting any current state. Selected observations, permitted updates and successful sync completion commit together. Order/purchase/shipment/tracking associations are checked against accepted identities inside that same transaction. Duplicate/unknown identities, missing known reservations, unrecognized statuses, financial conflicts or payment-coverage uncertainty retain evidence and a failed/incomplete run while leaving authoritative business records unchanged. Unknown legacy reservations require actual creation evidence; a current tracker/deal value alone does not reconstruct their historical terms.

Exposure uses locked `reservations.expected_payout` and actual recorded reimbursement amounts. It requires the latest full-sync attempt itself to be complete, fresh observations covering the known reservations, and provider cumulative `amount_paid` matching actual payment evidence. It does not fall back to an older successful run after a later failed attempt. Missing payment amount is unknown rather than zero. The exact current newly confirmed reservation is excluded from the prior-exposure subtotal; its own locked payout still covers its proposed complete order total.

`recordVerifiedPayment` accepts a previously authenticated `PAYMENT_SENT` notice with exact reservation/deal identity, amount, actual payment time, source hash and contract-verification provenance. It links `reimbursements.payment_email_id` to the email and records one actual payment per reservation. Equal repeats are idempotent; a different payment is a review conflict. This does not supply live payment-mail contract verification or invent payment rows, dates or references from changes in cumulative tracker balances.

`scripts/record_reimbursement.ts` consumes a private manifest matching `VerifiedPaymentNotice` in `relationalPayments.ts`. It validates schema, ownership and the accepted cutover/source hash. Default invocation reports the exact manifest hash and whether a payment already exists; `--apply --confirm-manifest-sha256 <reviewed hash>` is a separately authorized database write. It has no provider action path and does not authenticate a raw email by itself. For a future operator review:

```sh
npx tsx scripts/record_reimbursement.ts \
  --manifest "$BFMR_PAYMENT_MANIFEST" \
  --legacy-order-ledger "$BFMR_CUTOVER_LEGACY_LEDGER" \
  --account "$BFMR_EXPECTED_ACCOUNT"
```

Observation times, purchase-confirmation times and workflow-intent times are retained with their actual meanings. A first observation is not presented as the provider's shipment/delivery event time. Sparse scheduling and provider-ID state lives in append-only evidence; business costs, payout terms, relationships and statuses remain typed relational fields.

Canceled, partial and non-unit historical orders, and unsupported historical order-number/ASIN shapes, remain business records and evidence but are excluded from the supported Amazon automation projection. Cutover and runtime share the same scope predicate. They do not block unrelated supported orders. Contradictory supported order/shipment states or purchase dates make the cutover report unready before an acceptance marker can commit. Malformed active records and corrupt/conflicting shipment confirmations require review. Snapshot idempotency compares semantic JSON values so PostgreSQL JSONB key ordering does not create false conflicts or duplicate exclusions.

## Controlled cutover

### Explicit start-from-today boundary — 22 October 2026

The operator confirmed no outstanding reservations, related orders or uncertain
submissions need migration, then chose to leave prior completed activity outside
this system. This authorizes preparing that scope, not claiming full historical
coverage. A version-2 manifest records `coverage: { sinceBaseline: true }` and
`baseline: { mode: 'START_FROM', startsAt: <UTC instant>,
priorCompletedActivity: 'EXCLUDED', noOutstandingWork: true }`. Its reservation
and exclusion arrays must be empty and its legacy-ledger hash must be null.
Version-1 complete-history manifests retain their existing meaning.

The boundary is the exact UTC instant the candidate is prepared, not an inferred
local midnight. The preparation tool preserves an existing matching candidate
and its timestamp, creates a new private file exclusively with mode 0600 under
`~/.local/state/bfmr/cutover-start-from.json`, and invokes only the report tool:

```sh
node --import tsx scripts/prepare_fresh_start_cutover.ts --confirm-no-outstanding-work
```

The command refuses existing private journals/ledger/legacy queue, conflicting
accepted baselines, existing business records or any existing SQL Gmail state.
It does not create replacement journals, reset a cursor, install SQL, apply an
acceptance marker, initialize Gmail or invoke providers. A failure can leave the
private candidate for review; it never overwrites one. Before applying, review
the exact boundary, confirm the no-outstanding-work assertion still holds and
review the report/hash. Acceptance remains the existing explicit `--apply` flow
with that exact manifest hash/account. Prior activity is excluded by scope, not
recorded as imported or verified absent from history.

The accepted marker retains the version and boundary. Startup validates it and
email-triggered reservation preparation rejects receipt times before the boundary
or invalid timestamps. Unknown reservations, unpaid exposure, inconsistent state
or ambiguous provider evidence still stop work; there is no date-based blanket
skip of BFMR rows or waiver of financial/identity gates. The boundary is not a
Gmail cursor or a provider-created-at proof. Real first-watch setup and any gap
between the boundary and initial watch still need explicit coverage decisions;
this change neither scans an Inbox nor authorizes unattended operation.

### Offline fresh-start validation — 22 October 2026

The user authorized focused tests followed by commit/push. Run
`npm run test:cutover-start`: **19/19 passed**, zero failures/skips. The existing
`npm run test:relational` suite was rerun and passed **23/23**; do not add these
reruns to historical distinct-case totals. Both TypeScript checks and whitespace
checks passed.

The new suite blocks network/provider access, clears private service/database
environment settings and uses synthetic identities, temporary private files and
disposable PGlite with the actual business/intake schemas. It covers explicit
coverage/version parsing; required scope/confirmation and time assertions; file
permissions, stable candidate bytes and source hashes; malformed/conflicting
candidates; default and configured recovery paths, including dangling or
uninspectable paths; read-only reporting; atomic/idempotent scoped acceptance;
refusal to replace historical/other boundaries; duplicate/malformed markers;
ownership loss; preserved existing reservations, Gmail cursors/history gaps and
interrupted `PROCESSING` work; and old-email rejection before account/provider
work or reservation intent.

Preparation was factored into `freshStartCutoverPreparation.ts` so tests load no
private CLI environment. An override cannot conceal a default journal. Tests do
not execute the native CLI/database/lock path, contact a provider, establish
Gmail watch coverage or apply the operator's cutover. Native report review and
first-watch coverage remain pending.

### Historical reconciliation

Keep the existing writer stopped and preserve backup/source files before planning a real cutover. A missing previously existing journal must be restored/reconciled, not treated as an empty account. The source tool imports database records only and has no Gmail, BFMR, Amazon or browser-action path.

The private version-1 manifest must identify the exact account, approval time, complete reservation/order/actual-payment coverage and legacy ledger SHA-256. Each reservation needs authoritative creation-term evidence. Orders require confirmed identity and retailer-eligibility evidence; shipments must satisfy the one-shipment/tracking-number rule; actual payments require authenticated notice evidence. Standalone orders excluded from BFMR import must be explicit. Unsupported legacy package arrays, missing identities, inconsistent rows or unsubstantiated creation terms keep the report unready.

Use private paths and existing connection configuration. The following are future operator commands, not commands executed by this documentation update:

```sh
# Default: read-only reconciliation report, no import or acceptance marker.
npx tsx scripts/reconcile_relational_cutover.ts \
  --manifest "$BFMR_CUTOVER_MANIFEST" \
  --legacy-order-ledger "$BFMR_CUTOVER_LEGACY_LEDGER" \
  --account "$BFMR_EXPECTED_ACCOUNT"
```

Review the report and its exact `manifestSha256`. An authorized application additionally requires `--apply`, the exact reviewed `--confirm-account`, and `--confirm-manifest-sha256`; combining `--report` and `--apply` is rejected. Successful import and the acceptance marker commit together. The tool never replays a purchase, reservation or provider write. Exact repeated accepted input is idempotent; a different accepted manifest/account is not silently substituted. Keep the accepted legacy source bytes stable so subsequent startup can verify them.

## Offline validation — 21 October 2026

Evidence class: synthetic offline regression and compiler checks. Across the validation runs, the latest result for each distinct case totals **142 tests: 141 passed, zero failed, one skipped**. Reruns are counted once. The final source corrections were followed by the focused suite and compiler checks; the unchanged existing suite was not repeated afterward.

- `npm run test:relational`: **23/23 passed** in the integration validation (originally invoked with an explicit path to the reviewed source, now bundled by default), using disposable `@electric-sql/pglite` 0.5.10 and canonical schema source at `a67a0715ef040b0dd65de17ce63a0a5e34898699`, SHA-256 `f7849f7cad80c26f1c46d38369e2c58ed3a17d263d71f0696753b21397e8bab3`. The helper never consults a private `DATABASE_URL`.
- Existing tests were executed directly per file with `node --import tsx tests/<name>.test.ts`: **118 passed**, with the native PostgreSQL integration intentionally skipped because `BFMR_TEST_DATABASE_URL` was unset. Direct execution exposed individual cases rather than relying on this environment's whole-file `--test` summaries.
- The **40 browser fixture cases passed** across reruns with installed Chromium **154.0.8037.57**, selected through a temporary test-only launch preload (`NODE_OPTIONS='--import=<temporary preload>'`). Playwright's bundled headless-shell download was unavailable (HTTP 403). This verifies synthetic fixture behavior on system Chromium 154, not bundled Chromium 156 or authenticated provider layouts. The MFA fixture now uses a routed HTML sign-in transition so intercepted HTTP redirects cannot escape routing; its login/MFA/resumption assertions remain unchanged.
- `npm run typecheck`, `npm run typecheck:all`, and `git diff --check` passed.

The focused cases cover immutable/generated payout enforcement, compensation attempts, permitted status updates, exact capture idempotency without reverting newer deal rates, atomic full-read reconciliation and association conflicts, unknown legacy records, ownership rollback, actual payment identity/idempotency, fresh complete exposure, single-order/shipment constraints, multiple same-account/deal orders, retained historical exclusions, JSONB idempotency, startup recovery guards, and report-first/idempotent/failed cutover. Final cases verify consistent cutover/runtime scope and rejection of inconsistent order/shipment states before acceptance.

These results do not verify a native mini-PC PostgreSQL installation, real provider contracts, or production operation. Earlier October 11–12 results and the schema repository's pre-guard results retain their own dates/scopes.

## Remaining acceptance work

- Real creation/deal payout fields, full tracker retention/completeness, payment evidence, account alignment and current retailer/BFMR DOM/API contracts remain release gates. Keep contract flags unset until their meanings are verified.
- Installing the schema/guard, accepting an actual legacy import, runtime role provisioning, mini-PC startup/reboot supervision, backup/restore and production recovery have not been performed by this work.
- Single-new-deal automatic purchasing still has its existing early-return boundary, and the separate 14-day latest-delivery cutoff remains unimplemented. Neither behavior is broadened by persistence integration.
- Required Gmail watch/owned StreamingPull and SQL notification-before-ACK/cursor/watch recovery are implemented and have [offline intake coverage](GMAIL_PRODUCTION_INTAKE.md#offline-validation--22-october-2026); the periodic Gmail loop is removed. Installed operational SQL, real legacy import and native/provider/recovery acceptance remain pending. Broader operational queue/outbox integration and a supervised service also remain unfinished. No deployment or new live invocation is authorized by source presence.

## Documentation QA — 21 October 2026

The current v22 design/implementation pair is aligned with the adopted schema and source integration. The field dictionary was compared against all 16 canonical `CREATE TABLE` definitions and every column matched in order. All three reporting SQL blocks executed successfully against an empty disposable PGlite instance of that schema. Local Markdown targets and code fences were checked. The refreshed v22 design PDF was text-checked and visually reviewed, including the schema dictionary, reporting SQL and offline-rendered workflow/ERD figures; older PDFs remain unchanged. These are document checks and do not add software regression cases or native/provider acceptance.

## Schema consolidation — 21 October 2026

`database/` is now the canonical schema/migrations/design-notes location. The four imported SQL/design files are byte-identical to the former schema repository's merged main; the database guide records their hashes. Do not use the historical engine migrations as a substitute, and do not automatically run every upgrade on a fresh schema. The former repository remains intact for history; future schema changes belong here.

The relational test helper defaults to module-relative `database/schema.sql`, retains the pinned SHA-256 check and no longer skips database cases just because `BFMR_SCHEMA_SQL_PATH` is absent. An optional override may point to an identical reviewed file. No private database URL, second checkout, live migration or provider action is involved. Consolidation verification is recorded separately from the original 142-case evidence above.

Consolidation verification: `env -u BFMR_SCHEMA_SQL_PATH npm run test:relational` passed **23/23**, zero failed/skipped, using only the bundled file; `npm run typecheck:all` and whitespace checks passed. The schema, both upgrades and design notes were compared byte for byte with the merged source commit. Current Markdown links and code fences were checked, and the v22 design PDF was refreshed and text/render-reviewed. These are focused consolidation checks; the earlier 142-case aggregate was not rerun or increased by counting repeated cases. No installed database, provider action, actual migration/cutover, archive or deployment was invoked.
