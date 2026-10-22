# Worker action controls

**22 October 2026 — source implementation; provider and operational acceptance pending.**

This implements the action-control step of the project review. The subsequent [shared workflow](SHARED_EMAIL_WORKFLOW.md) implements source single-deal ordering and a narrowly scoped reviewed email repair path. The delivery cutoff, automatic reimbursement intake, deployment and generic operator repair remain separate work. No live workflow, schema installation, database import, notification or provider action was run.

## Checkout and account evidence

The email-driven purchase path requires nonblank `AMAZON_EXPECTED_DELIVERY_FRAGMENT`, an exact four-digit `AMAZON_EXPECTED_CARD_LAST4`, and the runtime’s pinned database-selected retailer-account email before preparing a cart. Missing expectations no longer permit generic address/card matching.

`AMAZON_ACCOUNT_IDENTITY_SELECTOR` must identify exactly one visible **text** field whose normalized complete value equals the runtime’s pinned database-selected retailer-account email. `AMAZON_ACCOUNT_IDENTITY_CONTRACT_VALIDATED=YES` is required. Verify that the field identifies the **active buying account**, including Amazon Business account switching, on product, checkout and order-history layouts. A display name, greeting, hidden input, account-switch candidate or arbitrary occurrence of an email does not establish that contract. No selector is invented by source. If the actual provider exposes no such verified field, this adapter stays blocked until a separately reviewed authoritative proof mechanism is implemented.

Account evidence is checked before cart preparation mutations, at final order authorization, before rejection cleanup, and before an automated CVV continuation. Tracking requires the same account proof on Order History. Missing/ambiguous/mismatching proof stops for review; it does not cancel the BFMR reservation speculatively. Manual fixed-item purchase/rehearsal scope remains separate.

Final authorization rechecks account, expected address/card, intake health and ownership, and commits checkout intent before the click. The submit helper then rechecks the exact checkout line, gift/free-delivery state and total. Guards also cover BFMR reservation/confirmation clicks and Purchase/Shipment/cancellation writes in the active worker. A guard failure after a prior submission remains unresolved; it never grants a retry.

## Cancellation proof

Only one exact reservation/deal row, quantity one, with agreeing status/quantity aliases and explicit `Canceled`/`Cancelled` proves cancellation. A missing row now stops for review, including after a cancellation POST or during recovery. HTTP success, absence, an expired reservation or an unknown status does not substitute for that proof. The cancellation POST remains bounded to one attempt; recovery is read-only. Existing fixtures modeling disappearance as successful release describe the older behavior and require revision when software testing is requested.

## Persistent blocking

`WorkerActionControl` uses the existing append-only `workflow_evidence` store; there is no new SQL schema or legacy-engine aggregate dependency. It records `WORKER_ACTION_CONTROL / BLOCKED` with a static reason and account. Its in-memory latch closes before awaiting persistence. If persistence fails, the current worker still stops; unavailable storage cannot establish durable delivery or restart acceptance.

Email action failures, intake failure, tracking failures, BFMR discrepancies, and maintenance/notification failures block further work. A successful later alert or worker restart does not clear the block. Intake shutdown awaits the failure handler so normal cleanup does not close the database ahead of the block attempt. Independent Gmail admission can continue during a browser pause; the serial browser consumer does not advance/replay interrupted work.

The reader recognizes an append-only `WORKER_ACTION_CONTROL / RESOLVED / REVIEWED` event only for the same account and exact `blocked_event_id`, with a `review_source_sha256`. This is an evidence format, **not a public reset API or authorization**. The narrowly scoped shared-email repair tool can generate resolutions only for exact workflow-scoped email incidents after fresh provider reconciliation and reviewed local repair; it cannot clear generic/unrelated incidents. Review must substantiate provider outcomes, reconcile SQL/journals/pending notifications and retain its actual evidence before any separately authorized repair. A hash alone does not authenticate provider evidence. General report/apply repair tooling and native/provider acceptance remain unfinished; do not edit/delete evidence or invent a resolution to get the worker running.

## Startup and recovery inventory

Before establishing Gmail watch or opening the worker browser, startup checks:

- Recorded unresolved action-control incidents.
- Valid startup snapshot and transition-log presence, post-reservation, multi-deal and daily-status/notification journals. Unfinished startup work is blocked even when the temporary test reservation is disabled.
- Interrupted Gmail `PROCESSING` work, unmatched relational reservation/checkout intents, failed retailer checks and unresolved BFMR Purchase/Shipment intents.
- Existing business cutover/legacy-ledger and Gmail source-hash boundaries, unchanged.

First adoption requires reviewing/restoring/reconciling **all** private stores and explicitly setting `BFMR_ACCEPT_RECOVERY_BASELINE=YES` for that startup only. This accepts observed presence/absence and configured paths into `WORKER_RECOVERY_INVENTORY`; remove the flag afterward. It does not prove that an absent historical file never existed. Do not accept a baseline over missing prior state. This work did not initialize a baseline.

The inventory stores path hashes and presence, without raw journal content. Subsequent startup/finished-work/idle audits reject missing previously observed files, changed paths, corrupt stores or unresolved work/pending alerts. Unchanged inventories do not create repeated rows. The flag cannot override an existing inventory or incident. Preserve inventories, SQL, journals and accepted legacy bytes together during backup/restore; stale but internally consistent backups still require authoritative provider reconciliation and remain an operational acceptance gate.

Proved pre-submission `CLOSED_NO_SLOTS`/`AUTH_REQUIRED` outcomes now retain matching `RESERVATION_CREATION / NO_ACTION` evidence. This avoids mistaking a verified non-submission for an unresolved creation intent. Historical unmatched intents remain review items; they are not silently repaired.

## Verification boundary

Source TypeScript and strict script checks plus whitespace checks were performed; exact results are recorded in the implementation register. No software tests were added or run because this request was implementation-only and `AGENTS.md` requires an explicit testing request. Previous test totals do not cover these changes. The broader script-and-test compiler check is blocked in this workspace by the missing declared `@electric-sql/pglite` dependency and consequent fixture typing errors. Browser selectors, native SQL/control queries, grants, crash/race/restore behavior and integrated alert/recovery paths need separately scoped acceptance.
