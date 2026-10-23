import { Pool } from 'pg';
import { BusinessRepositories } from './relationalRepositories';
import type { BusinessQueryable } from './relationalTypes';

export interface RelationalClient extends BusinessQueryable { release(destroy?: boolean): void }
export interface RelationalPool extends BusinessQueryable {
  connect(): Promise<RelationalClient>;
  end(): Promise<void>;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}
interface ColumnContract { type: string; required?: boolean }
const column = (type: string, required = true): ColumnContract => ({ type, required });
const requiredColumns: Record<string, Record<string, ColumnContract>> = {
  retailers: { id: column('bigint'), name: column('text'), primary_url: column('text') },
  retailer_accounts: { id: column('bigint'), retailer_id: column('bigint'), email: column('text'),
    retailer_account_ranking: column('integer') },
  reservation_status: { id: column('bigint'), description: column('text') },
  order_status: { id: column('bigint'), description: column('text') },
  shipment_status: { id: column('bigint'), description: column('text') },
  deals: { id: column('bigint'), bfmr_deal_id: column('text'), slug: column('text'), title: column('text'), reimbursement_amount: column('numeric(12,2)'), description: column('text', false) },
  deal_retailers: { deal_id: column('bigint'), retailer_id: column('bigint') },
  emails: { id: column('bigint'), gmail_message_id: column('text'), subject: column('text'), email_type: column('text'), received_at: column('timestamp with time zone') },
  email_deals: { email_id: column('bigint'), deal_id: column('bigint'), reference_type: column('text', false) },
  reservations: { id: column('bigint'), bfmr_reservation_id: column('text'), deal_id: column('bigint'), reservation_status_id: column('bigint'), source_email_id: column('bigint', false), quantity: column('integer'), payout_per_item: column('numeric(12,2)'), expected_payout: column('numeric(12,2)', false) },
  orders: { id: column('bigint'), order_id: column('text'), reservation_id: column('bigint'), deal_id: column('bigint'), retailer_id: column('bigint'), retailer_account_id: column('bigint'), status_id: column('bigint'), quantity: column('integer'), canceled_quantity: column('integer'), total_cost: column('numeric(12,2)'), purchase_date: column('date'), product_identifier: column('text'), order_time_estimated_delivery_date: column('date', false) },
  shipments: { id: column('bigint'), order_id: column('bigint'), tracking_number: column('text'), shipping_company: column('text'), status_id: column('bigint'), quantity: column('integer') },
  reimbursements: { id: column('bigint'), reservation_id: column('bigint'), payment_email_id: column('bigint'), amount: column('numeric(12,2)'), paid_at: column('timestamp with time zone'), payment_reference: column('text', false), recorded_at: column('timestamp with time zone') },
  workflow_evidence: { id: column('bigint'), email_id: column('bigint', false), reservation_id: column('bigint', false), order_id: column('bigint', false), correlation_id: column('uuid'), action_type: column('text'), phase: column('text'), outcome: column('text', false), evidence: column('jsonb'), recorded_at: column('timestamp with time zone') },
  sync_runs: { id: column('bigint'), provider: column('text'), scope: column('text'), target_order_id: column('bigint', false), started_at: column('timestamp with time zone'), completed_at: column('timestamp with time zone', false), status: column('text'), records_received: column('integer'), is_complete: column('boolean'), error_message: column('text', false) },
  provider_observations: { id: column('bigint'), email_id: column('bigint', false), deal_id: column('bigint', false), reservation_id: column('bigint', false), order_id: column('bigint', false), shipment_id: column('bigint', false), reimbursement_id: column('bigint', false), sync_run_id: column('bigint', false), provider: column('text'), resource_type: column('text'), observed_at: column('timestamp with time zone'), is_complete: column('boolean'), response_data: column('jsonb') },
};
interface CatalogColumn { table_name: string; column_name: string; type_name: string; not_null: boolean; identity: string; generated: string; expression: string | null }
interface CatalogConstraint { table_name: string; constraint_name: string; constraint_type: string; validated: boolean; key_columns: string[]; referenced_schema: string | null; referenced_table: string | null; referenced_columns: string[]; update_action: string; delete_action: string; match_type: string; definition: string }
interface CatalogTrigger { table_name: string; trigger_name: string; enabled: string; trigger_type: number; update_columns: string; deferrable: boolean; has_condition: boolean; function_schema: string; function_name: string; function_source: string; security_definer: boolean; config: string[] | null }
const normalizedSql = (sql: string) => sql.toLowerCase().replace(/\s+/g, '').replace(/[()]/g, '').replace(/::(?:numeric|integer|bigint|text|boolean)/g, '');
const expectedGuard = `BEGIN
 IF NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.payout_per_item IS DISTINCT FROM OLD.payout_per_item THEN
 RAISE EXCEPTION 'Reservation creation quantity and payout rate are immutable' USING ERRCODE = '23514';
 END IF; RETURN NEW; END;`;
function assert(condition: unknown, description: string): asserts condition {
  if (!condition) throw new Error(`Relational schema contract is not installed: ${description}. Apply reviewed schema changes separately; startup performs no DDL.`);
}

/** Relational business persistence, independent of the legacy operational JSONB aggregate. */
export class RelationalDatabase {
  private readonly pool: RelationalPool;
  private validated = false;
  private closed = false;
  private failed = false;
  private externalVerifyOwnership?: () => Promise<void>;
  private ownerClient: RelationalClient | null = null;
  private ownerKey: string | null = null;
  private lostOwnership = false;

  constructor(
    connectionString: string,
    verifyOwnership?: () => Promise<void>,
    options: { pool?: RelationalPool } = {}
  ) {
    if (!connectionString) throw new Error('A dedicated PostgreSQL connection is required.');
    this.externalVerifyOwnership = verifyOwnership;
    this.pool = options.pool ?? new Pool({ connectionString, max: 4, connectionTimeoutMillis: 10000, application_name: 'bfmr:relational' });
    this.pool.on?.('error', () => { this.failed = true; });
  }

  /** Acquires exclusive advisory lock for the target account namespace directly on this pool. */
  async claimAccount(account: string): Promise<boolean> {
    const key = `bfmr_worker_lock_${account.trim().toLowerCase()}`;
    if (this.ownerClient || this.lostOwnership) return false;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [key]
      );
      if (!result.rows[0].acquired) {
        client.release();
        return false;
      }
      this.ownerClient = client;
      this.ownerKey = key;
      return true;
    } catch (err) {
      client.release(true);
      throw err;
    }
  }

  /** Verifies that the exclusive account ownership lock remains active. */
  async verifyOwnership(): Promise<void> {
    if (this.externalVerifyOwnership) {
      await this.externalVerifyOwnership();
      return;
    }
    if (!this.ownerClient || this.lostOwnership) {
      throw new Error('PostgreSQL account ownership is absent or lost. Stop external actions.');
    }
    try {
      await this.ownerClient.query('SELECT 1');
    } catch (err) {
      this.lostOwnership = true;
      throw err;
    }
  }

  /** Releases the account ownership advisory lock. */
  async relinquishAccount(): Promise<void> {
    const client = this.ownerClient;
    this.ownerClient = null;
    if (client && this.ownerKey) {
      try {
        if (!this.lostOwnership) {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [this.ownerKey]);
        }
      } finally {
        client.release(this.lostOwnership);
        this.ownerKey = null;
      }
    }
  }

  private assertAvailable(): void {
    if (this.closed || this.failed) throw new Error('Relational database connection is unavailable; stop processing.');
  }
  /** Read-only contract validation; never creates tables, migrates data, or installs a guard. */
  async validateSchema(): Promise<void> {
    this.assertAvailable(); this.validated = false;
    await this.verifyOwnership();
    const client = await this.pool.connect();
    let destroy = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const columns = (await client.query<CatalogColumn>(`SELECT c.relname AS table_name,a.attname AS column_name,
        pg_catalog.format_type(a.atttypid,a.atttypmod) AS type_name,a.attnotnull AS not_null,
        a.attidentity AS identity,a.attgenerated AS generated,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS expression
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
        WHERE n.nspname='public' AND c.relkind IN ('r','p')`)).rows;
      for (const [table, names] of Object.entries(requiredColumns)) for (const [name, spec] of Object.entries(names)) {
        const actual = columns.find(item => item.table_name === table && item.column_name === name);
        assert(actual && actual.type_name === spec.type && actual.not_null === Boolean(spec.required), `${table}.${name}`);
      }
      for (const table of Object.keys(requiredColumns).filter(name => !['reservation_status', 'order_status', 'shipment_status', 'email_deals', 'deal_retailers'].includes(name))) {
        assert(columns.some(item => item.table_name === table && item.column_name === 'id' && item.identity === 'a'), `${table} generated-always identity`);
      }
      const payout = columns.find(item => item.table_name === 'reservations' && item.column_name === 'expected_payout');
      assert(payout?.generated === 's' && normalizedSql(payout.expression ?? '') === 'quantity*payout_per_item', 'stored generated reservation payout formula');
      const ranking = columns.find(item => item.table_name === 'retailer_accounts' && item.column_name === 'retailer_account_ranking');
      assert(ranking && ranking.expression === null && ranking.generated === '' && ranking.identity === '',
        'retailer account rankings must be explicitly assigned, without a default or generation');

      const constraints = (await client.query<CatalogConstraint>(`SELECT c.relname AS table_name,k.conname AS constraint_name,
        k.contype AS constraint_type,k.convalidated AS validated,
        ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY AS x(num,ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.ord) AS key_columns,
        nr.nspname AS referenced_schema,cr.relname AS referenced_table,
        ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY AS x(num,ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.ord) AS referenced_columns,
        k.confupdtype AS update_action,k.confdeltype AS delete_action,k.confmatchtype AS match_type,pg_catalog.pg_get_constraintdef(k.oid) AS definition
        FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_catalog.pg_class cr ON cr.oid=k.confrelid
        LEFT JOIN pg_catalog.pg_namespace nr ON nr.oid=cr.relnamespace WHERE n.nspname='public'`)).rows;
      const keys = (table: string, fields: string[], primary = false) => assert(constraints.some(item => item.table_name === table && item.validated &&
        (primary ? item.constraint_type === 'p' : ['p', 'u'].includes(item.constraint_type)) && item.key_columns.join(',') === fields.join(',')), `${table} unique (${fields.join(',')})`);
      for (const table of Object.keys(requiredColumns).filter(name => !['email_deals', 'deal_retailers'].includes(name))) keys(table, ['id'], true);
      for (const [table, fields] of [
        ['email_deals', ['email_id', 'deal_id']], ['deal_retailers', ['deal_id', 'retailer_id']],
        ['emails', ['gmail_message_id']], ['deals', ['bfmr_deal_id']], ['reservations', ['bfmr_reservation_id']],
        ['reservation_status', ['description']], ['order_status', ['description']], ['shipment_status', ['description']],
        ['reservations', ['id', 'deal_id']], ['orders', ['reservation_id']], ['orders', ['retailer_id', 'order_id']],
        ['shipments', ['order_id']], ['reimbursements', ['reservation_id']],
        ['retailer_accounts', ['retailer_id', 'email']], ['retailer_accounts', ['id', 'retailer_id']],
        ['retailer_accounts', ['retailer_id', 'retailer_account_ranking']], ['sync_runs', ['id', 'provider']],
      ] as Array<[string, string[]]>) keys(table, fields);
      const fk = (table: string, fields: string[], target: string, targetFields: string[] = ['id']) => assert(constraints.some(item =>
        item.table_name === table && item.constraint_type === 'f' && item.validated && item.key_columns.join(',') === fields.join(',') &&
        item.referenced_schema === 'public' && item.referenced_table === target && item.referenced_columns.join(',') === targetFields.join(',') &&
        item.update_action === 'r' && item.delete_action === 'r' && item.match_type === 's'), `${table} foreign key (${fields.join(',')})`);
      fk('retailer_accounts', ['retailer_id'], 'retailers');
      fk('deal_retailers', ['deal_id'], 'deals'); fk('deal_retailers', ['retailer_id'], 'retailers');
      fk('email_deals', ['email_id'], 'emails'); fk('email_deals', ['deal_id'], 'deals');
      fk('reservations', ['deal_id'], 'deals'); fk('reservations', ['reservation_status_id'], 'reservation_status'); fk('reservations', ['source_email_id'], 'emails');
      fk('orders', ['reservation_id', 'deal_id'], 'reservations', ['id', 'deal_id']); fk('orders', ['deal_id'], 'deals'); fk('orders', ['retailer_id'], 'retailers');
      fk('orders', ['retailer_account_id', 'retailer_id'], 'retailer_accounts', ['id', 'retailer_id']); fk('orders', ['deal_id', 'retailer_id'], 'deal_retailers', ['deal_id', 'retailer_id']); fk('orders', ['status_id'], 'order_status');
      fk('shipments', ['order_id'], 'orders'); fk('shipments', ['status_id'], 'shipment_status');
      fk('reimbursements', ['reservation_id'], 'reservations'); fk('reimbursements', ['payment_email_id'], 'emails');
      fk('workflow_evidence', ['email_id'], 'emails'); fk('workflow_evidence', ['reservation_id'], 'reservations'); fk('workflow_evidence', ['order_id'], 'orders');
      fk('sync_runs', ['target_order_id'], 'orders');
      for (const [field, table] of [['email_id', 'emails'], ['deal_id', 'deals'], ['reservation_id', 'reservations'], ['order_id', 'orders'], ['shipment_id', 'shipments'], ['reimbursement_id', 'reimbursements']]) fk('provider_observations', [field], table);
      fk('provider_observations', ['sync_run_id', 'provider'], 'sync_runs', ['id', 'provider']);
      for (const [table, name, expression] of [
        ['reservations', 'reservations_quantity_ck', 'quantity>0'],
        ['reservations', 'reservations_payout_per_item_ck', "payout_per_item>=0andpayout_per_item<>'nan'"],
        ['deals', 'deals_reimbursement_amount_ck', "reimbursement_amount>=0andreimbursement_amount<>'nan'"],
        ['orders', 'orders_quantity_ck', 'quantity>0'], ['orders', 'orders_canceled_quantity_ck', 'canceled_quantity>=0andcanceled_quantity<=quantity'],
        ['orders', 'orders_total_cost_ck', "total_cost>=0andtotal_cost<>'nan'"], ['shipments', 'shipments_quantity_ck', 'quantity>0'],
        ['reimbursements', 'reimbursements_amount_ck', "amount>=0andamount<>'nan'"],
      ]) {
        const actual = constraints.find(item => item.table_name === table && item.constraint_name === name && item.constraint_type === 'c' && item.validated);
        assert(actual && normalizedSql(actual.definition).replace(/^check/, '') === expression, `${table}.${name}`);
      }
      for (const name of ['sync_runs_provider_ck', 'sync_runs_scope_ck', 'sync_runs_status_ck', 'sync_runs_records_received_ck',
        'sync_runs_completed_at_ck', 'sync_runs_completion_ck', 'sync_runs_scope_target_ck']) {
        assert(constraints.some(item => item.table_name === 'sync_runs' && item.constraint_name === name && item.constraint_type === 'c' && item.validated), name);
      }

      const orderIndexes = (await client.query<{ index_name: string; key_columns: string[] }>(`SELECT ci.relname AS index_name,
        ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS x(num,ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=x.num
          WHERE x.ord<=i.indnkeyatts ORDER BY x.ord) AS key_columns
        FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_class ci ON ci.oid=i.indexrelid
        WHERE n.nspname='public' AND c.relname='orders' AND i.indisunique`)).rows;
      assert(!orderIndexes.some(item => item.key_columns.includes('retailer_account_id') && item.key_columns.includes('deal_id') &&
        !item.key_columns.some(name => ['id', 'order_id', 'reservation_id'].includes(name))), 'orders must allow multiple orders per retailer account and deal');

      const triggers = (await client.query<CatalogTrigger>(`SELECT c.relname AS table_name,t.tgname AS trigger_name,t.tgenabled AS enabled,
        t.tgtype::integer AS trigger_type,t.tgattr::text AS update_columns,t.tgdeferrable AS deferrable,t.tgqual IS NOT NULL AS has_condition,nf.nspname AS function_schema,p.proname AS function_name,
        p.prosrc AS function_source,p.prosecdef AS security_definer,p.proconfig AS config
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
        JOIN pg_catalog.pg_namespace nf ON nf.oid=p.pronamespace WHERE n.nspname='public' AND NOT t.tgisinternal`)).rows;
      const guard = triggers.find(item => item.table_name === 'reservations' && item.trigger_name === 'reservations_immutable_payout');
      assert(guard && guard.enabled === 'A' && guard.trigger_type === 17 && guard.update_columns === '' && !guard.deferrable && !guard.has_condition && !guard.security_definer &&
        guard.function_schema === 'public' && guard.function_name === 'reject_reservation_payout_change' &&
        guard.config?.includes('search_path=pg_catalog') && normalizedSql(guard.function_source) === normalizedSql(expectedGuard), 'immutable payout AFTER UPDATE ALWAYS guard');
      for (const [table, name, type, enabled] of [
        ['provider_observations', 'provider_observations_append_only', 58, 'A'],
        ['workflow_evidence', 'workflow_evidence_no_update_delete', 27, 'O'],
        ['workflow_evidence', 'workflow_evidence_no_truncate', 34, 'O'],
      ] as Array<[string, string, number, string]>) {
        const trigger = triggers.find(item => item.table_name === table && item.trigger_name === name);
        assert(trigger && [enabled, 'A'].includes(trigger.enabled) && trigger.trigger_type === type && trigger.update_columns === '' && !trigger.deferrable && !trigger.has_condition &&
          trigger.function_schema === 'public' && !trigger.security_definer &&
          normalizedSql(trigger.function_source) === normalizedSql(table === 'provider_observations'
            ? "BEGIN RAISE EXCEPTION 'provider_observations is append-only; insert a new observation instead' USING ERRCODE = '55000'; END;"
            : "BEGIN RAISE EXCEPTION 'workflow_evidence is append-only; % is not permitted.', TG_OP USING ERRCODE = '55000'; END;"), `${table} append-only trigger ${name}`);
      }
      const expectedStatuses: Record<string, string[]> = {
        reservation_status: ['active', 'canceled', 'reimbursed'],
        order_status: ['pending_shipment', 'partial_shipment', 'shipped', 'partial_delivery', 'delivered', 'partial_return', 'returned', 'vendor_canceled', 'user_canceled'],
        shipment_status: ['shipped', 'out_for_delivery', 'delivered', 'returned'],
      };
      for (const [table, descriptions] of Object.entries(expectedStatuses)) {
        // Table is selected only from the static contract above; never from caller input.
        const rows = (await client.query<{ id: string; description: string }>(`SELECT id::text,description FROM public.${table} ORDER BY id`)).rows;
        assert(rows.length === descriptions.length && descriptions.every((description, index) => rows.some(row => row.id === String(index + 1) && row.description === description)), `${table} fixed lookup identifiers`);
      }
      await this.verifyOwnership();
      await client.query('COMMIT');
      this.validated = true;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { destroy = true; this.failed = true; }
      throw error;
    } finally { client.release(destroy); }
  }
  async withTransaction<T>(action: (tx: BusinessRepositories) => Promise<T>): Promise<T> {
    this.assertAvailable();
    if (!this.validated) throw new Error('Validate the installed relational schema before business reads or writes.');
    await this.verifyOwnership();
    const client = await this.pool.connect();
    let destroy = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await action(new BusinessRepositories(client));
      await this.verifyOwnership();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { destroy = true; this.failed = true; }
      // In particular, never retry immutable-payout/check violations or unknown effects.
      throw error;
    } finally { client.release(destroy); }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.relinquishAccount();
    } finally {
      await this.pool.end();
    }
  }
}

