-- Immutable reservation payout upgrade, 20 October 2026.
-- Apply once, after backup/review and reconciliation of actual creation terms,
-- to an existing schema with the stored generated quantity * payout_per_item
-- expected_payout column (baseline fc5d503a82833fcbf4c5651bbfb1d8dcf96eb871).
-- Existing rows and the generated expression are not rewritten or backfilled.
-- The guard protects the stored terms going forward; it cannot establish that
-- existing values are the original terms. Never backfill from today's deal rate.
BEGIN;
SET LOCAL search_path = public;

-- Wait for concurrent writers and prevent writes during guard installation.
LOCK TABLE public.reservations IN SHARE ROW EXCLUSIVE MODE;

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

COMMENT ON COLUMN public.reservations.payout_per_item IS
    'Agreed creation-time USD rate per item; immutable after insertion.';
COMMENT ON COLUMN public.reservations.quantity IS
    'Creation-time reserved quantity; immutable after insertion.';
COMMENT ON COLUMN public.reservations.expected_payout IS
    'Generated USD total: immutable creation quantity multiplied by its saved payout_per_item.';

COMMIT;
