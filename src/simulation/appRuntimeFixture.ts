import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { QueryResult, QueryResultRow } from 'pg';
import { RelationalDatabase, type RelationalClient, type RelationalPool } from '../db/relationalDatabase';
import { BfmrRelationalSync } from '../services/bfmrRelationalSync';
import { relationalOrderLedger } from '../services/relationalOrderLedger';
import type { RelationalRuntime } from '../services/relationalRuntime';

const defaultSchemaPath = fileURLToPath(new URL('../../database/schema.sql', import.meta.url));
const defaultIntakeSqlPath = fileURLToPath(new URL('../../database/gmail_intake.sql', import.meta.url));

export async function createSimulationAppRuntime(options: {
  account?: string;
  retailerEmail?: string;
  schemaSqlPath?: string;
} = {}): Promise<RelationalRuntime & { pglite: PGlite }> {
  const account = (options.account || 'synthetic-operator-1').toLowerCase();
  const retailerEmail = (options.retailerEmail || 'buyer@example.invalid').toLowerCase();
  const schemaPath = options.schemaSqlPath || defaultSchemaPath;
  const schemaSql = await readFile(schemaPath, 'utf8');
  const intakeSql = await readFile(defaultIntakeSqlPath, 'utf8');

  const pglite = await PGlite.create();
  await pglite.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await pglite.exec(schemaSql);
  await pglite.exec(intakeSql);

  // Seed retailer and ranked retailer account
  const retailerRes = await pglite.query<{ id: string | number }>(
    `INSERT INTO public.retailers (name, primary_url)
     VALUES ('Amazon', 'https://www.amazon.com')
     RETURNING id`
  );
  const retailerId = String(retailerRes.rows[0].id);

  const accountRes = await pglite.query<{ id: string | number }>(
    `INSERT INTO public.retailer_accounts (retailer_id, email, ccv, retailer_account_ranking)
     VALUES ($1, $2, repeat('0', 3), 1)
     RETURNING id`,
    [retailerId, retailerEmail]
  );
  const retailerAccountId = String(accountRes.rows[0].id);

  // Seed gmail intake state for this account namespace
  await pglite.query(
    `INSERT INTO public.gmail_intake_state (account_namespace, mailbox, subscription, topic)
     VALUES ($1, 'deals@example.invalid', 'projects/synth/subscriptions/intake', 'projects/synth/topics/intake')
     ON CONFLICT (account_namespace) DO NOTHING`,
    [account]
  );

  let isOwned = true;

  async function query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    const res = await pglite.query<T>(sql, values);
    const rows = res.rows.map((row) => {
      const copy = { ...row };
      for (const field of res.fields) {
        if (field.dataTypeID === 20 && copy[field.name] !== null && copy[field.name] !== undefined) {
          (copy as Record<string, unknown>)[field.name] = String(copy[field.name]);
        }
      }
      return copy;
    });

    return {
      command: res.command ?? '',
      rowCount: res.affectedRows ?? rows.length,
      oid: 0,
      rows,
      fields: res.fields.map((f) => ({
        name: f.name,
        dataTypeID: f.dataTypeID,
        tableID: 0,
        columnID: 0,
        dataTypeSize: 0,
        dataTypeModifier: -1,
        format: 'text',
      })),
    };
  }

  const pool: RelationalPool = {
    query,
    async connect(): Promise<RelationalClient> {
      return { query, release() {} };
    },
    async end() {
      await pglite.close();
    },
  };

  const db = new RelationalDatabase('postgresql://synthetic-sim.invalid/app-run', async () => {
    if (!isOwned) throw new Error('Simulated application database ownership lost.');
  }, { pool });
  await db.validateSchema();

  const retailerAccount = Object.freeze({
    id: retailerAccountId,
    retailer_id: retailerId,
    email: retailerEmail,
    retailer_account_ranking: 1,
    name: 'Amazon',
    primary_url: 'https://www.amazon.com',
  });

  const ledgerOptions = Object.freeze({
    retailerId,
    retailerAccountId,
    expectedAccountEmail: retailerEmail,
  });

  const ownership = {
    async verifyOwnership() {
      if (!isOwned) throw new Error('Simulated account ownership lost.');
    },
    async claimAccount() {
      isOwned = true;
      return true;
    },
    onOwnershipLost(_callback: () => void) {},
    async close() {
      isOwned = false;
    },
  };

  const runtime: RelationalRuntime & { pglite: PGlite } = {
    db,
    ownership: ownership as any,
    account,
    retailerAccount: retailerAccount as any,
    baselineStartsAt: '2026-01-01T00:00:00.000Z',
    connectionString: 'postgresql://synthetic-sim.invalid/app-run',
    database: { mode: 'testing' as const, variable: 'DATABASE_URL_TEST' as const, targetSha256: 'mock' },
    retailerAccountId,
    async verifyRetailerAccount() {},
    sync: new BfmrRelationalSync(db),
    ledger: relationalOrderLedger(db, ledgerOptions),
    pglite,
    async close() {
      await db.close();
      await pglite.close();
    },
  };

  return runtime;
}
