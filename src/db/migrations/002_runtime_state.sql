-- Atomic durable state for one account worker. JSONB contains all business tables;
-- row locking serializes transactions and a dedicated session advisory lock owns the account.
CREATE TABLE IF NOT EXISTS bfmr_runtime_state (
  account_namespace text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
