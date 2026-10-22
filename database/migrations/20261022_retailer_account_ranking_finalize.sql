-- Stage 2 of the retailer-account ranking upgrade, after explicit operator
-- backfill. This script assigns/changes NO ranks and performs no provider action.
-- Stop the worker, verify the actual stage-1 baseline and preserve backups first.
BEGIN;
SET LOCAL search_path = public;
LOCK TABLE public.retailer_accounts IN ACCESS EXCLUSIVE MODE;

DO $ranking_baseline$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = 'public.retailer_accounts'::regclass
          AND a.attname = 'retailer_account_ranking'
          AND NOT a.attisdropped
          AND a.atttypid = 'pg_catalog.int4'::regtype
          AND NOT a.attnotnull
          AND a.attidentity = '' AND a.attgenerated = ''
          AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.pg_attrdef AS d
              WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum
          )
    ) THEN
        RAISE EXCEPTION
            'Ranking finalization requires the reviewed nullable integer column without a default or generation'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS c
        JOIN pg_catalog.pg_index AS i ON i.indexrelid = c.conindid
        WHERE c.conrelid = 'public.retailer_accounts'::regclass
          AND c.conname = 'retailer_accounts_retailer_ranking_uk'
          AND c.contype = 'u' AND c.convalidated
          AND i.indisunique AND i.indisvalid
          AND c.conkey = ARRAY[
              (SELECT a.attnum FROM pg_catalog.pg_attribute AS a
               WHERE a.attrelid = c.conrelid AND a.attname = 'retailer_id' AND NOT a.attisdropped),
              (SELECT a.attnum FROM pg_catalog.pg_attribute AS a
               WHERE a.attrelid = c.conrelid AND a.attname = 'retailer_account_ranking' AND NOT a.attisdropped)
          ]::smallint[]
    ) THEN
        RAISE EXCEPTION
            'Ranking finalization requires the reviewed per-retailer unique ranking constraint'
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (SELECT 1 FROM public.retailer_accounts WHERE retailer_account_ranking IS NULL) THEN
        RAISE EXCEPTION
            'Ranking finalization refused: explicitly assign reviewed ranks to every existing retailer account first'
            USING ERRCODE = '23502';
    END IF;
END;
$ranking_baseline$;

ALTER TABLE public.retailer_accounts
    ALTER COLUMN retailer_account_ranking SET NOT NULL;

COMMENT ON COLUMN public.retailer_accounts.retailer_account_ranking IS
    'Explicit integer preference within the retailer; lowest rank is selected. No default or inferred backfill.';

COMMIT;
