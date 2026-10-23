import { environmentPaths } from '../src/config/environment';
import { selectDatabase } from '../src/db/databaseConfig';
import './loadEnv';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareFreshStartCutover } from '../src/services/freshStartCutoverPreparation';
import { main as reportCutover } from './reconcile_relational_cutover';

/** Private candidate and report only; never apply, initialize or invoke providers. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--confirm-no-outstanding-work') {
    throw new Error('Requires explicit confirmation that no outstanding or uncertain work needs migration.');
  }
  selectDatabase();
  if (!process.env.BFMR_EXPECTED_ACCOUNT?.trim()) {
    throw new Error('Private account/database configuration is required.');
  }
  const candidate = await prepareFreshStartCutover({
    account: process.env.BFMR_EXPECTED_ACCOUNT,
    confirmedNoOutstandingWork: true,
    directory: environmentPaths().state,
    stateOverrides: {
      BFMR_AMAZON_ORDER_LEDGER_PATH: process.env.BFMR_AMAZON_ORDER_LEDGER_PATH,
      BFMR_GMAIL_QUEUE_PATH: process.env.BFMR_GMAIL_QUEUE_PATH,
      BFMR_MULTI_DEAL_STATE_PATH: process.env.BFMR_MULTI_DEAL_STATE_PATH,
      BFMR_STARTUP_STATE_PATH: process.env.BFMR_STARTUP_STATE_PATH,
      BFMR_POST_RESERVATION_STATE_PATH: process.env.BFMR_POST_RESERVATION_STATE_PATH,
      BFMR_STATUS_SNAPSHOT_PATH: process.env.BFMR_STATUS_SNAPSHOT_PATH,
    },
  });
  await reportCutover(['--report', '--manifest', candidate.manifestPath,
    '--legacy-order-ledger', candidate.legacyFile]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Fresh-start preparation stopped. Review private recovery state, candidate manifest and database; nothing was applied.');
    process.exitCode = 1;
  });
}
