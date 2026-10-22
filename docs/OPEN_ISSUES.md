# Open issues and release blockers

**Updated:** 22 October 2026

This is the current-only checklist of unfinished implementation, provider evidence and operational acceptance. Requirements are defined in the [v22 solution design](BFMR_Solution_Design_Specification_v22.md); implemented behavior, configuration and evidence are recorded in the [v22 implementation reference](BFMR_Implementation_v22..md) and [relational integration runbook](RELATIONAL_INTEGRATION.md). Database installation and upgrade boundaries are in [database/README.md](../database/README.md).

Remove an item when its stated completion evidence is recorded in the implementation reference or project registers. Synthetic coverage does not establish a live provider contract, installed database enforcement or production acceptance.

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

Establish the authenticated payment-notice contract and exact reservation/deal, actual amount, payment time and source provenance. Complete any automatic payment-template adapter only from verified evidence. Define reviewed handling for aggregate-only or conflicting payment evidence; do not infer individual payments or dates from cumulative balance changes. Preserve the one-reimbursement-per-reservation constraint.

## Database and operational acceptance

### SETUP-001 Local PostgreSQL and runtime configuration

Validate PostgreSQL 15+ on the mini-PC, exact BFMR account ownership and a non-owning runtime role with reviewed grants. Require one retailer named `Amazon`; multiple linked accounts are valid, and selection uses lowest `retailer_account_ranking` with no environment override or `ccv` read. Accept integer/non-null/per-retailer unique ranking and no default/generated assignment. For existing databases, separately review nullable/unique preparation, actual manual rank backfill and finalization; worker validation must reject the intermediate schema. Add least-privilege SELECT on ranking without application ranking updates. Verify missing-account stops and run-pinned identity/no silent switching. The operator reports native ranking/schema/account and lock checks passed;
complete role/data/restore and financial enforcement acceptance remain pending. Install only the applicable reviewed schema/upgrade, never startup DDL. Financial enforcement acceptance is tracked under IMPL-006 below.

### SETUP-002 Gmail queue initialization and recovery

The operator chose a version-2 start-from boundary excluding prior completed
activity after confirming no outstanding work. Validate the new manifest/report,
acceptance marker, startup/old-email guard and refusal of existing state before
applying it. Reconcile coverage between the exact boundary and first Gmail watch;
no baseline reset, historical-row blanket skip or Inbox scan is authorized by
that choice. Focused offline validation passed; native report/apply and real
first-watch coverage remain pending.

Verify first-ever SQL initialization versus restoration of an existing queue and the reviewed legacy import/source-hash boundary; the report/apply source is implemented, not applied. Install `database/gmail_intake.sql` separately with reviewed runtime grants. Reconcile interrupted `PROCESSING` work against BFMR/Amazon before operator repair. Preserve expired-history gaps; an alternative recovery scan or purchase backfill needs a separate explicit decision. Missing state must not silently initialize a new mailbox baseline.

### SETUP-003 Supervised service, scheduling and notifications

Provide and accept startup/reboot supervision, headed-browser/manual-auth access, ownership-loss shutdown, scheduled tracking/status checks, monitoring, log retention and durable notification-delivery recovery. Establish real-provider evidence for CON-001 watch/StreamingPull, notification-before-ACK, serialized work/cursor commits, daily watch renewal and startup/reconnect continuation. Native operational-schema validation/installation, legacy reconciliation/import and live reconnect/ACK/process-crash/restore behavior remain unverified. See GMAIL_PRODUCTION_INTAKE.md for offline evidence and remaining boundaries. No source/static/synthetic result closes service acceptance. Verify mailbox/OAuth identity, configured topic/subscription and Pub/Sub credentials. The separate listener/IMAP fallback is not production acceptance. Existing SQL and private operational stores need coordinated recovery; migration of all operational state into PostgreSQL is separate work.

### SETUP-004 Actual historical reconciliation and cutover

Reconcile real creation-term proofs, existing reservation/order/shipment identities and actual payment-email evidence. Review complete account coverage and legacy source hashes, resolve unsupported/conflicting records, and accept the controlled cutover only under separate authorization after backups. Import must not replay provider actions or substitute current deal terms for historical creation terms.

### SETUP-005 Backup, restore and stale-state recovery

Implement and verify backups/restoration of PostgreSQL, private Gmail/batch/recovery/status/notification stores and accepted legacy source files. Demonstrate safe recovery from stale backups and missing journals, preserving possible external outcomes and preventing duplicate actions. Establish access, retention and recovery procedures before unattended operation.

### IMPL-006 Creation-locked reservation payout (D22-03)

Verify installed native PostgreSQL enforcement using the reviewed non-owning role: creation quantity/rate edits, including compensating edits preserving their product, must be rejected; ordinary status updates must remain permitted. Confirm the stored generated formula and enabled `ALWAYS` guard match [database/schema.sql](../database/schema.sql). Source and embedded-test evidence alone do not close installed enforcement or the historical authenticity checks required by SETUP-004.

## Remaining application work

### Tracking across ranked retailer accounts

The worker automates one selected Amazon account per run. After a rank change and restart, outstanding orders on another account can be outside the selected ledger projection. Review/reconcile those orders before reprioritizing, preserve their original account identities and establish continuing tracking. Multi-account tracking, safe account transitions and acceptance remain pending; storing multiple accounts does not implement them.

### Single-deal automatic purchasing

Implement the shared durable ordering/confirmation/reconciliation workflow for newly processed single-deal mail before removing its current early return. Preserve the same quantity-one, financial, identity, gift, free-delivery and uncertainty safeguards as the supported multi-deal path. Do not revisit completed Gmail messages to backfill purchases.

### Fourteen-day latest-delivery cutoff

Implement and cover the approved calendar-day rule: exactly 14 days is allowed; a later date rejects checkout with exact new-reservation cancellation/readback. A range uses its latest date; an explicitly absent estimate may proceed under other guards; unreadable/conflicting evidence stops for review. Settle order-date timezone and final-review estimate-change handling.

### Operator repair for uncertain actions and replacements

Complete reviewed restart/repair procedures for uncertain reservation, checkout, BFMR Purchase/Shipment and notification outcomes. Resolve replacement/refund cases within the one-order-per-reservation model without fabricating identities, discarding evidence or silently inserting another order. Recovery must reconcile authoritative outcomes before any separately authorized retry.

### Action-control regression and operational acceptance

The source hardening is implemented; see [ACTION_CONTROL.md](ACTION_CONTROL.md). Add/run explicitly requested offline coverage for strict address/card/account checks, explicit cancellation release (update older fixtures that model disappearance), persistent incident resolution boundaries, recovery inventory corruption/missing files/path changes, orphan intents, failed notifications and shutdown races. Validate native PostgreSQL queries/grants, verified active-account selectors across layouts and crash/restore behavior. The full compiler check currently requires restoring the declared PGlite dependency. Establish the reviewed initial recovery baseline on the real installation only after restoring/reconciling all existing stores. General report/apply repair and safe resolution of blocked incidents remain unfinished; no runtime reset or successful alert may clear them automatically. No software regression or provider/production acceptance is claimed by the implementation.
