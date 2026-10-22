import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { GmailQueueState, QueuedEmail } from './gmailIntakeQueue';
import type { BusinessQueryable } from '../db/relationalTypes';

export interface GmailIntakeClient extends BusinessQueryable { release(destroy?: boolean): void }
export interface GmailIntakePool {
  connect(): Promise<GmailIntakeClient>;
  end(): Promise<void>;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}

export interface GmailIntakeOptions {
  account: string;
  mailbox: string;
  subscription: string;
  topic: string;
  verifyOwnership: () => Promise<void>;
}
export interface GmailNotificationEvidence {
  messageId: string;
  payloadSha256: string;
  historyId: string | null;
  rejection: string | null;
}
export interface LegacyGmailImportAssessment {
  ready: boolean;
  alreadyAccepted: boolean;
}
export class GmailIntakeStorageError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'GmailIntakeStorageError'; }
}
function demand(value: unknown, code: string): asserts value {
  if (!value) throw new GmailIntakeStorageError(code);
}
const digits = (value: unknown): value is string => typeof value === 'string' && /^[0-9]+$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
// PostgreSQL deparsing adds casts/parentheses to these simple closed checks.
// Compare the complete expression, not just a constraint with a matching name.
const normalizedCheck = (value: string): string => value.replace(/^CHECK\s*/i, '').replace(/::text(?:\[\])?/g, '')
  .replace(/\s|[()]/g, '').replace(/ARRAY\[/g, 'array[').replace(/ANY/g, 'any');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};
function validateEmail(value: QueuedEmail): void {
  demand(value && validId(value.id) && typeof value.sender === 'string' && typeof value.subject === 'string'
    && typeof value.body === 'string' && typeof value.receivedAt === 'string'
    && Number.isFinite(Date.parse(value.receivedAt)), 'GMAIL_INTAKE_INVALID_EMAIL');
  demand(value.inboxAtFetch === undefined || typeof value.inboxAtFetch === 'boolean', 'GMAIL_INTAKE_INVALID_EMAIL');
  demand(value.intakeDisposition === undefined || ['ADMITTED', 'IGNORED'].includes(value.intakeDisposition),
    'GMAIL_INTAKE_INVALID_EMAIL');
  demand(value.headers === undefined || Array.isArray(value.headers) && value.headers.every(h => h &&
    (h.name == null || typeof h.name === 'string') && (h.value == null || typeof h.value === 'string')),
  'GMAIL_INTAKE_INVALID_EMAIL');
}
function validateQueue(state: GmailQueueState, mailbox: string): void {
  demand(state && state.mailbox === mailbox && digits(state.cursor) && typeof state.gap === 'boolean'
    && Array.isArray(state.work), 'GMAIL_INTAKE_INVALID_QUEUE');
  const ids = new Set<string>();
  for (const item of state.work) {
    demand(item && validId(item.id) && !ids.has(item.id)
      && ['PENDING', 'PROCESSING', 'DONE'].includes(item.state), 'GMAIL_INTAKE_INVALID_QUEUE');
    ids.add(item.id);
    if (item.state !== 'DONE') {
      demand(item.email?.id === item.id, 'GMAIL_INTAKE_INVALID_QUEUE'); validateEmail(item.email!);
    } else demand(item.email === undefined, 'GMAIL_INTAKE_INVALID_QUEUE');
  }
}
/** Pure report/apply validation; does not touch PostgreSQL or a provider. */
export function validateLegacyGmailQueue(value: unknown, mailbox: string): asserts value is GmailQueueState {
  const state = value as GmailQueueState;
  validateQueue(state, mailbox);
  demand(!state.gap && state.work.every(item => item.state !== 'PROCESSING'),
    'GMAIL_INTAKE_LEGACY_RECONCILIATION_REQUIRED');
}
type StateRow = { account_namespace: string; mailbox: string; subscription: string; topic: string;
  consumed_cursor: string | null; history_gap: boolean; legacy_source_sha256: string | null;
  legacy_import_fingerprint: string | null; watch_expires_at: Date | null; watch_renewed_at: Date | null };

/** Dedicated private operational store. No DDL, automatic import or transaction retry. */
export class PostgresGmailIntakeStore {
  private readonly pool: GmailIntakePool;
  private validated = false;
  private unavailable = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private tail: Promise<void> = Promise.resolve();
  constructor(connectionString: string, private readonly options: GmailIntakeOptions, dependencies: { pool?: GmailIntakePool } = {}) {
    demand(connectionString && options.account.trim() && options.mailbox === options.mailbox.trim().toLowerCase()
      && options.mailbox.includes('@') && /^projects\/[^/]+\/subscriptions\/[^/]+$/.test(options.subscription)
      && /^projects\/[^/]+\/topics\/[^/]+$/.test(options.topic), 'GMAIL_INTAKE_CONFIGURATION_INVALID');
    this.pool = dependencies.pool ?? new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000,
      statement_timeout: 30000, application_name: 'bfmr:gmail-intake' });
    this.pool.on?.('error', () => { this.unavailable = true; });
  }
  private async transaction<T>(fn: (client: GmailIntakeClient) => Promise<T>, readOnly = false, schemaCheck = false): Promise<T> {
    const prior = this.tail; let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    let client: GmailIntakeClient | undefined;
    let destroy = false;
    try {
      demand(!this.closed && !this.unavailable, 'GMAIL_INTAKE_STORAGE_UNAVAILABLE');
      demand(schemaCheck || this.validated, 'GMAIL_INTAKE_SCHEMA_NOT_VALIDATED');
      await this.options.verifyOwnership();
      client = await this.pool.connect();
      await client.query(`BEGIN ISOLATION LEVEL SERIALIZABLE${readOnly ? ' READ ONLY' : ''}`);
      const result = await fn(client);
      await this.options.verifyOwnership();
      await client.query('COMMIT');
      await this.options.verifyOwnership();
      return result;
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch { destroy = true; }
      if (error instanceof GmailIntakeStorageError) throw error;
      throw new GmailIntakeStorageError('GMAIL_INTAKE_STORAGE_FAILURE_RECONCILE_BEFORE_RETRY');
    } finally { client?.release(destroy); release(); }
  }
  private async state(client: GmailIntakeClient, lock = false): Promise<StateRow | null> {
    const result = await client.query<StateRow>(`SELECT * FROM public.gmail_intake_state
      WHERE account_namespace=$1${lock ? ' FOR UPDATE' : ''}`, [this.options.account]);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    demand(row.mailbox === this.options.mailbox && row.subscription === this.options.subscription
      && row.topic === this.options.topic, 'GMAIL_INTAKE_SCOPE_CONFLICT');
    return row;
  }
  private async createNamespace(client: GmailIntakeClient): Promise<StateRow> {
    await client.query(`INSERT INTO public.gmail_intake_state(account_namespace,mailbox,subscription,topic)
      VALUES($1,$2,$3,$4) ON CONFLICT(account_namespace) DO NOTHING`,
    [this.options.account, this.options.mailbox, this.options.subscription, this.options.topic]);
    const state = await this.state(client, true);
    demand(state, 'GMAIL_INTAKE_STATE_MISSING'); return state;
  }
  private async queue(client: GmailIntakeClient, state: StateRow | null): Promise<GmailQueueState | null> {
    if (!state?.consumed_cursor) return null;
    const rows = await client.query<{ gmail_message_id: string; state: 'PENDING' | 'PROCESSING' | 'DONE'; payload: QueuedEmail | null }>(
      `SELECT gmail_message_id,state,payload FROM public.gmail_intake_work
       WHERE account_namespace=$1 ORDER BY received_at,gmail_message_id`, [this.options.account]);
    const queue: GmailQueueState = { mailbox: state.mailbox, cursor: state.consumed_cursor, gap: state.history_gap,
      work: rows.rows.map(row => ({ id: row.gmail_message_id, state: row.state,
        ...(row.payload === null ? {} : { email: row.payload }) })) };
    validateQueue(queue, this.options.mailbox); return queue;
  }
  private async assertRun(client: GmailIntakeClient, runId: string, states: string[]): Promise<void> {
    const result = await client.query<{ state: string }>(`SELECT state FROM public.gmail_intake_runs
      WHERE id=$1 AND account_namespace=$2 FOR UPDATE`, [runId, this.options.account]);
    demand(result.rows.length === 1 && states.includes(result.rows[0].state), 'GMAIL_INTAKE_RUN_NOT_ACTIVE');
  }
  async validateSchema(): Promise<void> {
    this.validated = false;
    await this.transaction(async client => {
      const expected: Record<string, Record<string, [string, boolean]>> = {
        gmail_intake_state: { account_namespace: ['text', true], mailbox: ['text', true], subscription: ['text', true], topic: ['text', true],
          consumed_cursor: ['text', false], history_gap: ['boolean', true], watch_baseline: ['text', false],
          watch_expires_at: ['timestamp with time zone', false], watch_renewed_at: ['timestamp with time zone', false],
          legacy_source_sha256: ['text', false], legacy_import_fingerprint: ['text', false], updated_at: ['timestamp with time zone', true] },
        gmail_intake_runs: { id: ['uuid', true], account_namespace: ['text', true], state: ['text', true],
          started_at: ['timestamp with time zone', true], activated_at: ['timestamp with time zone', false], stopped_at: ['timestamp with time zone', false] },
        gmail_intake_notifications: { subscription: ['text', true], message_id: ['text', true], account_namespace: ['text', true],
          run_id: ['uuid', true], payload_sha256: ['text', true], history_id: ['text', false], rejection: ['text', false],
          state: ['text', true], received_at: ['timestamp with time zone', true], consumed_at: ['timestamp with time zone', false] },
        gmail_intake_work: { account_namespace: ['text', true], gmail_message_id: ['text', true], state: ['text', true],
          payload: ['jsonb', false], payload_sha256: ['text', false], received_at: ['timestamp with time zone', true], recorded_at: ['timestamp with time zone', true], updated_at: ['timestamp with time zone', true] },
      };
      const columns = (await client.query<{ table_name: string; column_name: string; type_name: string; required: boolean }>(
        `SELECT c.relname AS table_name,a.attname AS column_name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type_name,
          a.attnotnull AS required FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])`, [Object.keys(expected)])).rows;
      for (const [table, fields] of Object.entries(expected)) for (const [name, [type, required]] of Object.entries(fields)) {
        demand(columns.some(c => c.table_name === table && c.column_name === name && c.type_name === type
          && c.required === required), 'GMAIL_INTAKE_SCHEMA_COLUMNS_INVALID');
      }
      const constraints = (await client.query<{ table_name: string; name: string; type: string; validated: boolean;
        fields: string[]; referenced_table: string | null; referenced_schema: string | null; referenced_fields: string[];
        update_action: string; delete_action: string; definition: string }>(
        `SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,k.convalidated AS validated,
          ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,ord)
            JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.ord) AS fields,
          cr.relname AS referenced_table,nr.nspname AS referenced_schema,
          ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,ord)
            JOIN pg_catalog.pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.ord) AS referenced_fields,
          k.confupdtype AS update_action,k.confdeltype AS delete_action,pg_catalog.pg_get_constraintdef(k.oid) AS definition
          FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          LEFT JOIN pg_catalog.pg_class cr ON cr.oid=k.confrelid
          LEFT JOIN pg_catalog.pg_namespace nr ON nr.oid=cr.relnamespace
          WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [Object.keys(expected)])).rows;
      const key = (table: string, fields: string[], types = ['p', 'u']) => demand(constraints.some(c =>
        c.table_name === table && types.includes(c.type) && c.validated && c.fields.join(',') === fields.join(',')),
      'GMAIL_INTAKE_SCHEMA_KEYS_INVALID');
      key('gmail_intake_state', ['account_namespace'], ['p']); key('gmail_intake_state', ['mailbox']);
      key('gmail_intake_state', ['subscription']); key('gmail_intake_state', ['account_namespace', 'subscription']);
      key('gmail_intake_runs', ['id'], ['p']); key('gmail_intake_runs', ['id', 'account_namespace']);
      key('gmail_intake_notifications', ['subscription', 'message_id'], ['p']);
      key('gmail_intake_work', ['account_namespace', 'gmail_message_id'], ['p']);
      const fk = (table: string, fields: string[], target: string, targetFields: string[]) => demand(constraints.some(c =>
        c.table_name === table && c.type === 'f' && c.validated && c.fields.join(',') === fields.join(',')
        && c.referenced_schema === 'public' && c.referenced_table === target && c.referenced_fields.join(',') === targetFields.join(',')
        && c.update_action === 'r' && c.delete_action === 'r'), 'GMAIL_INTAKE_SCHEMA_RELATIONSHIPS_INVALID');
      fk('gmail_intake_runs', ['account_namespace'], 'gmail_intake_state', ['account_namespace']);
      fk('gmail_intake_work', ['account_namespace'], 'gmail_intake_state', ['account_namespace']);
      fk('gmail_intake_notifications', ['account_namespace', 'subscription'], 'gmail_intake_state', ['account_namespace', 'subscription']);
      fk('gmail_intake_notifications', ['run_id', 'account_namespace'], 'gmail_intake_runs', ['id', 'account_namespace']);
      for (const [table, name, expression] of [
        ['gmail_intake_state', 'identity', `account_namespace <> '' AND mailbox <> '' AND mailbox=lower(btrim(mailbox)) AND subscription<>'' AND topic<>''`],
        ['gmail_intake_state', 'cursor', `consumed_cursor IS NULL OR consumed_cursor ~ '^[0-9]+$'`],
        ['gmail_intake_state', 'watch', `(watch_baseline IS NULL AND watch_expires_at IS NULL AND watch_renewed_at IS NULL)
          OR (watch_baseline ~ '^[0-9]+$' AND watch_baseline IS NOT NULL AND watch_expires_at IS NOT NULL
          AND watch_renewed_at IS NOT NULL AND watch_expires_at>watch_renewed_at)`],
        ['gmail_intake_state', 'import', `(legacy_source_sha256 IS NULL AND legacy_import_fingerprint IS NULL)
          OR (legacy_source_sha256 ~ '^[0-9a-f]{64}$' AND legacy_source_sha256 IS NOT NULL
          AND legacy_import_fingerprint ~ '^[0-9a-f]{64}$' AND legacy_import_fingerprint IS NOT NULL)`],
        ['gmail_intake_runs', 'lifecycle', `(state='STARTING' AND activated_at IS NULL AND stopped_at IS NULL)
          OR (state='ACTIVE' AND activated_at IS NOT NULL AND stopped_at IS NULL)
          OR (state='STOPPED' AND stopped_at IS NOT NULL)`],
        ['gmail_intake_runs', 'times', `(activated_at IS NULL OR activated_at>=started_at) AND (stopped_at IS NULL OR stopped_at>=started_at)`],
        ['gmail_intake_notifications', 'identity', `message_id<>'' AND payload_sha256 ~ '^[0-9a-f]{64}$'`],
        ['gmail_intake_notifications', 'state', `(state='REJECTED' AND rejection ~ '^[A-Z][A-Z0-9_]*$'
          AND rejection IS NOT NULL AND history_id IS NULL AND consumed_at IS NOT NULL)
          OR (state='PENDING' AND rejection IS NULL AND history_id ~ '^[0-9]+$' AND history_id IS NOT NULL AND consumed_at IS NULL)
          OR (state='CONSUMED' AND rejection IS NULL AND history_id ~ '^[0-9]+$' AND history_id IS NOT NULL AND consumed_at IS NOT NULL)`],
        ['gmail_intake_work', 'identity', `gmail_message_id<>''`],
        ['gmail_intake_work', 'hash', `(payload_sha256 IS NULL AND state='DONE') OR payload_sha256 ~ '^[0-9a-f]{64}$'`],
        ['gmail_intake_work', 'state', `(state='DONE' AND payload IS NULL)
          OR (state=ANY(ARRAY['PENDING','PROCESSING']) AND payload IS NOT NULL AND payload_sha256 IS NOT NULL
          AND jsonb_typeof(payload)='object' AND COALESCE(payload->>'id'=gmail_message_id,false)
          AND COALESCE(jsonb_typeof(payload->'sender')='string',false)
          AND COALESCE(jsonb_typeof(payload->'subject')='string',false)
          AND COALESCE(jsonb_typeof(payload->'body')='string',false)
          AND COALESCE(jsonb_typeof(payload->'receivedAt')='string',false))`],
      ]) demand(constraints.some(c => c.table_name === table && c.type === 'c' && c.validated
        && c.name === `${table}_${name}_ck` && normalizedCheck(c.definition) === normalizedCheck(expression)),
      'GMAIL_INTAKE_SCHEMA_CHECKS_INVALID');
      const oneRun = (await client.query<{ indisunique: boolean; indisvalid: boolean; columns: string[]; predicate: string }>(
        `SELECT i.indisunique,i.indisvalid,
          ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY x(num,ord)
            JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=x.num ORDER BY x.ord) AS columns,
          pg_catalog.pg_get_expr(i.indpred,i.indrelid) AS predicate
          FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='gmail_intake_one_live_run_idx'
            AND i.indrelid='public.gmail_intake_runs'::regclass AND i.indnkeyatts=1`)).rows;
      demand(oneRun.length === 1 && oneRun[0].indisunique && oneRun[0].indisvalid
        && oneRun[0].columns.join(',') === 'account_namespace'
        && oneRun[0].predicate.replace(/\s|[()]/g, '').replace(/::text(?:\[\])?/g, '')
          === "state=ANYARRAY['STARTING','ACTIVE']", 'GMAIL_INTAKE_SCHEMA_RUN_INDEX_INVALID');
    }, true, true);
    this.validated = true;
  }
  async load(): Promise<GmailQueueState | null> {
    return this.transaction(async client => this.queue(client, await this.state(client)), true);
  }
  async startRun(): Promise<string> {
    return this.transaction(async client => {
      const state = await this.createNamespace(client);
      demand(!state.history_gap, 'GMAIL_HISTORY_GAP');
      await client.query(`UPDATE public.gmail_intake_runs SET state='STOPPED',stopped_at=now()
        WHERE account_namespace=$1 AND state IN ('STARTING','ACTIVE')`, [this.options.account]);
      const runId = randomUUID();
      await client.query(`INSERT INTO public.gmail_intake_runs(id,account_namespace,state) VALUES($1,$2,'STARTING')`,
        [runId, this.options.account]);
      return runId;
    });
  }
  async setWatch(runId: string, watch: { historyId: string; expirationMs: number }, allowInitialize: boolean): Promise<GmailQueueState> {
    demand(digits(watch.historyId) && Number.isSafeInteger(watch.expirationMs) && watch.expirationMs > Date.now(),
      'GMAIL_INTAKE_INVALID_WATCH');
    return this.transaction(async client => {
      await this.assertRun(client, runId, ['STARTING', 'ACTIVE']);
      const state = await this.state(client, true); demand(state, 'GMAIL_INTAKE_STATE_MISSING');
      demand(!state.history_gap, 'GMAIL_HISTORY_GAP');
      demand(state.consumed_cursor !== null || allowInitialize, 'GMAIL_INTAKE_EXPLICIT_FIRST_INITIALIZATION_REQUIRED');
      await client.query(`UPDATE public.gmail_intake_state SET consumed_cursor=COALESCE(consumed_cursor,$2),
        watch_baseline=$2,watch_expires_at=$3,watch_renewed_at=now(),updated_at=now() WHERE account_namespace=$1`,
      [this.options.account, watch.historyId, new Date(watch.expirationMs)]);
      const result = await this.queue(client, await this.state(client)); demand(result, 'GMAIL_INTAKE_STATE_MISSING'); return result;
    });
  }
  async activate(runId: string): Promise<void> {
    await this.transaction(async client => {
      await this.assertRun(client, runId, ['STARTING']);
      const state = await this.state(client, true);
      demand(state?.consumed_cursor && !state.history_gap && state.watch_expires_at
        && state.watch_expires_at.getTime() > Date.now(), 'GMAIL_INTAKE_ACTIVATION_NOT_READY');
      await client.query(`UPDATE public.gmail_intake_runs SET state='ACTIVE',activated_at=now() WHERE id=$1`, [runId]);
    });
  }
  async stopRun(runId: string): Promise<void> {
    await this.transaction(async client => {
      await this.assertRun(client, runId, ['STARTING', 'ACTIVE', 'STOPPED']);
      await client.query(`UPDATE public.gmail_intake_runs SET state='STOPPED',stopped_at=COALESCE(stopped_at,now()) WHERE id=$1`, [runId]);
    });
  }
  async recordNotification(runId: string, event: GmailNotificationEvidence): Promise<void> {
    demand(validId(event.messageId) && hash(event.payloadSha256)
      && (event.rejection === null && digits(event.historyId)
        || event.historyId === null && typeof event.rejection === 'string' && /^[A-Z][A-Z0-9_]*$/.test(event.rejection)),
    'GMAIL_INTAKE_NOTIFICATION_INVALID');
    await this.transaction(async client => {
      await this.assertRun(client, runId, ['ACTIVE']);
      await this.state(client, true);
      await client.query(`INSERT INTO public.gmail_intake_notifications
        (subscription,message_id,account_namespace,run_id,payload_sha256,history_id,rejection,state,consumed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7::text IS NOT NULL THEN now() ELSE NULL END)
        ON CONFLICT(subscription,message_id) DO NOTHING`, [this.options.subscription, event.messageId, this.options.account,
        runId, event.payloadSha256, event.historyId, event.rejection, event.rejection === null ? 'PENDING' : 'REJECTED']);
      const saved = (await client.query<{ account_namespace: string; payload_sha256: string; history_id: string | null; rejection: string | null }>(
        `SELECT account_namespace,payload_sha256,history_id,rejection FROM public.gmail_intake_notifications
          WHERE subscription=$1 AND message_id=$2`, [this.options.subscription, event.messageId])).rows[0];
      demand(saved?.account_namespace === this.options.account && saved.payload_sha256 === event.payloadSha256
        && saved.history_id === event.historyId && saved.rejection === event.rejection, 'GMAIL_INTAKE_NOTIFICATION_IDENTITY_CONFLICT');
    });
  }
  async pendingNotifications(): Promise<Array<{ messageId: string; historyId: string }>> {
    return this.transaction(async client => {
      await this.state(client);
      const rows = await client.query<{ message_id: string; history_id: string }>(`SELECT message_id,history_id
        FROM public.gmail_intake_notifications WHERE account_namespace=$1 AND subscription=$2 AND state='PENDING'
        ORDER BY received_at,message_id LIMIT 1000`, [this.options.account, this.options.subscription]);
      return rows.rows.map(row => ({ messageId: row.message_id, historyId: row.history_id }));
    }, true);
  }
  async ingest(expectedCursor: string, nextCursor: string, emails: QueuedEmail[], notificationIds: string[]): Promise<void> {
    demand(digits(expectedCursor) && digits(nextCursor) && BigInt(nextCursor) >= BigInt(expectedCursor)
      && Array.isArray(emails) && Array.isArray(notificationIds) && new Set(notificationIds).size === notificationIds.length
      && notificationIds.every(validId), 'GMAIL_INTAKE_BATCH_INVALID');
    const ids = new Set<string>();
    for (const email of emails) { validateEmail(email); demand(!ids.has(email.id), 'GMAIL_INTAKE_BATCH_DUPLICATE'); ids.add(email.id); }
    await this.transaction(async client => {
      const state = await this.state(client, true);
      demand(state && !state.history_gap && state.consumed_cursor === expectedCursor, 'GMAIL_INTAKE_CURSOR_CONFLICT');
      for (const email of emails) {
        const digest = createHash('sha256').update(canonical(email)).digest('hex');
        const ignored = email.intakeDisposition === 'IGNORED';
        await client.query(`INSERT INTO public.gmail_intake_work
          (account_namespace,gmail_message_id,state,payload,payload_sha256,received_at) VALUES($1,$2,$3,$4::jsonb,$5,$6)
          ON CONFLICT(account_namespace,gmail_message_id) DO NOTHING`,
        [this.options.account, email.id, ignored ? 'DONE' : 'PENDING', ignored ? null : JSON.stringify(email), digest, new Date(email.receivedAt)]);
        const existing = (await client.query<{ state: string; payload: QueuedEmail | null; payload_sha256: string | null }>(
          `SELECT state,payload,payload_sha256 FROM public.gmail_intake_work WHERE account_namespace=$1 AND gmail_message_id=$2`,
          [this.options.account, email.id])).rows[0];
        demand(existing && (existing.payload_sha256 === digest || existing.state === 'DONE' && existing.payload_sha256 === null)
          && (existing.payload === null || canonical(existing.payload) === canonical(email)), 'GMAIL_INTAKE_EMAIL_IDENTITY_CONFLICT');
      }
      if (notificationIds.length) {
        const notifications = await client.query<{ message_id: string; history_id: string; state: string }>(
          `SELECT message_id,history_id,state FROM public.gmail_intake_notifications WHERE account_namespace=$1
            AND subscription=$2 AND message_id=ANY($3::text[]) FOR UPDATE`,
          [this.options.account, this.options.subscription, notificationIds]);
        demand(notifications.rows.length === notificationIds.length && notifications.rows.every(row =>
          row.state === 'PENDING' && digits(row.history_id) && BigInt(row.history_id) <= BigInt(nextCursor)),
        'GMAIL_INTAKE_NOTIFICATION_COVERAGE_INCOMPLETE');
        await client.query(`UPDATE public.gmail_intake_notifications SET state='CONSUMED',consumed_at=now()
          WHERE account_namespace=$1 AND subscription=$2 AND message_id=ANY($3::text[])`,
        [this.options.account, this.options.subscription, notificationIds]);
      }
      await client.query(`UPDATE public.gmail_intake_state SET consumed_cursor=$2,updated_at=now() WHERE account_namespace=$1`,
        [this.options.account, nextCursor]);
    });
  }
  async mark(id: string, next: 'PROCESSING' | 'DONE'): Promise<void> {
    demand(validId(id) && ['PROCESSING', 'DONE'].includes(next), 'GMAIL_INTAKE_TRANSITION_INVALID');
    await this.transaction(async client => {
      const state = await this.state(client, true); demand(state?.consumed_cursor && !state.history_gap, 'GMAIL_HISTORY_GAP');
      const allowed = next === 'PROCESSING' ? ['PENDING'] : ['PENDING', 'PROCESSING'];
      const changed = await client.query(`UPDATE public.gmail_intake_work SET state=$3,
        payload=CASE WHEN $3='DONE' THEN NULL ELSE payload END,updated_at=now()
        WHERE account_namespace=$1 AND gmail_message_id=$2 AND state=ANY($4::text[])`, [this.options.account, id, next, allowed]);
      demand(changed.rowCount === 1, 'GMAIL_INTAKE_TRANSITION_INVALID');
    });
  }
  async markGap(): Promise<void> {
    await this.transaction(async client => {
      const state = await this.state(client, true); demand(state?.consumed_cursor, 'GMAIL_INTAKE_STATE_MISSING');
      await client.query(`UPDATE public.gmail_intake_state SET history_gap=true,updated_at=now() WHERE account_namespace=$1`, [this.options.account]);
    });
  }
  async watchState(): Promise<{ expirationMs: number; renewedAtMs: number } | null> {
    return this.transaction(async client => {
      const state = await this.state(client);
      return state?.watch_expires_at && state.watch_renewed_at
        ? { expirationMs: state.watch_expires_at.getTime(), renewedAtMs: state.watch_renewed_at.getTime() } : null;
    }, true);
  }
  private async assessImport(client: GmailIntakeClient, existing: StateRow | null, sourceSha256: string,
    fingerprint: string): Promise<LegacyGmailImportAssessment> {
    if (!existing) return { ready: true, alreadyAccepted: false };
    if (existing.consumed_cursor !== null) {
      const accepted = existing.legacy_source_sha256 === sourceSha256 && existing.legacy_import_fingerprint === fingerprint;
      return { ready: accepted, alreadyAccepted: accepted };
    }
    if (existing.history_gap) return { ready: false, alreadyAccepted: false };
    const active = await client.query(`SELECT 1 FROM public.gmail_intake_runs WHERE account_namespace=$1 AND state<>'STOPPED' LIMIT 1`, [this.options.account]);
    const priorWork = await client.query(`SELECT 1 FROM public.gmail_intake_work WHERE account_namespace=$1 LIMIT 1`, [this.options.account]);
    return { ready: active.rows.length === 0 && priorWork.rows.length === 0, alreadyAccepted: false };
  }
  async assessLegacyImport(state: GmailQueueState, sourceSha256: string): Promise<LegacyGmailImportAssessment> {
    validateLegacyGmailQueue(state, this.options.mailbox);
    demand(hash(sourceSha256), 'GMAIL_INTAKE_LEGACY_SOURCE_HASH_INVALID');
    const fingerprint = createHash('sha256').update(canonical(state)).digest('hex');
    return this.transaction(async client => this.assessImport(client, await this.state(client), sourceSha256, fingerprint), true);
  }
  async importLegacy(state: GmailQueueState, sourceSha256: string): Promise<void> {
    validateLegacyGmailQueue(state, this.options.mailbox);
    demand(hash(sourceSha256), 'GMAIL_INTAKE_LEGACY_SOURCE_HASH_INVALID');
    const fingerprint = createHash('sha256').update(canonical(state)).digest('hex');
    await this.transaction(async client => {
      const existing = await this.createNamespace(client);
      const assessment = await this.assessImport(client, existing, sourceSha256, fingerprint);
      demand(assessment.ready, 'GMAIL_INTAKE_LEGACY_IMPORT_CONFLICT_OR_WRITER_NOT_STOPPED');
      if (assessment.alreadyAccepted) return; // Never rewind an advanced cursor or replay completed work.
      for (const item of state.work) await client.query(`INSERT INTO public.gmail_intake_work
        (account_namespace,gmail_message_id,state,payload,payload_sha256,received_at) VALUES($1,$2,$3,$4::jsonb,$5,$6)`,
      [this.options.account, item.id, item.state, item.email ? JSON.stringify(item.email) : null,
        item.email ? createHash('sha256').update(canonical(item.email)).digest('hex') : null,
        item.email ? new Date(item.email.receivedAt) : new Date(0)]);
      await client.query(`UPDATE public.gmail_intake_state SET consumed_cursor=$2,history_gap=false,
        legacy_source_sha256=$3,legacy_import_fingerprint=$4,updated_at=now() WHERE account_namespace=$1`,
      [this.options.account, state.cursor, sourceSha256, fingerprint]);
    });
  }
  async legacySourceHash(): Promise<string | null> {
    return this.transaction(async client => (await this.state(client))?.legacy_source_sha256 ?? null, true);
  }
  async close(): Promise<void> {
    if (!this.closing) {
      // Reject new/queued callbacks immediately; let an already-running
      // transaction finish before closing its pool. Repeated cleanup awaits it.
      this.closed = true;
      this.closing = (async () => { await this.tail; await this.pool.end(); })();
    }
    await this.closing;
  }
}
