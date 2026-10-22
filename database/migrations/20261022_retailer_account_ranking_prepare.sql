-- Stage 1 of the retailer-account ranking upgrade. Run once against the reviewed
-- pre-ranking business schema, separately from worker startup/fresh installation.
-- Stop the worker and preserve a reviewed backup first. This script deliberately
-- assigns NO ranks: every existing account remains NULL for operator review.
-- Do not start the worker until explicit backfill and stage 2 are complete.
BEGIN;
SET LOCAL search_path = public;
LOCK TABLE public.retailer_accounts IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.retailer_accounts
    ADD COLUMN retailer_account_ranking integer,
    ADD CONSTRAINT retailer_accounts_retailer_ranking_uk
        UNIQUE (retailer_id, retailer_account_ranking);

COMMENT ON COLUMN public.retailer_accounts.retailer_account_ranking IS
    'Upgrade incomplete: operator must assign explicit unique integer ranks within each retailer, then apply ranking finalization.';

COMMIT;

-- Separately review every account and supply the intended rank explicitly.
-- No default, row-number, account-ID ordering or other automatic assignment is
-- authorized by this migration. Integer ranks may be negative, zero or positive.
-- After the reviewed backfill, apply 20261022_retailer_account_ranking_finalize.sql.
