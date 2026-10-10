# MVP 1 implementation plan

Baseline: Solution Design Specification v1.5, especially pages 16-18 and 21. M0 project/bootstrap scaffolding is complete. M1 orchestration scaffolding exists, but production-grade durable persistence and the remaining production milestones are unfinished. The “initial handoff” refers to the documentation-only starting repository, not the current working tree.

## M0 Establish the fresh project [COMPLETED]

- Read the baseline, decisions and open issues. Fresh implementation without legacy code.
- Pinned supported Node.js 22, TypeScript 5.7, Vite 6.2, Playwright and PostgreSQL 16 schema.
- Established project structure (`src/db`, `src/domain`, `src/adapters`, `src/orchestrator`, `tests`), reproducible scripts (`npm test`, `npm run typecheck`, `npm run build`, `npm run dev`), package-lock, and non-secret `.env.example`.
- Documented adapter interfaces (`IGmailAdapter`, `IMyTrackerAdapter`, `IBrowserAdapter`, `ITelegramAdapter`) and safe local configuration.
- Captured implementation evidence index keyed by AT/G IDs.

Completion evidence:
- Setup verified on clean checkout: `npm test`, `npm run typecheck`, and `npm run build` pass cleanly.
- Zero secrets tracked in Git.

## M1 Orchestration scaffolding [PARTIAL]

- Added PostgreSQL schema/migration and TypeScript interfaces as scaffolding. The current `src/db/database.ts` implementation stores state in process-local Maps and uses an in-process lock; it is not a PostgreSQL-backed database and does not provide ACID transactions, cross-process ownership, or restart durability.
- Added an in-memory orchestration model for the T1–T6 transaction boundaries, retry/review states, duplicate checks, and notification gating. These are simulated state transitions, not durable commits around real provider side effects.
- Added fake Gmail, My Tracker, browser, and Telegram adapters for offline testing. Fake-adapter coverage verifies modeled invariants only; it does not prove provider behavior, persistence, or crash recovery.

Scaffolding evidence:
- `tests/m1_orchestration.test.ts` exercises the in-memory model and its failure cases.
- The earlier 11-test result is historical scaffolding evidence, not acceptance of production M1. Current required M1 work remains: implement and migrate the PostgreSQL store; make T1–T6 atomic and durable; implement cross-process singleton ownership; prove restart recovery, cursor preservation, and Telegram outbox behavior against PostgreSQL; then record the resulting test and migration evidence.
- No production PostgreSQL persistence or live BFMR operation is established by this scaffolding.

## M2 Gmail and Pub/Sub intake

- Implement watch renewal, StreamingPull, persistence before ACK, serialized history reads and email classification.
- Preserve cursor across restart; perform startup/reconnect continuation. Keep watch baseline separate from consumption cursor.
- Support both subject families, direct/testing-forward sender policy and single-deal classification.
- Treat expired/missing established cursor as an explicit fault; no silent reset or Inbox sweep.

Exit criteria: AT-01/02, AT-06/07 and intake portions of AT-13 pass. G-002 fixtures and G-004 recovery evidence are recorded.

## M3 Validate BFMR read contracts

- Implement dedicated authenticated browser navigation and stable deal/offer identity extraction.
- Implement My Tracker read adapter with secure credentials, verified account alignment and complete date/pagination handling.
- Validate bundles, color variants, duplicate detection and reported reservation visibility/release behavior using sanitized evidence.
- Resolve documented contract gaps from actual observations; do not guess field names or guarantees.

Exit criteria: AT-04/20/22 and read portions of G-001 pass. Record which live claims remain unproven and prevent unsafe submission/retry paths from using them.

## M4 Reservation and operational controls

- Implement one-unit website-form submission, reconciliation, one proved-failure retry and review/exhaustion blocks.
- Implement Telegram acceptance/recovery gates and local status/review/reprocessing CLI.
- Accept arbitrary retailers and bundles at intake. Apply the 10 October post-confirmation Amazon supplier evaluation to email reservations, cancel when Amazon is absent, and cancel confirmed startup CAPTCHA reservations. No purchasing or other financial/stock checks are approved.
- Complete offline side-effect failure tests, then designated real reservation tests under the documented gates.

Exit criteria: AT-03, AT-08 to AT-18, AT-20, AT-22/23 pass with appropriate offline/live evidence; G-001 and relevant G-005 records are complete.

## M5 Ubuntu deployment and acceptance

- Package service startup, exclusive process-group shutdown, headed Chromium desktop access, secure configuration and logs.
- Implement off-host encrypted backups, restore procedure, disk/watch monitoring and operator runbook.
- Demonstrate reboot, login/MFA recovery, Telegram failure and stale-backup reconciliation.
- Assemble the complete acceptance report and identify any unresolved limitations before enabling unattended operation.

Exit criteria: AT-19/21, G-003 and G-005 pass; all applicable acceptance IDs are accounted for. No acceptance item is marked complete solely from a narrative claim.

## Progress updates

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

Added the Node-only `bfmrEmailLinks` intake parser for the E2E runner, other email scripts, and orchestration engine. It decodes the observed BFMR tracking format locally and passes only validated direct deal destinations to the shared parser. The shared parser now counts distinct deal paths, rejects multi-deal bodies, and collapses repeated direct/decoded links. Skip logs distinguish unsupported/missing trusted links from nonqualifying subjects. The frontend parser remains free of Node compression dependencies.

Read-only evidence: the actual forwarded AirPods email now returns `isSingleDeal=true`, `isMultiDeal=false` and the direct BFMR deal URL. Only Gmail reads were made; no tracking URL, browser form or reservation endpoint was called. No raw email, recipient metadata or tracking token was saved to the repository or diagnostic output. Synthetic fixtures cover product plus navigation/unsubscribe links, forwarded subject, quoted-printable soft wrapping, repeated links, multiple distinct deals, exclusions, malformed/oversized tokens and unsafe/lookalike destinations. `node --import tsx --test tests/**/*.test.ts`: 36/36 pass. `npm run build`, explicit runner TypeScript checking, and `git diff --check` pass. Other tracking encodings remain unsupported; this is not proof of all email templates or production intake readiness.

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

Evidence: full offline suite initially passed 52/52; subsequent targeted startup checks cover manual challenge completion and the finalized immediate/10s/30s API checks. Build, project TypeScript and explicit live-entrypoint TypeScript checks pass. Synthetic Chromium verifies In Stock selection and resulting deal order. No live reservation scripts were run for validation. Actual BFMR filter markup and manual CAPTCHA/startup confirmation remain pending live acceptance; account alignment and production durability gaps remain open.


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
