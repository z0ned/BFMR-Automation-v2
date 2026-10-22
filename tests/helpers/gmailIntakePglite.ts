import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { QueryResult, QueryResultRow } from 'pg';
import { PostgresGmailIntakeStore, type GmailIntakeOptions, type GmailIntakePool } from '../../src/services/postgresGmailIntake';

// Always disposable in-memory WASM PostgreSQL. No environment/configuration files,
// DATABASE_URL, network connection or provider adapter are consulted.
let embeddedPromise: Promise<PGlite> | undefined;
after(async () => { if (embeddedPromise) await (await embeddedPromise).close(); });

export async function createGmailIntakeFixture() {
  const schema = await readFile(fileURLToPath(new URL('../../database/gmail_intake.sql', import.meta.url)), 'utf8');
  const embedded = await (embeddedPromise ??= PGlite.create());
  await embedded.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await embedded.exec(schema);
  let owned = true;
  let poolEndCalls = 0;
  let fault: ((sql: string) => void) | undefined;
  const statements: string[] = [];
  async function query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    statements.push(sql);
    fault?.(sql);
    const result = await embedded.query<T>(sql, values);
    const rows = result.rows.map(row => {
      const copy = { ...row };
      for (const field of result.fields) {
        const value = copy[field.name];
        if (field.dataTypeID === 20 && value != null) (copy as Record<string, unknown>)[field.name] = String(value);
        if (field.dataTypeID === 1184 && value != null && !(value instanceof Date)) {
          (copy as Record<string, unknown>)[field.name] = new Date(String(value));
        }
      }
      return copy;
    });
    return { command: result.command ?? '', rowCount: result.affectedRows ?? rows.length, oid: 0, rows,
      fields: result.fields.map(field => ({ name: field.name, dataTypeID: field.dataTypeID,
        tableID: 0, columnID: 0, dataTypeSize: 0, dataTypeModifier: -1, format: 'text' })) };
  }
  const pool: GmailIntakePool = {
    async connect() { return { query, release() {} }; },
    async end() { poolEndCalls += 1; },
  };
  const options: GmailIntakeOptions = {
    account: 'synthetic-bfmr-account', mailbox: 'synthetic@example.org',
    subscription: 'projects/synthetic/subscriptions/intake', topic: 'projects/synthetic/topics/intake',
    async verifyOwnership() { if (!owned) throw new Error('Synthetic ownership loss'); },
  };
  function createStore(overrides: Partial<GmailIntakeOptions> = {}) {
    return new PostgresGmailIntakeStore('postgresql://synthetic.invalid/offline-only', { ...options, ...overrides }, { pool });
  }
  const store = createStore();
  return { store, createStore, options, query, statements,
    poolEndCalls: () => poolEndCalls,
    loseOwnership() { owned = false; }, restoreOwnership() { owned = true; },
    setFault(handler?: (sql: string) => void) { fault = handler; } };
}
