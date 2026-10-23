# Implementation plan and evidence

## 23 October 2026 — recover the legacy status-only completion mistake

Operator read-only evidence exposed COMPLETE paired with RESERVING/PROCESSING.
The exact-message report now accepts only a status-only copy of its valid
immediate predecessor, binds predecessor/raw-snapshot provenance, and rechecks it
at atomic reviewed apply. Normal worker loading stays strict and all evidence
remains append-only. Missing/changed history or uncertain provider effects still
stop. See the [recovery record](RECOVERY_REVIEW_20261023.md#23-october-2026--legacy-completereserving-snapshot-recovery).
Focused offline checks: 29/29 passed, plus scoped TypeScript and whitespace. No
actual SQL repair, provider action or worker startup was performed.


## 23 October 2026 — origin/work integration into main

Merged `origin/work` at `044472e` with `origin/main` at `09f9d2b`. The actual
screenshot revision is now available after fetching main; earlier statements
that it was unavailable describe the initial review checkout. Main's Docker
connection/configuration, headless-browser, intake/parser and email-inspection
changes are retained. Both npm command sets remain available. The conflicting
bulk incident-reset script is replaced by work's exact-message report/apply
compatibility entrypoint; it does not terminate arbitrary advisory-lock holders,
mark all mail complete, or rewrite the recovery inventory.

TypeScript checking found that main's account-proof path could dereference a
missing expected account. A missing/blank account now returns false before any
page access. Merge validation: `npm run test:recovery` passed **22/22** existing
focused offline cases, and `npm run typecheck:recovery` passed after this guard.
These are reruns, not additions to the earlier 66-case evidence. No live worker,
provider operation, SQL application or actual incident repair was performed.
Native/provider acceptance remains open. Remote publication is verified
separately after the merge commit is pushed.


## 23 October 2026 — implementation committed; documentation handoff

Recovery/operations fixes are committed locally as `ee183ef` on `work`.
Implementation evidence is **66/66 focused offline cases passed**, source/scoped
TypeScript checks and shell/whitespace checks; see the
[amendment](RECOVERY_REVIEW_20261023.md#evidence-and-remaining-host-work).
The initial push was rejected before publication. The user subsequently requested
updated documentation and another commit/push to the configured repository.
Remote publication, operator-host installation and production acceptance are
separate checkpoints; none is inferred from a local commit or documentation.

Next work is exact-message host diagnostics and privilege review, authoritative
provider reconciliation with reviewed atomic repair, native concurrent-session
ceiling acceptance and a replacement-database restore drill. Preserve the
accepted cutover and Gmail cursor. This follow-up adds document QA, not a new
software-test result or live action. See the [handoff](BFMR_Handoff.md#next-steps).

## 23 October 2026 — recovery review amendment

The [recovery review amendment](RECOVERY_REVIEW_20261023.md) controls current
revision/grant diagnostics, atomic exact-message repair, creation-locked checkout
payouts, partial-payment exposure accounting, and coordinated backup/restore.
Earlier source/native acceptance claims retain their dated scope. These changes
have not been installed on the operator host or used to clear its incident.


## 22 October 2026 — shared single-/multi-deal source implemented

Extracted worker coordination to `bfmrWorker.ts`, per-message/per-reservation processing to `dealEmailWorkflow.ts`, reservation actions to `emailReservation.ts` and checkout orchestration to `reservedDealPurchase.ts`. `DealEmailWorkflowStore` persists append-only SQL checkpoints with optimistic revision checks and immutable identity for both message types. Single-deal mail now reaches the same guarded order path. Multi-deal reservation/evaluation barriers and existing financial/account/uncertainty safeguards remain. Report-first reconciliation supports freshly validated, reviewed local repair of safe interrupted states, atomic queue/snapshot/local-record repair and exact workflow-scoped email incident resolution; unknown effects cannot be replayed or invented. See [SHARED_EMAIL_WORKFLOW.md](SHARED_EMAIL_WORKFLOW.md).

Compilation/whitespace checks only; no software tests were added/run under the explicit-request rule. No live worker, provider mutation, SQL installation, actual report/apply, import or deployment was invoked. Behavioral crash/recovery, native SQL/role and provider acceptance remain open; previous suite totals do not cover this change.


## 22 October 2026 — merge action controls with ranked-account and fresh-start work

Resolved the work/main merge while retaining main's ranked PostgreSQL account selection and explicit fresh-start cutover boundary. Amazon browser proof and tracking now receive the runtime's pinned database-selected email directly, without reintroducing removed environment overrides. Mutation readiness also verifies that the ranked selection has not changed. Both branches' decision/evidence entries are retained. Source and strict script TypeScript checks and whitespace checks passed; no software tests or live workflow/database invocation was performed for this merge. Earlier behavioral evidence retains its original revision and scope.


## 22 October 2026 — action-control source implementation

Closed source gaps from the project review: reject missing exact checkout expectations; require verified active Amazon buying-account evidence; require explicit exact cancellation status; persist worker incident blocks in append-only SQL evidence; guard financial/provider mutation boundaries; and audit recovery journals, transition-log presence, pending notifications, Gmail PROCESSING work and unresolved relational/provider intents before production startup. Existing inventory detects later loss/path changes; adoption requires a reviewed first baseline. Normal intake cleanup awaits failure recording. Proved non-submissions retain NO_ACTION evidence rather than orphaning creation intent.

`npm run typecheck`, strict script-only TypeScript and `git diff --check` passed. Broader `typecheck:all` is blocked by the missing declared PGlite dependency and resulting fixture typing errors. No software tests were added/run; source implementation does not supersede historical evidence with a new passing behavioral result. No schema, live account, private state, recovery baseline, import, watch or deployment was changed. Next: requested offline regression updates (including the former disappearance-as-release fixtures), native/provider failure acceptance and reviewed operator repair. [ACTION_CONTROL.md](ACTION_CONTROL.md) defines the new controls and remaining acceptance boundaries.

## 22 October 2026 — explicit fresh-start cutover source

Added a separate version-2 start-from scope and private candidate/report tool;
version-1 historical imports retain full-history coverage semantics. Fresh-start
preparation refuses existing recovery/SQL state and preserves a matching
candidate timestamp. Acceptance records the boundary; runtime rejects earlier
email triggers without weakening provider/financial/recovery stops. See the
[runbook](RELATIONAL_INTEGRATION.md#explicit-start-from-today-boundary--22-october-2026).
User-authorized focused offline tests and the existing relational regression
suite passed; both TypeScript checks and whitespace checks passed. Coverage and
limits are recorded once in the [runbook](RELATIONAL_INTEGRATION.md#offline-fresh-start-validation--22-october-2026).
No native invocation, operator candidate preparation, cutover apply, Gmail
initialization or provider action was performed by the assistant. Operator-reported native setup evidence is recorded in the
implementation reference; it is separate from this new contract's acceptance.

## 22 October 2026 — requested account-ranking offline validation

Added `npm run test:retailer-accounts` and ran it alongside the existing relational
suite against disposable PGlite. Current results, coverage, synthetic seed
adaptation and native-psql limits are recorded once in the
[database guide](../database/README.md#offline-account-ranking-validation--22-october-2026).
No installed database, provider action, cutover or deployment was invoked.

## 22 October 2026 — initial Amazon seed integrated into creation installer

Added [seed_amazon_account.psql](../database/seed_amazon_account.psql) for the requested initial Amazon retailer/account at rank **1**, preserving required CCV and finalized ranking constraints. CCV arrives privately through `BFMR_INITIAL_ACCOUNT_CCV` and client-side COPY into a temporary table, with no tracked secret literal. It does not assign ranks to existing accounts or grant worker CCV reads.

[bfmr-postgres-db-install.psql](../database/bfmr-postgres-db-install.psql) now includes the seed after both schemas under `bfmr_owner` and grants application SELECT on ranking without CCV/account writes. Existing installer ownership/password controls are preserved. Installer changes remain uninstalled; seed SQL/private-input checks have [offline ranking evidence](../database/README.md#offline-account-ranking-validation--22-october-2026). No installed database/provider actions or deployment occurred; earlier evidence retains its original scope. The [database guide](../database/README.md) owns installation instructions.

## 22 October 2026 — ranked database-selected Amazon account

The worker requires exactly one `retailers` row where `name = 'Amazon'`, then selects its account by `ORDER BY retailer_account_ranking ASC LIMIT 1`. Multiple accounts are valid; zero linked accounts stop startup. Schema source adds integer/non-null ranking unique within each retailer, without defaults/generated values or automatic assignment. Database rows supply IDs/email/rank without environment overrides or `ccv` reads. Pin the selected account for the run; changed selection stops rather than switches. Existing homepage/provider/checkout guards remain.

Existing databases require reviewed nullable/unique preparation, operator-assigned rank backfill, then `NOT NULL` finalization; worker validation rejects the intermediate schema. Existing least-privilege roles need SELECT on ranking, without application rank updates. Ranking source remains uninstalled; see [offline ranking evidence](../database/README.md#offline-account-ranking-validation--22-october-2026) for current tests. Earlier evidence below retains its original schema/source scope. No installed database, provider, cutover or deployment action occurred.

Current ledger/tracking automation covers one selected account per run. Existing orders retain original account associations; review outstanding orders on other accounts before changing priorities. Multi-account tracking and acceptance remain open rather than implied by 1:M account storage.

## 22 October 2026 — requested offline intake validation

Added dedicated adapter, SQL-store, coordinator and integration tests under `npm run test:gmail-intake`. Synthetic providers and disposable embedded PostgreSQL exercise failure/recovery behavior without a native database or live provider. Current results, scope and remaining acceptance are recorded in [GMAIL_PRODUCTION_INTAKE.md](GMAIL_PRODUCTION_INTAKE.md#offline-validation--22-october-2026). Historical test totals below retain their original revisions and are not combined with these cases.

## 21 October 2026 — production push-intake source implemented

Implemented source for required CON-001 intake: owned low-level StreamingPull with explicit reconnect handling, mailbox/OAuth and subscription/topic verification, daily INBOX watch renewal, STARTING/ACTIVE delivery barrier, PostgreSQL notification/rejection/dedupe before ACK and atomic admissions/work/cursor progress. Removed both periodic Gmail history reads and the idle Gmail priority probe from the shared runner. Intake continues independently of serialized browser work and paused recovery UI; local timers do not poll Gmail.

Four additive operational tables live in `database/gmail_intake.sql`, separate from the unchanged pinned 16-table business schema. Startup validates without DDL/import; the separate legacy importer defaults to report mode and applies only an exact reviewed account/source hash. `npm start` skips the test startup reservation; existing explicit test entrypoints retain that separate option. Existing purchase scope/gates and uncertainty handling remain.

Evidence: source review, standard/strict script TypeScript and whitespace/document checks only. No software tests were added/run (AGENTS.md requires a testing request), and no live SQL, import, Gmail watch, Pub/Sub, BFMR/Amazon, Telegram or deployment invocation occurred. Earlier test totals do not cover this implementation. Native schema/deparse/grants, explicit queue migration/first setup, real IAM/provider contracts and crash/reconnect/restore/supervision evidence remain open; see `GMAIL_PRODUCTION_INTAKE.md`.

## 21 October 2026 — no-poll production intake documentation correction

Restored CON-001 across current references and `.env.example`: required Gmail watch/Pub/Sub StreamingPull, no periodic Gmail polling or Inbox sweep, PostgreSQL notification-before-ACK, separate watch/consumed cursors, daily renewal and startup/reconnect continuation. Mailbox/OAuth, topic/subscription and a verified Pub/Sub credential identity are required production settings, not optional utilities. The existing 15-second polling runner remains a documented implementation/release gap. Broader operational-store migration remains separate work.

Evidence class: documentation/template correction only. Checked variable-name coverage, duplicate entries, dotenv syntax, gates, current-reference consistency, Markdown fences and whitespace. No software tests, runtime/provider configuration or live actions were run; no implementation milestone or acceptance gate was closed.

**Current baseline:** [v22 solution design](BFMR_Solution_Design_Specification_v22.md) and [v22 implementation reference](BFMR_Implementation_v22..md). [OPEN_ISSUES.md](OPEN_ISSUES.md) lists only unfinished work; this plan retains dated implementation/evidence history. Mark code completion separately from provider acceptance and production deployment. A passing synthetic fixture does not prove live BFMR/Amazon behavior.

## 21 October 2026 — EV-001 diagnostic prepared; live proof pending

Added the standalone `inspect-bfmr-identity` command, an awaited proof-tab guard hook and injectable complete-read transport. It attaches only to an exact existing Chromium PID, uses a separate guarded tracker tab and emits sanitized checks; it has no live startup, reservation/order, database or notification path. The operator's authenticated BFMR session/configuration is on the local mini-PC/Ubuntu container. Cloud preflight found missing BFMR configuration and no permitted BFMR network destination, so no live account proof was collected and EV-001 remains open.

Focused offline verification: 12/12 synthetic cases passed, including the existing identity browser fixture on system Chromium; standard and targeted strict TypeScript checks passed, and help/missing-configuration behavior was exercised. The broader `typecheck:all` was blocked by a missing PGlite dependency in this workspace. Full details and evidence limits are in the v22 implementation reference. These cases are not added to the previous distinct-case aggregate. Next: run the diagnostic on the configured local session and review real selector/common-reservation evidence; do not enable writes or invent an empty-account proof.

## 21 October 2026 — artifact housekeeping

Removed the redundant Bun lockfile and the three obsolete v1.6–v1.8 specification PDFs at the user’s request. npm/`package-lock.json` and the v22 Markdown pair are the maintained dependency/documentation sources; historical artifacts remain available through Git history. No dependency versions or runtime behavior changed. Documentation and whitespace checks apply to this change; earlier test/PDF evidence retains its original scope.

## 21 October 2026 — command-line runtime and tooling

The maintained entrypoints are the automation scripts documented in the v22 implementation reference. Dependency/configuration and source-reference checks cover the backend-only TypeScript project and canonical npm lockfile. Shared intake parsing, business repositories, account ownership, operational journals and their backend regressions remain in scope. Current verification is recorded in the implementation reference; earlier dated test counts retain their original scope.


Verification for the maintained sources: **56/56 selected offline regressions passed**, zero failed/skipped: nine review/queue/identity cases, six email-link cases, three sample-classification cases, four URL cases, eleven orchestration cases and twenty-three relational cases. `npm run typecheck` and `npm run typecheck:all` passed. `npm ls --depth=0` and lockfile checks confirm the declared dependencies are installed and retained package versions are unchanged. Earlier broader results describe their original source snapshots; they were not rerun or counted again for this cleanup. No provider action, installed database change or deployment was performed.

## 21 October 2026 — database source consolidation

Moved the authoritative business schema, both upgrades and preserved database design notes into `database/`, with an application-specific guide and original source hashes. The imported source matches the former schema repository's merged main at `a67a0715ef040b0dd65de17ce63a0a5e34898699`. Updated current handoff/design/runbook references and the relational fixture default so one application checkout is sufficient. The SQL itself is unchanged. Native PostgreSQL installation, real upgrades/cutover, role/backup/service acceptance and any archival of the former repository remain separate work.


Verification: bundled-schema regressions passed 23/23 with `BFMR_SCHEMA_SQL_PATH` unset, and strict TypeScript checks passed. Original schema/migration/design-note bytes match the merged source; see `RELATIONAL_INTEGRATION.md` for the focused scope. Prior broader evidence retains its original dates and limits.

## 21 October 2026 — v22 integration handoff documentation

Updated `BFMR_Solution_Design_Specification_v22.md` and `BFMR_Implementation_v22..md` to the adopted 16-table schema, actual runtime/store boundaries, immutable creation terms, atomic reconciliation, payments/exposure, controlled cutover and exact existing offline evidence. Replaced obsolete order-linked payment SQL and conceptual columns/ERD; refreshed the current design PDF with text/render QA. This is documentation completion, not new software validation, native PostgreSQL acceptance, live provider work, actual cutover or deployment. Single-deal ordering and the 14-day delivery cutoff remain implementation gaps.


## Current status

| Milestone | State | Completed code / remaining evidence |
|---|---|---|
| M0 Fresh project/bootstrap | Code complete | Node.js/TypeScript automation project, package lock, scripts and instructions exist. Historical clean-checkout evidence should not be mistaken for deployment. |
| M1 Durable orchestration and ownership | Partial | Relational live-runner business repositories and atomic reconciliation; separate JSONB engine; cross-process advisory ownership and explicit operational stores. Need real cutover/schema/role acceptance, service lifecycle and backup/restore proof. |
| M2 Gmail and Pub/Sub intake | Partial | Watch/owned StreamingPull and dedicated SQL notification/work/cursor/run source replace periodic polling. Offline failure/recovery tests cover simulated providers and embedded SQL. Installed operational SQL/import, real IAM/provider/reconnect/restore and supervision acceptance remain pending. |
| M3 BFMR read contracts | Partial / live blocked | Trusted URL/deal API resolver, exact-ID My Tracker reads, shared status rules, account evidence gate and supplier check. Actual DOM selectors, account alignment, provider schema/status/payout/supplier coverage and immediate visibility need evidence. |
| M4 Reservation and side-effect controls | Partial | Live interactive runner, quantity-one website reservations, post-reservation evaluation/cancellation, Amazon checks/order path, journals, retailer tracking, BFMR writes and daily discrepancy alerts. Amazon layouts and BFMR side-effect contracts are not fully validated live; operator recovery and production notification gates remain incomplete. |
| M5 Deployment/operations | Not accepted | No supervised deployment, backup/restore proof, health/watch monitoring, operational runbook or complete acceptance report. |

Do not mark a milestone complete until the relevant offline and live evidence gates in v1.5 are matched to current requirements and documented. Only recorded evidence establishes acceptance. The repository currently has uncommitted changes from ongoing work; preserve them.

## 20 October 2026 target-design amendment — D22-03

Dedicated `RESERVATION_HISTORY` is no longer required; the active v22 target has 15 tables. Expected payout is fixed at reservation creation, and deal payout changes apply only to subsequently created reservations. Preserve existing JSON/status journals and provider/workflow evidence; do not delete or replay historical state. The current generated `quantity * payout_per_item` formula in the separate schema does not prevent input updates, so a reviewed guard/migration protecting the locked total and runtime integration of creation-term capture and provider-conflict review remain pending. Do not mark these complete from this documentation change. See [v22 implementation amendment](BFMR_Implementation_v22..md#14-reservation-payout-decision--20-october-2026-d22-03) and [OPEN_ISSUES.md](OPEN_ISSUES.md#impl-006-creation-locked-reservation-payout-d22-03).

Evidence class: user decision/documentation only; no source change, migration, software test, provider invocation or acceptance result. Historical progress entries below remain evidence for their original code paths and dates, including existing file-backed status history.

## 20 October 2026 source progress — reservation payout guard

Schema change: [BFMR_DB_Schema draft PR #1](https://github.com/z0ned/BFMR_DB_Schema/pull/1), source commit `a67a0715ef040b0dd65de17ce63a0a5e34898699`.

Guard source is present in `BFMR_DB_Schema/schema.sql` and `BFMR_DB_Schema/migrations/20261020_reservation_payout_immutability.sql`. `public.reject_reservation_payout_change()` is an `AFTER UPDATE` row guard comparing final `NEW`/`OLD` `quantity` and `payout_per_item` with `IS DISTINCT FROM`, raising SQLSTATE `23514` on a change. Its trigger is enabled `ALWAYS`; ordinary updates retaining those inputs remain allowed, and the generated expected-payout expression is unchanged.

Evidence class: source implementation only, updating the preceding pending-guard status. The SQL has not been applied or tested. No software tests were added or run, and no database change, provider action, or deployment occurred. Keep runtime creation-term capture, conflicting-payout evidence/review, legacy creation-evidence reconciliation, and database validation/application pending; source presence does not establish installed enforcement or production acceptance.

## Next work, in order

### 20 October 2026 relational integration source progress

Implemented the relational business-store source and runner wiring: `src/db/relationalDatabase.ts`, `relationalRepositories.ts`, `relationalTypes.ts`; reservation capture/sync/exposure; relational order/shipment ledger and tracking interfaces; authenticated verified-payment recording; startup schema/guard/cutover/account checks; and report-first controlled cutover tooling. Exact source responsibilities and configuration are in [RELATIONAL_INTEGRATION.md](RELATIONAL_INTEGRATION.md). Business transactions do not serialize authoritative records into the legacy engine aggregate. Existing operational journals remain durable and separate.

Validation recorded 21 October 2026: 142 distinct offline tests across runs, 141 passed, zero failed, one native PostgreSQL integration intentionally skipped. The final focused relational suite passed 23/23 against disposable PGlite and canonical guarded schema; unchanged existing cases contributed 118 passes plus the skip. TypeScript and whitespace checks passed. Browser fixtures used system Chromium 154; see `RELATIONAL_INTEGRATION.md` for commands, exact schema hash and limits. Startup recovery/capture guards, atomic provider associations, semantic JSONB idempotency and cutover/runtime history scope were reviewed and covered. No live provider or production database was invoked and no actual migration, legacy cutover or deployment occurred. Remaining work includes provider contracts, native PostgreSQL/role/schema installation evidence, real legacy reconciliation, backup/restore and service acceptance. Single-deal purchasing and the 14-day delivery cutoff remain independent gaps. Milestones above remain partial until their full evidence gates are met.

### Remaining work

1. **Close identity and provenance release blockers:** collect sanitized Gmail API auth headers and sanitized BFMR account/My Tracker DOM. Implement/test only observed selectors and account association. Provide an empty-account proof mechanism before permitting writes when no known common reservation exists. Confirm no sensitive account content enters fixtures.
2. **Validate My Tracker read contract:** deal-ID mapping, row IDs, pagination completeness, retention/date behavior, all statuses, quantities, offer IDs, amounts paid, payouts and immediate visibility. Validate supplier-list data. Keep all purchase and cancellation gates closed for unknown values.
3. **Validate Amazon order path read-only/fixtures first:** authenticated Business account choices, cart line boundaries, free non-Prime shipping, gift persistence, order total, exact thank-you Order # and order-history/package tracking cards. Do not repeat an order to debug identity; inspect Orders after any uncertain action.
4. **Validate BFMR Purchase/Shipment APIs with a separately authorized, exact test reservation:** capture safe intent/reconciliation evidence; never retry unknown writes until readback resolves them. Confirm actual field values/statuses and local journal behavior.
5. **Integrate durable service semantics:** database transactions and account ownership are code; integrate Gmail queue, side-effect journals, notification outbox, command attempts and orderly shutdown/recovery. Accept the source-implemented no-poll Gmail watch/StreamingPull and SQL notification/cursor/watch/reconnect path, boot supervision, persistent storage, backup and restore. Consider migration of separate JSON state only with explicit recovery and evidence.
6. **Operational acceptance:** perform test reservations/cancellations and retailer actions only under the user's explicit live instruction, then record date, code version, test account scope, outcome and limitation. No automatic unattended rollout until all evidence gates and manual recovery procedures work.

## Current verification snapshot (recorded 12 October 2026)

- Full offline suite: 118 passed, zero failed; one PostgreSQL integration is skipped in ordinary suite execution without `BFMR_TEST_DATABASE_URL`.
- Separately used a disposable PostgreSQL 18 cluster with synthetic state. Restart persistence, rollback, a separately spawned process being denied the account lock, and connection-loss fail-closed behavior passed.
- `npm run typecheck`, `npm run typecheck:all`, and `git diff --check` passed after the code fixes.
- No production DB migration, live BFMR write, Amazon order, tracking update, deployment or Telegram discrepancy alert was run for those fixes.
- Current documentation-only task must run PDF text/render/layout QA. Do not run additional software tests unless the user asks for testing or verification.

## Release blockers / open issues

See `OPEN_ISSUES.md`. At minimum: BFMR account DOM/alignment selectors are unverified and block reservation writes; real Gmail auth headers are unverified; My Tracker supplier/status/payout/purchase/shipment contracts are not proven in the current account; Amazon Business order/tracking selectors require live validation; private journals and production database backups/recovery need integration; expired Gmail cursor retains a stop-gap with no authorized Inbox sweep.

## Historical progress log

The detailed 10-12 October implementation notes below are retained as chronology. Treat dated test results as historical and apply v1.9 current-state summary above where old entries conflict. Do not infer current completion from an old entry's heading or an old test count.


### 12 October 2026 — require exactly one checkout product line before submission

The final order-review validator now derives item containers from visible ASIN identity and scoped quantity evidence, requires exactly one line with the expected ASIN and quantity one, and repeats this check immediately before the Place your order click. It rejects extra products, duplicate same-ASIN lines, missing identity, unscoped or conflicting quantities, and ambiguous item boundaries even when the combined total is under the approved cap. Repeated product links inside one verified line remain supported. Product-title matching and global quantity text no longer authorize a purchase. Offline intercepted Chromium regressions cover extra lines injected after a valid review and verify zero submit actions; no live purchases were made. Unsupported live checkout layouts stop for review.

### 12 October 2026 — bind Amazon order identity to submission confirmation

Removed the post-purchase history lookup that could choose an older purchase of the same product and total. The submission observer now captures labeled Order # values on the thank-you page reached by that submission, bound to its page, ASIN and checked total. The lookup waits for delayed identity on that exact confirmation URL and requires a single distinct order number; it never falls back to history or treats the URL's purchaseId as an Order #. Missing or ambiguous identity stops before the callers record an order or send its number to BFMR, without repeating the purchase. Five intercepted Chromium regressions cover older identical history, delayed/missing/ambiguous confirmation identity, mismatched request evidence and stale evidence invalidation. No live Amazon purchase or BFMR mutation was made.

### 12 October 2026 — daily BFMR official status reconciliation

The real-email runner now performs one complete unfiltered My Tracker read per Atlanta day after its nightly Amazon tracking checks. It stores a sanitized, fsynced snapshot of all open BFMR rows and updates each matching Amazon ledger entry with BFMR's observed status, quantity, purchase/shipment IDs, order number and tracking number. It compares the new read with the prior snapshot and local orders, then sends bounded Telegram messages for discrepancies. The notification text is journaled before sending and retried on delivery failure. New Gmail messages take priority before the BFMR read. Synthetic tests cover all-open snapshot persistence, mismatch alerts, once-daily scheduling and Telegram retry. The local files are the current runner's durable state; the intended PostgreSQL database is not implemented. No live BFMR or Telegram request was made for this change.

### 12 October 2026 — nightly Amazon shipment tracking in the real-email runner

Confirmed multi-deal Amazon purchases now persist exact retailer Order #, BFMR reservation ID, ASIN and verified total in an fsynced private local ledger before the batch journal marks ordering finished. The fixed-ASIN purchase test also records future confirmed purchases there without a BFMR reservation. When the real-email runner is active, its idle loop checks due orders after 03:00 `America/New_York` daily. Each read-only Playwright lookup opens the approved Amazon Orders page in the existing browser context, requires one visible order section with matching Order #, ASIN and total, then reads only its scoped tracking links. Multiple labeled package tracking numbers are stored separately; an ambiguous/missing order or unsupported tracking control alerts and preserves existing data. Gmail history is probed before each order, so new deal processing takes priority between lookups. Each lookup has a 90-second deadline. A just-purchased order waits until the next Atlanta 03:00. Synthetic tests cover DST timing, durable mapping, new-mail yielding and exact order/package selection. The authenticated Amazon Orders layout has not been validated live; no live tracking check or order was performed for this change. The live runner still lacks a production durable Gmail queue and must remain running for scheduled checks.

### 12 October 2026 — BFMR purchase and shipment submission from confirmed Amazon orders

The multi-deal runner now journals and submits each confirmed Amazon Order # as a BFMR Purchase through the documented `POST /api/v2/my-tracker` request for its exact reservation. A complete unfiltered My Tracker read must show the same reservation/deal, quantity one, Amazon Order # and purchase ID before the batch proceeds. The nightly Amazon tracking callback submits one verified package tracking number as a BFMR Shipment against that purchase ID, then requires exact shipment ID and tracking-number readback. Intent is fsynced before each POST. After an uncertain POST or missing readback, no automatic repeat is made; the nightly path alerts for review. Multiple package numbers for one BFMR unit stop for manual matching. The standalone Amazon purchase test has no BFMR reservation and does not submit to BFMR. Synthetic tests prove request shape, exact-ID matching, idempotency and no repeat after an uncertain response; BFMR's actual mutation and readback fields have not been validated live.

### 11 October 2026 — multi-deal live email runner (code only)

Added ordered trusted deal-link extraction for body-announced multi-deal emails whose declared deal count matches the distinct links. The real-email runner performs all quantity-one BFMR reservation attempts first, confirms each exact reservation through My Tracker, and then evaluates confirmed reservations for Amazon supplier presence. Non-Amazon reservations use the existing exact-ID cancellation path. It never creates a second BFMR reservation for a qualifying deal. For retained reservations with one item, one direct Amazon product link and exact payout, the unattended checkout path checks a $100 order cap, BFMR payout at least the complete Amazon order total, and a $200 cumulative exposure cap, along with gift, selected free non-Prime delivery and visible selected address/card sections. Exposure is existing unpaid My Tracker expected payouts (excluding the current reservation) plus the proposed Amazon total. Definitive checkout rule failures cancel the exact reservation after exact cart cleanup; missing/ambiguous evidence or uncertain actions stop for review. The status/payout mapping and complete coverage of unpaid My Tracker rows remain unverified, so the exposure reader and order submission are disabled by default. No automatic replay is added.

The two rendered multi-deal sample PDFs show two product bullets each. Their plain text extraction hides the deal links, but Poppler XML extraction of the supplied PDF preserves its two trusted deal URLs. Neither PDF proves MIME authentication. The fixed-ASIN purchase test keeps its specifically authorized duplicate-warning continuation; the new arbitrary-product path does not click that warning and instead requires manual Orders review. A local fsynced batch journal records confirmed references and stage transitions; an incomplete batch stops a later live run for manual My Tracker/Orders reconciliation. This is a stop guard, not automatic crash recovery or PostgreSQL durability. The multi-deal live runner has not been run live. Its Gmail history baseline and local journals still leave M1/M2 production durability and intake incomplete, so this code is not ready for unattended operation.

### 12 October 2026 — local PDF test entrypoint

Added `test-multi-deal-pdf`, which extracts the supplied Outlook PDF's two product bullets and embedded BFMR deal-detail links, validates a one-to-one ordered match through the shared intake parser, and reports the result without account mutations by default. `--live` passes that same parsed message to the existing startup and multi-deal processing flow, with its current live gates and recovery journal. The PDF is a manually supplied test source; it does not establish original email authentication. The default preview was run against the supplied file and identified both expected deals. No live reservations, cancellations, or Amazon actions were run for this entrypoint.

### 11 October 2026 — one-item Amazon purchase test command

Added `npm run test-amazon-purchase` for the explicitly authorized ASIN B0GTMJF7PV. It is separate from email processing and does not make a BFMR reservation. The interactive command requires an operator-provided USD total cap, checks the exact item and quantity one at final review, requests confirmation that the saved default address and payment method are selected, and submits only after exact ASIN-bound terminal confirmations. A purchase submission is attempted once; uncertain outcomes stop without retry. This code change does not itself run the command or place an order. Account-specific shipping and payment flows remain unverified by this implementation turn.

The first user-run attempt reached Amazon Business order review but stopped because the page showed two identical enabled Place your order controls and repeated order totals. The verifier now accepts the observed duplicate controls and duplicate total displays only when the labels/statuses and amounts agree, then clicks only one control. TypeScript and the order-total parser fixture pass. The browser checkout fixture could not be run in this sandbox, and the purchase command was not rerun.

The purchase test opens “Add gift options”, checks “This item is a gift”, and clicks “Save gift options”. It waits for the final secure-checkout button to return before proceeding. The page-scoped marker carries the saved gift action through the final pre-submit review. The existing offline checkout fixture covers the checkbox/save flow.

The Amazon purchase test now selects a free shipping/delivery radio option only when the option label explicitly says free and does not mention Prime. It verifies that a matching option is selected again at final review and blocks submission otherwise. The operator is asked to make the choice manually if Amazon's markup cannot be identified safely.

### 10 October 2026 — standalone Amazon checkout rehearsal

Added `npm run test-amazon-checkout` for the user-selected ASIN B09JQMJHXY, quantity one, saved default Amazon address, stopping before Place your order. Runs the shared BFMR startup cleanup, then creates an Amazon tab in the same browser context. Checks active cart isolation, validates product/quantity, adds at most once, and proceeds to order review. Account setup/intermediate checkout steps can require manual completion. The order button is never activated and email purchasing is not wired.

Validation: eight synthetic Chromium checkout tests passed, including preservation of the BFMR tab/context, no duplicate cart addition, refusal of unrelated cart items/quantity conflicts, manual account choices, and zero final-order submissions. Project and explicit script/test TypeScript checks passed. These tests use intercepted local HTML and make no live website requests. A public read of the specified Amazon product informed the offer selectors; authenticated live checkout has not been run. No Amazon item was added or ordered during implementation.

### 10 October 2026 — Amazon evaluation and disposable startup reservation

User authorized the first post-confirmation evaluation for incoming email reservations: retain when Amazon is listed as a supplier, otherwise cancel the exact reservation. Startup is excluded from evaluation and always cancels its confirmed CAPTCHA reservation before continuing. Added supplier parsing joined by exact API reservation/deal IDs, scoped form-encoded cancellation, complete My Tracker release checks, and local pending-work recovery. Unknown supplier evidence and unresolved cancellation stop and use the existing Telegram failure alert path; pre-existing duplicate reservations are never evaluated or canceled. The iPad target/Watch recovery target remain outside the email-only evaluation.

Live evidence: after explicit user authorization, complete My Tracker reads identified the sole active Fitbit Air Obsidian reservation by title, model and quantity one. One form-encoded cancellation POST targeted its exact reservation ID; a subsequent tracker read confirmed release. The endpoint uses the documented HTTPS API host, not the internal HTTP sample hostname. No new reservation or other account mutation was made during this test. Live supplier response variants and the full email evaluation sequence remain to be validated.

Validation: `node --import tsx --test tests/**/*.test.ts` passed 71/71 offline tests, including synthetic Chromium fixtures and evaluation/cancellation failure and recovery tests. Project TypeScript and explicit live-script/new-test TypeScript checks passed; `git diff --check` passed. Chromium fixtures required running outside the execution sandbox. These local recovery files are not PostgreSQL persistence or production acceptance evidence.

For each milestone record status, commit, commands run, test outcomes, sanitized fixture references, remaining gaps and any changed design decision. Keep this file current as implementation proceeds. Consult v1.5 for detailed test assertions; the milestone grouping does not replace them.

### 10 October 2026 — reusable interactive test session

The email E2E runner now owns Chromium for its entire session, processes successive emails serially with one history iterator, and holds failed tests open for inspection until exit. Ctrl+C/SIGTERM clean up the browser. See the v1.6 design addendum. Lifecycle regression tests use fakes; live multi-email/CAPTCHA reuse is not yet verified. Existing production intake and visible-title extraction gaps remain.

### 10 October 2026 — visible catalog title preflight correction (M3 / EV-001 / G-001)

The paused email test used an immediate `h1:visible` lookup although the supplied screenshot showed a catalog title. The shared browser adapter now waits up to 10 seconds for a unique visible semantic heading (`h1`–`h6` or `role=heading`) associated with the Payout Price / Retail Price section. Navigation and generic page labels are excluded; missing or ambiguous titles still stop preflight. This fixes both live runners that call `getVisibleDealTitle`; no email-subject or URL-title fallback was added.

Evidence: `tests/visible_deal_title.test.ts` uses synthetic local HTML in a fresh headless Chromium instance to cover alternate heading levels, whitespace normalization, delayed rendering, hidden/missing headings and ambiguity. `node --import tsx --test tests/**/*.test.ts`: 30/30 pass. `npm run typecheck` and `git diff --check` pass. The direct Node test entry point avoids the sandbox restriction on the tsx CLI's IPC socket; fixture Chromium tests ran outside the sandbox. No BFMR requests or reservations were made. The screenshot does not establish the actual DOM tag; live markup validation and the remaining EV-001 identity/form evidence are still outstanding.

### 10 October 2026 — duplicate preflight continues intake (FR-004 / AT-04)

User requested that an already-reserved deal should keep the app waiting for additional deals. The interactive email runner now logs SKIPPED and returns normally for both CONFIRMED and EXISTING preflight results, so the session advances to its next email without a form submission. UNKNOWN reads and unresolved submission outcomes retain the existing pause behavior. This matches the baseline normal duplicate skip; it adds no replay or retry. Validation: TypeScript check (including the runner), offline session/tracker tests, and diff whitespace check; no live reservation attempted.

### 10 October 2026 — full deals continue intake (FR-003 / AT-03)

The email runner now checks for the screenshot's visible `Deal Full - Looks like you missed this one` message before title extraction and again after the title wait. Full/closed/no-slots results log SKIPPED and return to the same email iterator and browser. The browser adapter shares the explicit visible-message detector, checks again after waiting for quantity controls and before clicking, and only returns CLOSED_NO_SLOTS before a submission. Missing controls and uncertain outcomes remain failures; no post-click shortcut or retry was added.

Evidence: synthetic Chromium fixtures recognize the full page without title/prices, recognize closed/no-slot messages, and reject hidden messages, loading pages and retailer stock wording. `node --import tsx --test tests/**/*.test.ts`: 31/31 pass. `npm run typecheck`, explicit TypeScript checking of `scripts/test_real_email_e2e.ts`, and `git diff --check` pass. No live BFMR requests or reservations were made.

### 10 October 2026 — tracked email destination extraction (FR-002 / SEC-002 / G-002)

Added the Node-only `bfmrEmailLinks` intake parser for the E2E runner, other email scripts, and orchestration engine. It decodes the observed BFMR tracking format locally and passes only validated direct deal destinations to the shared parser. The shared parser now counts distinct deal paths, rejects multi-deal bodies, and collapses repeated direct/decoded links. Skip logs distinguish unsupported/missing trusted links from nonqualifying subjects. The shared parser remains free of Node compression dependencies.

Read-only evidence: the actual forwarded AirPods email now returns `isSingleDeal=true`, `isMultiDeal=false` and the direct BFMR deal URL. Only Gmail reads were made; no tracking URL, browser form or reservation endpoint was called. No raw email, recipient metadata or tracking token was saved to the repository or diagnostic output. Synthetic fixtures cover product plus navigation/unsubscribe links, forwarded subject, quoted-printable soft wrapping, repeated links, multiple distinct deals, exclusions, malformed/oversized tokens and unsafe/lookalike destinations. `node --import tsx --test tests/**/*.test.ts`: 36/36 pass. explicit runner TypeScript checking, and `git diff --check` pass. Other tracking encodings remain unsupported; this is not proof of all email templates or production intake readiness.

### 10 October 2026 — listing redirect during deal preflight

User reported that the paused Amazon Direct email had reached `https://www.bfmr.com/deals?tag=all`. This explains the absent product title; it does not establish that BFMR marked the deal full. The interactive runner now skips a trusted exact deals-listing redirect before submission, including redirects during title rendering or page confirmation. It logs the listing reason, submits nothing, never selects a replacement deal, and returns to listening. Challenges, login forms, untrusted destinations and other page mismatches still pause. Post-click reconciliation is unchanged. Added bounded heading-count/tag/label diagnostics for actual title-extraction failures without logging heading text or raw page data.

Evidence: synthetic intercepted Chromium pages exercise listing, challenge, password form, account-page mismatch, untrusted host and normal deal-title reading. `node --import tsx --test tests/**/*.test.ts`: 39/39 pass. Project and explicit runner TypeScript checks and `git diff --check` pass. No live reservation or retry was made. Public unauthenticated markup reads returned an HTTPS canonical redirect and 403; the actual account DOM was not accessible, so the listing observation comes from the user.

### 10 October 2026 — correction: listing redirects do not prove unavailability

Supersedes the preceding listing-skip behavior. The user supplied the exact tracked AirPods link and confirmed manual navigation reaches the individual deal. Local decoding and a read-only tracker request both confirmed destination `/deals/d-ikygz` (HTTP 302). The automated listing transition's cause remains unproved. Removed listing redirects from normal unavailable skips; they now pause as navigation/identity mismatches. Added requested-page and main-frame path diagnostics, omitting queries/account data, and a specific listing error around title extraction. Explicit full/closed messages and preflight duplicates continue normally. Updated `BFMR_Solution_Design_v1.6_Addendum.md` with the final behavior, tracked-link format/limits, intake baseline limitation and outstanding evidence. No reservation or retry was made.

Validation: `node --import tsx --test tests/visible_deal_title.test.ts tests/bfmr_url.test.ts`: 13/13 pass. Project and explicit runner TypeScript checks and `git diff --check` pass. The new diagnostic logger requires restarting the runner; the failed run's preceding navigation output is still needed to establish its actual route sequence.

### 10 October 2026 — confirmed Deal not found page

The user's screenshot shows the correct AirPods short-link URL with an explicit `Deal not found` message. This explains the title failure without assuming a listing redirect or tracking-decoder fault. Added that exact visible message to the shared unavailable-page detector, with its own log reason. The existing preflight and pre-click unavailable checks now skip it and continue intake; no back button, alternate deal or retry is used. Hidden messages and unexplained listing routes remain inconclusive. Updated the v1.6 addendum with the screenshot evidence and final behavior. Synthetic intercepted Chromium coverage checks the exact missing-deal layout, unchanged URL and hidden-message rejection.

Validation: `node --import tsx --test tests/**/*.test.ts`: 40/40 pass. Project and explicit runner TypeScript checks and `git diff --check` pass. No live reservation or retry was made.


### 10 October 2026 — live reservation test startup

Connected the shared startup flow to the real-email and iPad live reservation test entrypoints. It filters the listing through the website, skips duplicate/unavailable candidates, submits quantity one and confirms automatically through My Tracker. Startup has no CHECK-API prompt. Conservative retry/recovery rules use an owner-only fsynced local snapshot plus transition journal; this is test recovery evidence, not the production PostgreSQL store. Gmail baseline capture now precedes startup so arrivals during CAPTCHA are retained. Updated v1.6 design and decision register with the user's production-to-test clarification.

Evidence: full offline suite initially passed 52/52; subsequent targeted startup checks cover manual challenge completion and the finalized immediate/10s/30s API checks. Project TypeScript and explicit live-entrypoint TypeScript checks pass. Synthetic Chromium verifies In Stock selection and resulting deal order. No live reservation scripts were run for validation. Actual BFMR filter markup and manual CAPTCHA/startup confirmation remain pending live acceptance; account alignment and production durability gaps remain open.


### 10 October 2026 — startup In Stock label matching

The user's screenshot shows In Stock while the literal-space locator timed out. Changed the exact label matcher to tolerate absent/alternate whitespace and hyphens without matching unrelated wording. The DOM cause is inferred, not proven by the screenshot. Added synthetic Chromium cases for adjacent styled spans (`InStock` text), nonbreaking spaces, hyphens and a hidden duplicate alongside the original label/order check. TypeScript and whitespace checks pass; live BFMR rerun is still required. No live form action was performed during diagnosis.


### 10 October 2026 — unfiltered startup progression

Removed In Stock lookup/click entirely following Matt's live feedback. Both live test entrypoints now use `getStartupDealUrls` to read the existing visible listing order. Proved failure exhaustion advances to the next displayed candidate instead of terminating selection. Uncertain outcomes still block further submissions. Updated synthetic coverage to verify order with and without a filter, no filter click, and two proved failures followed by successful reservation of the next candidate. Project TypeScript and targeted startup checks pass; live validation remains pending. No live BFMR mutation was performed.


### 10 October 2026 — pricing-scoped catalog title

Fixed broad ancestor pricing association that admitted subtitles and Additional Details headings as catalog titles. Title candidates now require a single tightest pricing section and a unique principal semantic heading within it. Synthetic Chromium fixtures cover the screenshot's title/subtitle/details structure, same-level ambiguity and separate pricing sections. Project TypeScript checks pass; real page DOM validation remains pending. No live reservation attempted.


### 10 October 2026 — automatic API confirmation and live Telegram failure alerts

Removed CHECK-API from the email, iPad and Watch recovery scripts. Shared read-only confirmation polls delayed visibility automatically and stops on unknown/conflicting results. Unexpected post-startup preflight challenges stop/alert in the email/iPad tests. Added server-side Telegram failure reporting using existing configured environment variables, validated responses and sanitized transport exceptions. Startup proved failures notify before progressing; unresolved failures notify before existing failure handling. Notification failure stops further processing and is explicit locally. This is immediate live-test reporting; production durable outbox/replay remains separate work. No live Telegram message or BFMR reservation was sent during implementation.

Evidence: injected-transport notification tests cover missing configuration, valid delivery, rejected/malformed responses, credential redaction, original-error retention and no success alert. Fake confirmation tests cover delayed visibility, bounded polling and immediate unknown/conflict termination; startup coverage verifies notification before retry and halt on delivery failure. Project and all three explicit script TypeScript checks pass. Live BFMR/Telegram delivery acceptance remains pending.

Final validation for this slice: `node --import tsx --test tests/**/*.test.ts` passed 59/59 tests, including synthetic Chromium and injected Telegram transport. Project and explicit live-script TypeScript checks and `git diff --check` passed. No live Telegram messages or BFMR mutations were made.

### Amazon authentication resumption correction — 10 October 2026

Replaced the blocking terminal prompt for Amazon authentication with bounded browser polling and restored cart/product navigation after a successful login detour. Address/payment steps remain manual. Added synthetic regression cases for cart/product redirects through sign-in and MFA, and unresolved-authentication timeout. Live Amazon validation remains with the user; automated fixtures do not prove Amazon's current UI contract.

### Amazon product-first navigation correction — 10 October 2026

A user-reported unknown cart layout previously stopped navigation before the product page. Open the requested product first, preserve cart preflight before mutation, return to the product on unknown cart contents, and log sanitized structural diagnostics. Added synthetic cases for unknown-cart recovery and the shorter empty-cart heading. Live cart markup remains unverified.


### 11 October 2026 — live Amazon checkout rehearsal reached final review

The live `npm run test-amazon-checkout` run passed its BFMR startup reservation, exact startup cancellation and My Tracker release verification. It then opened the requested Amazon product, proceeded through Amazon Business checkout with the existing one-unit cart item and reported PASS after confirming the product, quantity one and order total on final review. The Place your order button was not clicked, and no order was submitted. This validates the observed account/session and this ASIN only; it is not a purchase test or evidence for other account/UI variants. The order remains in the Amazon cart for the user to manage. No automated test was run for this user-driven live run.

### 11 October 2026 — purchase safeguard refinement

The purchase CLI now rejects spending caps above $100 and rechecks both the cap and the exact confirmed total immediately before the single submission. Shipping verification requires an explicitly free shipping summary or an exactly offset shipping credit; item/tax arithmetic alone no longer proves free shipping. CVV fill/read errors are suppressed to avoid logging the secret. Confirmation uses the requested “Do you want me to <ACTION>?” wording with Y/N answers, and answering N to browser closure leaves Chromium open without repeated prompts. No tests, typecheck, or live checkout were run for this refinement, as instructed.

### 11 October 2026 — capture Amazon Order # after purchase

Historical behavior, superseded by the 12 October submission-confirmation identity fix above: after a confirmed purchase, the CLI clicked Returns and Orders and read the first displayed order section matching the purchased ASIN or exact product title and approved total. That did not establish that the order was newly submitted. The current code requires a unique Order # from this submission's thank-you confirmation and stops for review if identity is missing. The thank-you URL purchaseId is never treated as the Order #.

### 11 October 2026 — Amazon duplicate-order warning

The user explicitly authorized clicking Place your order once more when Amazon presents its duplicateOrder pending-order warning after submission. This continuation requires the recognized route and warning copy, matching product evidence and prices within the confirmed total. It is attempted at most once and never retried after an uncertain click; CVV handling and confirmation/Order # retrieval continue afterwards. This supersedes the blanket one-click restriction only for this recognized warning. No tests or live purchase were run for this change.

### 11 October 2026 — wait for post-submit confirmation

The user reported a placed order followed by the CLI's uncertain-outcome message, which skipped Order # retrieval. Replaced the one-shot confirmation read with bounded 60-second observation using a single URL/DOM snapshot per poll and whitespace-normalized Amazon Business confirmation text. Recognized duplicate/CVV continuations are attempted at most once each. After any uncertain click, the app only observes for confirmation and never retries or initiates another purchase action. Confirmed placement proceeds to the existing Orders lookup. No tests or live actions were run for this correction.

### 11 October 2026 — duplicate-warning readiness correction

The warning handler previously consumed its one permitted continuation as soon as the route appeared, even if the warning text/product/button had not rendered. It now polls read-only until all required evidence is present and consumes the continuation only when the click is attempted. Product-title matching accepts the same exact title before Amazon's pipe-separated descriptive suffix. Both button and link semantics are supported for the exact Place your order label. A successful click returns to bounded confirmation observation without demanding navigation within 1.5 seconds. Added sanitized continuation/outcome diagnostics. No tests or live actions were run.

### 11 October 2026 — require empty cart before product navigation

The shared Amazon checkout preparation now opens the cart first and requires verified empty-cart evidence before visiting the product page or adding one unit. An existing target item also blocks startup. Unknown/nonempty cart states remain on the cart for inspection, with existing items untouched. This supersedes product-first navigation and target-item reuse. No tests or live actions were run.

### 11 October 2026 — fix browser-side order extraction runtime error

The user's live run confirmed placement and navigated to Orders, then failed with `ReferenceError: __name is not defined`. Removed the local named normalization function from the Playwright evaluation callback; tsx/esbuild's function-name helper is not transferred into the browser context. Normalization is now inline and the Order # matching/total checks remain in place. No tests or live actions were run for this correction.

### 11 October 2026 — user-confirmed purchase-to-order-ID success and v1.8 handoff

Following the browser evaluation fix, the user reported that the complete purchase test worked, including Order # capture. The supplied preceding live log had already confirmed the duplicate-warning continuation, placement and navigation to Orders at $99.99; the final successful run is user-reported rather than a new agent-run regression suite. Created BFMR_Solution_Design_Specification_v1.8.pdf with a 13-page current-state guide covering Amazon safeguards, cart-first preparation, exact-PID browser attachment, body-only email classification, evidence boundaries and production gaps, followed by all 61 historical v1.7 pages. Saved editable current-state Markdown beside it. PDF rendering and text-preservation checks were performed; no code tests, typecheck or live actions were run.

## 12 October 2026 review corrections

Implemented review items 1–6 and 9–12 with offline regression coverage: exact reservation identity and lifecycle matching, Gmail provenance/mode, account-evidence gate, durable Gmail queue/cursor, shared unpaid exposure rules, reservation history/discrepancies, uncertain outcomes, incident-specific blocks, isolated test transactions plus durable PostgreSQL/account locking, and explicit acceptance evidence. Standard and extended TypeScript checks pass. Offline suite: 118 pass, zero fail; PostgreSQL integration runs separately against a disposable cluster. Live account selectors/auth-header fixtures remain a release gate, not completed integration evidence. Current setup and limits are in the v22 implementation reference.

## 22 October 2026 — Milestone #1: Fourteen-day latest-delivery cutoff & cart cleanup

Implemented the strict 14-calendar-day delivery cutoff policy across Amazon evaluation and rehearsal (`commit b1957be`):
- `src/services/amazonEvaluation.ts`: Added `parseAmazonDeliveryEstimate` to extract single dates, cross-month/same-month date ranges, relative words ("Today", "Tomorrow"), and explicitly absent estimates. Added `evaluateDeliveryCutoff` with calendar day calculations in `America/New_York` using UTC midnight conversions to prevent daylight saving time hour skew. Enforces: $\le 14$ calendar days passes; $> 14$ days rejects; date ranges evaluated by latest date; absent estimates pass under standard limits; unparseable estimates halt for review.
- `src/services/amazonCheckoutRehearsal.ts`: Added `extractAmazonDeliveryEstimate` to extract delivery text from selected radio options and review summary; populated in `readAmazonOrderReview`.
- `src/services/reservedDealPurchase.ts`: Integrated cutoff evaluation. When rejected, executes `rejectCheckout()` which calls `removePreparedAmazonCartItem` to assert an empty Amazon cart, followed by `cancelConfirmedReservation` with My Tracker readback in `dealEmailWorkflow.ts`.
- `tests/delivery_cutoff.test.ts`: Created an 11-case test suite covering boundary dates (Day 13, 14, 15), DST transitions, absent notices, and malformed inputs. All 11 tests pass.

## 22 October 2026 — Milestone #2 (Slice 1): Payment email ingestion via carrier tracking ID resolution

Implemented carrier tracking ID resolution and idempotent reimbursement recording in the intake queue (`commit cc5ce37`):
- `src/types/intakeEmail.ts`: Added `isPaymentNotice` and `paymentNotice` metadata structure (`trackingNumbers`, `amountCents`, `paidAt`, `paymentReference`).
- `src/services/emailParser.ts`: Implemented extraction of carrier tracking numbers (`TBA...`, `1Z...`, `9400...`, `\d{12,15}`), dollar amounts into cents, timestamps, and references from authenticated payment emails. Prevents payment emails from triggering deal reservations.
- `src/db/relationalRepositories.ts`: Added `shipments.findByTrackingNumber` (using index `shipments_tracking_number_idx`) and `deals.findById`.
- `src/services/relationalPayments.ts`: Added `recordPaymentByTrackingNumber` enforcing the relational resolution chain: `tracking_number -> shipments -> orders -> reservations -> reimbursements`. Records reimbursements idempotently, updates reservation status to `'3'` (Reimbursed) when fully paid, and quarantines unmapped tracking numbers in `workflow_evidence` (`UNRESOLVED_PAYMENT_TRACKING`).
- `src/services/dealEmailWorkflow.ts`: Wired payment handling into `processEmail`, committing the intake cursor and bypassing the purchase flow.
- `tests/payment_intake.test.ts`: Created a 5-case test suite covering multi-carrier parsing, tracking resolution, idempotent re-runs, and quarantine handling. All 5 tests pass.

## 22 October 2026 — Milestone #2 (Slice 2): Informational email ingestion & checkout live payout update

Implemented informational email ingestion, database linking, and checkout-time live payout price retrieval (`commit 7681678`):
- `src/types/intakeEmail.ts` & `src/services/emailParser.ts`: Added `isInformationalUpdate` and `informationalType` (`PAYOUT_INCREASE`, `ADDITIONAL_SLOTS`, `CLOSING`, `DEAL_UPDATE`). Enforces that informational notices never trigger new reservations or purchasing loops.
- `src/services/dealEmailWorkflow.ts`: Wired informational email intake to persist in `emails`, link to matching deals in `email_deals`, commit the Gmail history intake cursor, and exit cleanly without purchasing.
- `src/db/relationalRepositories.ts`: Added `reservations.updatePayout(reservationId, payoutPerItemCents)` to update `reservations.payout_per_item`, which automatically recalculates the generated stored column `expected_payout = (quantity * payout_per_item)`. Confirmed `reservations` as the single source of truth for payout rates.
- `src/services/relationalDealTerms.ts`: Added `fetchLiveBfmrDealPayout(slug)` calling BFMR Deal API `GET /api/v2/deals/{slug}`.
- `src/services/relationalReservations.ts`: Updated `readLockedPurchaseEvidence` to call `fetchLiveBfmrDealPayout` at the checkout screen, update `reservations.payout_per_item` in the database, record audit evidence in `workflow_evidence`, and evaluate Amazon checkout review against this fresh live payout.
- `tests/informational_and_checkout_payout.test.ts`: Created a 5-case test suite covering informational classification (payout increase, closing, slots), live BFMR Deal API payout retrieval, database updating, and checkout evidence injection. All 5 tests pass.

## 22 October 2026 — Milestone #3: Standalone Native PostgreSQL & Role Validator Script

Implemented the terminal CLI database environment verification tool (`commit 6d78e86`):
- `scripts/validate_database_environment.ts`: Standalone validator script runnable via `npm run validate-db`. Reads standard PG connection variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, or `DATABASE_URL`).
  - Checks server version $\ge 150000$.
  - Checks runtime role privileges: non-superuser, non-createdb, non-createrole.
  - Verifies public schema and 16 business tables are present and owned by a dedicated owner role (e.g. `bfmr_owner`), confirming `bfmr_app` is non-owning.
  - Active Probes (inside an unconditionally rolled-back transaction):
    - DDL rejection: asserts `CREATE TABLE` under runtime role fails with `42501` (`insufficient_privilege`).
    - Append-only trigger: asserts `UPDATE` on `workflow_evidence` throws `55000` (append-only trigger active).
    - Generated stored column: verifies PostgreSQL calculates `expected_payout = (quantity * payout_per_item)`.
    - Reimbursement uniqueness: verifies duplicate insert for same `reservation_id` throws `23505` (`unique_violation`).
    - CCV privacy: asserts `retailer_accounts.ccv` is protected from runtime access.
- `package.json`: Added `"validate-db": "tsx scripts/validate_database_environment.ts"`.
- `tests/database_validator.test.ts`: Created unit tests covering config resolution, catalog inspection, probe expectations, and rollback enforcement. All 2 tests pass.

## 22 October 2026 — Milestone #5: Production Service Supervision & Systemd Packaging

Implemented production supervisor, systemd service configuration, health monitoring CLI, and backup/restore scripts:
- `scripts/supervise_worker.ts`: Process supervisor executing `scripts/run_bfmr.ts`. Implements signal forwarding (`SIGINT`, `SIGTERM`), graceful shutdown with configurable timeout, exponential backoff restart delay (5s to 60s), burst crash circuit breaker (halts if > 5 crashes within 5 minutes to prevent account churn), and periodic heartbeat writing (`/tmp/bfmr-worker-heartbeat.json`).
- `systemd/bfmr-worker.service`: Systemd service unit for Ubuntu/mini-PC configuring working directory, environment loading, non-root user execution, systemd journal logging (`SyslogIdentifier=bfmr-worker`), and security sandboxing (`NoNewPrivileges`, `ProtectSystem=full`).
- `scripts/health_check.ts`: Standalone diagnostic tool runnable via `npm run health`. Checks database connectivity and PostgreSQL version, inspects worker heartbeat status and age, verifies un-reimbursed exposure does not exceed the $200.00 limit, and outputs a formatted terminal report with exit code 0/1.
- `scripts/backup_production_state.sh` & `scripts/restore_production_state.sh`: Automated backup and restore tooling with native and Docker container `bfmr-postgres` support, gzip compression, state tarballing, SHA-256 integrity verification, and 14-backup retention.
- `src/services/bfmrWorker.ts`: Updated `admitGmailEmail` to admit verified payment notices and informational update messages into the worker intake pipeline.
- `package.json`: Added `"start"`, `"supervise"`, `"health"`, and `"test"` scripts (running all 26 unit tests across the 5 test suites).
- `scripts/validate_database_environment.ts` & `scripts/health_check.ts`: Added shared `connectDatabaseClient()` helper providing transparent fallback to `localhost:5432` when executing from host environments where internal Docker network hostnames (such as `bfmr-postgres`) do not resolve in host DNS.
- `tests/milestone5_operations.test.ts`: Added 3 unit tests verifying heartbeat writes, stale heartbeat detection, and active healthy worker detection. All 26 tests pass.

## 22 October 2026 — Milestone #4: Controlled Reconciliation & Production Cutover

Implemented interactive production cutover CLI workflow:
- `scripts/run_production_cutover.ts`: Interactive production cutover orchestrator.
  - Pre-flight checks: Validates `BFMR_EXPECTED_ACCOUNT`, claims exclusive account advisory lock `bfmr_worker_lock_${account}`, and validates relational schema.
  - Automated Backup: Triggers `./scripts/backup_production_state.sh` prior to cutover application.
  - Candidate Manifest Generation: Prepares a clean fresh-start boundary manifest (`prepareFreshStartCutover`) anchored at the exact cutover timestamp with `mode: 'START_FROM'`, `priorCompletedActivity: 'EXCLUDED'`, and `noOutstandingWork: true`.
  - SHA-256 Verification: Computes and displays the manifest SHA-256 fingerprint for operator inspection.
  - Operator Confirmation: Prompts the operator with `Type 'YES' to confirm and apply this production cutover boundary:` (with `--dry-run` and `--non-interactive` flag support).
  - Atomic Commitment: Atomically applies the cutover to PostgreSQL via `applyRelationalCutover()` recording the cutover marker in `public.workflow_evidence`.
  - Verification: Confirms cutover acceptance with `assertRelationalCutoverReady()`.
- `tests/cutover.test.ts`: Added 4 unit tests covering CLI argument parsing, SHA-256 hashing, compliant fresh-start manifest creation and validation, and missing confirmation rejection. All 30 tests across all 6 test suites pass.

## 22 October 2026 — Architecture & Database Optimization Hardening

Implemented production optimizations, index additions, and process hygiene:
- `database/optimizations.sql`:
  - Added partial index `idx_workflow_evidence_cutover` on `public.workflow_evidence (action_type, phase, outcome)` for cutover and order state lookups.
  - Added partial index `idx_reservations_open_exposure` on `public.reservations (id, expected_payout) WHERE reservation_status_id != 2` to accelerate exposure boundary calculation.
  - Added index `idx_orders_order_id` on `public.orders (order_id)` for rapid retailer order number lookups.
  - Added trigger `trg_enforce_exposure_cap` (`check_max_unreimbursed_exposure()`) on `public.reservations` to strictly enforce the $200.00 exposure limit at the database engine level.
- `scripts/apply_database_optimizations.ts`: Dedicated CLI tool (`npm run optimize-db`) to apply optimizations to the target database.
- `scripts/supervise_worker.ts`: Added `reapOrphanBrowserProcesses()` to automatically sweep and terminate lingering headless browser instances on supervisor startup and shutdown.
- `src/adapters/playwrightBrowser.ts`: Added `captureErrorScreenshot()` to capture full-page diagnostic PNG screenshots into `~/.local/state/bfmr/screenshots/` upon unexpected failure or DOM layout changes.
- `package.json`: Added `"optimize-db"` script and updated `"test"` to run all 35 tests across all 7 test suites.
- `tests/optimizations.test.ts`: Added unit tests verifying process reaper safety, screenshot method resilience, SQL optimization syntax, permission hardening, and native advisory locking. All 35 unit tests pass.

## 23 October 2026 — Information Security & Code Quality Hardening

- `scripts/loadEnv.ts`: Added `secureSecretFile()` to automatically verify and harden permissions on `.env` and GCP credential files to `0600` on POSIX systems.
- `src/db/relationalDatabase.ts`: Unified database ownership and advisory locking. Added `claimAccount()` and `relinquishAccount()` directly to `RelationalDatabase`, enabling native advisory lock management on its connection pool without dual-pool overhead.
- `database/migrations/20261022_drop_ccv.sql` & `database/optimizations.sql`: Dropped unused plaintext `retailer_accounts.ccv` column for PCI-DSS compliance. Updated `RelationalDatabase` schema validation to treat `ccv` as optional.
- `src/services/freshStartCutoverPreparation.ts`: De-compressed code into clean, readable, typed TypeScript with structured guard clauses and explicit contracts.

