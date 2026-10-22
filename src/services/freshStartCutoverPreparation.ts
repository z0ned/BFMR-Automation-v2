import fs from 'node:fs/promises';
import path from 'node:path';
import { parseRelationalCutoverManifest, type RelationalCutoverManifest } from './relationalCutover';

const stateFiles = {
  BFMR_AMAZON_ORDER_LEDGER_PATH: 'amazon-orders.json',
  BFMR_GMAIL_QUEUE_PATH: 'gmail-intake.json',
  BFMR_MULTI_DEAL_STATE_PATH: 'multi-deal.json',
  BFMR_STARTUP_STATE_PATH: 'startup-reservation.json',
  BFMR_POST_RESERVATION_STATE_PATH: 'post-reservation.json',
  BFMR_STATUS_SNAPSHOT_PATH: 'bfmr-status.json',
};
export interface FreshStartPreparationOptions {
  account: string;
  confirmedNoOutstandingWork: boolean;
  directory: string;
  stateOverrides?: Partial<Record<keyof typeof stateFiles, string>>;
}

/** Only prepares a private candidate. No environment, database or provider reads.
 * Explicit configuration makes offline tests independent of private local state.
 */
export async function prepareFreshStartCutover(options: FreshStartPreparationOptions) {
  const account = options.account.trim().toLowerCase();
  if (!account || !path.isAbsolute(options.directory) || options.confirmedNoOutstandingWork !== true) {
    throw new Error('Fresh-start preparation requires an account, absolute private directory and no-outstanding-work confirmation.');
  }
  for (const [variable, filename] of Object.entries(stateFiles)) {
    // An override must not conceal an existing default journal.
    const override = options.stateOverrides?.[variable as keyof typeof stateFiles];
    for (const file of new Set([path.join(options.directory, filename), ...(override ? [override] : [])])) {
      if (!path.isAbsolute(file)) throw new Error('Recovery paths must be absolute.');
      try { await fs.lstat(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error('Private recovery state could not be inspected; reconcile before proceeding.');
      }
      throw new Error('Existing private recovery state must be reconciled; fresh-start preparation refused.');
    }
  }
  const manifestPath = path.join(options.directory, 'cutover-start-from.json');
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
  let manifest: RelationalCutoverManifest;
  try {
    manifest = parseRelationalCutoverManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
    if (manifest.version !== 2 || manifest.account !== account) throw new Error('Existing candidate differs; review it privately.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const startsAt = new Date().toISOString();
    manifest = parseRelationalCutoverManifest({
      version: 2, account, approvedAt: startsAt, coverage: { sinceBaseline: true },
      baseline: { mode: 'START_FROM', startsAt, priorCompletedActivity: 'EXCLUDED', noOutstandingWork: true },
      legacyOrderLedgerSha256: null, excludedStandaloneOrderIds: [], reservations: [],
    });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return { manifestPath, manifest,
    legacyFile: options.stateOverrides?.BFMR_AMAZON_ORDER_LEDGER_PATH || path.join(options.directory, 'amazon-orders.json') };
}
