-- BFMR Solution Design Specification v1.5 - Initial PostgreSQL Schema
-- Page 12 Data Model and Invariants

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('testing', 'production')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    listener_started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    config_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('STARTING', 'ACTIVE', 'SHUTTING_DOWN', 'TERMINATED'))
);

CREATE TABLE IF NOT EXISTS inbound_events (
    id TEXT PRIMARY KEY,
    subscription TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    mailbox TEXT NOT NULL,
    history_id BIGINT NOT NULL,
    run_id TEXT REFERENCES runs(id),
    state TEXT NOT NULL CHECK (state IN ('RECEIVED', 'PROCESSED', 'REJECTED')),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_subscription_provider_msg UNIQUE (subscription, provider_message_id)
);

CREATE TABLE IF NOT EXISTS gmail_state (
    mailbox TEXT PRIMARY KEY,
    consumed_history_id BIGINT NOT NULL,
    watch_baseline_history_id BIGINT NOT NULL,
    watch_expiration TIMESTAMPTZ NOT NULL,
    last_success_at TIMESTAMPTZ,
    intake_state TEXT NOT NULL CHECK (intake_state IN ('ACTIVE', 'GMAIL_HISTORY_GAP', 'STOPPED')),
    initialization_marker BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    mailbox TEXT NOT NULL,
    gmail_id TEXT NOT NULL,
    internal_date BIGINT NOT NULL,
    outer_sender TEXT NOT NULL,
    auth_result TEXT NOT NULL,
    inbox_at_fetch BOOLEAN NOT NULL,
    admission_run_id TEXT REFERENCES runs(id),
    classification TEXT NOT NULL CHECK (classification IN ('SINGLE_DEAL', 'MULTI_DEAL', 'ADDITIONAL_SLOTS', 'UNRELATED', 'AMBIGUOUS')),
    candidate_refs JSONB,
    content_hash TEXT NOT NULL,
    CONSTRAINT uq_mailbox_gmail_id UNIQUE (mailbox, gmail_id)
);

CREATE TABLE IF NOT EXISTS deal_observations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    deal_id TEXT NOT NULL,
    email_ref TEXT NOT NULL,
    canonical_url TEXT,
    offer_id TEXT,
    color TEXT,
    bundle_components JSONB,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    email_id TEXT REFERENCES emails(id),
    admission_run_id TEXT REFERENCES runs(id),
    execution_run_id TEXT REFERENCES runs(id),
    kind TEXT NOT NULL CHECK (kind IN ('AUTO', 'CLI')),
    request_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('QUEUED', 'CHECKING', 'WAIT_STATUS', 'READY', 'SUBMITTING', 'RECONCILING', 'RETRY_PENDING', 'RESERVED', 'SKIPPED', 'REVIEW', 'EXHAUSTED')),
    attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
    queue_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    monotonic_sequence BIGSERIAL,
    deal_id TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    command_id TEXT REFERENCES commands(id),
    ordinal INT NOT NULL CHECK (ordinal IN (1, 2)),
    account_id TEXT NOT NULL,
    deal_id TEXT NOT NULL,
    selected_offer TEXT NOT NULL,
    quantity INT NOT NULL CHECK (quantity = 1),
    prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invoked_at TIMESTAMPTZ,
    result TEXT CHECK (result IN ('SUCCESS', 'UNCERTAIN', 'FAILED', 'CLOSED_NO_SLOTS', 'CONFLICT')),
    reservation_id TEXT,
    evidence JSONB,
    CONSTRAINT uq_command_ordinal UNIQUE (command_id, ordinal)
);

CREATE TABLE IF NOT EXISTS deal_blocks (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES runs(id),
    account_id TEXT NOT NULL,
    deal_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('REVIEW', 'EXHAUSTED')),
    reason TEXT NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    CONSTRAINT uq_run_deal_block UNIQUE (run_id, account_id, deal_id, type)
);

CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    type TEXT NOT NULL,
    episode TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'RESOLVED')),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    disposition TEXT
);

CREATE TABLE IF NOT EXISTS notification_outbox (
    id TEXT PRIMARY KEY,
    incident_id TEXT REFERENCES incidents(id),
    phase TEXT NOT NULL CHECK (phase IN ('ALERT', 'RECOVERY')),
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'SENT', 'FAILED')),
    due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tries INT NOT NULL DEFAULT 0,
    telegram_message_id BIGINT,
    CONSTRAINT uq_incident_phase UNIQUE (incident_id, phase)
);

CREATE TABLE IF NOT EXISTS runtime_gates (
    gate_name TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    since TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_events (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    correlation_id TEXT,
    causation_id TEXT,
    run_id TEXT,
    command_id TEXT,
    attempt_id TEXT,
    event_type TEXT NOT NULL,
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance and invariant checks
CREATE INDEX IF NOT EXISTS idx_commands_queue ON commands(queue_time, state);
CREATE INDEX IF NOT EXISTS idx_attempts_unresolved ON attempts(result) WHERE result = 'UNCERTAIN';
CREATE INDEX IF NOT EXISTS idx_deal_blocks_active ON deal_blocks(deal_id, run_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_due ON notification_outbox(state, due_at) WHERE state = 'PENDING';
