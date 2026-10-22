# Decision register

## 22 October 2026 — shared single-/multi-deal workflow implementation

The user requested extracting production coordination into shared services and making both qualifying message types durable with identical purchase safeguards. Preserve the all-reservations-before-evaluation barrier, reconcile possible effects before reviewed repair and never backfill completed mail. The source now uses existing append-only SQL evidence, exact admitted PROCESSING identity, causal action checkpoints and report-first/freshly validated local repair scoped to interrupted work. This changes source behavior, not live invocation authority or installed schema. See [SHARED_EMAIL_WORKFLOW.md](SHARED_EMAIL_WORKFLOW.md). No software tests, provider action or actual repair/deployment occurred.


## 22 October 2026 — close reviewed action-control gaps

The user requested implementation of the action-control step from the repository review: strict checkout expectations and exact Amazon buying-account evidence, explicit cancellation release proof, persistent incident blocking and production startup recovery audits. Implementation uses existing business evidence tables and preserves approved purchase scope, CON-001 intake and at-most-once mutation rules. A verified account selector and one-time reviewed recovery inventory are additional source gates, not provider acceptance or permission to run the worker. No general incident-reset/repair capability is authorized by source presence. Details and static-check limits are in [ACTION_CONTROL.md](ACTION_CONTROL.md) and the v22 implementation amendment. No software tests or live actions were performed.

## 22 October 2026 — start from today; exclude prior completed activity

The user subsequently authorized focused offline validation and committing/pushing
the fresh-start change. Tests use synthetic state and disposable PGlite; native
cutover application and live provider/worker actions remain separate. Evidence is
recorded in the [runbook](RELATIONAL_INTEGRATION.md#offline-fresh-start-validation--22-october-2026).

After reporting no outstanding work and no located recovery files, the operator
explicitly chose a new operational boundary and excluded prior completed
activity. Use a version-2 cutover declaration with an exact UTC start instant,
explicit exclusion and no-outstanding-work assertion; never represent it as
complete historical coverage. Existing history-mode imports stay unchanged.
Prepare/report first; do not silently apply a marker, reset Gmail or ignore
unknown unpaid/provider evidence. The [cutover runbook](RELATIONAL_INTEGRATION.md#explicit-start-from-today-boundary--22-october-2026)
owns procedure and limitations. This decision does not itself apply a cutover or
authorize a live worker.

## 22 October 2026 — focused offline account tests and publication authorized

The user approved adding/running focused offline account-selection, ranking,
upgrade and seed tests, followed by committing and pushing the completed work.
Use synthetic identities and disposable PGlite; private-input shell checks use
only synthetic environment values. This does not authorize an installed database
upgrade, real rank backfill, live provider action or deployment. See the
[database guide](../database/README.md#offline-account-ranking-validation--22-october-2026)
for evidence and limits.

## 22 October 2026 — explicit initial Amazon retailer/account seed

The user requested the initial Amazon retailer/account in the creation workflow with rank **1**, retaining required CCV. [The seed source](../database/seed_amazon_account.psql) keeps the requested initial identity in that file and receives CCV only through private `BFMR_INITIAL_ACCOUNT_CCV` and client-side COPY into a temporary table. Never commit a CCV literal or print its value. Worker CCV reads remain forbidden; fresh integer/non-null/unique ranking and reviewed existing-account backfill remain required. An explicit seed is not a rank default or general autofill.

[The creation installer](../database/bfmr-postgres-db-install.psql) includes the seed under `bfmr_owner` after both schemas and grants worker SELECT on ranking, preserving existing ownership/password controls and withholding CCV/account writes. Source changes remain uninstalled; [offline ranking evidence](../database/README.md#offline-account-ranking-validation--22-october-2026) records synthetic validation without installed database/provider actions or deployment. See [database/README.md](../database/README.md) for the operator boundary.

## 22 October 2026 — ranked database selection of the Amazon account

The user clarified that a retailer has multiple accounts. Require exactly one `retailers` row where `name = 'Amazon'`, then select its account using `ORDER BY retailer_account_ranking ASC LIMIT 1`. Multiple accounts are valid; zero linked accounts stop startup. Add integer `retailer_account_ranking NOT NULL` and `UNIQUE (retailer_id, retailer_account_ranking)`, without default/generated values or automatic assignment. No positivity or consecutive-rank requirement was added. This supersedes the interim exactly-one-account interpretation.

IDs, stored email and rank come only from the database, without environment overrides or a `ccv` read. Pin the chosen account for the worker run; changed selection stops work, never silently switches. Existing provider/checkout/homepage guards remain independent. Existing least-privilege roles need SELECT on ranking, without application permission to update it.

The current worker handles one selected account per run, not multi-account tracking. Keep existing orders tied to their original account; review outstanding orders on other accounts before reprioritizing because they may be outside the next run's selected ledger projection. No tracking redesign is implied by the selection change.

Existing-database upgrade source is two-stage: nullable ranking plus uniqueness, then reviewed manual backfill, then `NOT NULL` finalization. No inferred/default ranks; runtime schema validation refuses the unfinished contract. This authorizes source/schema/template/documentation changes, not installing SQL, backfilling an actual database, provider actions, cutover or deployment. Ranking source remains uninstalled; subsequent user-authorized [offline ranking evidence](../database/README.md#offline-account-ranking-validation--22-october-2026) records the focused tests. Earlier dated results retain their original schema/source scope.

## 22 October 2026 — offline intake testing authorized

The user explicitly requested adding and running offline intake tests. Use synthetic provider adapters and disposable PGlite with the actual operational SQL; block network access and private provider/database configuration in these suites. Optional typed persistence injection preserves production defaults. This authorizes offline verification, not native installation, legacy cutover, provider configuration, a live worker or deployment. Evidence is recorded in [GMAIL_PRODUCTION_INTAKE.md](GMAIL_PRODUCTION_INTAKE.md#offline-validation--22-october-2026).

## 21 October 2026 — implement required production intake source

The user requested implementation of production intake. The new source uses CON-001 watch/owned StreamingPull with dedicated PostgreSQL operational tables; it does not redesign or alter the pinned business schema. Existing JSON Gmail state requires reviewed explicit import, never startup import/reset. A production entrypoint skips the separately scoped startup test reservation. This is implementation authority, not authority to install SQL, configure a live watch/subscription, invoke BFMR/Amazon actions or deploy. Static evidence and limits are recorded in IMPLEMENTATION_PLAN.md and GMAIL_PRODUCTION_INTAKE.md; no software test or provider acceptance is implied.

## 21 October 2026 — restore required no-poll Gmail intake (CON-001)

Restored the original CON-001 requirement from the v1.5 design: **"Gmail watch and Pub/Sub-driven intake. No periodic Gmail polling or Inbox sweep."** The user confirmed this remains controlling. Later "if required" descriptions and optional production Pub/Sub template entries were documentation drift, not an authorized design change.

Production requires watch renewal, StreamingPull, durable PostgreSQL notifications before ACK, serialized cursor/work commits and event-driven history reads. A startup/reconnect continuation from the saved cursor is allowed; watch baseline/expiration remain distinct, and gaps/missing existing state stop for reconciliation. The current 15-second polling runner is an implementation gap. Required configuration includes mailbox/OAuth identity, topic/subscription and verified Pub/Sub credentials; a credential file or a separately verified ADC identity can supply the latter. Separate legacy listener/IMAP code is not accepted production intake.

Provenance: `docs/BFMR_Solution_Design_Specification_v1.5.pdf` at historical commit `ffe0cc9`, CON-001 and the Gmail startup/reconnect/ACK sections. Current design, implementation, handoff, registers, overview, README and `.env.example` were corrected. This is documentation/template work only: no runtime code, provider configuration, live workflow or production acceptance changed.

## 21 October 2026 — dependency and specification artifacts

Use npm with `package-lock.json` as the sole maintained dependency lock. The user authorized deleting `bun.lock` and the v1.6–v1.8 generated specification PDFs in `output/pdf/`. Maintain the v22 Markdown design/implementation pair; historical specifications and generated PDFs remain accessible through Git history. Parser email/PDF samples are retained. Earlier PDF-generation evidence below describes its original checkpoint, not an artifact maintained in the current tree.

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
