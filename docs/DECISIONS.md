# Decision register

## 20 October 2026 — fixed reservation payout; no dedicated history table (D22-03)

The user's decision is that `RESERVATION_HISTORY` is not needed. Expected payout is fixed when a reservation is created and never changes for that reservation. Payout changes belong to the deal and apply only to future reservations: a deal change from $80 to $95 leaves an existing one-unit reservation at $80 and gives a subsequently created one-unit reservation $95. Preserve the creation-time financial snapshot; with the current generated quantity-times-rate formula, protect its inputs against edits that recalculate the locked total. Retain conflicting provider observations for review rather than silently updating the reservation.

This supersedes the dedicated table and payout-evolution requirements inherited from D20-13; the active v22 target now has 15 tables. D22-02's 16-table count below describes that earlier decision point. Existing JSON/status journals and provider/workflow evidence remain implementation facts and are not removed. See [v22 design](BFMR_Solution_Design_Specification_v22.md#3-approved-design-decisions-and-v22-amendments) and [implementation amendment](BFMR_Implementation_v22..md#14-reservation-payout-decision--20-october-2026-d22-03). Database enforcement is pending because the existing generated payout formula does not lock writable inputs. This records a user decision only; no code, migration, software test, provider action or production acceptance changed.

## 20 October 2026 — one shipment and tracking number per order (D22-02)

The user's approved assumption is one shipment and one tracking number per order. An order may have zero or one shipment before shipping; every recorded shipment belongs to exactly one order and has one required `tracking_number` and `shipping_company`. Store both directly on `SHIPMENTS`, with `SHIPMENTS.order_id NOT NULL UNIQUE` referencing `ORDERS.id`. Tracking numbers are not globally unique. The separate `ORDER_TRACKING` table and its one-to-many tracking-reference relationship are retired from the v22 target model, which now has 16 tables.

D22-02 extends D22-01. Multiple distinct provider shipments or tracking numbers must be preserved as review evidence rather than silently selected, merged, overwritten, or discarded. Existing package-array code and journals are implementation facts; this documentation amendment does not change code, run a migration, or authorize a provider action.

## 19 October 2026 — v22 order–shipment cardinality (D22-01)

The user's approved business rule is a one-to-one relationship between orders and shipments: an order may have zero or one shipment before shipping, and each stored shipment belongs to exactly one order. The target constraint is `SHIPMENTS.order_id NOT NULL UNIQUE` with a foreign key to `ORDERS.id`. This supersedes the earlier v20/v22 multiple-shipment target. See [v22 design specification](BFMR_Solution_Design_Specification_v22.md#3-approved-design-decisions-and-v22-amendments) and [v22 implementation reference](BFMR_Implementation_v22..md#13-current-v22-amendment--19-october-2026).

This is a documentation/target-design change only. Existing package-array journals, application code, database migrations, and provider acceptance remain unchanged; migration must retain multiple-shipment observations as review exceptions rather than silently merge or discard them.

## Controlling decisions as of 12 October 2026

This section controls when earlier entries below conflict. Full implementation and evidence details are in [Solution Design Specification v1.9](BFMR_Solution_Design_Specification_v1.9.md).

- **Multiple new deals:** accept an unambiguous body-announced multi-deal email with distinct trusted deal links. Reserve quantity one once for every deal before checking eligibility. Bundles remain one BFMR offer. Additional-slot notices and unsupported roundups remain excluded.
- **Sender provenance:** direct BFMR sender in production. `matt.ward@live.com` only in explicit `BFMR_INTAKE_MODE=testing`. Both require trusted Gmail authentication evidence.
- **Identity and duplicates:** exact canonical API deal ID, not title fallback. Any recognized open reservation for that ID blocks another reservation. Newly created confirmation separately requires one exact reservation ID, Reserved status and quantity one. Unknown state blocks.
- **Supplier and cancellation:** after new reservation confirmation, check the BFMR supplier list for Amazon. A confirmed failure of that check cancels only the exact new reservation and verifies release. Unknown supplier/cancel results stop. Startup CAPTCHA reservations are confirmed and then canceled, without supplier evaluation.
- **Amazon purchase policy for the approved multi-deal path:** one item/quantity one; maximum total $100; payout >= complete Amazon order total; existing unpaid BFMR expected payouts plus proposed Amazon total <= $200. Check gift, free non-Prime delivery, saved address/payment, exact line and total immediately before submission. Rule failures cancel only the exact new BFMR reservation; uncertainty blocks retry. Do not connect arbitrary email/product types to purchase.
- **Separate fixed-item Amazon purchase:** exact `B0GTMJF7PV` test command, interactive cap <= $100 and explicit Y/N approval. The user reported one successful purchase-to-Order-# flow. This is not authority for another item or automatic email linkage. `B09JQMJHXY` remains a no-submit rehearsal product.
- **Order identity/tracking:** use Order # from the thank-you page caused by the current submission. No history-first-match fallback. Daily Amazon Orders check after 03:00 `America/New_York`; BFMR tracking updates use exact reservation and verified Purchase/Shipment readback.
- **Durable operations:** PostgreSQL aggregate transactions and account-scoped session advisory lock exist. Live queue, batch, Amazon ledger and BFMR status journals are private JSON and remain separate. First queue creation is explicit; lost cursors/uncertain effects are not reset or blindly replayed.
- **Dashboard/evidence:** simulated UI only; no green status without recorded evidence; no live operational claim.
- **No challenge bypass:** login/MFA/CAPTCHA remains manual. Keep secrets and private account material out of logs and Git.

## 12 October 2026 - review hardening details

Tracker matching uses exact IDs and shared lifecycle classification. Sender authentication uses trusted Gmail API headers. Browser/API account alignment requires configured account identity plus a known common reservation; current selectors are not live-validated and missing proof blocks writes. Gmail cursor/work commit atomically. Reconciliation keeps reservation history and persistent discrepancies. Unconfirmed engine submissions stay UNCERTAIN/REVIEW; incident resolution is scoped by incident ID. The in-memory DB is test-only; PostgreSQL is the engine store. See v1.9 Sections 4-12 and `REVIEW_FIXES_2026-10-12.md`.

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

