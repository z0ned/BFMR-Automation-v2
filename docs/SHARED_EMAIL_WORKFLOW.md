# Durable single-/multi-deal email workflow

## 23 October 2026 — recovery review amendment

The [recovery review amendment](RECOVERY_REVIEW_20261023.md) controls current
revision/grant diagnostics, atomic exact-message repair, creation-locked checkout
payouts, partial-payment exposure accounting, and coordinated backup/restore.
Earlier source/native acceptance claims retain their dated scope. These changes
have not been installed on the operator host or used to clear its incident.


**22 October 2026 — source implementation; behavioral/native/provider acceptance remains pending.**

## Runtime and scope

`npm start` loads private configuration in `scripts/run_bfmr.ts` and invokes `src/services/bfmrWorker.ts`. The worker delegates both qualifying message types to `dealEmailWorkflow.ts`. `scripts/test_real_email_e2e.ts` is a compatibility/test entrypoint that explicitly injects the temporary startup reservation; production does not import or invoke it. `reservedDealPurchase.ts` owns checkout orchestration; the historical purchase script re-exports that implementation.

Authenticated single-new-deal and supported multiple-new-deal emails now use the same phases and safeguards. The single-deal early return is removed. Every announced distinct offer receives its quantity-one reservation pass before any supplier evaluation; an uncertain reservation stops the batch. All confirmed offers finish supplier evaluation/cancellation before purchasing starts. A bundle remains one offer. Duplicate/open deals and explicitly unavailable pages remain skips. Existing account, supplier, gift, free non-Prime delivery, $100 complete-total, locked-payout coverage and $200 exposure guards apply to both message types. The separate 14-day delivery rule remains unimplemented.

No live workflow, provider action, schema installation, SQL import, repair or deployment was invoked by this source change. Source is not permission to run a worker or apply a repair.

## Durable state

`DealEmailWorkflowStore` appends versioned `DEAL_EMAIL_WORKFLOW / SNAPSHOT` events to existing `workflow_evidence`; it adds no SQL schema. Each message binds the exact Gmail identity/source hash, message type, account, pinned ranked retailer-account ID, start time, immutable announced URLs and one workflow correlation UUID. Per-offer snapshots retain canonical deal/reservation identity, preparation target, locked checkout intent, causal order confirmation and exact action progress. Bodies, authentication headers, payment secrets and raw provider pages are not copied into this evidence. SQL intake remains the private payload store.

Normal writes compare the expected previous snapshot ID and validate permitted transitions and immutable identity. JSONB object-key ordering cannot create false conflicts. Reservation creation intent/confirmation still uses the existing relational evidence and locked terms. An older NO_ACTION or confirmation cannot satisfy a later creation intent.

| Step | Durable boundary and restart meaning |
| --- | --- |
| `PENDING` | No reservation attempt has started. |
| `RESERVING` | Preflight/creation is in progress. Canonical identity is committed before calling the website submit adapter. Exact SQL creation capture plus current provider readback can substantiate confirmation; a provider deal/title match alone cannot. |
| `RESERVED` / `EVALUATING` | Exact creation is captured; supplier evaluation is a read. Cancellation has its own subsequent intent. |
| `ELIGIBLE` / `CHECKOUT_PREPARING` | Supplier eligibility is recorded. Cart preparation may have happened; preparation recovery requires exact account and verified empty-cart evidence before another preparation. |
| `CHECKOUT_INTENT` | Exact ASIN, complete total, payout and product URL are committed before submission. Missing causal Order # capture remains uncertain; do not search for a first matching order or submit again. |
| `ORDER_CONFIRMED` | The current submission's Order #, ASIN, total and confirmation time are captured before SQL order persistence. Exact retailer readback can support local SQL repair without another purchase. |
| `ORDER_RECORDED` | SQL order capture is complete; a later BFMR write must first enter its own intent. |
| `PURCHASE_UPDATE_INTENT` | BFMR Purchase may have happened. Only exact purchase-ID/order/reservation readback supports completion; no repeated POST. |
| `CANCEL_INTENT` | Cancellation may have happened. Only exact explicit canceled status supports completion; absence is unknown. |
| `COMPLETE` / `CANCELLED` / `SKIPPED` | Terminal member; never purchased/re-reserved by continuation. Cart uncertainty still blocks message completion. |

Messages are `RUNNING`, `PAUSED`, `READY` after reviewed repair, or `COMPLETE`. Exceptions preserve the last durable boundary and pause without automatic replay. A failed snapshot cannot erase an earlier committed intent. The legacy multi-deal and post-reservation journals remain backup/recovery evidence and startup gates; email processing no longer overwrites them. Test-startup cleanup retains its own existing journal.

## Payment Notice Ingestion Path

When an incoming email is parsed as a payment notice (`isPaymentNotice: true`), `processEmail` branches before deal claims:
1. Extracts carrier tracking numbers, paid amounts in cents, timestamps, and payment references.
2. Resolves the reservation through the relational hierarchy: `tracking_number -> shipments -> orders -> reservations -> reimbursements`.
3. Records the reimbursement idempotently via `recordPaymentByTrackingNumber`, updating reservation status to `'3'` (Reimbursed) when fully paid.
4. If tracking numbers are unmapped in local shipments, stores `UNRESOLVED_PAYMENT_TRACKING` in `workflow_evidence` for subsequent reconciliation without data loss.
5. Commits the intake cursor and terminates without entering deal reservation or purchasing loops.

## Fourteen-Day Delivery Cutoff Policy

During checkout review, the delivery estimate is evaluated against the 14-calendar-day policy in `America/New_York`:
- Calendar dates $\le 14$ days from the order placement date pass.
- Calendar dates $> 14$ days trigger rejection: `rejectCheckout()` navigates to the cart, executes `removePreparedAmazonCartItem` asserting an empty cart, and returns `{ status: 'INELIGIBLE', cartCleared: true }`.
- The workflow catches `INELIGIBLE`, initiates `cancelConfirmedReservation` with explicit My Tracker readback, and leaves no lingering items in the cart.
- Unreadable or conflicting delivery estimates quarantine the workflow for operator review without speculative cancellation.

## No historical purchase backfill

New Gmail workflows require the exact SQL `PROCESSING` payload, matching source fingerprint and accepted fresh-start time boundary. Existing DONE tombstones, missing queue state, altered payloads and previously recorded emails without a new workflow cannot be enrolled into purchasing. Completed workflow snapshots return without purchase work; a completion-to-DONE acknowledgement gap can be repaired to DONE only. The reviewed repair path never transitions DONE mail to PENDING or changes the consumed history cursor.

The separately invoked local PDF test uses a distinct workflow source and cannot create a fictitious authenticated Gmail email. Repeated/unfinished PDF workflows do not authorize replay. The reviewed Gmail repair command does not repair PDF-source or historical legacy workflows.

## Report-first reconciliation and reviewed local repair

Stop the account worker and preserve coordinated backups before the operator invokes the tool. It acquires the existing account ownership lock and validates the installed contracts/cutover/ranked account. It requires an **existing exact Chromium PID**, verified BFMR browser/API account alignment, actual financial/creation contracts and current retailer-account proof. It never invokes startup reservation, login forms, cancellation, checkout, BFMR Purchase/Shipment POSTs, Gmail watch/history or notifications. Browser navigation/API reads can contact the providers.

Supply an existing owner-only directory **outside the repository** for reports. Reports contain actual private identifiers and must not enter Git/chat/logs. From the configured local Ubuntu checkout, the default report command is:

```sh
node --import tsx scripts/reconcile_deal_email.ts \
  --message-id "$BFMR_RECOVERY_MESSAGE_ID" \
  --browser-pid "$BFMR_CHROMIUM_PID" \
  --report-file "$BFMR_PRIVATE_RECOVERY_REPORT"
```

These shell variable names are operator inputs, not new required worker settings. The tool creates the report exclusively with mode 0600 and prints only its SHA-256, readiness and static issue codes. It does not overwrite an existing report. Reads validate full-account locked financial/payment coverage and provider order associations, not just a selected row. The report retains the exact workflow snapshot revision and proposed continuation/local repairs. Unknown outcomes produce `ready: false`; they cannot be applied.

After reviewing the actual evidence and receiving separately scoped authority for local repair, apply only a ready report less than five minutes old:

```sh
node --import tsx scripts/reconcile_deal_email.ts \
  --message-id "$BFMR_RECOVERY_MESSAGE_ID" \
  --browser-pid "$BFMR_CHROMIUM_PID" \
  --report-file "$BFMR_PRIVATE_RECOVERY_REPORT" \
  --apply --confirm-report-sha256 "$BFMR_REVIEWED_REPORT_SHA256"
```

Apply regenerates provider evidence and requires the same complete plan, account, source and snapshot revision. Provider drift, stale reports, completed/missing/changed Gmail work and an active account owner stop the operation. The transaction can restore an already captured and independently verified order, record explicit cancellation/purchase readbacks, append the repaired workflow snapshot, return only unfinished original work to PENDING (or terminal work to DONE), and resolve **only** email-action incidents scoped to that exact workflow. Queue repair and these local records commit together. No provider mutation is repeated, no historical creation terms/order IDs are guessed, and unrelated or older unscoped incidents remain blocked. A failed/repeated apply cannot rewind the cursor or reopen a completed message.

`CHECKOUT_INTENT` without a saved causal order confirmation, ambiguous creation without exact capture, unconfirmed BFMR writes, missing cancellation rows, unsupported shipment evidence and irreconcilable financial data remain review stops. Obtaining or substantiating missing historical/provider evidence needs separately scoped operator work; the tool has no generic reset or arbitrary order-ID input. Reviewed READY work still needs a separately authorized worker run and all current guards before any remaining new action.

Daily Shipment updates retain their separate exact order/shipment intent ledger and action controls; this email workflow ends at verified BFMR Purchase reporting. No multiple-shipment, replacement/refund or generic notification repair is introduced.

## Acceptance still required

Source and strict script TypeScript checks and whitespace checks cover compilation only. No software tests were added or run for this implementation under `AGENTS.md`'s explicit-request rule. Previous suites/results apply to their own source revisions and do not prove this workflow. Required behavioral cases include identical single-/multi-deal limits and duplicate guards, first-pass barriers, queue tombstones/no backfill, JSONB idempotency, stale snapshot/report rejection, and crash/COMMIT-loss windows before/after every reservation, cart, order and BFMR update boundary. Native role/SQL, provider layout, read-only reconciliation and supervised recovery acceptance remain open.
