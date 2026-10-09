# Decision register

Final user decisions from 9 October 2026. This is a summary of v1.5, not a substitute for it.

| Topic | Final decision |
| --- | --- |
| Starting point | Fresh implementation in this repository; no reuse of the earlier codebase |
| Platform | Ubuntu with Playwright bundled Chromium in headed mode |
| Trigger | A single new-deal email; no required retailer channel in subject |
| Retailers | All retailers; Amazon-only restriction withdrawn |
| Bundles | Included; quantity 1 refers to the BFMR offer |
| Additional slots / multiple deals | Excluded from MVP 1 |
| Business eligibility | No financial, stock, profitability or retailer-eligibility evaluation |
| Duplicate protection | Check My Tracker before reserving; any active reservation for the same deal blocks creation |
| Navigation | Open trusted email deal link directly in dedicated authenticated browser; no mandatory Active Deals API resolution |
| Reservation creation | Playwright website form only; no reservation-creation API |
| Confirmation | My Tracker API |
| Testing | Real reservations in testing and production modes |
| Release | Entirely manual; no one-minute or failed-eligibility release |
| Purchasing | Outside MVP 1 |
| Downtime | Catch up and process qualifying missed emails using durable cursor and dedupe |

## Superseded intermediate choices

The conversation temporarily expanded MVP 1 to reserve, evaluate financial/stock/bundle criteria and cancel failed deals through the cancellation API. The user later removed all eligibility evaluation and restored manual release. Do not implement those intermediate choices.

The final removal of the Amazon-only restriction also removes the need for an API retailer eligibility check. It does not remove the My Tracker duplicate or confirmation checks, or operational safety checks.

## Deferred financial discussion

Page 19 of v1.5 records earlier clarifications: inclusive limits, the mixed exposure calculation, rejected retailer-account and retail-price restrictions, and the temporary zero-extra-charges assumption. None is active MVP 1 scope, and none automatically becomes an approved later-MVP requirement. The exposure treatment of unpurchased reservations was not answered.

## Retained design versus user decisions

The database schema, retry timings, initial Gmail baseline, local CLI and other engineering details are specified in v1.5. Preserve their distinction from confirmed user requirements. In particular, the expired-history recovery limitation remains explicit in `OPEN_ISSUES.md`.
