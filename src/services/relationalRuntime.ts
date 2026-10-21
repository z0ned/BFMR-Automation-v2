import path from 'node:path';
import os from 'node:os';
import { PostgresAccountOwnership } from '../db/postgresDatabase';
import { RelationalDatabase } from '../db/relationalDatabase';
import { BfmrRelationalSync } from './bfmrRelationalSync';
import { relationalOrderLedger, validateRelationalRetailerAccount } from './relationalOrderLedger';
import { assertRelationalCutoverReady, hashPrivateFile } from './relationalCutover';

/** Business records use PostgreSQL; cursors, batch/recovery journals and alerts
 * keep their existing private stores. Startup performs no DDL or state import.
 */
export async function openRelationalRuntime() {
  const account = process.env.BFMR_EXPECTED_ACCOUNT?.trim().toLowerCase();
  const connection = process.env.DATABASE_URL;
  const retailerAccountId = process.env.BFMR_RETAILER_ACCOUNT_ID?.trim();
  const expectedAccountEmail = process.env.BFMR_RETAILER_ACCOUNT_EMAIL?.trim();
  if (!account || !connection || !retailerAccountId || !expectedAccountEmail) {
    throw new Error('Relational startup requires DATABASE_URL, BFMR_EXPECTED_ACCOUNT, BFMR_RETAILER_ACCOUNT_ID and BFMR_RETAILER_ACCOUNT_EMAIL.');
  }
  if (!/^[1-9]\d*$/.test(retailerAccountId)) throw new Error('Retailer account must be an existing database ID.');
  const ownership = new PostgresAccountOwnership(connection, account);
  const db = new RelationalDatabase(connection, () => ownership.verifyOwnership());
  try {
    if (!await ownership.claimAccount(`bfmr_worker_lock_${account}`)) throw new Error('Another worker owns this BFMR account.');
    await db.validateSchema();
    const legacyFile = process.env.BFMR_AMAZON_ORDER_LEDGER_PATH || path.join(os.homedir(), '.local/state/bfmr/amazon-orders.json');
    await assertRelationalCutoverReady(db, { account, legacyOrderLedgerSha256: await hashPrivateFile(legacyFile) });
    const options = { retailerAccountId, expectedAccountEmail };
    await validateRelationalRetailerAccount(db, options);
    return {
      db, ownership, account, retailerAccountId,
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
