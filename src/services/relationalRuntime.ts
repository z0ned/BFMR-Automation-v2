import { environmentPaths } from '../config/environment';
import { selectDatabase, databaseIdentity } from '../db/databaseConfig';
import { assertNoIncompleteRestore } from './restoreBoundary';
import path from 'node:path';
import os from 'node:os';
import { PostgresAccountOwnership } from '../db/postgresDatabase';
import { RelationalDatabase } from '../db/relationalDatabase';
import { BfmrRelationalSync } from './bfmrRelationalSync';
import { relationalOrderLedger, validateRelationalRetailerAccount } from './relationalOrderLedger';
import { assertRelationalCutoverReady, hashPrivateFile } from './relationalCutover';

/**
 * Resolves the working connection string, automatically translating the internal
 * Docker hostname 'bfmr-postgres' to 'localhost' when running on the host machine.
 */
export async function resolveWorkingConnectionString(rawUrl?: string): Promise<string> {
  let connection = rawUrl ?? selectDatabase().connectionString;
  if (connection.includes('@bfmr-postgres')) {
    try {
      const dns = await import('node:dns/promises');
      await dns.lookup('bfmr-postgres');
    } catch {
      connection = connection.replace(/@bfmr-postgres(:|\/)/, '@localhost$1');
    }
  }
  return connection;
}

/** Business records use PostgreSQL. The worker opens its separate SQL Gmail
 * intake store under this ownership; batch/recovery journals and alerts retain
 * their private stores. Startup performs no DDL or state import.
 */
export async function openRelationalRuntime() {
  assertNoIncompleteRestore();
  const account = process.env.BFMR_EXPECTED_ACCOUNT?.trim().toLowerCase();
  const selected = selectDatabase();
  const rawConnection = selected.connectionString;
  if (!account) {
    throw new Error('Relational startup requires the mode-selected database URL and BFMR_EXPECTED_ACCOUNT.');
  }

  const connection = await resolveWorkingConnectionString(rawConnection);
  const ownership = new PostgresAccountOwnership(connection, account);
  const db = new RelationalDatabase(connection, () => ownership.verifyOwnership());

  try {
    if (!await ownership.claimAccount(`bfmr_worker_lock_${account}`)) {
      throw new Error('Another worker owns this BFMR account.');
    }
    await db.validateSchema();
    if (selected.mode === 'testing') {
      const roles = await db.withTransaction(tx => tx.query<{ unsafe: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)
      ) OR EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND pg_has_role(current_user, c.relowner, 'USAGE')
      ) AS unsafe`));
      const production = process.env.DATABASE_URL_PRODUCTION;
      if (roles.rows[0]?.unsafe !== false || (production &&
          new URL(production).username === new URL(selected.connectionString).username)) {
        throw new Error('Testing requires a distinct non-owning database runtime role without administrator privileges.');
      }
    }
    const retailerAccount = Object.freeze(await validateRelationalRetailerAccount(db));
    if (selected.mode === 'testing') {
      const expected = process.env.AMAZON_EXPECTED_ACCOUNT?.trim().toLowerCase();
      const production = process.env.AMAZON_EXPECTED_ACCOUNT_PRODUCTION?.trim().toLowerCase();
      if (!expected || !production || expected === production || retailerAccount.email.trim().toLowerCase() !== expected) {
        throw new Error('The test database must select the separate configured test Amazon account. Cloned production accounts cannot be used.');
      }
    }
    const options = Object.freeze({
      retailerId: retailerAccount.retailer_id,
      retailerAccountId: retailerAccount.id,
      expectedAccountEmail: retailerAccount.email,
    });
    const legacyFile = process.env.BFMR_AMAZON_ORDER_LEDGER_PATH || path.join(environmentPaths().state, 'amazon-orders.json');
    const baselineStartsAt = await assertRelationalCutoverReady(db, {
      account,
      legacyOrderLedgerSha256: await hashPrivateFile(legacyFile),
    });

    return {
      db,
      ownership,
      account,
      retailerAccount,
      baselineStartsAt,
      connectionString: connection,
      database: databaseIdentity(selected),
      retailerAccountId: retailerAccount.id,
      async verifyRetailerAccount() {
        await validateRelationalRetailerAccount(db, options);
      },
      sync: new BfmrRelationalSync(db),
      ledger: relationalOrderLedger(db, options),
      async close() {
        try {
          await db.close();
        } finally {
          await ownership.close();
        }
      },
    };
  } catch (error) {
    try {
      await db.close();
    } finally {
      await ownership.close();
    }
    throw error;
  }
}

export type RelationalRuntime = Awaited<ReturnType<typeof openRelationalRuntime>>;
