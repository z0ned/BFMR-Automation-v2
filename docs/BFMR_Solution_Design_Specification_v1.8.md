# BFMR Automation - Solution Design Specification v1.8

> **Historical and superseded:** compiled 11 October 2026, before the 12 October review fixes and v1.9 update. Use `BFMR_Solution_Design_Specification_v1.9.md` and `.pdf` for current requirements and code state. This file remains unchanged beyond this status notice for traceability.

Compiled 11 October 2026. Part I current-state source. Part II of the PDF preserves v1.7 in full.

## 1. Solution Design Specification v1.8

### Purpose and snapshot

Complete continuation handoff for a new LLM. Compiled 11 October 2026, Europe/London, from v1.7, the current working tree, project records and the user-reported live Amazon results. Repository: /home/wardmatt/bfmr-automation/BFMR-Automation-v2. This is a fresh implementation; do not import the previous BFMR codebase.

### Read order and authority

Read this current-state guide first. It resolves superseded descriptions in the historical appendix. Later explicit user instructions control. Retain the detailed v1.5 requirement IDs and acceptance gates embedded in the preserved v1.7; apply the dated changes here when they conflict. Source code establishes implemented behavior, not permission to perform a live action. This document itself does not authorize another purchase, reservation or cancellation.

### Where we are

The standalone Amazon purchase CLI has now completed the observed flow: quantity one of B0GTMJF7PV, gift, selected free non-Prime delivery, $99.99 order total, terminal Y confirmation, duplicate-order warning continuation, confirmed placement, navigation to Orders and Order # capture. The user subsequently reported: "It worked." This is user-run live evidence for the observed account/session and product, not a fresh automated acceptance run.

### Production status

M0 bootstrap is complete. M1 remains scaffolding: the database implementation uses process-local Maps and an in-process lock. Durable PostgreSQL orchestration, restart-safe Gmail cursor/queue, cross-process ownership and a durable Telegram outbox remain unfinished. M2-M5 are not complete. The UI contains simulated state and does not prove production execution.

### Document structure

Part I contains 13 pages of controlling current state, operating rules, implementation details, evidence and continuation guidance. Part II preserves every page of v1.7, including the v1.6/v1.5 baseline and original project records. Historical pages are visibly marked. Older product-first navigation, subject-based intake, no-PID attachment and blanket no-purchase statements are superseded only as described in Part I.

## 2. BFMR email and startup behavior

### Email reservation path

Validate provenance/account and qualify one new-deal email from body content and trusted deal-detail links. Open the trusted BFMR destination in authenticated Chromium. Perform a complete My Tracker duplicate check, reserve quantity one through the normal website form, then confirm the exact reservation using complete My Tracker reads. All retailers and bundles are accepted at intake; one means one BFMR offer, not one of every bundle component.

### Post-reservation Amazon supplier evaluation

For that exact newly confirmed email reservation, retain it if validated supplier evidence lists Amazon. If complete evidence proves Amazon absent, cancel only that new reservation and verify release by exact ID. Unknown or conflicting evidence stops and alerts; never interpret it as absence. Successful Amazon-listed reservations remain for Matt to manage. Purchasing is not connected to email intake.

### Startup CAPTCHA reservation

test-real-email and its E2E alias, test-bfmr-ipad-reservation and test-amazon-checkout run the designated startup flow. Read /deals in displayed order without In Stock filtering; skip duplicates/unavailable candidates and advance only after proved failure under bounded retry rules. Confirm quantity one automatically, cancel the exact startup reservation and verify release. Startup is excluded from supplier evaluation. test-amazon-purchase, auth helpers and Watch recovery do not run startup.

### Stop, skip and recovery rules

Duplicates, explicit full/closed/no-slots and explicit Deal not found are normal skips that allow email listening to continue. Unknown API results, wrong identity/quantity, unexplained listing redirects, ambiguous title, unexpected challenges and uncertain submissions stop for review. Manual CAPTCHA/login/MFA only. No CHECK-API prompt remains. Failure alerts use Telegram; failed alert delivery stops processing. Immediate live-test alerts are not the production outbox.

### Reservation and cancellation safety

BFMR reservation creation uses website form actions only. My Tracker reads must be complete and validated. At most two reservation submit ordinals are allowed only with definitive non-creation evidence and fresh duplicate checks. Journal uncertain attempts and reconcile before any replay. Cancellation uses the documented HTTPS endpoint with form encoding, journaled intent and exact-ID release verification; never retry an uncertain cancellation POST.

## 3. Chromium ownership and local configuration

### Exact browser attachment is now implemented

The browser wrapper may launch headed Chromium with a dedicated profile and loopback remote debugging, then pass the actual browser-process PID using --browser-pid <pid> or BFMR_CHROMIUM_PID. The adapter inspects /proc/<pid>/cmdline and exe, requires a recognized Chromium executable, --user-data-dir and --remote-debugging-port, and refuses an explicitly non-loopback debugging address. It does not discover and choose an arbitrary open browser.

### Endpoint and identity checks

A fixed debugging port is supported. With port 0, read the profile DevToolsActivePort file. Connect over http://127.0.0.1:<port>, call CDP SystemInfo.getProcessInfo and require the returned browser PID to equal the supplied PID. Require a browser context and reuse the first persistent/default context. A shell/launcher PID is not acceptable. The code exists; no new live PID-attachment validation was performed during this handoff.

### Fallback and ownership

Without a PID, launchPersistentContext retains standalone behavior. CHROMIUM_PROFILE_PATH overrides the default ~/.config/bfmr/chromium-profile. The purchase CLI forces headed mode. Retailer tabs share the authenticated context with BFMR. App-owned Chromium is closed through context shutdown; a CDP-attached browser is disconnected through the adapter while the wrapper owns browser lifetime. Do not assume the CLI close prompt terminates wrapper-owned Chromium.

### Environment loading

scripts/loadEnv.ts loads BFMR_ENV_FILE, repository .env, ~/.env.bfmr_automation, then ~/.env; existing values win and later files fill unset values. It may set GOOGLE_APPLICATION_CREDENTIALS to ~/.bfmr/gcp-credentials.json when unset. Gmail uses GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN; BFMR uses BFMR_EXPECTED_ACCOUNT, BFMR_API_KEY, BFMR_API_SECRET; Telegram uses TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.

### Local state and secrets

Startup state defaults to ~/.local/state/bfmr/startup-reservation.json, overridden by BFMR_STARTUP_STATE_PATH. Post-reservation state defaults to ~/.local/state/bfmr/post-reservation.json, overridden by BFMR_POST_RESERVATION_STATE_PATH. These journals are not PostgreSQL. Never include secret values, cookies, profiles, raw private emails or account screenshots in Git or handoff artifacts. AMAZON_DEFAULT_CARD is a secret CVV value, not a full card number.

## 4. Body-only email classification and sample coverage

### Latest parser rule

The subject is header metadata only. It must not determine message type, deal count, retailer, bundle status, product title or offer details. The same body must produce the same interpretation regardless of subject. A NEW DEAL subject cannot turn an update or slot notice into a new-deal trigger. This supersedes older subject-family eligibility descriptions.

### Implemented recognition

emailParser.ts strips scripts/styles and HTML markup into readable body text, normalizes whitespace and some entities, and recognizes the body phrase "we posted a new deal". It excludes recognized payout/update/reservations-added language. It detects multi-deal announcements, counts/roundups and additional-slot language. New template language outside these recognized patterns can still be missed; do not claim arbitrary semantic understanding.

### Trusted link handling

Extract HTML href and plain-text URLs, decode supported BFMR tracking links locally through bfmrEmailLinks.ts, validate the destination with bfmrUrl.ts, and require exactly one distinct trusted deal-detail path. Collapse repeated links to the same path. Multiple distinct paths block single-deal qualification. Never visit unsubscribe, footer or tracking URLs as a navigation fallback. The supported tracker payload is bounded base64url/zlib data with exactly one trusted l destination.

### Offer fields

Retailer comes only from an explicit body Retailer field, not a subject or product brand. Product title can come from the body hyperlink text or supported body copy. Bundle detection and prices use body evidence. Website identity/title/quantity preflight remains required before a real reservation; parser output does not replace it.

### Samples and evidence boundary

docs/sample_emails/from_bfmr contains 25 rendered PDF examples across new_deal, multiple_new_deals, all_open_deals, deal_update, reservations_added, pay_out and other; deal_closing currently has no PDF. No retailer email PDFs are present. tests/fixtures/bfmr_email_samples.ts contains sanitized synthetic derivatives; tests/bfmr_email_samples.test.ts covers category boundaries and subject invariance. File existence is not a fresh passing test result. Rendered emails do not prove raw MIME authentication/provenance or complete template coverage.

## 5. Separate purchase CLI and cart-first preparation

### Scope and command

The manually invoked purchase CLI is scripts/test_amazon_purchase.ts, exposed as npm run test-amazon-purchase -- --max-total 100.00. It is restricted to https://www.amazon.com/dp/B0GTMJF7PV, Google Fitbit Air - Screenless Activity Tracker, Berry, exactly one unit. It performs no BFMR reservation or startup cleanup and must not be connected to email automation. The terminal must be interactive. A cap is required, positive, at most two decimals and no greater than $100 USD.

### Cart-first sequence is controlling

Open https://www.amazon.com/gp/cart/view.html first. Require verified EMPTY cart evidence before navigating to the product or adding anything. Existing target items also block startup. Unknown/nonempty carts stop without removing, editing or replacing existing items. Remain on the cart for inspection. This supersedes product-first navigation and reuse of an existing quantity-one target cart line.

### Product and add evidence

After confirming empty, navigate to the direct product URL, verify ASIN and read the visible product title (with fixed-ASIN fallback when needed). Require one primary Add to cart control and form evidence for the exact ASIN and quantity 1. Add at most once. A timeout or uncertain add is not permission to add again; reopen and inspect the cart. Require exactly the target line and quantity one after addition.

### Conditional protection and access

If a unique visible No thanks protection-offer control appears, dismiss it; never accept a protection plan or subscription. Login/MFA/access challenges are completed manually in Chromium. The bounded login wait resumes automatically after completion and restores the requested route without repeating cart mutations. Address/payment or unfamiliar checkout steps can require manual completion through the terminal continuation prompt.

### Shared helper impact

runAmazonCheckoutRehearsal is shared with test-amazon-checkout. The latter still targets B09JQMJHXY, runs BFMR startup cleanup and stops at final review. The latest empty-cart-first requirement applies to shared preparation for both commands. Historical rehearsal success that reused an existing cart item does not override this new sequence.

## 6. Gift options and free non-Prime shipping

### Cart-level gift flag

Find "This order contains a gift" in the cart. Amazon overlays a decorative icon on the native checkbox; use its associated label, then verify the native checkbox is checked. If no associated visible label exists, the implemented fallback invokes the native input click. Wait two seconds, verify it is still checked, then proceed to checkout. Missing, ambiguous, disabled or unchecked gift controls stop the flow.

### Save the gift editor

When Amazon opens /gift or shows Choose gift options/Save gift options, complete the editor before asking for purchase approval. Select "This item is a gift" when exposed. Amazon Business can show two Save gift options buttons; either is acceptable by the user requirement, while the implementation chooses the lowest enabled visible control. Click once, then wait for the editor/save controls to disappear and an enabled Place your order control to return. Do not request confirmation while still on /gift.

### Gift evidence implementation

ensureAmazonGiftSelected carries successful gift preparation in a page-scoped WeakSet after saving or another accepted gift path; amazonGiftSelected can also inspect a checkbox or explicit gift text. This is session evidence, not persistent proof across restart and not independently audited final gift data. Keep the editor-closed and secure-review guards.

### Select and verify free delivery

Choose a visible delivery radio whose associated option label explicitly says free shipping/delivery and does not mention Prime. A surrounding single-radio option block may supply the label. Never accept a Prime trial or Prime-only shipping. Verify both checked radio state and order-summary shipping evidence; do not assume clicking succeeded.

### Shipping summary and timing

Accepted evidence is shipping $0, shipping free, or a positive shipping charge exactly offset in cents by free-shipping credits. Item-plus-tax arithmetic alone is insufficient. Poll selection/summary up to 60 times at 500 ms intervals. Missing/disabled/free-Prime-only options or unverified summary stop submission. The historical $106.98 total exposed the earlier assumption; the successful observed final total was $99.99.

## 7. Final review and financial safeguards

### Review must be secure and complete

readAmazonOrderReview requires a checkout or gp/buy route, no gift editor or Save gift options controls, and an enabled final order control. Check target ASIN link or matching visible title, explicit/widget quantity evidence all equal to one, unambiguous positive USD order total, gift evidence and selected free non-Prime shipping. The CLI requires three consecutive matching final-review reads, separated by 500 ms, before presenting approval.

### Duplicate display controls

Amazon Business may show two visible Place your order controls and repeat Order total. Up to two final buttons are accepted; only one enabled control is chosen. Repeated total displays must agree in cents. Reject inconsistent amounts, unsupported currency evidence or missing totals. Do not count duplicate displays as separate orders.

### Exact approval interface

Ask "Do you want me to <ACTION>?" and accept Y or N (case-insensitive, trimmed). Other input repeats the question. ACTION describes exactly one named product, selected free non-Prime delivery, gift, saved default address/payment and the displayed USD total. N stops without submission. The CLI asks the operator to visually confirm the saved address/payment; it does not programmatically prove their identity.

### Immediate pre-click recheck

submitAmazonOrderOnce re-reads the final review with gift and free non-Prime requirements. Require a valid integer-cent cap no greater than 10000, current total within that cap and current total exactly equal to the total approved by the user. Missing limits or a changed total block submission. Do not rely solely on the earlier printed summary.

### Separate authorization from documentation

A new LLM must not run a purchase merely because this PDF documents a successful test. The current request is documentation only. When a live run is requested, preserve terminal approval. The duplicate-warning continuation described next is the narrowly authorized exception to a blanket one-click rule; it does not allow generic order retries, a second unit or another ASIN.

## 8. Duplicate warning, CVV and confirmation waiting

### Submission state

Attempt the primary final order click once. Then observe Amazon for confirmation for up to 60 seconds, polling about every 500 ms; helper actions may consume part of that interval. Read the path and normalized visible body from one DOM snapshot to avoid mixing navigation states. Transient destroyed-context reads can be retried as observations. Recognize Amazon Business "Your order on behalf of ... has been placed" as well as supported ordinary order-confirmation wording.

### Recognized pending-order continuation

Amazon may navigate to /checkout/.../duplicateOrder and display "This is a pending order" plus "You placed an order for these items recently. Do you want to place the same order again?" The user explicitly authorized clicking Place your order on this screen once. Require that route and copy, matching ASIN or normalized product title before a pipe-separated description, no conflicting visible product ASIN, displayed positive prices no greater than the approved total, and exactly one enabled button/link with the exact label.

### Wait for readiness, never consume an attempt early

The route can arrive before text/product/button rendering. Missing pre-click evidence returns without clicking and allows another read within the deadline. Mark the continuation attempted only when an action is attempted. After a successful click, keep observing; do not require departure within 1.5 seconds and do not click the warning again. This exception is for Amazon asking to repeat a recently purchased item, not proof that an uncertain previous order failed.

### CVV continuation

Only after a recognized visible CVV/CVC/security-code input appears, use AMAZON_DEFAULT_CARD if it is exactly 3 or 4 digits. Require one field, its containing form and one enabled supported submit control. Never print the value. Suppress fill/read errors that might contain it. Attempt completion at most once. Presence of this code does not establish that every Amazon CVV variant is supported or live-validated.

### Uncertainty rule

After a timed-out/uncertain action, observe only for confirmed placement: no generic retry and no additional purchase continuation. If still unconfirmed at the deadline, return UNCERTAIN, exit code 2 and instruct the operator to inspect Orders before any rerun. Confirmation on a recognized thank-you route can succeed without a visible title because that page may show only the product image.

## 9. Returns and Orders, Order # and browser retention

### Navigate only after confirmed placement

When submission returns PLACED, retrieveAmazonOrderId clicks the visible Returns & Orders / Returns and Orders link, falling back to a#nav-orders. Validate HTTPS amazon.com destination, credentials/port absence, and an approved order-history path. Supported routes are /gp/css/order-history and /your-orders/orders. The thank-you URL purchaseId is not the Amazon Order # and must not be used as one.

### Read the matching order section

On Orders, traverse visible product links in display order, expected newest first. Match the purchased ASIN or exact normalized product title. Ascend from that product only to an enclosing section containing Order placed and exactly one distinct Order # matching three digits, seven digits, seven digits. Never borrow an ID from a neighboring section containing another order. Require the section Total to equal the user-approved total in cents.

### Result and failure

Poll extraction up to 20 times with 500 ms waits while on the approved Orders route. Return the matched ID and print "[Amazon purchase test] Order #: <id>". The ID is currently returned/displayed, not durably persisted or written into BFMR. Lookup failure must not lead to another purchase; the order may already be placed. Generic exceptions use STOPPED and exit code 1, even after successful placement, so read preceding confirmation messages.

### Runtime fix that enabled success

A user-run flow reached Orders but failed with page.evaluate ReferenceError: __name is not defined. A local normalization function inside the callback was transformed by tsx/esbuild into a helper-dependent named function; that helper was absent in the browser. Removed the local function and normalized inline. Keep browser evaluation callbacks self-contained. Following this change the user reported successful completion.

### Screenshot and close behavior

In finally, keep Chromium available for inspection and ask "Do you want me to close Chromium after you finish your screenshot?" Y calls browser.close(); N or a prompt error leaves it open and does not repeat the close question. Close manually when finished. For wrapper-owned CDP mode, adapter close disconnects rather than shutting the wrapper browser. Terminal confirmation and browser lifetime are separate from order outcome.

## 10. What has been demonstrated and what has not

### Earlier BFMR and rehearsal evidence

The project records user-run BFMR startup confirmation, exact startup cancellation and release verification. The AirPods rehearsal reached final review without submitting an Amazon order. A separately designated exact-ID cancellation test was verified against My Tracker. These are bounded observations, not validation of every supplier schema, account, bundle or provider failure mode.

### Latest purchase evidence, 11 October 2026

The user supplied a final review showing Google Fitbit Air Berry, quantity 1, selected gift, selected free non-Prime delivery and $99.99 total against a $100 cap, followed by terminal y. A later log showed the duplicate-warning continuation clicked once, Amazon placement confirmed, and navigation to Orders. Extraction then hit the __name runtime error. After the inline-normalization fix, the user stated "It worked. Nice job!" Treat the full purchase-to-Order-# flow as user-reported success.

### Historical automated evidence

The implementation plan records 71/71 offline tests for the earlier evaluation/cancellation slice, and earlier counts such as 59/59 for preceding slices. Historical TypeScript/build/diff checks are recorded there. These counts are dated evidence, not the result for the final current tree. No tests, typecheck, build or live action were run during these later Amazon fixes or PDF preparation. Do not describe the new safeguards as freshly regression-tested.

### Failures corrected during iteration

Gift checkbox interception: associated label plus checked-state verification and two-second delay. Gift screen left unsaved: explicit Save and secure-review wait. Shipping left charged: radio and summary verification. Order placed but UNCERTAIN: bounded post-submit wait with normalized Business wording. Pending-order route arrived before controls: poll pre-click evidence without consuming the action. Wrong first page: enforce empty cart before product navigation. Orders navigation succeeded but extraction crashed: remove browser-side helper dependency.

### Evidence privacy

The screenshots/logs establish observed behavior but include private account/order details. This handoff intentionally omits real order numbers, delivery addresses, personal/account names and raw screenshots. Refer to sanitized fixtures for future tests. No commit, merge, deployment or production acceptance is implied by document generation.

## 11. Source map and manual operating commands

### Primary Amazon files

scripts/test_amazon_purchase.ts: fixed-ASIN CLI, cap parsing, Y/N prompt, final review, submission, Order # output and close prompt. src/services/amazonCheckoutRehearsal.ts: trusted Amazon navigation, cart inspection, gift, shipping, quantity/total evidence, pending-order/CVV handlers, confirmation wait and history extraction. scripts/test_amazon_checkout.ts: separate no-purchase rehearsal with startup cleanup. src/adapters/playwrightBrowser.ts: PID attachment, standalone persistent launch, trusted BFMR actions, shared retailer tabs and shutdown ownership.

### BFMR services

startupReservation.ts and startupJournal.ts: ordered startup and recovery. bfmrTrackerApi.ts and automaticConfirmation.ts: complete API evidence and polling. amazonEvaluation.ts, postReservation.ts, reservationCancellation.ts and postReservationJournal.ts: supplier decision, exact-ID cancellation and recovery. reservationAlerts.ts: immediate Telegram alerts. browserSession.ts: lifecycle and serial email session. bfmrEmailLinks.ts, emailParser.ts, bfmrUrl.ts, visibleDealTitle.ts and dealAvailability.ts: qualification and page evidence. These paths are under src/services/.

### Scaffolding and tests

src/db/database.ts uses Maps; schema.ts and migrations/001_initial_schema.sql are design scaffolding. src/orchestrator/engine.ts models orchestration; src/services/orchestrator.ts and UI components contain demo state. tests/amazon_checkout.test.ts and amazon_purchase_test.test.ts contain earlier synthetic purchase/rehearsal coverage; they may need updates for current cart-first and submission-limit contracts. Other tests cover tracker, URL/link parsing, sample emails, startup, alerts, evaluation, lifecycle and visible titles.

### Commands; do not execute from this document alone

Live purchase: npm run test-amazon-purchase -- --max-total 100.00. Optional wrapper attachment: append --browser-pid <actual-browser-pid>. Live email: npm run test-real-email (test-real-email-e2e is an alias). Other live scripts: test-bfmr-ipad-reservation, test-amazon-checkout, resume-watch-series-reservation. Setup: auth-bfmr, auth-gmail. Read/inspection helpers: inspect-tracker-api, debug-email, wait-for-email. Offline: npm test. Project checks: npm run typecheck and npm run build.

### Runtime versions and check coverage

package.json currently declares Playwright ^1.64.0, tsx ^4.23.15, TypeScript ^5.7.3, Vite ^6.2.0 and React ^19.0.0. Read package-lock.json for installed resolution; ranges do not prove a pinned runtime. Node 22/PostgreSQL 16 remain the design baseline. tsconfig.json includes src only, so npm run typecheck does not by itself check scripts/ or tests/. Explicit script/test checking is needed when validation is requested.

## 12. Known limits and production milestones

### Amazon limitations to preserve honestly

Current review evidence uses broad visible DOM text and limited quantity heuristics; it does not structurally prove every possible cart/shipment layout. Gift state can depend on a page-scoped marker. Free shipping identification depends on explicit labels and supported summary wording. Duplicate-warning price checks are not an independent full order-total re-verification. CVV recognition supports only the implemented field/form variants. Preserve the cap and approved review; do not broaden purchase scope to compensate for unknown UI.

### Order association and durability

Orders extraction assumes displayed newest-first order and matches product plus total. It has no pre-purchase order-ID baseline, no timestamp-bound correlation and no explicit cancelled-order filter. Another purchase of the same item at the same total can be ambiguous; current code should not be presented as a guaranteed reconciliation system. There is no durable Amazon attempt/Order # journal, no safe resume-only command and no automatic BFMR-to-Amazon order linkage.

### Gmail and persistence gap

Production requirements preserve established cursor/unfinished work and catch up across downtime. The current live email test instead captures a fresh pre-startup Gmail history baseline each invocation and polls; pre-baseline mail is excluded by that test. Do not equate it with completed production Pub/Sub or restart-safe intake. If an established cursor expires, preserve the gap, alert and stop; no silent reset or Inbox sweep. Bounded recovery scanning remains a user decision.

### M1-M5 next implementation

M1: implement PostgreSQL-backed storage, migrations, T1-T6 transactions, cross-process singleton, durable dedupe/cursor/queue and Telegram outbox; prove crash/restart behavior. M2: production watch renewal/StreamingPull with persistence before ACK. M3: complete provider/account/deal/form and pagination evidence. M4: integrate approved reservation controls/recovery with the durable store. M5: service startup, backups/restore, disk/watch monitoring, access recovery and acceptance report.

### Other inconsistencies and boundaries

README and historical decisions still contain older product-first/cart-reuse and exact-phrase confirmation descriptions; this Part I states the current code and user-approved rules. AGENTS.md contains some bootstrap-era wording. The standalone adapter launch also still includes an AutomationControlled-related flag despite the stated no-stealth policy; this was observed, not altered or approved by this document. Resolve that inconsistency in a separately scoped code change. Retain EV-001/002/003 and OQ-001 gaps rather than declaring them closed.

## 13. Instructions for the next LLM and historical appendix

### Start safely

Read Part I, AGENTS.md, docs/DECISIONS.md, docs/IMPLEMENTATION_PLAN.md and docs/OPEN_ISSUES.md, then inspect the current git status/diff. The working tree has multiple pre-existing modified and untracked files from ongoing work. Preserve them; do not reset, clean, overwrite unrelated changes or infer a clean committed baseline. This handoff includes no commit SHA as a release claim.

### Testing preference and live authorization

The user instructed: do not add or run tests unless asked to test/verify. No code tests are authorized by the request to generate this PDF. PDF rendering/extraction is artifact QA only. A request for changes authorizes implementation within that scope, not a live purchase. Do not place orders, reserve/cancel inventory or send external messages merely to validate documentation. A live purchase still requires the fixed product/cap and terminal Y.

### If a run is already uncertain

Read the preceding terminal messages before deciding whether failure occurred before or after submission. If placement succeeded but Order # extraction failed, investigate Orders read-only; do not rerun the full purchase CLI. After any uncertain order action, reconcile manually in Amazon Orders before another live attempt. The pending-order continuation is allowed only for the recognized screen within the authorized active flow, once; it is not permission to replay a previous run.

### Priorities when further work is requested

Preserve the working purchase flow and keep it isolated from MVP 1 intake. If asked to verify, update meaningful synthetic coverage for empty-cart startup, gift-save gating, shipping summary, cap/confirmed-total recheck, pending warning readiness, delayed confirmation, CVV redaction and Order # extraction under the actual tsx runner. Improve durable order correlation only under an approved scope. Resume PostgreSQL/production milestones before claiming unattended readiness.

### Part II: complete preserved v1.7

The following 61 pages reproduce v1.7 in full so the detailed v1.5 architecture, FR/OPS/CON/INT/SEC/DATA requirements, AT/G acceptance gates, schemas, T1-T6 boundaries, retry timings and dated records remain available in this single PDF. They are historical material, not a second current-state controller. Outer page labels identify historical pages; their original page numbers remain for traceability. Resolve older statements using this Part I and later explicit user decisions.

### Source and maintenance record

Primary inputs: docs/BFMR_Solution_Design_Specification_v1.7.pdf; docs/Overview.txt; README.md; AGENTS.md; DECISIONS.md; IMPLEMENTATION_PLAN.md; OPEN_ISSUES.md; current Amazon/browser/parser code; user-provided logs and final success report. Editable Part I source is saved as docs/BFMR_Solution_Design_Specification_v1.8.md. Preserve v1.5, v1.6 and v1.7 unchanged. This document generation records the latest result without changing application behavior.
