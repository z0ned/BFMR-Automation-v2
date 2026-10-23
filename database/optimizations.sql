-- ====================================================================
-- BFMR Automation v2 - Production Optimizations & Hardening
-- Applicable to PostgreSQL 15+ (Verified on PostgreSQL 17)
-- ====================================================================

BEGIN;
LOCK TABLE public.reservations, public.reimbursements IN SHARE ROW EXCLUSIVE MODE;

-- 1. Index Optimizations
-- Accelerate cutover state and order state inspections
CREATE INDEX IF NOT EXISTS idx_workflow_evidence_cutover
ON public.workflow_evidence (action_type, phase, outcome)
WHERE action_type IN ('RELATIONAL_CUTOVER', 'AMAZON_ORDER_STATE');

-- Accelerate open exposure checks (< $200.00 boundary)
CREATE INDEX IF NOT EXISTS idx_reservations_open_exposure
ON public.reservations (id, expected_payout)
WHERE reservation_status_id != 2;

-- Accelerate order lookups by retailer order ID
CREATE INDEX IF NOT EXISTS idx_orders_order_id
ON public.orders (order_id);

-- 2. Conservative reservation-payout ceiling, separate from checkout's
-- authoritative complete-provider-coverage + proposed Amazon cost gate.
-- All competing writes share this lock. READ COMMITTED takes a fresh snapshot
-- after waiting; SERIALIZABLE uses SSI and may abort a competing transaction.
-- REPEATABLE READ is refused because its stale snapshot is unsafe here.
CREATE OR REPLACE FUNCTION check_max_unreimbursed_exposure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_exposure numeric;
    incoming_payout numeric := 0;
    excluded_id bigint := NULL;
BEGIN
    IF current_setting('transaction_isolation') = 'repeatable read' THEN
        RAISE EXCEPTION 'Exposure writes require READ COMMITTED or SERIALIZABLE'
            USING ERRCODE = '25000';
    END IF;
    PERFORM pg_advisory_xact_lock(194832761, 200);
    IF TG_TABLE_NAME = 'reservations' THEN
        excluded_id := NEW.id;
        IF NEW.reservation_status_id <> 2 THEN
            SELECT GREATEST(NEW.quantity * NEW.payout_per_item - COALESCE(SUM(amount), 0), 0)
              INTO incoming_payout FROM public.reimbursements WHERE reservation_id=NEW.id;
        END IF;
    END IF;
    SELECT COALESCE(SUM(GREATEST(r.expected_payout - COALESCE(re.amount, 0), 0)), 0)
      INTO current_exposure
      FROM public.reservations r
      LEFT JOIN public.reimbursements re ON re.reservation_id=r.id
      WHERE r.reservation_status_id <> 2 AND r.id IS DISTINCT FROM excluded_id;
    IF current_exposure + incoming_payout > 200.00 THEN
        RAISE EXCEPTION 'Unreimbursed reservation payouts exceed $200.00'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL; -- AFTER statement/row trigger return values are ignored.
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_exposure_cap ON public.reservations;
CREATE TRIGGER trg_enforce_exposure_cap
    AFTER INSERT OR UPDATE ON public.reservations
    FOR EACH ROW EXECUTE FUNCTION check_max_unreimbursed_exposure();
DROP TRIGGER IF EXISTS trg_reimbursement_exposure_cap ON public.reimbursements;
CREATE TRIGGER trg_reimbursement_exposure_cap
    AFTER INSERT OR UPDATE OR DELETE ON public.reimbursements
    FOR EACH ROW EXECUTE FUNCTION check_max_unreimbursed_exposure();

-- 3. PCI-DSS Compliance: Drop unused plaintext CCV storage
ALTER TABLE public.retailer_accounts DROP COLUMN IF EXISTS ccv;


-- Refuse adoption over an already-over-limit baseline; never rewrite payments
-- or reservation terms to make the installation pass.
DO $$ BEGIN
 IF (SELECT COALESCE(SUM(GREATEST(r.expected_payout-COALESCE(re.amount,0),0)),0)
     FROM public.reservations r LEFT JOIN public.reimbursements re ON re.reservation_id=r.id
     WHERE r.reservation_status_id<>2) > 200 THEN
   RAISE EXCEPTION 'Existing unreimbursed payouts require review before ceiling installation' USING ERRCODE='23514';
 END IF;
END $$;
COMMIT;
