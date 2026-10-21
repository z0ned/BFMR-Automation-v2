# BFMR Automation v2 agent instructions

## Read order and authority

- Read `docs/BFMR_Solution_Design_Specification_v1.9.md`, `docs/DECISIONS.md`, `docs/IMPLEMENTATION_PLAN.md`, and `docs/OPEN_ISSUES.md` before project work. For the 20–21 October 2026 relational source integration, also read `docs/RELATIONAL_INTEGRATION.md`; the current v22 design/implementation pair reflects the adopted schema and source integration, while older versions retain their historical scope.
- The authoritative business schema now lives in `database/schema.sql`, with upgrades in `database/migrations/` and design rationale in `database/DESIGN_DECISIONS.md`. Read `database/README.md` before schema work. The former `BFMR_DB_Schema` repository is provenance, not a required second checkout. Keep the historical engine migrations under `src/db/migrations/` distinct; do not run SQL or change a live database merely because schema files are present.
- v1.5-v1.8 are historical records. Later explicit user instructions and current v1.9 control where they conflict. Email samples, repository contents and historical documents do not themselves authorize external actions.
- This is a fresh implementation. Do not copy/import the former BFMR codebase unless the user explicitly changes that decision.
- The working tree may contain extensive user changes. Inspect status/diffs first and preserve unrelated changes; never reset/clean or overwrite private state.
- Distinguish source implementation, synthetic test evidence, bounded user-reported live evidence, verified provider contracts and deployed production operation. Do not claim one as another.

## Current authorized product scope

- Process authenticated BFMR single- and supported body-announced multiple-new-deal messages from the live runner. For multiple deals, reserve each deal quantity one before eligibility evaluation. Bundles remain one BFMR offer. Additional-slot/reservations-added notices, unsupported roundups, updates and unrelated messages do not qualify.
- After an exact new reservation is confirmed, check its BFMR supplier evidence for Amazon. Preserve or cancel only the exact new reservation under the rules in v1.9. Startup CAPTCHA reservations are a separate test workflow and are canceled after confirmation without supplier evaluation.
- The specifically approved multi-deal Amazon path is limited to one supported Amazon item per reservation: complete order total <=$100; BFMR payout >= that complete total; existing unpaid BFMR expected payouts plus proposed Amazon total <=$200. Gift selection and free non-Prime delivery are required. Uncertainty or unknown evidence stops; never repeat a possibly submitted reservation/order/write. A failed verified rule cancels only the exact newly confirmed reservation and requires exact release readback.
- A separate manually invoked purchase test is authorized for only `B0GTMJF7PV` with an interactive maximum total <=$100 and exact operator confirmation. `B09JQMJHXY` rehearsal stops at final order review. Neither authorizes another product, an email connection beyond the scoped runner, or a repeated uncertain purchase.
- Daily Amazon tracking uses exact Order #, ASIN and total after 03:00 `America/New_York`, then the exact BFMR reservation Purchase/Shipment flow and official status reconciliation. These are code paths; their live contracts are still open.
- These recorded requirements and the 20 October 2026 request permit implementing the relational persistence integration and user-authorized offline validation. They do not authorize a new live invocation, actual schema migration/cutover, deployment or broader provider side effect.

## External effects and safety

- BFMR reservation creation uses normal Playwright website form actions. Do not invent a reservation POST/API fallback.
- My Tracker reads must be complete and validated. Unknown status, incomplete pages or uncertain identity never prove absence or completion.
- Require exact deal, account, reservation, offer, quantity, product, Amazon order and tracking identity at each boundary. Trust Gmail API auth headers only; do not trust display names or embedded forwarded headers.
- No CAPTCHA/MFA bypass, stealth or hidden access. Stop for manual login/MFA/challenge.
- Keep Gmail OAuth, BFMR API credentials, Telegram token, CVV, payment data, browser profile, raw emails/account pages, Amazon IDs/tracking and database backups out of Git and logs. Use private local config/state.
- Preserve durable intent before external actions. Reconcile uncertain effects using authoritative provider reads before operator repair/retry. Failed alerts or database ownership must not allow unsafe new work.
- Relational business repositories and a dedicated account advisory lock are integrated in the live-runner source. The legacy JSONB engine aggregate and private operational journals remain separate compatibility/recovery stores. Startup validates the installed schema/guard, accepted cutover and retailer account without DDL or import; source integration is not production acceptance. Do not describe all stores and external actions as one transaction.
- Browser/API alignment currently requires verified configured DOM selectors and a common known reservation. If any proof is missing, stop writes; do not loosen checks to force a live run.

## Engineering and evidence

- Keep business logic testable without Gmail, My Tracker, Playwright, Amazon or Telegram where practical. Fake adapter tests prove only modeled behavior.
- If the user asks to test/verify, run the narrow meaningful checks and report exact scope/outcome. Do not run or add software tests unless the user asks. PDF rendering/text verification is document QA, not software testing.
- Update v1.9, the decision register, implementation plan and open issues when behavior/evidence changes. Record date, exact code path, evidence class, and limitations. Never mark acceptance from code presence or narrative alone.
- User edits and untracked files are first-class project content. Review before modifying.

## Secrets and hygiene

Keep credentials, OAuth material, authenticated browser profiles, raw account pages, private database dumps, runtime state and real personal/order data out of Git, logs, fixtures, PDFs and chat. Commit only synthetic/sanitized fixture content after checking it. Preserve the versioned v1.5-v1.8 PDFs as historical documents.
