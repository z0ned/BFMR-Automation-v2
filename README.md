# BFMR Automation v2

Fresh implementation of the BFMR reservation MVP. The repository includes interactive live test runners and offline orchestration scaffolding. Production PostgreSQL persistence and deployment remain unfinished.

## Authoritative design

Read [Solution Design Specification v1.5](docs/BFMR_Solution_Design_Specification_v1.5.pdf). It supersedes conflicting instructions in earlier BFMR documents. Later explicit instructions from Matt take precedence.

The earlier BFMR codebase is not the starting point. Do not import or migrate it by default.

## MVP 1 behavior

1. Receive a qualifying single new-deal email through Gmail watch and Google Pub/Sub.
2. Open the trusted BFMR deal link in a dedicated authenticated browser and establish the deal identity.
3. Use the My Tracker API to check for an existing active reservation for that deal. Skip if one exists, including a manual reservation or another color.
4. Submit quantity 1 through the BFMR website form using Playwright.
5. Confirm the outcome using My Tracker; reconcile uncertain results before any retry.
6. For a newly confirmed email reservation, check BFMR's suppliers for Amazon. Keep the reservation if Amazon is listed; otherwise cancel that exact reservation and verify release with My Tracker. Unknown supplier evidence or cancellation outcome stops processing and alerts through Telegram.

Any retailer and bundle deal can trigger intake. The Amazon supplier evaluation happens after confirmation; there are no financial, profitability, retailer-stock, email-driven purchase, or one-minute-release checks. Multiple-deal emails and additional-slot notifications are ignored. Live tests make real reservations. A separately authorized, manually invoked one-item Amazon purchase test is not part of email automation or MVP 1. The latest scope is in the [v1.6 addendum](docs/BFMR_Solution_Design_v1.6_Addendum.md); it supersedes older manual-release-only descriptions in the PDFs.

Persist the Gmail history cursor and catch up after downtime, with durable deduplication. The expired-history limitation is documented in the specification and [open issues](docs/OPEN_ISSUES.md).

## Technical direction

- Single Ubuntu host, Node.js and TypeScript.
- Local PostgreSQL for durable intake, queue, attempts and audit records.
- Playwright bundled Chromium in headed mode, with a secured desktop for manual login/MFA.
- Website form submission only; no reservation-creation API or reconstructed HTTP request.
- My Tracker API for duplicate and confirmation reads.
- Pub/Sub pull, outbound connectivity and no public webhook.
- Telegram incidents, local CLI and operational recovery as defined in v1.5.

## Handoff contents

| File | Purpose |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Instructions and boundaries for a coding agent |
| [Design PDF](docs/BFMR_Solution_Design_Specification_v1.5.pdf) | Complete requirements, architecture, contracts and acceptance criteria |
| [Implementation plan](docs/IMPLEMENTATION_PLAN.md) | Milestones and required evidence |
| [Decision register](docs/DECISIONS.md) | Final scope and supersession summary |
| [Open issues](docs/OPEN_ISSUES.md) | Unresolved decisions, integration evidence and setup inputs |

See the implementation plan for offline test evidence and live integration checks. These do not establish production readiness.

## Starting implementation

Ask the coding agent to implement MVP 1 from v1.5 as a fresh project, following AGENTS.md and the implementation plan. Provide required service access securely. Start with the repository bootstrap and offline tests; satisfy the documented evidence gates before live enablement.

The repository contains no credentials, browser profiles or private email/account fixtures. Never paste secrets into issues, chat, commits or test evidence.

## BFMR browser sign-in

The browser wrapper starts headed Chromium with a dedicated persistent profile and loopback remote debugging, then passes the Chromium browser-process PID to the app (not a shell or launcher PID). The app resolves that process's CDP port from its launch arguments (or its profile's `DevToolsActivePort` file when the wrapper uses port `0`), then verifies through CDP that the endpoint belongs to that PID. It does not search for an arbitrary open browser. Pass the PID as `--browser-pid <pid>` after the npm script name, or set `BFMR_CHROMIUM_PID` in the app process environment. For example:

```bash
npm run test-real-email -- --browser-pid 12345
```

The wrapper must supply `--user-data-dir` and `--remote-debugging-port` to Chromium. Keep the CDP endpoint bound to loopback; the app refuses an explicitly non-loopback remote debugging address. A fixed debugging port or `--remote-debugging-port=0` is supported. Use the same wrapped browser for BFMR sign-in and subsequent runs so they share its authenticated profile. The app disconnects from a wrapped browser when it exits; the wrapper owns browser shutdown. Without a PID, the adapter retains its existing standalone-launch behavior for manual local setup.

Complete BFMR login and any MFA directly in the wrapper-opened Chromium window. The sign-in helper never processes an email or submits a reservation. If BFMR expires the session, run the sign-in helper again through the wrapper with the same browser PID.

The email listener loads environment values from `.env` in the repository, then fills unset values from `~/.env.bfmr_automation` or `~/.env`. Google credentials default to `~/.bfmr/gcp-credentials.json` when that file exists and no `GOOGLE_APPLICATION_CREDENTIALS` path is set. Shell-provided variables take precedence.


## Amazon checkout rehearsal

Run `npm run test-amazon-checkout` in an interactive terminal for `https://www.amazon.com/dp/B09JQMJHXY`, quantity one, using Amazon's saved default delivery address. Stop another BFMR test runner first so it releases the persistent Chromium profile. The command runs the usual BFMR startup reservation/confirmation/cancellation, then opens Amazon in another tab of that same browser context. BFMR stays open and both sites retain their sessions in the profile.

The rehearsal opens the requested product first, then checks the cart before adding anything. If the cart cannot be verified, it returns to the product for inspection and logs structural diagnostics. The rehearsal requires an empty active cart or a cart containing only one unit of this product. Other items or uncertain cart contents stop it without cart changes. It adds the product only when needed, proceeds to checkout, and stops at final order review without clicking Place your order or Buy Now. Login/MFA, challenges, address/payment choices and unfamiliar intermediate steps require manual action. Use the saved default address and an existing payment method; do not submit the order. Press Enter at the final terminal prompt to close Chromium. If Amazon conditionally displays its protection offer after Add to cart, the runner clicks the single visible “No thanks” button; if no offer appears, it continues without waiting for a required dialog. If checkout is verified, the runner uses Amazon’s cart sidebar submit control or a uniquely labeled visible “Proceed to checkout” button/link. The cart item remains for inspection.

This is a separate fixed-product rehearsal; automatic email purchasing is not enabled. On 11 October 2026, a live run reached final review and verified the requested product, quantity one and order total; Place your order was not clicked. This confirms the observed account/session flow, not other accounts or future Amazon UI variants.

## Amazon one-item purchase test

The user authorized a separate command-line test for exactly one `Google Fitbit Air - Screenless Activity Tracker, Berry` item (ASIN `B0GTMJF7PV`). It does not run the BFMR startup reservation. The command requires an interactive terminal and a USD total cap, checks that the active cart is empty or contains only one unit of this exact ASIN, and stops on uncertain product, delivery, cart, quantity, order-total, or confirmation evidence. Before submission, it selects and verifies a free delivery option whose option label does not mention Prime; if automatic detection fails, the operator can select it manually and the command rechecks. It opens “Add gift options”, checks “This item is a gift”, and clicks “Save gift options” when the gift editor appears; it waits for secure checkout to return before continuing. It handles up to two visible “Place your order” controls by selecting one enabled control, and accepts repeated order totals only when they agree. It asks the operator to verify the free non-Prime delivery option, saved default delivery address, and payment method, then requires exact `REVIEWED B0GTMJF7PV` and `PLACE B0GTMJF7PV` terminal entries before submitting once. It never retries an uncertain order submission. No email intake path invokes this command.

Example, replacing the value with the operator's chosen USD spending limit:

```bash
npm run test-amazon-purchase -- --max-total <USD-limit>
```

The `--max-total` value is an operator-selected USD limit and must cover the complete displayed order total. If using the Chromium wrapper, also pass `--browser-pid <pid>` after the npm separator. This command performs a real purchase when all checks and both exact terminal confirmations pass.

## Live reservation test startup

The startup reservation exists only to trigger CAPTCHA. After My Tracker confirms it, the app cancels that exact reservation and confirms release before proceeding. Startup never runs the Amazon evaluation. `resume-watch-series-reservation` remains excluded from startup; its recovery target and the dedicated iPad test's target do not run the email-only Amazon evaluation.

Post-confirmation recovery uses `~/.local/state/bfmr/post-reservation.json` (override with `BFMR_POST_RESERVATION_STATE_PATH`). Keep this file across restarts. An uncertain cancellation is reconciled read-only; it never automatically repeats the cancellation POST.

`npm run test-real-email` (also `test-real-email-e2e`) and `npm run test-bfmr-ipad-reservation` now attempt a real quantity-one reservation on every startup: open BFMR Deals and inspect deals in displayed order without selecting a filter, skipping duplicates/unavailable deals and advancing after proved failures until one succeeds. Complete any CAPTCHA directly in Chromium. Startup and subsequent reservations check My Tracker automatically; no CHECK-API prompt is required. The iPad test can create an additional reservation for its original target.

Uncertain startup outcomes stop processing for inspection. Recovery evidence lives in `~/.local/state/bfmr/startup-reservation.json` and its adjacent `.events.jsonl` file (override with `BFMR_STARTUP_STATE_PATH`). Keep that path consistent across restarts. See the [v1.6 addendum](docs/BFMR_Solution_Design_v1.6_Addendum.md) for retry and recovery behavior. Offline tests and sign-in/read-only helpers do not reserve startup inventory.


Live reservation tests require `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the existing local environment configuration. Failed or unconfirmed reservations send a Telegram alert; duplicate/unavailable email skips continue normally. Complete CAPTCHA at startup in Chromium. An unexpected later challenge or uncertain submission stops processing and alerts. Notification delivery failure is logged locally and stops further processing; the live test sender does not persist failed alerts for automatic redelivery.
