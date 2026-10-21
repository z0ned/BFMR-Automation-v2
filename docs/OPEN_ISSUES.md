# Open issues and release inputs

Current status is controlled by [Solution Design Specification v1.9](BFMR_Solution_Design_Specification_v1.9.md). These items distinguish unresolved user decisions, external provider evidence, environment setup and unimplemented operational work. Code coverage alone does not close provider evidence.

## 21 October 2026 — external schema checkout dependency removed

The schema, upgrade migrations and preserved rationale now live under `database/` in this repository. Original SQL/design contents and reviewed schema hash are preserved; the relational fixture resolves the bundled schema without a required environment override. This resolves the split-repository source dependency, not installed schema/guard/role acceptance or actual database migration/cutover. The former repository remains available for history and has not been archived or deleted.


Verification: bundled-schema regressions passed 23/23 with `BFMR_SCHEMA_SQL_PATH` unset, and strict TypeScript checks passed. Original schema/migration/design-note bytes match the merged source; see `RELATIONAL_INTEGRATION.md` for the focused scope. Prior broader evidence retains its original dates and limits.

## 21 October 2026 — documentation/schema alignment

The current v22 pair now matches the adopted 16-table schema names and relationships, including direct reservation/payment-email reimbursements and `deal_retailers`. Earlier 15-entity conceptual fields, multiple order-linked payments and generic metadata-column examples are superseded. This resolves the documentation mismatch, not native PostgreSQL installation, actual guard/role/cutover acceptance, verified provider/payment contracts or production recovery. Existing offline evidence and the single-deal/14-day gaps remain as recorded below.


## Release blockers and external evidence

### EV-001 BFMR account identity and browser/API alignment

The browser write guard needs exact account identity and a common known reservation visible in the browser and complete My Tracker API. Obtain sanitized current-page evidence for `BFMR_ACCOUNT_IDENTITY_SELECTOR`, `BFMR_TRACKER_BROWSER_URL`, `BFMR_ACCOUNT_RESERVATION_SELECTOR`, `data-reserve-id`, and `data-deal-id`. The current implementation cannot prove an account with no common known reservation. Determine a safe authoritative alternative. Until validated, missing selectors/identity fail closed and live reservation writes do not proceed.

### EV-002 Gmail provenance and message templates

Capture sanitized Gmail API headers for direct BFMR mail and the authorized `matt.ward@live.com` testing forward. Confirm Google Authentication-Results, Received, DMARC, DKIM/SPF layouts, and ensure legitimate messages pass without trusting display names or body text. Rendered sample PDFs do not provide this evidence. Test subject invariance, body announcements, tracked links, multi-deal counts, duplicates, bundles, additional-slot notices and updates using sanitized fixtures.

### EV-003 My Tracker and BFMR API contracts

Validate deal slug to `deal_id`, complete unfiltered pagination, retention of old active reservations, exact reserve ID, status and quantity/offer fields, supplier list, payout totals and unit amounts, amount paid, all open/terminal statuses and immediate post-submit visibility. Validate Purchase and Shipment request fields, returned IDs, eventual readback and behavior after an uncertain POST. Never treat an incomplete read as absence. Keep `BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED` unset until payout/status arithmetic is evidenced.

### EV-004 Amazon Business checkout and tracking UI

Verify real logged-in DOM layouts for saved account choice, exact single ASIN line/quantity, gift editor and saved gift state, free non-Prime delivery, total, duplicate warning, CVV challenge, submission confirmation Order #, Orders history card and package tracking details. The current order identity and tracking extractors have synthetic coverage; no single synthetic test proves live layout. Do not rerun a purchase to find an existing Order #.

### EV-005 Full exposure semantics

The user settled a $100 total cap, BFMR payout >= full Amazon order cost, and <=$200 for existing unpaid BFMR expected payouts plus the proposed Amazon total. The code assumes unit payout multiplies quantity, total fields describe the whole row, `amount_paid` subtracts from expected payout, and current new reservation is excluded from the prior-orders subtotal. Validate those exact BFMR field meanings and which unpaid statuses count. Until then, leave the contract gate unset.

## Environment and operations

### SETUP-001 PostgreSQL and private state

Configure the local mini-PC `DATABASE_URL`, account namespace and relational startup prerequisites in `RELATIONAL_INTEGRATION.md`. `src/db/migrations/002_runtime_state.sql` belongs to the separate JSONB engine. The live runner needs relational business-record backups plus private persistent storage/backups for Gmail, multi-deal/recovery and BFMR status/notification journals. Preserve the accepted legacy order file as a cutover hash boundary; standalone manual orders retain their separate ledger. Build and test backup/restore and stale backup reconciliation before deployment. Never test against production database.

### SETUP-002 First queue initialization/recovery

First-ever setup can use `BFMR_INITIALIZE_GMAIL_QUEUE=YES`, then remove it. Restore an existing queue if missing. `PROCESSING` rows and expired-history gaps require external BFMR/Amazon reconciliation and an explicit repair procedure; never delete state to restart intake. Expired Gmail history remains unresolved without an authorized recovery scan.

### SETUP-003 Runner service and notifications

The runner currently uses Gmail history polling and a single interactive process. Production service supervision, watch renewal/StreamingPull, durable notification delivery gates, browser desktop access after reboot, log retention, monitoring, Telegram outage behavior and restart recovery need an integrated runbook and acceptance.

## 20 October 2026 design decision and focused implementation gap

### IMPL-006 Creation-locked reservation payout (D22-03)

The user decided that dedicated `RESERVATION_HISTORY` is not needed; its absence is no longer a design gap. A reservation's expected payout never changes after creation. Deal payout changes affect future reservations only. The active v22 target therefore has 15 tables; existing JSON/status journals and provider/workflow evidence remain preserved.

**Pending enforcement:** the separate schema's stored generated `expected_payout = quantity * payout_per_item` still recalculates if either writable input changes. Design and review a guard and upgrade migration that protect the creation financial snapshot and locked total without blocking ordinary status updates; integrate authoritative capture of creation terms and mismatch review into ingestion/reconciliation. Retain later conflicting provider observations, block their authoritative promotion and never replace creation payout with the current deal rate. Do not guess missing legacy creation terms. This documentation decision implements no guard, migration or runtime change. See [v22 design](BFMR_Solution_Design_Specification_v22.md#9-approved-authoritative-reconciliation-design) and [implementation amendment](BFMR_Implementation_v22..md#14-reservation-payout-decision--20-october-2026-d22-03).

**20 October 2026 source status:** The guard and upgrade-migration source are now present in `BFMR_DB_Schema/schema.sql` and `BFMR_DB_Schema/migrations/20261020_reservation_payout_immutability.sql`. `public.reject_reservation_payout_change()` uses an `AFTER UPDATE` row trigger enabled `ALWAYS`, compares final `NEW`/`OLD` `quantity` and `payout_per_item` via `IS DISTINCT FROM`, and raises SQLSTATE `23514` on a change. Ordinary updates retaining those inputs remain allowed; the generated expected-payout expression is unchanged. This supersedes only the pending guard-source work described above. See [BFMR_DB_Schema draft PR #1](https://github.com/z0ned/BFMR_DB_Schema/pull/1), source commit `a67a0715ef040b0dd65de17ce63a0a5e34898699`.

**Still open:** The SQL has not been applied or tested; no software tests were added or run, no database changed, and no provider action or deployment occurred. Runtime authoritative creation-term capture, payout-conflict retention/review, and legacy creation-evidence reconciliation remain pending. Do not infer historical creation terms from current deal payout or claim installed database enforcement from source presence.

## Code completion versus acceptance

### 20 October 2026 relational integration source status

Source implementation now covers relational business repositories, runner reservation capture, atomic complete-read reconciliation/conflict evidence, order/shipment ledger and tracking interfaces, actual verified-payment recording, fresh locked-payout exposure, and explicit startup/cutover controls. See [RELATIONAL_INTEGRATION.md](RELATIONAL_INTEGRATION.md). The runtime capture/conflict paths previously listed under IMPL-006 are implemented at the source level; source presence does not prove actual provider fields or installed database enforcement.

21 October 2026 offline evidence: 141 passed, zero failed, one native PostgreSQL integration skipped across 142 distinct tests; final focused relational cases passed 23/23 using disposable PGlite/canonical guarded schema. Compiler/build/whitespace checks passed. The final cutover/runtime predicate and order/shipment coherence review findings are fixed and covered. Browser fixture evidence uses system Chromium 154; see `RELATIONAL_INTEGRATION.md` for exact boundaries. This supersedes earlier untested-guard wording only for the embedded offline SQL evidence.

Still open: provider creation-term/deal-rate/payment/full-tracker contracts remain unverified; native mini-PC PostgreSQL validation, actual schema/guard installation, runtime roles, an accepted real legacy cutover, backup/restore and service acceptance remain pending. Operational journals and the legacy JSONB engine remain separate stores. The single-deal purchase early return and independent 14-day delivery cutoff remain gaps. No live provider or production database was invoked and no actual migration/cutover/deployment occurred.

- PostgreSQL transaction and advisory lock code exists and passed a disposable synthetic PostgreSQL integration. This is not production DB migration or backup acceptance.
- File-backed queue, multi-deal, order and status journals exist but are not committed in one shared DB transaction with every external side effect.
- Amazon purchase and BFMR tracking write code exists; no complete current live multi-deal Amazon/BFMR write cycle was verified.
- Dashboard remains simulated and provides no live state.
- User-reported live fixed-item purchase success is limited to that specific test/product/session; do not expand it as general evidence.

## Resolved source-review findings (12 October 2026)

The source review findings are fixed in code and have offline regression coverage: wrong-deal title fallback and open-status duplicates; unauthenticated sender/hardcoded auth pass; reminder-only browser account check; memory-only Gmail cursor/work; incompatible lifecycle status sets; daily history loss; fabricated reservation IDs; all-block incident clearing; process-local default orchestration persistence/locking; dashboard fabricated acceptance status; and the previously reported checkout single-line/order identity issues. See `REVIEW_FIXES_2026-10-12.md` and v1.9 Sections 4-11. Do not confuse “code fixed” with the live provider evidence listed above.
