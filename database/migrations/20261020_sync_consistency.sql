-- Synchronization consistency upgrade, 20 October 2026.
-- Apply once to the schema immediately preceding this change.
-- Existing runs need real scope backfill and any state/timestamp reconciliation.
-- See DESIGN_DECISIONS.md for the nullable-column preparation step.
-- No provider normalization, guessed historical scopes, or observation edits occur.
BEGIN;
SET LOCAL search_path = public;

ALTER TABLE sync_runs
    ADD COLUMN IF NOT EXISTS scope text,
    ADD COLUMN IF NOT EXISTS target_order_id bigint,
    ALTER COLUMN scope SET NOT NULL,
    ADD CONSTRAINT sync_runs_provider_ck
        CHECK (provider ~ '[^[:space:]]'),
    ADD CONSTRAINT sync_runs_scope_ck
        CHECK (scope ~ '^[A-Z][A-Z0-9_]*$'),
    ADD CONSTRAINT sync_runs_status_ck
        CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'INCOMPLETE')),
    ADD CONSTRAINT sync_runs_completed_at_ck
        CHECK (completed_at IS NULL OR completed_at >= started_at),
    ADD CONSTRAINT sync_runs_completion_ck
        CHECK (
            (status = 'RUNNING' AND completed_at IS NULL AND NOT is_complete)
            OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND is_complete)
            OR (status IN ('FAILED', 'INCOMPLETE')
                AND completed_at IS NOT NULL AND NOT is_complete)
        ),
    ADD CONSTRAINT sync_runs_scope_target_ck
        CHECK (
            (scope <> 'AMAZON_ORDER_TRACKING' OR target_order_id IS NOT NULL)
            AND (scope NOT IN ('BFMR_MY_TRACKER_FULL', 'GMAIL_HISTORY')
                OR target_order_id IS NULL)
        ),
    ADD CONSTRAINT sync_runs_id_provider_uk
        UNIQUE (id, provider),
    ADD CONSTRAINT sync_runs_target_order_fk
        FOREIGN KEY (target_order_id) REFERENCES orders (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE provider_observations
    ADD CONSTRAINT provider_observations_provider_ck
        CHECK (provider ~ '[^[:space:]]'),
    DROP CONSTRAINT provider_observations_sync_run_fk,
    ADD CONSTRAINT provider_observations_sync_provider_fk
        FOREIGN KEY (sync_run_id, provider) REFERENCES sync_runs (id, provider)
        MATCH SIMPLE ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE INDEX sync_runs_provider_scope_status_idx
    ON sync_runs (provider, scope, status, started_at, id);
CREATE INDEX sync_runs_target_order_idx
    ON sync_runs (target_order_id) WHERE target_order_id IS NOT NULL;

COMMENT ON COLUMN sync_runs.status IS
    'RUNNING, COMPLETED, FAILED, or INCOMPLETE; completion time and completeness must match the state.';
COMMENT ON COLUMN sync_runs.scope IS
    'Required uppercase scope identifier defining collection coverage; extension scopes require an application contract.';
COMMENT ON COLUMN sync_runs.target_order_id IS
    'Internal orders.id; required for AMAZON_ORDER_TRACKING and absent for BFMR_MY_TRACKER_FULL or GMAIL_HISTORY.';
COMMENT ON COLUMN provider_observations.sync_run_id IS
    'Optional run association; a linked observation must have exactly the same provider as its run.';

COMMIT;
