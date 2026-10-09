// Type definitions matching PostgreSQL schema from v1.5 Page 12

export type RunMode = 'testing' | 'production';
export type RunStatus = 'STARTING' | 'ACTIVE' | 'SHUTTING_DOWN' | 'TERMINATED';

export interface RunRow {
  id: string;
  mode: RunMode;
  created_at: string;
  listener_started_at: string | null;
  ended_at: string | null;
  config_version: string;
  status: RunStatus;
}

export interface InboundEventRow {
  id: string;
  subscription: string;
  provider_message_id: string;
  mailbox: string;
  history_id: number;
  run_id: string | null;
  state: 'RECEIVED' | 'PROCESSED' | 'REJECTED';
  received_at: string;
}

export interface GmailStateRow {
  mailbox: string;
  consumed_history_id: number;
  watch_baseline_history_id: number;
  watch_expiration: string;
  last_success_at: string | null;
  intake_state: 'ACTIVE' | 'GMAIL_HISTORY_GAP' | 'STOPPED';
  initialization_marker: boolean;
}

export type EmailClassification = 'SINGLE_DEAL' | 'MULTI_DEAL' | 'ADDITIONAL_SLOTS' | 'UNRELATED' | 'AMBIGUOUS';

export interface EmailRow {
  id: string;
  mailbox: string;
  gmail_id: string;
  internal_date: number;
  outer_sender: string;
  auth_result: string;
  inbox_at_fetch: boolean;
  admission_run_id: string | null;
  classification: EmailClassification;
  candidate_refs: any;
  content_hash: string;
}

export interface DealObservationRow {
  id: string;
  account_id: string;
  deal_id: string;
  email_ref: string;
  canonical_url: string | null;
  offer_id: string | null;
  color: string | null;
  bundle_components: any;
  observed_at: string;
}

export type CommandKind = 'AUTO' | 'CLI';
export type CommandState = 
  | 'QUEUED'
  | 'CHECKING'
  | 'WAIT_STATUS'
  | 'READY'
  | 'SUBMITTING'
  | 'RECONCILING'
  | 'RETRY_PENDING'
  | 'RESERVED'
  | 'SKIPPED'
  | 'REVIEW'
  | 'EXHAUSTED';

export interface CommandRow {
  id: string;
  email_id: string;
  admission_run_id: string;
  execution_run_id: string | null;
  kind: CommandKind;
  request_id: string;
  state: CommandState;
  attempt_count: number; // 0..2
  queue_time: string;
  monotonic_sequence: number;
  deal_id: string;
}

export type AttemptResult = 'SUCCESS' | 'UNCERTAIN' | 'FAILED' | 'CLOSED_NO_SLOTS' | 'CONFLICT';

export interface AttemptRow {
  id: string;
  command_id: string;
  ordinal: 1 | 2;
  account_id: string;
  deal_id: string;
  selected_offer: string;
  quantity: 1; // CHECK quantity = 1 strictly
  prepared_at: string;
  invoked_at: string | null;
  result: AttemptResult | null;
  reservation_id: string | null;
  evidence: any;
}

export interface DealBlockRow {
  id: string;
  run_id: string;
  account_id: string;
  deal_id: string;
  type: 'REVIEW' | 'EXHAUSTED';
  reason: string;
  opened_at: string;
  resolved_at: string | null;
}

export interface IncidentRow {
  id: string;
  scope: string;
  type: string;
  episode: string;
  state: 'ACTIVE' | 'RESOLVED';
  opened_at: string;
  resolved_at: string | null;
  disposition: string | null;
}

export interface NotificationOutboxRow {
  id: string;
  incident_id: string;
  phase: 'ALERT' | 'RECOVERY';
  state: 'PENDING' | 'SENT' | 'FAILED';
  due_at: string;
  tries: number;
  telegram_message_id: number | null;
}

export interface RuntimeGateRow {
  gate_name: string;
  reason: string;
  since: string;
}

export interface WorkflowEventRow {
  id: string;
  actor: string;
  correlation_id: string | null;
  causation_id: string | null;
  run_id: string | null;
  command_id: string | null;
  attempt_id: string | null;
  event_type: string;
  detail: any;
  created_at: string;
}
