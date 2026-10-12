import { Pool, type PoolClient } from 'pg';
import { TransactionalDatabase, TransactionContext, type DatabaseState } from './database';

/** Durable aggregate storage. All business tables commit together under one locked account row.
 * The dedicated advisory-lock connection is never returned to the pool while ownership is held.
 */
export class PostgresDatabase extends TransactionalDatabase {
  private pool: Pool;
  private closed = false;
  private owner: PoolClient | null = null;
  private ownerKey: string | null = null;
  private lostOwnership = false;
  private lossHandlers: Array<() => void> = [];
  onOwnershipLost(handler: () => void): void { this.lossHandlers.push(handler); }
  private loseOwnership(): void {
    if (this.lostOwnership) return;
    this.lostOwnership = true;
    for (const handler of this.lossHandlers) handler();
  }
  private tail: Promise<void> = Promise.resolve();

  constructor(connectionString: string, private namespace: string) {
    super();
    if (!connectionString || !namespace) throw new Error('PostgreSQL connection and account namespace are required.');
    this.pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 10000, application_name: `bfmr:${namespace}` });
    this.pool.on('error', () => this.loseOwnership());
  }
  async initialize(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS bfmr_runtime_state (
      account_namespace text PRIMARY KEY, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    await this.pool.query('INSERT INTO bfmr_runtime_state(account_namespace,payload) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
      [this.namespace, this.encode(this.state)]);
    await this.refresh();
  }
  private encode(state: DatabaseState): string {
    return JSON.stringify(Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'advisory_locks')
      .map(([key, value]) => [key, Array.from((value as Map<string, unknown>).entries())])));
  }
  private decode(payload: Record<string, Array<[string, unknown]>>): DatabaseState {
    const state = structuredClone(this.state);
    for (const key of Object.keys(state)) {
      if (key === 'advisory_locks') continue;
      if (!Array.isArray(payload[key])) throw new Error('Invalid PostgreSQL runtime state; recovery required.');
      (state as unknown as Record<string, unknown>)[key] = new Map(payload[key]);
    }
    return state;
  }
  async refresh(): Promise<void> {
    const result = await this.pool.query('SELECT payload FROM bfmr_runtime_state WHERE account_namespace=$1', [this.namespace]);
    if (result.rows.length !== 1) throw new Error('Missing PostgreSQL account state.');
    this.state = this.decode(result.rows[0].payload);
  }
  // Synchronous read helpers expose the last committed view. Every transaction reloads the
  // locked row; callers refresh before scheduling from an external read.
  override async withTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    let client: PoolClient | undefined;
    try {
      this.assertOwnership();
      client = await this.pool.connect();
      await client.query('BEGIN');
      const result = await client.query('SELECT payload FROM bfmr_runtime_state WHERE account_namespace=$1 FOR UPDATE', [this.namespace]);
      if (result.rows.length !== 1) throw new Error('Missing PostgreSQL account state.');
      const working = this.decode(result.rows[0].payload);
      let sequence = Array.from(working.commands.values()).reduce((max, row) => Math.max(max, row.monotonic_sequence), 0);
      const value = structuredClone(await fn(new TransactionContext(working, () => ++sequence)));
      await this.verifyOwnership();
      await client.query('UPDATE bfmr_runtime_state SET payload=$2::jsonb,updated_at=now() WHERE account_namespace=$1',
        [this.namespace, this.encode(working)]);
      await client.query('COMMIT');
      this.state = working;
      return value;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client?.release(); release(); }
  }
  assertOwnership(): void {
    if (!this.owner || this.lostOwnership) throw new Error('PostgreSQL account ownership is absent or lost. Stop external actions.');
  }
  async verifyOwnership(): Promise<void> {
    this.assertOwnership();
    try { await this.owner!.query('SELECT 1'); this.assertOwnership(); }
    catch (error) { this.loseOwnership(); throw error; }
  }
  /** Acquire before any browser or queue operation. Never treats the same worker's lock as reentrant. */
  async claimAccount(key: string): Promise<boolean> {
    if (key !== `bfmr_worker_lock_${this.namespace}`) throw new Error('Lock key must identify this database account namespace.');
    if (this.owner || this.lostOwnership) return false;
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [key]);
      if (!result.rows[0].acquired) { client.release(); return false; }
      this.owner = client; this.ownerKey = key;
      client.on('error', () => this.loseOwnership());
      client.on('end', () => { if (this.owner === client) this.loseOwnership(); });
      return true;
    } catch (error) { client.release(true); throw error; }
  }
  async relinquishAccount(): Promise<void> {
    const client = this.owner;
    this.owner = null;
    if (client) {
      try { if (!this.lostOwnership) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [this.ownerKey]); }
      finally { client.release(this.lostOwnership); this.ownerKey = null; }
    }
  }
  override acquireAdvisoryLock(_key: string): boolean {
    throw new Error('PostgreSQL ownership must be acquired with await claimAccount().');
  }
  override releaseAdvisoryLock(_key: string): void {
    throw new Error('PostgreSQL ownership must be released with await relinquishAccount().');
  }
  override isAdvisoryLockHeld(key: string): boolean { return this.ownerKey === key && !this.lostOwnership; }
  override reset(): void { throw new Error('Durable PostgreSQL state cannot be reset through the runtime API.'); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.relinquishAccount(); } finally { await this.pool.end(); }
  }
}
