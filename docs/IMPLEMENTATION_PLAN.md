# MVP 1 implementation plan

Baseline: Solution Design Specification v1.5, especially pages 16-18 and 21. All milestones below are **not started**. There is no production code in the initial handoff.

## M0 Establish the fresh project

- Read the baseline, decisions and open issues. Do not import legacy code.
- Select and pin supported Node.js, TypeScript, Playwright and PostgreSQL versions.
- Establish application structure, dependency lockfile, reproducible setup, tests and non-secret configuration examples.
- Document adapter interfaces and secure local service setup. Capture an implementation evidence index keyed by AT/G IDs.

Completion evidence: clean-checkout setup and documented build/type-check/test commands work; no runtime secrets are tracked.

## M1 Durable orchestration and ownership

- Implement migrations, cursor persistence, email dedupe, command/attempt state machine, incidents and notification outbox.
- Enforce single browser/account ownership, transaction boundaries T1-T6 and durable retry budgets.
- Use fake adapters to prove crashes, duplicates, failed writes and uncertain effects.

Completion evidence: relevant AT-01, AT-05, AT-08/09, AT-14 to AT-19 scenarios pass offline. No browser submission is required for this milestone.

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
