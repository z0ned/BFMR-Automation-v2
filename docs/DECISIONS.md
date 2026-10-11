# Decision register

User decisions from 9–10 October 2026. The table includes the latest Amazon evaluation/startup cleanup amendment; dated history below records superseded choices.

| Topic | Final decision |
| --- | --- |
| Starting point | Fresh implementation in this repository; no reuse of the earlier codebase |
| Platform | Ubuntu with Playwright bundled Chromium in headed mode |
| Trigger | A single new-deal email; no required retailer channel in subject |
| Retailers | All retailers accepted at intake; new email reservations are retained only when Amazon is listed as a supplier after confirmation |
| Bundles | Included; quantity 1 refers to the BFMR offer |
| Additional slots / multiple deals | Excluded from MVP 1 |
| Business eligibility | Amazon supplier presence is the first post-reservation evaluation; no financial, stock or profitability checks |
| Duplicate protection | Check My Tracker before reserving; any active reservation for the same deal blocks creation |
| Navigation | Open trusted email deal link directly in dedicated authenticated browser; no mandatory Active Deals API resolution |
| Reservation creation | Playwright website form only; no reservation-creation API |
| Confirmation | My Tracker API |
| Testing | Real reservations in testing and production modes |
| Release | Cancel the confirmed startup CAPTCHA reservation; cancel a new email reservation when Amazon is absent. Other releases remain manual. |
| Purchasing | Outside MVP 1 |
| Downtime | Catch up and process qualifying missed emails using durable cursor and dedupe |

## 10 October 2026 — Amazon checkout rehearsal

Latest checkout clarification (10 October): the user selected `https://www.amazon.com/dp/B09JQMJHXY`, quantity one and Amazon's saved default delivery address for a standalone rehearsal in the same Chromium browser. Stop at the final Place your order screen; actual order submission is explicitly excluded. No email-to-order integration is enabled. The test includes the usual BFMR startup reservation and cancellation.

## 11 October 2026 — one-item Amazon purchase test

Matt explicitly authorized a separate command-line purchase test for exactly one item at `https://www.amazon.com/dp/B0GTMJF7PV` (Google Fitbit Air, Berry). This is not MVP 1 email automation and must not run a BFMR startup reservation. The command requires an interactive terminal, an operator-specified USD order-total limit, confirmation that the saved default delivery address and payment method are selected, and exact ASIN-bound terminal phrases before one final order submission. It checks the final product, quantity, and total; an uncertain submission is never retried. This authorization is limited to this named item and test command.

## 11 October 2026 — gift flag on Amazon purchases

Every Amazon purchase performed by an authorized test must be marked as a gift before submission. For the authorized Amazon Business purchase test, open “Add gift options”, select “This item is a gift”, and click “Save gift options” to return to secure checkout. The final review must accept the gift state before submission.

## 11 October 2026 — free delivery without Prime

For Amazon purchases, select a free delivery option that does not require Prime. Amazon may show multiple delivery options, including Prime-only free delivery and non-Prime free shipping. Select and verify the non-Prime free option before continuing to final order confirmation.

## Superseded intermediate choices

The 10 October Amazon evaluation amendment below reopens only supplier presence and scoped cancellation. The broader financial evaluation and purchasing proposals remain deferred.

The conversation temporarily expanded MVP 1 to reserve, evaluate financial/stock/bundle criteria and cancel failed deals through the cancellation API. The user later removed all eligibility evaluation and restored manual release. Do not implement those intermediate choices.

The final removal of the Amazon-only restriction also removes the need for an API retailer eligibility check. It does not remove the My Tracker duplicate or confirmation checks, or operational safety checks.

## Deferred financial discussion

Page 19 of v1.5 records earlier clarifications: inclusive limits, the mixed exposure calculation, rejected retailer-account and retail-price restrictions, and the temporary zero-extra-charges assumption. None is active MVP 1 scope, and none automatically becomes an approved later-MVP requirement. The exposure treatment of unpurchased reservations was not answered.

## Retained design versus user decisions

The database schema, retry timings, initial Gmail baseline, local CLI and other engineering details are specified in v1.5. Preserve their distinction from confirmed user requirements. In particular, the expired-history recovery limitation remains explicit in `OPEN_ISSUES.md`.

## 10 October 2026 — browser lifetime

User decision: open Chromium when the application starts; reuse that window for all processing and tests; close it only when the application terminates. See [v1.6 addendum](BFMR_Solution_Design_v1.6_Addendum.md). CAPTCHA completion is manual, and reuse does not guarantee BFMR will never challenge again.

## 10 October 2026 — automatic quantity-one authorization

User authorized quantity-one reservations without per-reservation approval. Remove RESERVE-1 from the email runner and iPad live test. Retain preflight/duplicate checks and manual access-challenge completion; CHECK-API remains a readiness prompt after the action.

## 10 October 2026 — BFMR tracked email links

Observed integration format: the forwarded AirPods new-deal email wraps product and footer links in HTTPS `email.mail.buyformeretail.com/c/<token>`. The token is base64url-encoded zlib data containing URL-encoded fields; `l` contains the destination. Node intake decodes this locally with bounded input/output sizes and accepts exactly one `l` field only when its value passes the existing trusted BFMR deal URL validator. No tracker, footer or unsubscribe URL is visited. The browser destination allowlist is unchanged. Unsupported/malformed tokens do not identify a deal. Multiple distinct direct/decoded deal paths prevent single-deal qualification; repeated links collapse.


## 10 October 2026 — live-test startup reservation

Matt corrected “production” to “every test script”: the live reservation test entrypoints (`test-real-email`, its E2E alias and `test-bfmr-ipad-reservation`) perform startup on every invocation. Open `/deals`, click In Stock, reserve quantity one of the first unreserved available deal in displayed order; duplicate/unavailable candidates advance to the next deal. Matt completes CAPTCHA manually in Chromium. Automatically verify startup using My Tracker without CHECK-API and preserve existing conservative retry limits. This startup exception does not add real reservations to offline tests, read-only/sign-in helpers or unfinished-reservation recovery. See the v1.6 addendum for recovery evidence and current live-validation gaps. Normal email post-action CHECK-API remains unchanged.


## 10 October 2026 — remove startup In Stock filtering

Matt explicitly removed In Stock selection. Try the first displayed deal on `/deals` and advance to later displayed deals after duplicates, unavailability or proved failure until My Tracker confirms success. Retain the existing two-submit limit per deal, advance after proved exhaustion, and reconcile uncertain actions before any additional submission. This supersedes the filter selection in the earlier startup decision.


## 10 October 2026 — no CHECK-API; Telegram failures

Matt instructed the app to assume CAPTCHA is completed only at startup, remove CHECK-API and notify him through Telegram if a reservation fails. All live reservation/recovery post-action API checks are now automatic. Startup remains manual CAPTCHA in Chromium; unexpected later challenges stop/alert instead of requiring PAGE-READY in the email/iPad flow. Unknown/unconfirmed outcomes still cannot authorize resubmission. Configured Telegram failure alerts are required for live entrypoints; immediate test-runner delivery is distinguished from the production durable outbox in v1.6.

## 10 October 2026 — first evaluation and disposable startup reservation

User authorized an Amazon supplier check after confirmation of new email reservations, with cancellation when Amazon is absent. Startup is excluded from the evaluation: its reservation is only for CAPTCHA and must always be canceled after confirmation. Unknown supplier/cancellation results stop and alert. User approved testing form encoding for the cancellation API and designated their sole active Fitbit reservation for the live test; exact-ID cancellation and API release verification succeeded. This supersedes the earlier blanket ban on evaluation and cancellation only within this scope; no purchasing or financial/stock evaluation is added. See the addendum for the tested request and recovery rules.

### Amazon login continuation — 10 October 2026

Manual sign-in and MFA happen in Chromium. Detect completion and resume automatically, without requiring Enter in the terminal. Restore the intended cart/product route after login redirects, while preserving the existing no-repeat cart action and no-order-submission constraints.

### 11 October 2026 — Amazon duplicate-order warning

The user explicitly authorized clicking Place your order once more when Amazon presents its duplicateOrder pending-order warning after submission. This continuation requires the recognized route and warning copy, matching product evidence and prices within the confirmed total. It is attempted at most once and never retried after an uncertain click; CVV handling and confirmation/Order # retrieval continue afterwards. This supersedes the blanket one-click restriction only for this recognized warning. No tests or live purchase were run for this change.
