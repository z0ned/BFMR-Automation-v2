-- BFMR relational schema for PostgreSQL 15+.
-- Apply once to an empty database, for example:
--   createdb bfmr
--   psql -X --set=ON_ERROR_STOP=1 --dbname=bfmr --file=schema.sql
-- This script creates objects in public; it does not create/drop a database.
-- All monetary amounts are USD. See DESIGN_DECISIONS.md for the design contract.

BEGIN;
SET LOCAL search_path = public;

-- Lookup identifiers are schema-managed constants, not identity sequences.
CREATE TABLE reservation_status (
    id bigint PRIMARY KEY,
    description text NOT NULL UNIQUE
);

INSERT INTO reservation_status (id, description) VALUES
    (1, 'active'),
    (2, 'canceled'),
    (3, 'reimbursed');

CREATE TABLE order_status (
    id bigint PRIMARY KEY,
    description text NOT NULL UNIQUE
);

INSERT INTO order_status (id, description) VALUES
    (1, 'pending_shipment'),
    (2, 'partial_shipment'),
    (3, 'shipped'),
    (4, 'partial_delivery'),
    (5, 'delivered'),
    (6, 'partial_return'),
    (7, 'returned'),
    (8, 'vendor_canceled'),
    (9, 'user_canceled');

CREATE TABLE shipment_status (
    id bigint PRIMARY KEY,
    description text NOT NULL UNIQUE
);

INSERT INTO shipment_status (id, description) VALUES
    (1, 'shipped'),
    (2, 'out_for_delivery'),
    (3, 'delivered'),
    (4, 'returned');

CREATE TABLE retailers (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    primary_url text NOT NULL
);

CREATE TABLE retailer_accounts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    retailer_id bigint NOT NULL,
    email text NOT NULL,
    -- Text preserves leading zeros. Retention was explicitly requested for automation.
    ccv text NOT NULL,
    CONSTRAINT retailer_accounts_ccv_format_ck
        CHECK (ccv ~ '^[0-9]{3,4}$'),
    CONSTRAINT retailer_accounts_retailer_email_uk
        UNIQUE (retailer_id, email),
    -- Required target key for the orders account/retailer consistency FK.
    CONSTRAINT retailer_accounts_id_retailer_uk
        UNIQUE (id, retailer_id),
    CONSTRAINT retailer_accounts_retailer_fk
        FOREIGN KEY (retailer_id) REFERENCES retailers (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE deals (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bfmr_deal_id text NOT NULL UNIQUE,
    slug text NOT NULL,
    title text NOT NULL,
    reimbursement_amount numeric(12,2) NOT NULL,
    description text,
    CONSTRAINT deals_reimbursement_amount_ck
        CHECK (reimbursement_amount >= 0 AND reimbursement_amount <> 'NaN'::numeric)
);

CREATE TABLE deal_retailers (
    deal_id bigint NOT NULL,
    retailer_id bigint NOT NULL,
    PRIMARY KEY (deal_id, retailer_id),
    CONSTRAINT deal_retailers_deal_fk
        FOREIGN KEY (deal_id) REFERENCES deals (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT deal_retailers_retailer_fk
        FOREIGN KEY (retailer_id) REFERENCES retailers (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE emails (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    gmail_message_id text NOT NULL UNIQUE,
    subject text NOT NULL DEFAULT '',
    email_type text NOT NULL,
    received_at timestamptz NOT NULL
);

CREATE TABLE email_deals (
    email_id bigint NOT NULL,
    deal_id bigint NOT NULL,
    reference_type text,
    PRIMARY KEY (email_id, deal_id),
    CONSTRAINT email_deals_email_fk
        FOREIGN KEY (email_id) REFERENCES emails (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT email_deals_deal_fk
        FOREIGN KEY (deal_id) REFERENCES deals (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE reservations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bfmr_reservation_id text NOT NULL UNIQUE,
    deal_id bigint NOT NULL,
    reservation_status_id bigint NOT NULL DEFAULT 1,
    source_email_id bigint,
    quantity integer NOT NULL,
    payout_per_item numeric(12,2) NOT NULL,
    expected_payout numeric(12,2)
        GENERATED ALWAYS AS (quantity * payout_per_item) STORED,
    CONSTRAINT reservations_quantity_ck CHECK (quantity > 0),
    CONSTRAINT reservations_payout_per_item_ck
        CHECK (payout_per_item >= 0 AND payout_per_item <> 'NaN'::numeric),
    -- Required target key for the orders reservation/deal consistency FK.
    CONSTRAINT reservations_id_deal_uk UNIQUE (id, deal_id),
    CONSTRAINT reservations_deal_fk
        FOREIGN KEY (deal_id) REFERENCES deals (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT reservations_status_fk
        FOREIGN KEY (reservation_status_id) REFERENCES reservation_status (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    -- Deliberately independent of email_deals: a same-deal link is not required.
    CONSTRAINT reservations_source_email_fk
        FOREIGN KEY (source_email_id) REFERENCES emails (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Check the final row after any BEFORE triggers. Both creation inputs are
-- immutable, including compensating edits that would leave their product equal.
CREATE FUNCTION public.reject_reservation_payout_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    IF NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.payout_per_item IS DISTINCT FROM OLD.payout_per_item
    THEN
        RAISE EXCEPTION
            'Reservation creation quantity and payout rate are immutable'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER reservations_immutable_payout
    AFTER UPDATE ON public.reservations
    FOR EACH ROW EXECUTE FUNCTION public.reject_reservation_payout_change();

ALTER TABLE public.reservations
    ENABLE ALWAYS TRIGGER reservations_immutable_payout;

-- A reservation can exist without an order. Each stored order requires one
-- reservation, and the unique reservation_id permits at most one order per reservation.
CREATE TABLE orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id text NOT NULL,
    reservation_id bigint NOT NULL,
    deal_id bigint NOT NULL,
    retailer_id bigint NOT NULL,
    retailer_account_id bigint NOT NULL,
    status_id bigint NOT NULL DEFAULT 1,
    quantity integer NOT NULL,
    canceled_quantity integer NOT NULL DEFAULT 0,
    total_cost numeric(12,2) NOT NULL,
    purchase_date date NOT NULL,
    product_identifier text NOT NULL,
    order_time_estimated_delivery_date date,
    CONSTRAINT orders_reservation_uk UNIQUE (reservation_id),
    CONSTRAINT orders_retailer_order_number_uk UNIQUE (retailer_id, order_id),
    CONSTRAINT orders_quantity_ck CHECK (quantity > 0),
    CONSTRAINT orders_canceled_quantity_ck
        CHECK (canceled_quantity >= 0 AND canceled_quantity <= quantity),
    CONSTRAINT orders_total_cost_ck
        CHECK (total_cost >= 0 AND total_cost <> 'NaN'::numeric),
    CONSTRAINT orders_reservation_deal_fk
        FOREIGN KEY (reservation_id, deal_id) REFERENCES reservations (id, deal_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT orders_deal_fk
        FOREIGN KEY (deal_id) REFERENCES deals (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT orders_retailer_fk
        FOREIGN KEY (retailer_id) REFERENCES retailers (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT orders_account_retailer_fk
        FOREIGN KEY (retailer_account_id, retailer_id)
        REFERENCES retailer_accounts (id, retailer_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT orders_eligible_retailer_fk
        FOREIGN KEY (deal_id, retailer_id) REFERENCES deal_retailers (deal_id, retailer_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT orders_status_fk
        FOREIGN KEY (status_id) REFERENCES order_status (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE shipments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id bigint NOT NULL,
    tracking_number text NOT NULL,
    shipping_company text NOT NULL,
    status_id bigint NOT NULL DEFAULT 1,
    quantity integer NOT NULL,
    CONSTRAINT shipments_order_uk UNIQUE (order_id),
    CONSTRAINT shipments_quantity_ck CHECK (quantity > 0),
    CONSTRAINT shipments_order_fk
        FOREIGN KEY (order_id) REFERENCES orders (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT shipments_status_fk
        FOREIGN KEY (status_id) REFERENCES shipment_status (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Payments retain a direct reservation FK, with no shipment_id, as requested.
-- One order/reservation, one shipment/order, and one payment/shipment imply
-- at most one actual reimbursement payment per reservation.
CREATE TABLE reimbursements (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reservation_id bigint NOT NULL,
    payment_email_id bigint NOT NULL,
    amount numeric(12,2) NOT NULL,
    paid_at timestamptz NOT NULL,
    payment_reference text,
    recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT reimbursements_reservation_uk UNIQUE (reservation_id),
    CONSTRAINT reimbursements_amount_ck
        CHECK (amount >= 0 AND amount <> 'NaN'::numeric),
    CONSTRAINT reimbursements_reservation_fk
        FOREIGN KEY (reservation_id) REFERENCES reservations (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT reimbursements_payment_email_fk
        FOREIGN KEY (payment_email_id) REFERENCES emails (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Append-only action evidence. Subject links may be absent before those rows
-- exist; correlation_id connects the intent and later confirmation/reconciliation.
CREATE TABLE workflow_evidence (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email_id bigint,
    reservation_id bigint,
    order_id bigint,
    correlation_id uuid NOT NULL,
    action_type text NOT NULL,
    phase text NOT NULL,
    outcome text,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT workflow_evidence_action_type_ck
        CHECK (action_type ~ '[^[:space:]]'),
    CONSTRAINT workflow_evidence_phase_ck
        CHECK (phase ~ '[^[:space:]]'),
    CONSTRAINT workflow_evidence_outcome_ck
        CHECK (outcome IS NULL OR outcome ~ '[^[:space:]]'),
    CONSTRAINT workflow_evidence_object_ck
        CHECK (jsonb_typeof(evidence) = 'object'),
    CONSTRAINT workflow_evidence_email_fk
        FOREIGN KEY (email_id) REFERENCES emails (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT workflow_evidence_reservation_fk
        FOREIGN KEY (reservation_id) REFERENCES reservations (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT workflow_evidence_order_fk
        FOREIGN KEY (order_id) REFERENCES orders (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Corrections and subsequent phases are new rows, not edits to prior evidence.
CREATE FUNCTION workflow_evidence_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $workflow_evidence$
BEGIN
    RAISE EXCEPTION 'workflow_evidence is append-only; % is not permitted.', TG_OP
        USING ERRCODE = '55000';
END;
$workflow_evidence$;

CREATE TRIGGER workflow_evidence_no_update_delete
    BEFORE UPDATE OR DELETE ON workflow_evidence
    FOR EACH ROW EXECUTE FUNCTION workflow_evidence_reject_mutation();

CREATE TRIGGER workflow_evidence_no_truncate
    BEFORE TRUNCATE ON workflow_evidence
    FOR EACH STATEMENT EXECUTE FUNCTION workflow_evidence_reject_mutation();

-- Synchronization attempts are retained even when incomplete or unsuccessful.
CREATE TABLE sync_runs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider text NOT NULL,
    scope text NOT NULL,
    target_order_id bigint,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    status text NOT NULL,
    records_received integer NOT NULL,
    is_complete boolean NOT NULL,
    error_message text,
    CONSTRAINT sync_runs_provider_ck
        CHECK (provider ~ '[^[:space:]]'),
    CONSTRAINT sync_runs_scope_ck
        CHECK (scope ~ '^[A-Z][A-Z0-9_]*$'),
    CONSTRAINT sync_runs_status_ck
        CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'INCOMPLETE')),
    CONSTRAINT sync_runs_records_received_ck
        CHECK (records_received >= 0),
    CONSTRAINT sync_runs_completed_at_ck
        CHECK (completed_at IS NULL OR completed_at >= started_at),
    CONSTRAINT sync_runs_completion_ck
        CHECK (
            (status = 'RUNNING' AND completed_at IS NULL AND NOT is_complete)
            OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND is_complete)
            OR (status IN ('FAILED', 'INCOMPLETE')
                AND completed_at IS NOT NULL AND NOT is_complete)
        ),
    CONSTRAINT sync_runs_scope_target_ck
        CHECK (
            (scope <> 'AMAZON_ORDER_TRACKING' OR target_order_id IS NOT NULL)
            AND (scope NOT IN ('BFMR_MY_TRACKER_FULL', 'GMAIL_HISTORY')
                OR target_order_id IS NULL)
        ),
    CONSTRAINT sync_runs_id_provider_uk
        UNIQUE (id, provider),
    CONSTRAINT sync_runs_target_order_fk
        FOREIGN KEY (target_order_id) REFERENCES orders (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Observations are immutable snapshots; later facts and associations use new rows.
CREATE TABLE provider_observations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email_id bigint,
    deal_id bigint,
    reservation_id bigint,
    order_id bigint,
    shipment_id bigint,
    reimbursement_id bigint,
    sync_run_id bigint,
    provider text NOT NULL,
    resource_type text NOT NULL,
    observed_at timestamptz NOT NULL,
    is_complete boolean NOT NULL,
    response_data jsonb NOT NULL,
    CONSTRAINT provider_observations_provider_ck
        CHECK (provider ~ '[^[:space:]]'),
    CONSTRAINT provider_observations_email_fk
        FOREIGN KEY (email_id) REFERENCES emails (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT provider_observations_deal_fk
        FOREIGN KEY (deal_id) REFERENCES deals (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT provider_observations_reservation_fk
        FOREIGN KEY (reservation_id) REFERENCES reservations (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT provider_observations_order_fk
        FOREIGN KEY (order_id) REFERENCES orders (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT provider_observations_shipment_fk
        FOREIGN KEY (shipment_id) REFERENCES shipments (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT provider_observations_reimbursement_fk
        FOREIGN KEY (reimbursement_id) REFERENCES reimbursements (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT provider_observations_sync_provider_fk
        FOREIGN KEY (sync_run_id, provider) REFERENCES sync_runs (id, provider)
        MATCH SIMPLE ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE FUNCTION reject_provider_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    RAISE EXCEPTION 'provider_observations is append-only; insert a new observation instead'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER provider_observations_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON provider_observations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_provider_observation_mutation();

ALTER TABLE provider_observations
    ENABLE ALWAYS TRIGGER provider_observations_append_only;

-- Unique and primary-key indexes already cover the corresponding FK prefixes.
-- These additional indexes support the remaining association lookups.
CREATE INDEX deal_retailers_retailer_idx ON deal_retailers (retailer_id, deal_id);
CREATE INDEX email_deals_deal_idx ON email_deals (deal_id, email_id);
CREATE INDEX reservations_deal_idx ON reservations (deal_id);
CREATE INDEX reservations_source_email_idx
    ON reservations (source_email_id) WHERE source_email_id IS NOT NULL;
CREATE INDEX orders_account_retailer_idx ON orders (retailer_account_id, retailer_id);
CREATE INDEX orders_deal_retailer_idx ON orders (deal_id, retailer_id);
CREATE INDEX shipments_tracking_number_idx ON shipments (tracking_number);
CREATE INDEX reimbursements_payment_email_idx ON reimbursements (payment_email_id);
CREATE INDEX workflow_evidence_correlation_idx
    ON workflow_evidence (correlation_id, recorded_at, id);
CREATE INDEX workflow_evidence_email_idx
    ON workflow_evidence (email_id, recorded_at, id) WHERE email_id IS NOT NULL;
CREATE INDEX workflow_evidence_reservation_idx
    ON workflow_evidence (reservation_id, recorded_at, id) WHERE reservation_id IS NOT NULL;
CREATE INDEX workflow_evidence_order_idx
    ON workflow_evidence (order_id, recorded_at, id) WHERE order_id IS NOT NULL;

CREATE INDEX sync_runs_provider_scope_status_idx
    ON sync_runs (provider, scope, status, started_at, id);
CREATE INDEX sync_runs_target_order_idx
    ON sync_runs (target_order_id) WHERE target_order_id IS NOT NULL;

CREATE INDEX provider_observations_email_idx
    ON provider_observations (email_id) WHERE email_id IS NOT NULL;
CREATE INDEX provider_observations_deal_idx
    ON provider_observations (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX provider_observations_reservation_idx
    ON provider_observations (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX provider_observations_order_idx
    ON provider_observations (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX provider_observations_shipment_idx
    ON provider_observations (shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX provider_observations_reimbursement_idx
    ON provider_observations (reimbursement_id) WHERE reimbursement_id IS NOT NULL;
CREATE INDEX provider_observations_sync_run_idx
    ON provider_observations (sync_run_id) WHERE sync_run_id IS NOT NULL;

COMMENT ON COLUMN deals.reimbursement_amount IS
    'Current reimbursement per item in USD. Existing reservations retain their saved rate.';
COMMENT ON COLUMN reservations.payout_per_item IS
    'Agreed creation-time USD rate per item; immutable after insertion.';
COMMENT ON COLUMN reservations.quantity IS
    'Creation-time reserved quantity; immutable after insertion.';
COMMENT ON COLUMN reservations.expected_payout IS
    'Generated USD total: immutable creation quantity multiplied by its saved payout_per_item.';
COMMENT ON COLUMN reservations.source_email_id IS
    'Optional triggering email; no matching email_deals association is required.';
COMMENT ON COLUMN orders.order_id IS
    'External retailer order number, unique within its retailer. Internal references use orders.id.';
COMMENT ON COLUMN orders.total_cost IS
    'Required actual retailer order cost in USD; no default is supplied.';
COMMENT ON COLUMN orders.purchase_date IS
    'Required calendar date of purchase; no default is supplied.';
COMMENT ON COLUMN orders.product_identifier IS
    'Required retailer product code, such as an Amazon ASIN; text preserves leading zeros and nonnumeric codes.';
COMMENT ON COLUMN orders.order_time_estimated_delivery_date IS
    'Optional estimated delivery date provided when the order was placed.';
COMMENT ON COLUMN order_status.id IS
    'Stable schema-managed lookup identifier.';
COMMENT ON COLUMN shipments.order_id IS
    'Unique foreign key to the internal orders.id, not the external orders.order_id.';
COMMENT ON COLUMN shipments.tracking_number IS
    'Carrier tracking value; not a globally unique or permanent shipment identifier.';
COMMENT ON COLUMN reimbursements.amount IS
    'Actual USD payment amount from the authoritative payment-sent email.';
COMMENT ON COLUMN retailer_accounts.ccv IS
    'Card verification code retained for automation at user request; see DESIGN_DECISIONS.md.';
COMMENT ON TABLE email_deals IS
    'Email/deal associations only; a link does not authorize a reservation or purchase.';
COMMENT ON TABLE reimbursements IS
    'One actual payment per reservation, sourced from a payment email; no direct shipment foreign key.';

COMMENT ON TABLE workflow_evidence IS
    'Append-only workflow intent, decision, outcome, and reconciliation evidence; not a command queue or permission to retry an external action.';
COMMENT ON COLUMN workflow_evidence.order_id IS
    'Optional foreign key to the internal orders.id, not the external orders.order_id.';
COMMENT ON COLUMN workflow_evidence.correlation_id IS
    'Application-supplied UUID shared by the evidence rows for one workflow; it is not unique per row.';
COMMENT ON COLUMN workflow_evidence.action_type IS
    'Application-defined nonblank action label; no lifecycle or action vocabulary is imposed by this schema.';
COMMENT ON COLUMN workflow_evidence.phase IS
    'Application-defined nonblank workflow phase, such as intent, confirmation, or reconciliation.';
COMMENT ON COLUMN workflow_evidence.outcome IS
    'Optional application-defined outcome; NULL is allowed before an outcome is known.';
COMMENT ON COLUMN workflow_evidence.evidence IS
    'Sanitized structured JSON object only; do not store credentials, card codes, raw authenticated pages, or unredacted messages.';
COMMENT ON COLUMN workflow_evidence.recorded_at IS
    'Local evidence-recording timestamp; not proof of provider completion or a provider event timestamp.';

COMMENT ON TABLE provider_observations IS
    'Append-only provider observations; corrections and later associations require new rows.';
COMMENT ON COLUMN provider_observations.order_id IS
    'Optional foreign key to internal orders.id, not the external retailer order number.';
COMMENT ON COLUMN provider_observations.is_complete IS
    'Application-supplied assessment against the defined completeness requirements.';
COMMENT ON COLUMN provider_observations.response_data IS
    'Selected provider-reported facts; application code must sanitize the payload before insertion.';
COMMENT ON TABLE sync_runs IS
    'Synchronization attempts; one run may have many provider observations.';
COMMENT ON COLUMN sync_runs.status IS
    'RUNNING, COMPLETED, FAILED, or INCOMPLETE; completion time and completeness must match the state.';
COMMENT ON COLUMN sync_runs.is_complete IS
    'Application-supplied assessment that the required scope was retrieved and validated.';
COMMENT ON COLUMN sync_runs.error_message IS
    'Optional failure or incompleteness details; application code must sanitize before storage.';

COMMENT ON COLUMN sync_runs.scope IS
    'Required uppercase scope identifier defining collection coverage; extension scopes require an application contract.';
COMMENT ON COLUMN sync_runs.target_order_id IS
    'Internal orders.id; required for AMAZON_ORDER_TRACKING and absent for BFMR_MY_TRACKER_FULL or GMAIL_HISTORY.';
COMMENT ON COLUMN provider_observations.sync_run_id IS
    'Optional run association; a linked observation must have exactly the same provider as its run.';

COMMIT;
