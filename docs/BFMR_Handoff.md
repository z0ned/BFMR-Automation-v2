# BFMR_Handoff

**As of 23 October 2026.** Compact context for the next LLM; consult linked references for implementation details rather than reconstructing historical decisions.

## Current recovery checkpoint

The 23 October merge integrates `origin/work` (`044472e`) with main's newer
`09f9d2b` runtime fixes. The screenshot revision is now fetched and its bulk-reset
script is replaced by the reviewed exact-message compatibility flow. Main's
other runtime fixes and `inspect-email` command are retained. The merge reran
22/22 recovery cases and passed the scoped compiler check; see the
[merge record](RECOVERY_REVIEW_20261023.md#23-october-2026--originwork-integration-into-main).
These reruns do not increase the earlier 66-case count or establish live acceptance.

Implementation commit **`ee183ef`**, on branch `work`, addresses the 23 October
review. The [recovery amendment](RECOVERY_REVIEW_20261023.md) owns exact commands,
source paths, failure boundaries and evidence. It supersedes older claims about
bulk unblocking, refreshing reservation payouts and safe restore/ceiling acceptance.
The first push attempt was rejected by automatic approval review before remote
publication; a local commit is not evidence that the operator host has the fixes.
The user subsequently requested documentation updates and another commit/push.
Verify the remote branch and installed revision separately; do not infer deployment.

The screenshot's repair failed on `gmail_intake_work` permissions, and startup
then found interrupted `PROCESSING` mail. No real queue row or incident has been
cleared here. Keep the worker/supervisor stopped pending exact-message diagnostics,
authoritative provider reconciliation and a reviewed report/apply repair.

The focused implementation validation passed **66/66 cases**, plus source and
scoped TypeScript, shell syntax and whitespace checks. This documentation refresh
adds document QA only; it does not rerun or increase those software-test totals.
Native concurrent-session ceiling checks, a replacement-database restore drill,
installed role/grant acceptance and live provider outcomes remain open.

## Goal and authority

Build a fresh TypeScript BFMR buying-club automation: authenticated Gmail offer → BFMR reservation → eligible Amazon purchase → tracking/BFMR updates → reimbursement reconciliation. The participant pays Amazon upfront; correct identity, controlled exposure and recoverable uncertainty are essential. Do not import the former BFMR codebase.

Work in `BFMR-Automation-v2` (`/workspace/BFMR-Automation-v2` in this workspace). Read [AGENTS.md](../AGENTS.md) before changes, inspect Git status/diffs and preserve user changes/private state. Current authority is the [v22 design](BFMR_Solution_Design_Specification_v22.md), [v22 implementation](BFMR_Implementation_v22..md), latest [decisions](DECISIONS.md), [implementation plan](IMPLEMENTATION_PLAN.md), [open issues](OPEN_ISSUES.md) and [relational runbook](RELATIONAL_INTEGRATION.md). Later explicit user instructions prevail. `Overview.txt` and dated historical entries contain superseded paths, table counts and implementation status; use the current baseline below. Older linked documents may not exist locally.

## Where we are

Completed work includes relational business persistence, production push-intake source, offline validation and consolidation of schema/application into one repository. **The project is not an accepted unattended production service.** No actual schema installation, historical cutover or deployment was performed by that work; live provider contracts remain open.

- Worker: `npm start` → `scripts/run_bfmr.ts`; shared processing lives in `src/services/bfmrWorker.ts` and `dealEmailWorkflow.ts`; the test-named script is now a thin compatibility/test wrapper. Production startup skips the temporary test reservation. New source implements Gmail watch/owned Pub/Sub StreamingPull, SQL notification-before-ACK, atomic admissions/cursor progress, daily watch renewal and startup/reconnect catch-up. No periodic Gmail polling or Inbox sweep. The 23 October run directly exercised `tests/postgres_gmail_intake.test.ts` (14/14); native SQL/provider/service acceptance remains open. See current results in the [intake runbook](GMAIL_PRODUCTION_INTAKE.md).
- Implemented source includes quantity-one website reservations, exact confirmation, supplier evaluation/cancellation, multi-deal Amazon ordering, tracking, BFMR Purchase/Shipment writes and daily discrepancy alerts. Each still depends on current verified provider contracts.
- Relational runtime implements schema/account/cutover validation, advisory ownership, serializable transactions, locked creation terms, reconciliation, SQL order/shipment ledger, verified payments and exposure. Require one retailer named `Amazon`, then select its account by lowest `retailer_account_ranking`; multiple accounts are valid; zero linked accounts stop startup. IDs/email/rank come only from SQL, never `ccv`. Pin the account for the run; changed selection stops without switching. Startup does no DDL/import; ownership loss stops work and closes the browser. Operator-reported native ranking/schema/account checks passed; see the implementation reference for scope and remaining acceptance.
- SQL business records, dedicated SQL Gmail intake, private batch/recovery/status/notification journals, and the legacy JSONB engine aggregate remain separate stores. No transaction spans them and external providers. The active email runner uses SQL business records; the legacy/manual order file remains a preserved cutover/hash source and standalone manual store. Evidence rows are not retry commands.
- Single- and multi-deal ordering now share durable SQL per-message/per-reservation action states and purchasing guards. New PROCESSING mail only can enroll. Interrupted work requires report-first reconciliation and reviewed local repair; completed messages cannot be backfilled. See [SHARED_EMAIL_WORKFLOW.md](SHARED_EMAIL_WORKFLOW.md); source/static evidence is not behavioral or production acceptance.
- Later 22 October source implements the 14-day delivery cutoff and payment/informational-email ingestion. Their earlier focused results retain their dated scope; no new provider acceptance is implied. The 23 October recovery fixes preserve creation-time payouts rather than refreshing existing reservation rates. There is no accepted live dashboard operations API/service.

## 22 October action-control source update

See [ACTION_CONTROL.md](ACTION_CONTROL.md). The worker now requires exact Amazon account/address/card evidence, explicit cancellation status, persistent incident blocks and startup recovery audits even without the test reservation. Configure only verified account selectors and review/restore all journals before accepting the first recovery inventory. The original action-control update had static evidence only. The subsequent 23 October recovery amendment records focused software coverage and passing source/scoped compiler checks after restoring the locked PGlite package locally. Exact-message reviewed repair is source-implemented; general uncertain-action resolution and native/provider acceptance remain open.

## Settled rules to preserve

- Only authenticated, body-classified single-new-deal or explicitly supported multiple-new-deal mail qualifies. Subjects/printed samples do not establish qualification or provenance. Production accepts the approved BFMR sender; the separate testing sender requires explicit testing mode. Updates, added slots, payout changes and unsupported/all-open roundups never trigger reservations. Bundles remain one offer. Never backfill completed mail into purchasing.
- For multiple deals, attempt one quantity-one reservation per distinct deal **before any batch supplier/checkout evaluation**. Capture failure stops the batch. Resolve canonical deal IDs, require complete tracker reads and exact browser/API account alignment. Any recognized open reservation for the deal blocks another. Reserve through normal Playwright website forms; no invented API POST fallback.
- After exact new-reservation confirmation, verify Amazon supplier evidence. Checkout requires one supported item/quantity one, empty-cart preflight, exact account/ASIN/line/address/payment, gift selection, free non-Prime delivery, complete total **≤$100**, locked BFMR payout **≥ total**, and existing unpaid expected payouts **+ proposed Amazon total ≤$200**. Exclude the exact current reservation from prior exposure; check its payout separately.
- Exposure requires the latest fresh complete validated reconciliation and actual payment coverage. Unknown paid amount is not zero; terminal status is not settlement; an older successful read cannot replace a later failed one. Keep `BFMR_CREATION_TERMS_CONTRACT_VALIDATED`, `BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED` and purchasing policy gates closed until their requirements are established.
- Verified rule failure cancels **only the exact newly confirmed reservation**, with exact release readback. Unknown evidence stops for review. Startup CAPTCHA reservations are a separate test flow: confirm then cancel without supplier evaluation. Login/MFA/CAPTCHA remain manual.
- Every external action needs durable intent, exact identity, bounded submission, authoritative readback and durable outcome. Never repeat a possibly successful action. Amazon Order # must come from the current submission's causal thank-you confirmation, bound to ASIN/total; no history-first-match fallback.
- Check known Amazon orders and BFMR status once per `America/New_York` day at/after 03:00, prioritizing new mail. Match exact Order #/ASIN/total; BFMR Purchase then Shipment writes require exact IDs and readback. Missing records are discrepancies, not proof of cancellation/payment.
- Separate manual purchase test is restricted to `B0GTMJF7PV`, interactive cap ≤$100 and exact confirmation; `B09JQMJHXY` rehearsal stops at final review. Past success grants no new live authority.

## Database contract

[database/schema.sql](../database/schema.sql) is authoritative: **16 tables**, including `deal_retailers`; no dedicated `reservation_history` or `order_tracking`. Original files came unchanged from former `BFMR_DB_Schema` main `a67a0715ef040b0dd65de17ce63a0a5e34898699`; 22 October source adds integer `retailer_account_ranking NOT NULL`, unique with `retailer_id`, without defaults/autofill. Existing DBs require prepare → reviewed manual backfill → finalization; the validator rejects the intermediate schema. Grant application SELECT on ranking, never rank UPDATE or `ccv` reads. See [database guide](../database/README.md) and [relational runbook](RELATIONAL_INTEGRATION.md#retailer-account-ranking-upgrade--22-october-2026). One account is automated per run; review outstanding other-account orders before changing priorities. Existing orders keep their original account; multi-account tracking is open. Historical `src/db/migrations/` are a separate engine schema. `database/gmail_intake.sql` adds four operational tables separately (20 total with both contracts).

The historical [initial Amazon seed](../database/seed_amazon_account.psql) and
ranking upgrades retain their original scope. Later 22 October work removed CCV
storage from the native schema; current worker validation accepts its absence and
never reads it. Do not reintroduce or supply a card security code merely because
an older installation example mentions it. Use the actual reviewed installation
baseline and preserve original account/order identities.

At most one order per reservation, one shipment/tracking number per order, and one actual reimbursement per reservation. Reimbursement links directly to reservation and payment email; no order is required. Multiple same-account/deal orders across different reservations are allowed. Extra shipments/payments and replacement/refund conflicts require review/design decisions, not silent merging or extra rows.

`expected_payout` is generated from creation `quantity * payout_per_item`; an `ALWAYS` immutable-input trigger rejects either input changing, including compensating edits. Deal payout changes affect future reservations only. Preserve conflicting observations; never reconstruct missing historical terms from today's rate or infer actual payments/dates from cumulative balance changes. Runtime must validate installed guard/roles, exact retailer account and one accepted account/source-hash cutover marker before work.

## Evidence already recorded

22 October operator-reported native results include PostgreSQL 17 role/schema
checks, an accepted start-from cutover at `2026-10-22T17:36:11.084Z`, and bounded
health/service checks recorded in the implementation reference and project
registers. These reports describe their original revisions and do not validate
the revised intake grants, payout handling, ceiling or restore tooling in
`ee183ef`. Do not prepare another fresh-start baseline or reset Gmail to clear
the interrupted work shown in the screenshot.

21 October offline evidence: **142 distinct cases across runs: 141 passed, zero failed, one native PostgreSQL integration skipped**. Final focused relational suite: **23/23** on disposable PGlite; typechecks/build passed. Consolidation separately reran 23/23 using bundled schema with no override; do not double-count reruns. Browser fixtures used system Chromium 154, not authenticated provider layouts. These results establish neither native mini-PC installation nor live/production acceptance. A prior fixed-item purchase success was bounded user-reported evidence only. Exact commands/limits are in the relational runbook; newer intake results are recorded separately in the intake runbook linked above.

## Next steps

1. Verify the published and installed revision, preserving all existing state.
   Run `npm run recovery:diagnose -- --message-id <private-Gmail-ID>` on the
   configured operator host; optionally require the exact reviewed full SHA with
   `--expect-revision`. The diagnostic reports source identity, connected role,
   missing intake grants and the exact message's state without provider actions.
2. With writers stopped and a coordinated backup preserved, review the actual
   grants against `database/runtime_intake_grants.psql`. Apply only separately
   reviewed maintenance to the correct existing schema/role; do not rerun the
   fresh installer or grant ownership/superuser rights.
3. Reconcile the exact message's BFMR/Amazon effects. Use
   `npm run recovery:report -- --help`, review a fresh private report/hash, then
   separately authorize its local apply. Unknown outcomes remain blocked.
   `npm run unblock` without arguments refuses a bulk reset. Never mark all
   workflows complete, reset the cursor, or replay completed messages.
4. Accept the revised optional payout ceiling under native competing sessions,
   partial payments and status/payment changes, and perform a coordinated restore
   drill into an empty replacement database. Preserve an incomplete-restore
   marker until the SQL/local-state pair is reconciled. The authoritative checkout
   exposure check still requires full fresh provider/payment coverage.
5. Close provider gates EV-001–EV-006 and the remaining crash/recovery,
   notification, supervision and ranked-account tracking acceptance in
   [OPEN_ISSUES.md](OPEN_ISSUES.md) before unattended operation. Real provider
   reads/mutations and worker startup remain separately scoped actions.

Keep completed evidence in the implementation reference/registers and unfinished
work in `OPEN_ISSUES.md`. Credentials, raw mail/account pages, authenticated
profiles, real order/tracking identities and backups remain private. Email PDFs
are parser references, not Gmail provenance or action authority. This documentation
and publication request authorizes no installed SQL change, incident repair,
provider action, deployment or live worker invocation.
