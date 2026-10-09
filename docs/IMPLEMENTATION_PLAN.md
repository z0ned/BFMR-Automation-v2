# MVP 1 implementation plan

Baseline: Solution Design Specification v1.5, especially pages 16-18 and 21. All milestones below are **not started**. There is no production code in the initial handoff.

## M0 Establish the fresh project [COMPLETED]

- Read the baseline, decisions and open issues. Fresh implementation without legacy code.
- Pinned supported Node.js 22, TypeScript 5.7, Vite 6.2, Playwright and PostgreSQL 16 schema.
- Established project structure (`src/db`, `src/domain`, `src/adapters`, `src/orchestrator`, `tests`), reproducible scripts (`npm test`, `npm run typecheck`, `npm run build`, `npm run dev`), package-lock, and non-secret `.env.example`.
- Documented adapter interfaces (`IGmailAdapter`, `IMyTrackerAdapter`, `IBrowserAdapter`, `ITelegramAdapter`) and safe local configuration.
- Captured implementation evidence index keyed by AT/G IDs.

Completion evidence:
- Setup verified on clean checkout: `npm test`, `npm run typecheck`, and `npm run build` pass cleanly.
- Zero secrets tracked in Git.

## M1 Durable orchestration and ownership [COMPLETED]

- Implemented database migrations (`001_initial_schema.sql`), schema types (`src/db/schema.ts`), and transactional engine (`src/db/database.ts`) with ACID guarantees and rollback on error.
- Implemented singleton advisory lock for single browser/account worker ownership (`acquireSingletonLock`).
- Implemented durable Gmail cursor persistence (`consumed_history_id`), email deduplication, and OQ-001 boundary enforcement (stops intake on expired cursor).
- Implemented transaction boundaries T1 through T6:
  - T1: Inbound event receipt committed before ACK; duplicate events deduplicated.
  - T2: History batch consumption, email classification, AUTO command queuing, atomic cursor advancement.
  - T3: Attempt preparation, gate validation, duplicate check in My Tracker, attempt pre-allocation, SUBMITTING commit before click.
  - T4: Outcome handling, bounded uncertainty (stops auto-retry, creates REVIEW deal block, alerts Telegram), strict max 2 submit ordinals (ordinal 2 retry on 500, EXHAUSTED on second failure, zero ordinal 3).
  - T5: Operator review resolution (`resolveReviewIncident`) and current-run email reprocessing (`reprocessEmail`) with fresh 2-attempt budget.
  - T6: Notification outbox dispatch with `TELEGRAM_BLOCKED` gate enforcement on failure and clearing on success.
- Implemented offline fake adapters (`FakeGmailAdapter`, `FakeMyTrackerAdapter`, `FakeBrowserAdapter`, `FakeTelegramAdapter`).
- Verified offline side-effect failures and invariants via automated test suite `tests/m1_orchestration.test.ts`.

Completion evidence:
- Test command: `npm test` (11/11 tests passing):
  - AT-01: Valid Pub/Sub delivery is durably stored before ACK; duplicate delivery deduplicated.
  - AT-05: Singleton worker lock prevents concurrent execution.
  - AT-04 & AT-05: Existing reservation in My Tracker skips creation; failed read transitions to WAIT_STATUS.
  - AT-08 & AT-14: Submit timeout results in UNCERTAIN, halts automatic retry, opens review block, alerts Telegram.
  - AT-09: Maximum two submit ordinals per command; second failure enters EXHAUSTED with zero ordinal 3.
  - AT-11 & AT-18: Notification failure halts new deal work via TELEGRAM_BLOCKED; successful send clears gate.
  - AT-10: Operator review resolution and explicit current-run replay.
  - OQ-001 (Page 6): Expired Gmail cursor halts intake with GMAIL_HISTORY_GAP instead of unauthorized sweep.
  - AT-15: Restart in RETRY_PENDING preserves ordinal 2 only; terminal EXHAUSTED is not re-enqueued.
  - AT-16 & AT-17: Quantity invariant strictly enforces quantity=1 and rejects illegal quantity writes.
  - AT-19: Database/lock loss halts execution and prevents concurrent browser instances.
- Zero live BFMR calls or real reservations made.

## M2 Gmail and Pub/Sub intake

- Implement watch renewal, StreamingPull, persistence before ACK, serialized history reads and email classification.
- Preserve cursor across restart; perform startup/reconnect continuation. Keep watch baseline separate from consumption cursor.
- Support both subject families, direct/testing-forward sender policy and single-deal classification.
- Treat expired/missing established cursor as an explicit fault; no silent reset or Inbox sweep.

Completion evidence: AT-01/02, AT-06/07 and intake portions of AT-13 pass. G-002 fixtures and G-004 recovery evidence are recorded.

## M3 Validate BFMR read contracts

- Implement dedicated authenticated browser navigation and stable deal/offer identity extraction.
- Implement My Tracker read adapter with secure credentials, verified account alignment and complete date/pagination handling.
- Validate bundles, color variants, duplicate detection and reported reservation visibility/release behavior using sanitized evidence.
- Resolve documented contract gaps from actual observations; do not guess field names or guarantees.

Completion evidence: AT-04/20/22 and read portions of G-001 pass. Record which live claims remain unproven and prevent unsafe submission/retry paths from using them.

## M4 Reservation and operational controls

- Implement one-unit website-form submission, reconciliation, one proved-failure retry and review/exhaustion blocks.
- Implement Telegram acceptance/recovery gates and local status/review/reprocessing CLI.
- Include arbitrary retailers and bundles without business eligibility evaluation. Add no cancellation or purchasing path.
- Complete offline side-effect failure tests, then designated real reservation tests under the documented gates.

Completion evidence: AT-03, AT-08 to AT-18, AT-20, AT-22/23 pass with appropriate offline/live evidence; G-001 and relevant G-005 records are complete.

## M5 Ubuntu deployment and acceptance

- Package service startup, exclusive process-group shutdown, headed Chromium desktop access, secure configuration and logs.
- Implement off-host encrypted backups, restore procedure, disk/watch monitoring and operator runbook.
- Demonstrate reboot, login/MFA recovery, Telegram failure and stale-backup reconciliation.
- Assemble the complete acceptance report and identify any unresolved limitations before enabling unattended operation.

Completion evidence: AT-19/21, G-003 and G-005 pass; all applicable acceptance IDs are accounted for. No acceptance item is marked complete solely from a narrative claim.

## Progress updates

For each milestone record status, commit, commands run, test outcomes, sanitized fixture references, remaining gaps and any changed design decision. Keep this file current as implementation proceeds. Consult v1.5 for detailed test assertions; the milestone grouping does not replace them.
