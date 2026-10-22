# Database design decisions

This document accompanies `schema.sql` and records the current BFMR database design. Later decisions in the requirements discussion supersede earlier ones. PostgreSQL stores the data and enforces structural integrity; application code manages the business workflow.

## Installation and scope

The schema targets PostgreSQL 15 or later. It creates tables, indexes, an append-only observation guard, and status seed data in the `public` schema of an existing empty database. It does not create the database, database users, or permissions, and it does not configure Gmail, BFMR, payment providers, or automation.

From this repository directory, with PostgreSQL connection settings already configured:

```sh
createdb bfmr
psql -X --set=ON_ERROR_STOP=1 --dbname=bfmr --file=schema.sql
```

`bfmr` is an example database name. Database creation requires appropriate PostgreSQL privileges. The SQL file runs as a transaction and is intended for a fresh installation, not repeated execution or migration of an existing schema.

## Naming and identifiers

- SQL identifiers use unquoted lowercase names. Business and evidence tables are: `reservations`, `orders`, `retailers`, `retailer_accounts`, `deals`, `emails`, `email_deals`, `deal_retailers`, `shipments`, `reimbursements`, `workflow_evidence`, `sync_runs`, and `provider_observations`. Lookup tables are `reservation_status`, `order_status`, and `shipment_status`.
- Ordinary internal primary keys use `bigint GENERATED ALWAYS AS IDENTITY`. Lookup tables use fixed seeded `bigint` identifiers.
- BFMR reservation and deal identifiers are stored separately as unique `text` values. They are external identifiers, not internal primary keys.
- `orders.id` is the internal primary key. `orders.order_id` is the retailer's order number. `(retailer_id, order_id)` is unique because order numbers are unique within a retailer.
- `shipments.id` is the internal primary key. Tracking number and shipping company are separate text fields. Tracking numbers are not globally unique because carriers may overlap or reuse them.

## Application amendment: explicit retailer-account ranking

The retailer/account relationship is one-to-many. Multiple accounts for one
retailer are valid; the worker chooses the account with the lowest explicit
`retailer_accounts.retailer_account_ranking` and pins that account for the run.
It must not infer priority from IDs, email addresses or database return order.

The rank is a required `integer` with no default. Negative values, zero and
positive values are allowed: the approved rule is numeric ordering, not a
positive-only or consecutive sequence. The unique key
`(retailer_id, retailer_account_ranking)` prevents tied priorities within one
retailer while allowing the same rank under another retailer. Existing
`(retailer_id, email)` uniqueness, account/retailer consistency keys and historical
order account references remain unchanged. No new table is introduced.

Fresh installation uses the completed `NOT NULL` contract in `schema.sql`.
Existing installations use the separately reviewed preparation and finalization
sources under `migrations/20261022_retailer_account_ranking_*.sql`. Preparation
adds a nullable column and the unique constraint; it deliberately supplies no
ranks. An operator must review and explicitly populate the intended priority
for every account before finalization validates the baseline and enforces
`NOT NULL`. No migration fabricates preference from row numbers or account IDs.
Keep the worker stopped between stages; runtime must reject nullable/incomplete
ranking rather than choose an account from partial data.

The worker reads the ranking field but does not manage account/rank records.
Give its non-owning role the required `SELECT` access; administrator-only
backfill/rank changes do not justify worker INSERT/UPDATE grants on
`retailer_accounts`. No existing database has been upgraded or real ranks assigned. Subsequent
user-authorized synthetic tests are recorded in the
[database guide](README.md#offline-account-ranking-validation--22-october-2026).
Earlier validation records below retain their original source/date scope.

## Order purchase details

`orders` also stores these purchase details:

| Column | Type | Meaning |
| --- | --- | --- |
| `total_cost` | `numeric(12,2) NOT NULL` | Actual retailer order cost in USD; finite and nonnegative. |
| `purchase_date` | `date NOT NULL` | Calendar date of purchase. |
| `product_identifier` | `text NOT NULL` | Retailer product code, such as an Amazon ASIN. Text preserves leading zeros and nonnumeric characters. No format or uniqueness rule is imposed. |
| `order_time_estimated_delivery_date` | `date` | Optional estimated delivery date provided when the order was placed. |

These columns have no defaults. Every order must supply `total_cost`, `purchase_date`, and `product_identifier`; a known zero cost is permitted. `order_time_estimated_delivery_date` is nullable.

For a database created from the previous version, backfill any missing purchase details with actual values before applying:

```sql
BEGIN;
ALTER TABLE public.orders
    ALTER COLUMN total_cost SET NOT NULL,
    ALTER COLUMN purchase_date SET NOT NULL,
    ALTER COLUMN product_identifier SET NOT NULL,
    ADD COLUMN order_time_estimated_delivery_date date;
COMMENT ON COLUMN public.orders.total_cost IS
    'Required actual retailer order cost in USD; no default is supplied.';
COMMENT ON COLUMN public.orders.purchase_date IS
    'Required calendar date of purchase; no default is supplied.';
COMMENT ON COLUMN public.orders.product_identifier IS
    'Required retailer product code, such as an Amazon ASIN; text preserves leading zeros and nonnumeric codes.';
COMMENT ON COLUMN public.orders.order_time_estimated_delivery_date IS
    'Optional estimated delivery date provided when the order was placed.';
COMMIT;
```

## Relationships and cardinalities

| Relationship | Current rule |
| --- | --- |
| Deal → reservation | A deal can have many reservations; each reservation belongs to one deal. |
| Reservation → order | A reservation can have zero or one order; each order belongs to one reservation. |
| Order → shipment | An order can have zero or one shipment; each shipment belongs to one order. |
| Reservation → reimbursement | A reservation can have zero or one reimbursement; each reimbursement belongs to one reservation. |
| Retailer → account | A retailer can have many accounts; each account belongs to one retailer. |
| Retailer → order | A retailer can have many orders; each order has one retailer. |
| Retailer account → order | An account can have many orders, including multiple orders for the same deal. Every order requires an account. |
| Deal ↔ retailer | Many-to-many through `deal_retailers`. |
| Email ↔ deal | Many-to-many through `email_deals`. |
| Email → reservation | A reservation can optionally identify one triggering email. An email can trigger multiple reservations. |
| Email → reimbursement | Each reimbursement identifies its payment email. A payment email is not constrained to one reimbursement. |
| Sync run → provider observation | A run can have many observations; each observation optionally references one run. |
| Email, deal, reservation, order, shipment, reimbursement → provider observation | Each entity can have many observations. An observation can optionally reference one row from each entity table. |

The one-order and one-shipment limits are enforced by unique foreign keys on `orders.reservation_id` and `shipments.order_id`. A reservation must exist before an order can reference it. The database has no requirement that every reservation already have an order or that every order already have a shipment.

The final one-order-per-reservation decision replaces the earlier model of multiple historical orders and replacement-order rows. The schema cannot retain a canceled order and insert a second order for the same reservation. How automation handles a replacement within this single-order model remains an application decision; the schema does not silently restore the superseded history model.

## Retailer eligibility and account consistency

- `deal_retailers` replaces the former list of retailer IDs on `deals`. Its composite primary key is `(deal_id, retailer_id)`.
- `orders.deal_id` is stored alongside `reservation_id`. A composite foreign key requires the order's deal to match its reservation's deal.
- An order's `(deal_id, retailer_id)` must exist in `deal_retailers`.
- `orders.retailer_id` remains stored so retailer-wide order-number uniqueness can be enforced. A composite foreign key requires it to match the selected retailer account's retailer.
- `(retailer_id, email)` uniquely identifies a retailer account. The schema uses ordinary case-sensitive text equality; any email normalization policy remains in the application.
- The database does not enforce uniqueness on `(retailer_account_id, deal_id)`. The former partial unique index was removed at the user's request; any per-deal purchase policy is managed by application code.

The extra unique keys used as composite foreign-key targets support these consistency checks. They do not imply additional business identities.

For an existing database created from an earlier version, apply the index removal with:

```sql
BEGIN;
DROP INDEX IF EXISTS public.orders_account_deal_qualifying_uk;
COMMENT ON COLUMN public.order_status.id IS 'Stable schema-managed lookup identifier.';
COMMIT;
```

## Quantities and money

All monetary amounts are USD and use `numeric(12,2)`. No currency column or currency conversion is included.

- `deals.reimbursement_amount` is the deal's current reimbursement amount per unit. A verified payout change updates the deal and applies only to reservations created under the new terms.
- `reservations.payout_per_item` is the agreed per-unit rate saved when the reservation is created. The agreed creation-time payout is fixed; neither later deal-rate changes nor synchronization may change an existing reservation's expected payout.
- `reservations.expected_payout` is a stored generated column equal to the creation-time `quantity * payout_per_item`. It cannot be written independently and is never recalculated from order quantity, cancellations, delivery, or reimbursement amounts. Payments affect the outstanding balance, not the agreed expected payout.
- Reservation, order, and shipment quantities must be greater than zero.
- `orders.quantity` retains the original ordered quantity. `canceled_quantity` defaults to zero and must be between zero and `quantity`.
- `orders.total_cost` records the total purchase cost separately from the expected BFMR reimbursement.
- Monetary amounts are finite and nonnegative, including reimbursement payments; zero is permitted. PostgreSQL's special `NaN` value is rejected explicitly. Reimbursements represent actual payments rather than signed adjustment ledger entries.

The application checks cross-table quantities, including the rule that ordered quantity cannot exceed reserved quantity. It must preserve the reservation's agreed creation-time expected payout. With the present generated formula, quantity or per-unit-rate edits must not recalculate that locked amount; order cancellations and status changes do not reduce it. No trigger adjusts quantities, copies deal rates, or changes lifecycle statuses automatically.

### Fixed reservation payout decision — 20 October 2026

The user decided that a reservation's expected payout is locked at creation and never changes. Payout changes occur only on the deal object and affect future reservations. For example, a reservation made at $80 remains $80 after the deal payout becomes $95; a new reservation under the revised deal terms records $95.

No dedicated `reservation_history` table is needed or planned. Its absence is intentional, not a schema gap. `provider_observations` continues to preserve sanitized provider facts, and `workflow_evidence` continues to preserve workflow decisions and outcomes. A conflicting later provider payout is retained as evidence for review; it does not authorize rewriting the locked reservation amount.

The original decision amendment was documentation only: the generated expression alone did not lock its writable inputs. The following source change implements that guard without changing the generated expression or the decision's business semantics.

### Reservation payout guard source — 20 October 2026

`schema.sql` now defines `public.reject_reservation_payout_change()` and the `reservations_immutable_payout` row-level `AFTER UPDATE` trigger. It compares final `NEW.quantity` and `NEW.payout_per_item` to their `OLD` values with `IS DISTINCT FROM` and raises SQLSTATE `23514` (`check_violation`) if either differs. Checking every update after any `BEFORE` triggers protects both creation inputs, including compensating edits that leave the total equal. Ordinary updates to other existing fields and no-op assignments to unchanged financial inputs remain permitted. The trigger is enabled `ALWAYS`, including replica-session writes.

The stored generated `expected_payout = quantity * payout_per_item` continues to enforce the formula and disallow independent assignment. Deal-rate changes do not modify existing reservations; new reservations must receive their actual agreed creation terms. There is no new history table, automatic deal-rate copy, or lifecycle adjustment.

For an existing database on the preceding schema, `migrations/20261020_reservation_payout_immutability.sql` supplies the corresponding single-use, transactional upgrade. It locks `public.reservations` against concurrent writers while installing the same function, trigger, enablement and column comments. It performs no data rewrite or backfill and leaves the generated expression intact. Review authoritative creation evidence and reconcile unsupported legacy terms before an authorized application; never substitute today's deal rate. Once installed, the guard protects whatever terms are stored going forward, not their historical authenticity. A fresh installation uses `schema.sql` alone; do not also apply the upgrade to it. Reapplying the upgrade fails atomically on the existing objects.

Runtime ingestion/reconciliation remains separate work. A conflicting provider value must remain in provider observations/workflow evidence for review and must not be promoted into the reservation. A rejected update rolls back its statement/transaction; the trigger does not independently save conflict evidence. The application must preserve that evidence without losing it to the rejected write and must not blindly retry the same conflicting upsert.

This guard protects updates to the two financial inputs. Runtime roles must be non-owning and lack DDL/trigger-management, reservation DELETE/TRUNCATE, and reservation-identity reassignment privileges, so they cannot replace a snapshot or attach it to a different logical reservation. Role provisioning remains deployment work; this source change creates no roles or grants and does not prevent a database owner from altering the schema.

**Evidence:** source implementation and manual review only. No software tests were added or run for this change, and neither SQL file was applied to a database. Existing validation results below predate this guard and do not verify it. Database installation, legacy reconciliation, runtime integration and production acceptance remain pending.

## Emails and payment evidence

The design serves one Gmail account and one BFMR account. There are no account-partition columns for either service.

- `emails.gmail_message_id` is unique to prevent duplicate Gmail message records. `received_at` stores the trusted Gmail receipt timestamp as `timestamptz`.
- `emails.subject` is required and defaults to an empty string. `email_type` is required free text; allowed classifications have not been fixed.
- `email_deals` has composite primary key `(email_id, deal_id)`. Its optional `reference_type` remains free text because the allowed values have not been defined.
- An email–deal link alone does not authorize a reservation or purchase.
- `reservations.source_email_id` is optional. It does not require a matching link to the same deal in `email_deals`.
- `reimbursements.payment_email_id` is required. The application verifies that this email is the relevant payment notice and supplies the amount documented in it. That amount is assumed to equal the amount actually received.
- `payment_reference` is optional and has no uniqueness rule; the provider's reference format and uniqueness scope have not been specified.

BFMR pays per tracking number, with at most one payment per shipment. With the final one-shipment-per-order and one-order-per-reservation model, `reimbursements.reservation_id` is unique. Reimbursements retain this direct reservation link; they have no `shipment_id`, as explicitly requested. This enforces at most one reimbursement record per reservation, but it does not prove that the payment corresponds to an existing tracking number or shipment. The application verifies that association and prevents duplicate processing.

## Synchronization runs

`sync_runs` records the collection attempt and its declared coverage. It can be updated while an attempt progresses; provider observations remain append-only.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `bigint` identity, primary key | Internal run identifier. |
| `provider` | `text NOT NULL` | Nonblank source identifier. Provider matching is exact and case-sensitive. |
| `scope` | `text NOT NULL` | Required uppercase scope identifier matching `^[A-Z][A-Z0-9_]*$`. |
| `target_order_id` | `bigint` | Optional FK to internal `orders.id`, with known-scope rules below. |
| `started_at` | `timestamptz NOT NULL` | When collection began. |
| `completed_at` | `timestamptz` | Required for every finished attempt and absent while running; cannot precede `started_at`. |
| `status` | `text NOT NULL` | Exactly `RUNNING`, `COMPLETED`, `FAILED`, or `INCOMPLETE`. |
| `records_received` | `integer NOT NULL` | Nonnegative count. A complete empty result may have zero records. |
| `is_complete` | `boolean NOT NULL` | True only for `COMPLETED`; false for every other state. |
| `error_message` | `text` | Optional sanitized failure or incompleteness details. |

Apart from the identity, no defaults are supplied. The application supplies the actual scope, timestamps, counts, state, and completeness assessment.

### Run-state constraints

| Status | Completion timestamp | Completeness |
| --- | --- | --- |
| `RUNNING` | Must be NULL | Must be false |
| `COMPLETED` | Required, at or after start | Must be true |
| `FAILED` | Required, at or after start | Must be false |
| `INCOMPLETE` | Required, at or after start | Must be false |

These are row-consistency constraints, not lifecycle-transition triggers. Application code controls progression and must not reopen a finished attempt or overwrite its declared scope to represent a different collection.

### Scope contract

| Scope | Coverage | `target_order_id` |
| --- | --- | --- |
| `BFMR_MY_TRACKER_FULL` | Complete validated My Tracker coverage for the configured BFMR account, including all required pages. | Must be NULL |
| `AMAZON_ORDER_TRACKING` | Retailer tracking data for one exact locally recorded order. The application also validates its retailer/account identity. | Required FK to `orders.id` |
| `GMAIL_HISTORY` | The declared history interval for the configured Gmail mailbox. Persist its actual cursor/range in the associated operational state or sanitized evidence. | Must be NULL |

Other uppercase scope identifiers remain extensible. Before using one, the application must define and validate its coverage, provider, account context, target requirements, and counting rules. An undefined name must not authorize promotion of current state. Canonical uppercase scope syntax prevents case or whitespace variants from bypassing the known-scope checks. Canonical provider names should be supplied consistently; the schema does not silently trim or rename providers.

Indexes support provider/scope/status scheduling and target-order lookups. One run can have many observations. A composite `UNIQUE (id, provider)` key supports the observation foreign key `(sync_run_id, provider)`; linked observations must match the run's provider exactly. Default `MATCH SIMPLE` allows an observation without a run when `sync_run_id` is NULL.

An individual observation may be complete while the overall run is incomplete. These two completeness flags are deliberately not constrained to match. The application verifies that linked subjects and any order-scoped observation belong to the declared run target; the provider FK alone does not prove that association.

### Authoritative completion and recovery

Retrieve the required provider data, then validate account identity, pagination, scope coverage, and field semantics. To finalize, lock the run row, verify that the attempt is still eligible to finish, and use one database transaction to persist the validated observations, update authoritative mutable business records, and set the terminal run state. Preserve existing reservation expected payouts and their agreed creation-time terms; verified deal-rate changes update only the deal. A conflicting reservation payout blocks authoritative promotion pending review. Failed or incomplete attempts may retain partial observations and failure details but must preserve prior authoritative current state. A successful HTTP response or record count does not establish completeness.

Crash recovery must reconcile stale `RUNNING` attempts explicitly. The schema cannot prove a provider read was complete, implement a scheduler, supply Gmail cursors, or make external provider actions transactional. This repository change supplies schema constraints and this application contract; it does not implement a runtime finalization service.

The 20 October 2026 fixed-payout decision supersedes the earlier proposal for `reservation_history`. Synchronization has no dependency on that table. Keep provider observations and workflow evidence with their existing links; do not add a dedicated reservation-history write to finalization.

### Upgrade from the preceding schema

The fresh-install script remains for an empty database. Existing installations use `migrations/20261020_sync_consistency.sql`, applied once after backup and review.

If existing runs need backfill, first add the new nullable columns:

```sql
BEGIN;
ALTER TABLE public.sync_runs
    ADD COLUMN IF NOT EXISTS scope text,
    ADD COLUMN IF NOT EXISTS target_order_id bigint;
COMMIT;
```

Backfill each run's actual scope and any real target order, and reconcile inconsistent legacy state/timestamps/provider associations from authoritative evidence. Do not guess historical scope, invent completion times, or edit immutable observations to force the migration through. Unsupported or conflicting legacy evidence needs an explicit reconciliation decision. Then apply the migration, which sets scope NOT NULL and installs the checks, indexes, and composite provider FK.

The migration is transactional. Missing scopes, inconsistent states, invalid targets, or provider mismatches cause it to fail without partially installing its changes. Preparation columns/backfill performed in an earlier transaction remain available for correction. Run it once; it is not a general repeatable migration runner. No database is migrated merely by committing these files.

## Provider observations and append-only records

`provider_observations` stores provider-reported facts separately from the current business records:

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `bigint` identity, primary key | Internal observation identifier. |
| `email_id` | `bigint` | Optional foreign key to `emails.id`. |
| `deal_id` | `bigint` | Optional foreign key to `deals.id`. |
| `reservation_id` | `bigint` | Optional foreign key to `reservations.id`. |
| `order_id` | `bigint` | Optional foreign key to internal `orders.id`. |
| `shipment_id` | `bigint` | Optional foreign key to `shipments.id`. |
| `reimbursement_id` | `bigint` | Optional foreign key to `reimbursements.id`. |
| `sync_run_id` | `bigint` | Optional foreign key to `sync_runs.id`. |
| `provider` | `text NOT NULL` | External source, such as BFMR, Amazon, or Gmail. |
| `resource_type` | `text NOT NULL` | Kind of resource observed. |
| `observed_at` | `timestamptz NOT NULL` | When the information was observed. |
| `is_complete` | `boolean NOT NULL` | Whether the observation meets its defined completeness requirements. |
| `response_data` | `jsonb NOT NULL` | Selected, sanitized provider-reported facts. |

All seven relationship fields are independently nullable; an observation may have no linked entity yet or may reference several. Foreign keys validate each referenced row without imposing a minimum link count. The composite run/provider foreign key additionally requires linked observations to match their run's provider; other cross-entity coherence remains application-controlled. Repeated observations are permitted. Partial indexes support lookups by each non-NULL reference.

The five observation fields are required and have no defaults. `provider` and `resource_type` remain text; providers must be nonblank and match any linked run exactly. Resource-type values remain application-defined. Application code defines completeness requirements and sanitizes `response_data` and synchronization errors before insertion; the database does not infer completeness or inspect JSON for sensitive content. Storing an observation does not authorize a reservation or purchase or automatically change business records.

A statement-level trigger rejects `UPDATE`, `DELETE`, and `TRUNCATE`, including operations affecting zero rows and truncation through a parent table's `CASCADE`. It is enabled `ALWAYS`, so it also runs when `session_replication_role` is `replica`. Corrections, new facts, and later associations require new observation rows. The guard applies to ordinary database writes; an owner or sufficiently privileged administrator can still alter or remove it. Application roles should not own the table or have administrative privileges; role provisioning remains outside this schema.

## Statuses and application responsibilities

The status lookup tables contain `id` as their primary key and unique `description` values. Seed data uses these fixed identifiers:

| Table | ID → description |
| --- | --- |
| `reservation_status` | `1` → `active`; `2` → `canceled`; `3` → `reimbursed` |
| `order_status` | `1` → `pending_shipment`; `2` → `partial_shipment`; `3` → `shipped`; `4` → `partial_delivery`; `5` → `delivered`; `6` → `partial_return`; `7` → `returned`; `8` → `vendor_canceled`; `9` → `user_canceled` |
| `shipment_status` | `1` → `shipped`; `2` → `out_for_delivery`; `3` → `delivered`; `4` → `returned` |

`returned` means a carrier return to the retailer. Partial order statuses remain available despite the final one-shipment limit; the application determines which statuses apply to the recorded quantities.

The application calculates order shipping and delivery progress from shipment information, handles cancellations and returns, and marks reservations `reimbursed` when payments meet or exceed `expected_payout`. Status foreign keys enforce valid values; they do not enforce transitions or trigger recalculation. No lifecycle triggers are installed.

## Workflow evidence

`workflow_evidence` implements the v22 design's append-only record of workflow intent, decisions, confirmations, uncertain outcomes, and reconciliation.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `bigint GENERATED ALWAYS AS IDENTITY` | Internal primary key. |
| `email_id` | `bigint` | Optional foreign key to `emails.id`. |
| `reservation_id` | `bigint` | Optional foreign key to `reservations.id`. |
| `order_id` | `bigint` | Optional foreign key to internal `orders.id`, not the retailer order number. |
| `correlation_id` | `uuid NOT NULL` | Application-supplied identifier shared across one workflow's evidence rows. |
| `action_type` | `text NOT NULL` | Nonblank application-defined action label. |
| `phase` | `text NOT NULL` | Nonblank application-defined phase, such as intent, confirmation, or reconciliation. |
| `outcome` | `text` | Optional nonblank outcome; NULL is permitted while unknown. |
| `evidence` | `jsonb NOT NULL DEFAULT '{}'::jsonb` | Sanitized JSON object containing supporting facts. Arrays, scalar JSON, and JSON null are rejected. |
| `recorded_at` | `timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP` | Local recording time. |

The three subject links are independently optional. An intent can be recorded before its reservation/order exists, including with no subject links when the workflow correlation identifies the work. Later rows can add the established links using the same `correlation_id`; prior evidence is not updated. Foreign keys enforce existence, while the application verifies that multiple supplied subjects belong to the same workflow. The correlation UUID intentionally is not unique because one workflow has multiple evidence rows.

Indexes support correlation and optional email/reservation/order lookups, ordered by recording time and ID. No fixed action, phase, or outcome vocabulary is imposed until the application contract is defined.

Row triggers reject UPDATE and DELETE, and a statement trigger rejects TRUNCATE. Corrections and later outcomes are appended as new rows. This protects ordinary DML; a database owner or suitably privileged administrator can still change the schema or disable triggers. Application roles and operational permissions remain deployment responsibilities. Referenced business records cannot be deleted while evidence references them.

Store only selected, sanitized facts. JSON payload validation/versioning and redaction remain application responsibilities. Credentials, card security codes, raw authenticated pages, and unredacted messages do not belong in evidence.

This table does not implement a command queue, Gmail cursor, lifecycle transitions, external-action idempotency, or provider readback. Recording an intent is required before an external action; an evidence row does not authorize a purchase, retry, or other provider mutation.

For an existing installation, apply the new table, function, triggers, four indexes, and comments as a separate reviewed migration. Do not rerun the complete fresh-install `schema.sql` against an existing database.

## Required data and deletion behavior

Core identifiers, relationship keys, quantities, financial fields, and timestamps are required unless explicitly optional. Optional fields are `reservations.source_email_id`, `deals.description`, `email_deals.reference_type`, `reimbursements.payment_reference`, `orders.order_time_estimated_delivery_date`, `sync_runs.completed_at`, `sync_runs.error_message`, and scope-dependent `sync_runs.target_order_id`, all seven relationship fields on `provider_observations`, and `workflow_evidence.email_id`, `workflow_evidence.reservation_id`, `workflow_evidence.order_id`, and `workflow_evidence.outcome`.

All foreign keys use `ON DELETE RESTRICT` and `ON UPDATE RESTRICT`. Referenced rows and keys cannot be deleted or changed while dependent records exist. Deletion, retention, and archival workflows require application handling or a future explicit migration. The schema creates supporting indexes for relationship access, but workload-specific performance tuning remains future work.

## Card verification code

`retailer_accounts.ccv` is retained at the user's explicit request for automation. It is text restricted to three or four ASCII digits so leading zeros are preserved. PCI DSS prohibits storing card verification codes after authorization, including encrypted storage; retaining this field leaves that compliance issue unresolved. No card codes or other credentials are included in the SQL or this document.

## Deliberately excluded

- The `open_orders` view was dropped from the design and is not created.
- No multi-account Gmail or BFMR support, payment-adjustment ledger, order-history model, lifecycle triggers, or application authorization logic is included. The observation guard only enforces immutability; it does not manage lifecycle transitions.
- A dedicated `reservation_history` table is intentionally excluded by the 20 October 2026 decision. Reservation expected payout is fixed at creation; deal payout changes apply to future reservations. Existing provider observations and workflow evidence remain in scope.
- Existing-data migration, backups, operational permissions, and deployment configuration are outside this initial schema file.

## Validation

Before the workflow-evidence addition, the purchase-detail schema and its documented upgrade were validated on an isolated PostgreSQL 17.11 server. All 15 focused checks passed for both a fresh installation and an upgrade from the previous schema. Checks confirmed the column types, required purchase values without defaults, rejection of omitted values and updates to NULL, and a nullable estimated delivery date that can be stored or cleared. The upgrade correctly rejected existing NULL purchase values without partially changing the schema, then succeeded after the synthetic fixture was backfilled. Validation used synthetic data in disposable databases.

### Workflow-evidence validation — 19 October 2026

The complete updated fresh-install script was executed in an isolated, in-memory PGlite 0.5.10 database using PostgreSQL 18.6. All 34 focused checks passed: full-schema creation, optional and valid subject links, shared workflow correlation, evidence and timestamp defaults, rejection of invalid foreign keys and non-object/NULL JSON, blank-label and required-field checks, rejection of UPDATE/DELETE/TRUNCATE (including cascading truncation), preservation of referenced rows and evidence after failed mutations, and creation of the four lookup indexes and both append-only triggers. Only synthetic fixture data was used. No production database or external provider was accessed. This is embedded PostgreSQL validation, not a native PostgreSQL 15 deployment or application integration test.

### Synchronization and observation validation — 20 October 2026

Before the synchronization-consistency constraints, that fresh-install schema was executed on an isolated PostgreSQL 17.11 server. All 62 focused synchronization and observation checks passed, covering field types and optionality, all seven foreign-key targets and invalid references, unlinked and repeated observations, multiple observations per run, run completion updates, nonnegative record counts, and rejection of observation UPDATE/DELETE/TRUNCATE. Mutation checks included empty tables, cascading truncation, and replica-session mode; failed mutations preserved existing rows, and subsequent inserts remained possible. The 15 existing order purchase-detail checks also passed. Validation used synthetic data in disposable databases; no deployed database was changed.

### Synchronization-consistency validation — 20 October 2026

The updated fresh-install script and the upgrade migration passed 80 focused checks in isolated, in-memory PGlite 0.5.10 databases using PostgreSQL 18.6. Checks covered every status/completion-time/completeness combination, required and canonical scope values, nonblank providers, order-target requirements and foreign keys, exact run/observation provider matching, immutable observation protection, and the new indexes. A simulated atomic finalization succeeded; a failed finalization rolled back its observations and state changes. Fresh and upgraded constraint catalogs matched. The migration succeeded for both empty and correctly backfilled existing data, rejected missing scopes, provider mismatches, and inconsistent legacy states atomically, and preserved existing immutable observations. Only synthetic data was used. No live database or external provider was accessed. This validates the SQL in embedded PostgreSQL; it does not test a native PostgreSQL 15 deployment or implement or test an application finalization service.
