import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { QueryResult, QueryResultRow } from 'pg';
import { RelationalDatabase, type RelationalClient, type RelationalPool } from '../../src/db/relationalDatabase';

/** Canonical schema: database/schema.sql, based on BFMR_DB_Schema commit
 * a67a0715ef040b0dd65de17ce63a0a5e34898699 plus the approved 22 October
 * retailer-account ranking amendment. Earlier test evidence predates it.
 * No private DATABASE_URL is consulted. Cases share one embedded process with
 * a newly created public schema per fixture to bound WASM startup and memory.
 */
const CANONICAL_SCHEMA_SHA256 = '6c7c2707e854d9f5d07c9db073b5508792800ef5c57b6dcb5d19e2c445682af6';
export const schemaPath = process.env.BFMR_SCHEMA_SQL_PATH || fileURLToPath(new URL('../../database/schema.sql', import.meta.url));
export const databaseTestOptions = { skip: false };
let embeddedPromise: Promise<PGlite> | undefined;
after(async () => { if (embeddedPromise) await (await embeddedPromise).close(); });

export async function createRelationalFixture() {
  const schema = await readFile(schemaPath);
  if (createHash('sha256').update(schema).digest('hex') !== CANONICAL_SCHEMA_SHA256) {
    throw new Error('Schema fixture differs from the reviewed canonical source revision.');
  }
  const embedded = await (embeddedPromise ??= PGlite.create());
  await embedded.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await embedded.exec(schema.toString('utf8'));
  let owned = true;
  const statements: string[] = [];
  async function query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    statements.push(sql);
    const result = await embedded.query<T>(sql, values);
    // PGlite decodes int8 into numbers; node-postgres deliberately returns strings.
    const rows = result.rows.map(row => {
      const copy = { ...row };
      for (const field of result.fields) {
        if (field.dataTypeID === 20 && copy[field.name] !== null && copy[field.name] !== undefined) {
          (copy as Record<string, unknown>)[field.name] = String(copy[field.name]);
        }
      }
      return copy;
    });
    return { command: result.command ?? '', rowCount: result.affectedRows ?? rows.length,
      oid: 0, rows, fields: result.fields.map(field => ({ name: field.name, dataTypeID: field.dataTypeID,
        tableID: 0, columnID: 0, dataTypeSize: 0, dataTypeModifier: -1, format: 'text' })) };
  }
  const pool: RelationalPool = {
    query,
    async connect(): Promise<RelationalClient> { return { query, release() {} }; },
    // Each fixture closes its application wrapper. The global after hook closes
    // the shared embedded process after all serial cases have completed.
    async end() {},
  };
  const db = new RelationalDatabase('postgresql://synthetic.invalid/offline-only', async () => {
    if (!owned) throw new Error('Synthetic account ownership was lost.');
  }, { pool });
  return { db, query, embedded, statements, loseOwnership() { owned = false; }, restoreOwnership() { owned = true; } };
}
