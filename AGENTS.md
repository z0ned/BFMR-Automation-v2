# BFMR Automation v2 agent instructions

## Authority and project status

- This is a fresh implementation. Do not copy, import or migrate the earlier BFMR codebase unless Matt explicitly changes that instruction.
- Read `docs/BFMR_Solution_Design_Specification_v1.5.pdf`, `docs/DECISIONS.md`, `docs/IMPLEMENTATION_PLAN.md` and `docs/OPEN_ISSUES.md` before implementing.
- Later explicit user instructions take precedence over repository documents. The v1.5 PDF is authoritative over these summaries. If a real conflict remains, identify it rather than silently choosing.
- The initial repository contains documentation only. Do not claim code, tests, provider contracts or deployment are complete from the existence of this handoff.
- When asked to implement, progress through the milestones and maintain evidence. Routine engineering choices may be made and documented; do not invent business requirements or provider guarantees.

## Preserve MVP 1 scope

- Single new-deal email -> trusted BFMR browser navigation -> My Tracker duplicate check -> website quantity-one reservation -> My Tracker confirmation.
- Accept all retailers and bundles at intake. After a new email reservation is confirmed, check the exact reservation's supplier list for Amazon; cancel that reservation when Amazon is absent. Unknown supplier evidence stops/alerts, never implies absence. Quantity 1 is one BFMR offer, not one unit of each bundle component.
- Ignore multiple-deal mail and additional-slot notifications. Retailer channel in the subject is not required.
- The 10 October evaluation amendment allows the Amazon supplier check and scoped automatic cancellation. The startup CAPTCHA reservation is always canceled after confirmation, without Amazon evaluation. No other financial/stock/purchase or timed-release behavior is approved. Successful email reservations listing Amazon remain for Matt to manage.
- Both testing and production reserve real inventory. Automated offline tests use fake adapters; do not confuse those with the deployed testing mode.
- Preserve Gmail cursor and unfinished work across restarts; catch up on downtime mail. Never restore the old receipt-time cutoff or overwrite the saved cursor when renewing the watch.

## External effects and correctness

- The 10 October Amazon checkout rehearsal permits preparing quantity one of B09JQMJHXY in the same Chromium context with the saved default Amazon address. Stop at final order review; never click Place your order, Buy Now, or a subscription control. No automatic purchasing or email-to-order integration is authorized by this rehearsal.

- Use Playwright's normal BFMR website form actions to reserve. Do not reconstruct reservation requests, call undocumented mutation endpoints or implement an API write fallback.
- My Tracker API reads must be complete and validated. Missing pages, failed reads and unknown shapes never prove absence.
- Cancellation is allowed only for an exact newly confirmed reservation ID (or an explicitly designated manual test). Use the documented HTTPS reservation-cancellation endpoint with form encoding, journal intent, and verify release by exact ID through complete My Tracker reads. Do not retry an uncertain cancellation POST or cancel pre-existing duplicate reservations.
- Validate email provenance, expected account/deal identity and trusted URL/redirect destinations. These safety checks remain required despite the removal of business eligibility checks.
- One account worker and browser owner; durable attempt record before a possible click. Reconcile uncertain outcomes before retry. At most two submit ordinals per command, as specified.
- Real test reservations require the designated test context and documented pre-live gates. This documentation bootstrap itself grants no instruction to operate live BFMR accounts.
- Stop for manual login/MFA or access challenges. No challenge bypass, stealth or anti-bot evasion.

## Engineering and evidence

- Use the Ubuntu, Node.js/TypeScript, local PostgreSQL and bundled headed Chromium architecture in v1.5. Pin supported versions after verifying compatibility.
- Keep business logic independent of Gmail, My Tracker, Playwright and Telegram adapters so failure cases can be tested offline.
- Maintain stable FR/OPS/CON/INT/SEC/DATA and AT/G identifiers. Record which tests and fixtures prove each implemented slice.
- Prioritize durable dedupe, cursor/queue transactions, safe recovery and external contract validation before live operation.
- Record unresolved integration facts honestly. A passing fake-adapter test does not prove BFMR behavior.
- Update the implementation plan as work completes. Record consequential design changes and their effect on requirements/tests. Do not reopen settled scope merely because an old source disagrees.
- No repository-specific build or test command exists initially. Add a reproducible setup and meaningful checks as implementation is introduced.

## Secrets and repository hygiene

- Keep credentials, OAuth material, browser profiles, cookies, raw email/account pages, database dumps and runtime state out of Git and logs.
- Keep BFMR API keys server-side and out of browser headers/context. Use secure local secret references.
- Only commit synthetic or sanitized fixtures after checking them for reusable secrets and personal account data.
- Do not publish traces/screenshots containing account information. Do not assume `.gitignore` sanitizes an archive.
- Preserve the versioned v1.5 PDF. Create a new design version for material changes rather than silently altering the baseline.
