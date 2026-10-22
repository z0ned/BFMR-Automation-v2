-- Additive PostgreSQL 15+ operational intake contract, separate from schema.sql.
-- Install once under separate operator authorization; runtime never executes DDL.
-- Raw authenticated message bodies/headers in gmail_intake_work are PRIVATE.
-- Back up these tables together. Do not reset lost cursors or replay PROCESSING.
BEGIN;
SET LOCAL search_path = public;

CREATE TABLE gmail_intake_state (
    account_namespace text PRIMARY KEY,
    mailbox text NOT NULL UNIQUE,
    subscription text NOT NULL UNIQUE,
    topic text NOT NULL,
    consumed_cursor text,
    history_gap boolean NOT NULL DEFAULT false,
    watch_baseline text,
    watch_expires_at timestamptz,
    watch_renewed_at timestamptz,
    legacy_source_sha256 text,
    legacy_import_fingerprint text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT gmail_intake_state_scope_uk UNIQUE (account_namespace, subscription),
    CONSTRAINT gmail_intake_state_identity_ck CHECK (
        account_namespace <> '' AND mailbox <> '' AND mailbox = lower(btrim(mailbox))
        AND subscription <> '' AND topic <> ''),
    CONSTRAINT gmail_intake_state_cursor_ck CHECK (
        consumed_cursor IS NULL OR consumed_cursor ~ '^[0-9]+$'),
    CONSTRAINT gmail_intake_state_watch_ck CHECK (
        (watch_baseline IS NULL AND watch_expires_at IS NULL AND watch_renewed_at IS NULL)
        OR (watch_baseline ~ '^[0-9]+$' AND watch_baseline IS NOT NULL
            AND watch_expires_at IS NOT NULL AND watch_renewed_at IS NOT NULL
            AND watch_expires_at > watch_renewed_at)),
    CONSTRAINT gmail_intake_state_import_ck CHECK (
        (legacy_source_sha256 IS NULL AND legacy_import_fingerprint IS NULL)
        OR (legacy_source_sha256 ~ '^[0-9a-f]{64}$' AND legacy_source_sha256 IS NOT NULL
            AND legacy_import_fingerprint ~ '^[0-9a-f]{64}$' AND legacy_import_fingerprint IS NOT NULL))
);

CREATE TABLE gmail_intake_runs (
    id uuid PRIMARY KEY,
    account_namespace text NOT NULL,
    state text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    activated_at timestamptz,
    stopped_at timestamptz,
    CONSTRAINT gmail_intake_runs_scope_uk UNIQUE (id, account_namespace),
    CONSTRAINT gmail_intake_runs_account_fk FOREIGN KEY (account_namespace)
        REFERENCES gmail_intake_state (account_namespace) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT gmail_intake_runs_lifecycle_ck CHECK (
        (state = 'STARTING' AND activated_at IS NULL AND stopped_at IS NULL)
        OR (state = 'ACTIVE' AND activated_at IS NOT NULL AND stopped_at IS NULL)
        OR (state = 'STOPPED' AND stopped_at IS NOT NULL)),
    CONSTRAINT gmail_intake_runs_times_ck CHECK (
        (activated_at IS NULL OR activated_at >= started_at)
        AND (stopped_at IS NULL OR stopped_at >= started_at))
);

CREATE TABLE gmail_intake_notifications (
    subscription text NOT NULL,
    message_id text NOT NULL,
    account_namespace text NOT NULL,
    run_id uuid NOT NULL,
    payload_sha256 text NOT NULL,
    history_id text,
    rejection text,
    state text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz,
    PRIMARY KEY (subscription, message_id),
    CONSTRAINT gmail_intake_notifications_scope_fk FOREIGN KEY (account_namespace, subscription)
        REFERENCES gmail_intake_state (account_namespace, subscription) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT gmail_intake_notifications_run_fk FOREIGN KEY (run_id, account_namespace)
        REFERENCES gmail_intake_runs (id, account_namespace) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT gmail_intake_notifications_identity_ck CHECK (
        message_id <> '' AND payload_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT gmail_intake_notifications_state_ck CHECK (
        (state = 'REJECTED' AND rejection ~ '^[A-Z][A-Z0-9_]*$' AND rejection IS NOT NULL
            AND history_id IS NULL AND consumed_at IS NOT NULL)
        OR (state = 'PENDING' AND rejection IS NULL AND history_id ~ '^[0-9]+$'
            AND history_id IS NOT NULL AND consumed_at IS NULL)
        OR (state = 'CONSUMED' AND rejection IS NULL AND history_id ~ '^[0-9]+$'
            AND history_id IS NOT NULL AND consumed_at IS NOT NULL))
);

CREATE TABLE gmail_intake_work (
    account_namespace text NOT NULL,
    gmail_message_id text NOT NULL,
    state text NOT NULL,
    payload jsonb,
    payload_sha256 text,
    received_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_namespace, gmail_message_id),
    CONSTRAINT gmail_intake_work_account_fk FOREIGN KEY (account_namespace)
        REFERENCES gmail_intake_state (account_namespace) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT gmail_intake_work_identity_ck CHECK (gmail_message_id <> ''),
    CONSTRAINT gmail_intake_work_hash_ck CHECK (
        (payload_sha256 IS NULL AND state = 'DONE') OR payload_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT gmail_intake_work_state_ck CHECK (
        (state = 'DONE' AND payload IS NULL)
        OR (state = ANY (ARRAY['PENDING', 'PROCESSING']) AND payload IS NOT NULL AND payload_sha256 IS NOT NULL
            AND jsonb_typeof(payload) = 'object'
            AND COALESCE(payload->>'id' = gmail_message_id,false)
            AND COALESCE(jsonb_typeof(payload->'sender') = 'string',false)
            AND COALESCE(jsonb_typeof(payload->'subject') = 'string',false)
            AND COALESCE(jsonb_typeof(payload->'body') = 'string',false)
            AND COALESCE(jsonb_typeof(payload->'receivedAt') = 'string',false)))
);

CREATE INDEX gmail_intake_notifications_pending_idx
    ON gmail_intake_notifications (account_namespace, received_at, message_id) WHERE state = 'PENDING';
CREATE INDEX gmail_intake_work_pending_idx
    ON gmail_intake_work (account_namespace, received_at, gmail_message_id) WHERE state <> 'DONE';
CREATE UNIQUE INDEX gmail_intake_one_live_run_idx ON gmail_intake_runs (account_namespace)
    WHERE state IN ('STARTING', 'ACTIVE');

COMMENT ON TABLE gmail_intake_state IS
    'Private authoritative Gmail cursor/watch state. Renewal never replaces consumed_cursor.';
COMMENT ON TABLE gmail_intake_notifications IS
    'Durable notification/rejection evidence, unique subscription/message identity; ACK only after commit.';
COMMENT ON TABLE gmail_intake_work IS
    'Private queued authenticated Gmail payloads and retained DONE tombstones. Never log or export payloads.';
COMMENT ON TABLE gmail_intake_runs IS
    'Intake startup activation barrier. Existing provider/browser actions are not part of this transaction.';
COMMIT;
