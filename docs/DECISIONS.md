# Decision register

## 21 October 2026 — command-line application scope

The maintained application consists of Node.js/TypeScript automation entrypoints, backend services, PostgreSQL repositories and offline regression tooling. Operate through the documented scripts with their exact account/financial/provider gates. npm and `package-lock.json` define dependencies. The shared intake parser and its message types remain available to the backend; synthetic adapter implementations remain confined to testing. This scope update changes no provider authority or installed database.


## 21 October 2026 — maintain schema and application in one repository

The user requested moving the schema, migrations and design notes into `BFMR-Automation-v2`. `database/` is now the authoritative location, preserving the four SQL/design files byte for byte from `BFMR_DB_Schema` main at `a67a0715ef040b0dd65de17ce63a0a5e34898699`. The database guide records original hashes and upgrade boundaries. Tests default to the local module-relative schema and retain the reviewed hash check; no second checkout is needed. Historical engine migrations remain distinct. The former repository is retained for history; this request does not archive/delete it or apply SQL to an installed database.


## 21 October 2026 — align v22 documentation with the adopted schema and integration

The v22 design and implementation references now describe the existing **16-table** `BFMR_DB_Schema/schema.sql` contract plus the reviewed immutable-payout guard, matching the user's integration request. Actual columns, `deal_retailers`, reservation/payment-email reimbursements, single-record cardinalities, lookup mappings, evidence boundaries, SQL examples and ERD supersede the earlier 15-entity conceptual illustrations. This changes documentation to reflect already authorized/source-implemented choices; it adds no purchase scope, schema migration or provider authority. Source paths, 23/23 focused relational regressions and the aggregate 141-pass/one-native-PostgreSQL-skip evidence retain their recorded offline limits. The current v22 design PDF is refreshed from the Markdown; older versions remain unchanged.


## 20 October 2026 — implement relational business persistence

The user authorized using the existing `BFMR_DB_Schema/schema.sql` fields/relationships as the business persistence contract, connecting the runner and tracking/reconciliation services, preserving creation terms, integrating actual payments and complete-coverage exposure, and providing controlled cutover source. The implementation is described in [RELATIONAL_INTEGRATION.md](RELATIONAL_INTEGRATION.md). It does not redesign the schema or adopt the older v22 order-linked multiple-payment illustrations: reimbursement is directly linked to the reservation, with at most one actual payment row.

Account ownership, startup schema/guard and retailer-account validation, a matching cutover marker/source hash, independent deal-rate evidence, and conflict retention remain required. Operational cursor/work/retry/alert stores and the legacy JSONB engine compatibility path remain explicit separate stores. Unknown legacy creation terms are never filled from today's deal payout, and import never replays provider effects.

Evidence class: source implementation and user-authorized offline validation, recorded 21 October 2026: 141 passed, zero failed, one native PostgreSQL case skipped across 142 distinct tests; final focused relational cases passed 23/23 using disposable PGlite and canonical guarded schema. TypeScript and whitespace checks passed. System Chromium 154 browser fixtures do not prove live or bundled-browser behavior. Exact commands, schema hash and boundaries are in `RELATIONAL_INTEGRATION.md`. Final review aligned import/runtime automation scope and blocks inconsistent supported order/shipment states before cutover acceptance. No live provider or production database was invoked and no actual migration/cutover/deployment was performed. The current request changes persistence, not live authority, single-deal purchase scope or the independent 14-day delivery-cutoff gap. Earlier decision/evidence entries below retain their original dates and limitations; their untested-guard/source-only status is superseded only by this bounded offline evidence.

## 20 October 2026 — fixed reservation payout; no dedicated history table (D22-03)

The user's decision is that `RESERVATION_HISTORY` is not needed. Expected payout is fixed when a reservation is created and never changes for that reservation. Payout changes belong to the deal and apply only to future reservations: a deal change from $80 to $95 leaves an existing one-unit reservation at $80 and gives a subsequently created one-unit reservation $95. Preserve the creation-time financial snapshot; with the current generated quantity-times-rate formula, protect its inputs against edits that recalculate the locked total. Retain conflicting provider observations for review rather than silently updating the reservation.

This supersedes the dedicated table and payout-evolution requirements inherited from D20-13; the active v22 target now has 15 tables. D22-02's 16-table count below describes that earlier decision point. Existing JSON/status journals and provider/workflow evidence remain implementation facts and are not removed. See [v22 design](BFMR_Solution_Design_Specification_v22.md#3-approved-design-decisions-and-v22-amendments) and [implementation amendment](BFMR_Implementation_v22..md#14-reservation-payout-decision--20-october-2026-d22-03). Database enforcement is pending because the existing generated payout formula does not lock writable inputs. This records a user decision only; no code, migration, software test, provider action or production acceptance changed.

## 20 October 2026 — reservation payout guard source (D22-03 follow-up)

Schema change: [BFMR_DB_Schema draft PR #1](https://github.com/z0ned/BFMR_DB_Schema/pull/1), source commit `a67a0715ef040b0dd65de17ce63a0a5e34898699`.

Guard source has been added to `BFMR_DB_Schema/schema.sql` and `BFMR_DB_Schema/migrations/20261020_reservation_payout_immutability.sql`. `public.reject_reservation_payout_change()` checks final `NEW` versus `OLD` `quantity` and `payout_per_item` with `IS DISTINCT FROM` in an `AFTER UPDATE` row trigger enabled `ALWAYS`; a change raises SQLSTATE `23514`. Updates retaining both inputs remain allowed, and the generated expected-payout expression is unchanged.

Evidence class: source implementation only, superseding the pending-guard source status above. No software tests were added or run; the SQL has not been applied or tested, and no database, provider, or deployed runtime changed. Authoritative creation-term ingestion, provider-conflict review, and legacy creation-evidence reconciliation remain pending; retained observations and workflow evidence must not be discarded.

## 20 October 2026 — one shipment and tracking number per order (D22-02)

The user's approved assumption is one shipment and one tracking number per order. An order may have zero or one shipment before shipping; every recorded shipment belongs to exactly one order and has one required `tracking_number` and `shipping_company`. Store both directly on `SHIPMENTS`, with `SHIPMENTS.order_id NOT NULL UNIQUE` referencing `ORDERS.id`. Tracking numbers are not globally unique. The separate `ORDER_TRACKING` table and its one-to-many tracking-reference relationship are retired from the v22 target model, which now has 16 tables.

D22-02 extends D22-01. Multiple distinct provider shipments or tracking numbers must be preserved as review evidence rather than silently selected, merged, overwritten, or discarded. Existing package-array code and journals are implementation facts; this documentation amendment does not change code, run a migration, or authorize a provider action.

## 19 October 2026 — v22 order–shipment cardinality (D22-01)

The user's approved business rule is a one-to-one relationship between orders and shipments: an order may have zero or one shipment before shipping, and each stored shipment belongs to exactly one order. The target constraint is `SHIPMENTS.order_id NOT NULL UNIQUE` with a foreign key to `ORDERS.id`. This supersedes the earlier v20/v22 multiple-shipment target. See [v22 design specification](BFMR_Solution_Design_Specification_v22.md#3-approved-design-decisions-and-v22-amendments) and [v22 implementation reference](BFMR_Implementation_v22..md#13-current-v22-amendment--19-october-2026).

This is a documentation/target-design change only. Existing package-array journals, application code, database migrations, and provider acceptance remain unchanged; migration must retain multiple-shipment observations as review exceptions rather than silently merge or discard them.

## Controlling decisions as of 12 October 2026

This section controls when earlier entries below conflict. Current implementation and evidence details are in the [v22 implementation reference](BFMR_Implementation_v22..md), alongside the [v22 solution design](BFMR_Solution_Design_Specification_v22.md).

- **Multiple new deals:** accept an unambiguous body-announced multi-deal email with distinct trusted deal links. Reserve quantity one once for every deal before checking eligibility. Bundles remain one BFMR offer. Additional-slot notices and unsupported roundups remain excluded.
- **Sender provenance:** direct BFMR sender in production. `matt.ward@live.com` only in explicit `BFMR_INTAKE_MODE=testing`. Both require trusted Gmail authentication evidence.
- **Identity and duplicates:** exact canonical API deal ID, not title fallback. Any recognized open reservation for that ID blocks another reservation. Newly created confirmation separately requires one exact reservation ID, Reserved status and quantity one. Unknown state blocks.
- **Supplier and cancellation:** after new reservation confirmation, check the BFMR supplier list for Amazon. A confirmed failure of that check cancels only the exact new reservation and verifies release. Unknown supplier/cancel results stop. Startup CAPTCHA reservations are confirmed and then canceled, without supplier evaluation.
- **Amazon purchase policy for the approved multi-deal path:** one item/quantity one; maximum total $100; payout >= complete Amazon order total; existing unpaid BFMR expected payouts plus proposed Amazon total <= $200. Check gift, free non-Prime delivery, saved address/payment, exact line and total immediately before submission. Rule failures cancel only the exact new BFMR reservation; uncertainty blocks retry. Do not connect arbitrary email/product types to purchase.
- **Separate fixed-item Amazon purchase:** exact `B0GTMJF7PV` test command, interactive cap <= $100 and explicit Y/N approval. The user reported one successful purchase-to-Order-# flow. This is not authority for another item or automatic email linkage. `B09JQMJHXY` remains a no-submit rehearsal product.
- **Order identity/tracking:** use Order # from the thank-you page caused by the current submission. No history-first-match fallback. Daily Amazon Orders check after 03:00 `America/New_York`; BFMR tracking updates use exact reservation and verified Purchase/Shipment readback.
- **Durable operations:** PostgreSQL aggregate transactions and account-scoped session advisory lock exist. Live queue, batch, Amazon ledger and BFMR status journals are private JSON and remain separate. First queue creation is explicit; lost cursors/uncertain effects are not reset or blindly replayed.
- **No challenge bypass:** login/MFA/CAPTCHA remains manual. Keep secrets and private account material out of logs and Git.

## 12 October 2026 - review hardening details


## Historical decisions (retained for traceability)

Entries below record the decisions made on 9-11 October and earlier intermediate choices. Apply the controlling section above wherever an older entry says multiple-deal mail is excluded, Amazon purchasing is excluded, or status/tracking work is deferred. Older decisions remain useful for stable boundaries such as website-only BFMR reservation creation, quantity one, trusted URLs, manual access challenges, exact cancellation and the dedicated fixed-product test.

### 11 October - multiple-deal Amazon workflow

The user authorized multi-deal BFMR email processing, one reservation for each deal, then eligibility checks, Amazon ordering under the limits listed above, and cancellation of rule failures. Existing unpaid BFMR payout plus proposed Amazon cost is the cumulative exposure basis. The default delivery address and card are configured in Amazon. Uncertainty stops for review.

### 12 October - BFMR purchase and tracking API code

The user requested code to update the exact BFMR reservation with the retailer Order # and shipment tracking number. The code records a Purchase, then a Shipment linked to its purchase ID, and confirms each by exact My Tracker readback. No live write test was performed during the review fix.

### 12 October - daily retailer tracking and BFMR reconciliation

The user requested a daily Amazon retailer check and a daily My Tracker official-status comparison that updates local state and alerts on discrepancies. Run after 03:00 Atlanta local time so daytime deal processing has priority. Exact Order # matching is required.

### 12 October - Amazon identity and checkout corrections

Order ID must originate in the confirmation for the submission that just occurred; old identical history entries must not be selected. Final checkout must show exactly one product line, expected ASIN, quantity one.

### 11 October - fixed item purchase and Amazon checkout rules

The fixed-item purchase test is restricted to ASIN `B0GTMJF7PV`; the user explicitly reported success for one live purchase under a <=$100 cap. Gift and free non-Prime delivery are required. The independent checkout rehearsal for `B09JQMJHXY` stops at final review. A recognized Amazon duplicate-order warning continuation was approved once within the active fixed-item flow.

### 10 October - BFMR baseline changes retained

Fresh implementation; BFMR reservation creation through normal website form; My Tracker read-only duplicate and confirmation checks; quantity one; all retailer types and bundles accepted; direct trusted detail navigation; startup CAPTCHA reservation for designated live test entrypoints followed by exact cancellation; manual login/MFA/CAPTCHA. These entries supersede the v1.5 baseline only where the user explicitly changed behavior.

### Superseded financial discussion

Earlier proposed evaluation/cancellation rules were at one point withdrawn, then later explicitly restored in the scoped multiple-deal Amazon workflow. Do not treat the broad historic discussion as additional criteria: only the exact cap, payout comparison, $200 exposure basis and cancellation rule in the controlling section apply. The unsettled contract details remain release gates.
