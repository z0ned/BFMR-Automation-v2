import path from 'node:path';
import os from 'node:os';
import { PostgresAccountOwnership } from '../db/postgresDatabase';
import { RelationalDatabase } from '../db/relationalDatabase';
import { BfmrRelationalSync } from './bfmrRelationalSync';
import { relationalOrderLedger, validateRelationalRetailerAccount } from './relationalOrderLedger';
import { assertRelationalCutoverReady, hashPrivateFile } from './relationalCutover';

/** Business records use PostgreSQL. The worker opens its separate SQL Gmail
 * intake store under this ownership; batch/recovery journals and alerts retain
 * their private stores. Startup performs no DDL or state import.
 */
export async function openRelationalRuntime() {
  const account = process.env.BFMR_EXPECTED_ACCOUNT?.trim().toLowerCase();
  const connection = process.env.DATABASE_URL;
  if (!account || !connection) {
    throw new Error('Relational startup requires DATABASE_URL and BFMR_EXPECTED_ACCOUNT.');
  }
  const ownership = new PostgresAccountOwnership(connection, account);
  const db = new RelationalDatabase(connection, () => ownership.verifyOwnership());
  try {
    if (!await ownership.claimAccount(`bfmr_worker_lock_${account}`)) throw new Error('Another worker owns this BFMR account.');
    await db.validateSchema();
    const retailerAccount = Object.freeze(await validateRelationalRetailerAccount(db));
    const options = Object.freeze({ retailerId: retailerAccount.retailer_id,
      retailerAccountId: retailerAccount.id, expectedAccountEmail: retailerAccount.email });
    const legacyFile = process.env.BFMR_AMAZON_ORDER_LEDGER_PATH || path.join(os.homedir(), '.local/state/bfmr/amazon-orders.json');
    await assertRelationalCutoverReady(db, { account, legacyOrderLedgerSha256: await hashPrivateFile(legacyFile) });
    return {
      db, ownership, account, retailerAccount,
      retailerAccountId: retailerAccount.id,
      async verifyRetailerAccount() { await validateRelationalRetailerAccount(db, options); },
      sync: new BfmrRelationalSync(db),
      ledger: relationalOrderLedger(db, options),
      async close() { try { await db.close(); } finally { await ownership.close(); } },
    };
  } catch (error) {
    try { await db.close(); } finally { await ownership.close(); }
    throw error;
  }
}

export type RelationalRuntime = Awaited<ReturnType<typeof openRelationalRuntime>>;
