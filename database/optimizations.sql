-- ====================================================================
-- BFMR Automation v2 - Production Optimizations & Hardening
-- Applicable to PostgreSQL 15+ (Verified on PostgreSQL 17)
-- ====================================================================

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

-- 2. Database-Enforced Financial Exposure Boundary ($200.00 Hard Cap)
CREATE OR REPLACE FUNCTION check_max_unreimbursed_exposure()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_exposure numeric(12,2);
    incoming_payout numeric(12,2);
BEGIN
    -- Canceled reservations (status 2) do not add exposure
    IF NEW.reservation_status_id = 2 THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(SUM(expected_payout), 0)
    INTO current_exposure
    FROM public.reservations r
    WHERE r.reservation_status_id != 2
      AND NOT EXISTS (
          SELECT 1 FROM public.reimbursements re WHERE re.reservation_id = r.id
      );

    incoming_payout := (NEW.quantity * NEW.payout_per_item);

    IF (current_exposure + incoming_payout) > 200.00 THEN
        RAISE EXCEPTION 'Total unreimbursed exposure ($%) exceeds maximum allowable limit of $200.00',
            (current_exposure + incoming_payout)
            USING ERRCODE = '23514'; -- check_violation
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_exposure_cap ON public.reservations;

CREATE TRIGGER trg_enforce_exposure_cap
    BEFORE INSERT ON public.reservations
    FOR EACH ROW
    EXECUTE FUNCTION check_max_unreimbursed_exposure();

-- 3. PCI-DSS Compliance: Drop unused plaintext CCV storage
ALTER TABLE public.retailer_accounts DROP COLUMN IF EXISTS ccv;

