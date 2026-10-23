import fs from 'node:fs/promises';
import path from 'node:path';
import { parseRelationalCutoverManifest, type RelationalCutoverManifest } from './relationalCutover';

const STATE_FILES = {
  BFMR_AMAZON_ORDER_LEDGER_PATH: 'amazon-orders.json',
  BFMR_GMAIL_QUEUE_PATH: 'gmail-intake.json',
  BFMR_MULTI_DEAL_STATE_PATH: 'multi-deal.json',
  BFMR_STARTUP_STATE_PATH: 'startup-reservation.json',
  BFMR_POST_RESERVATION_STATE_PATH: 'post-reservation.json',
  BFMR_STATUS_SNAPSHOT_PATH: 'bfmr-status.json',
} as const;

export interface FreshStartPreparationOptions {
  account: string;
  confirmedNoOutstandingWork: boolean;
  directory: string;
  stateOverrides?: Partial<Record<keyof typeof STATE_FILES, string>>;
}

export interface FreshStartPreparationResult {
  manifestPath: string;
  manifest: RelationalCutoverManifest;
  legacyFile: string;
}

/**
 * Prepares a fresh-start cutover candidate manifest.
 *
 * Verifies that no unreconciled legacy JSON state files exist in the target directory,
 * creates the private directory (0700 permissions), and generates a version 2 START_FROM
 * manifest locking the cutover timestamp.
 */
export async function prepareFreshStartCutover(
  options: FreshStartPreparationOptions
): Promise<FreshStartPreparationResult> {
  const account = options.account.trim().toLowerCase();

  if (!account || !path.isAbsolute(options.directory) || options.confirmedNoOutstandingWork !== true) {
    throw new Error(
      'Fresh-start preparation requires an account, absolute private directory and no-outstanding-work confirmation.'
    );
  }

  // Ensure no existing recovery state files are concealed
  for (const [variable, filename] of Object.entries(STATE_FILES)) {
    const override = options.stateOverrides?.[variable as keyof typeof STATE_FILES];
    const candidateFiles = new Set([
      path.join(options.directory, filename),
      ...(override ? [override] : []),
    ]);

    for (const file of candidateFiles) {
      if (!path.isAbsolute(file)) {
        throw new Error('Recovery paths must be absolute.');
      }

      try {
        await fs.lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue; // File does not exist; safe to proceed
        }
        throw new Error('Private recovery state could not be inspected; reconcile before proceeding.');
      }

      throw new Error('Existing private recovery state must be reconciled; fresh-start preparation refused.');
    }
  }

  const manifestPath = path.join(options.directory, 'cutover-start-from.json');
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });

  let manifest: RelationalCutoverManifest;

  try {
    const existingRaw = await fs.readFile(manifestPath, 'utf8');
    manifest = parseRelationalCutoverManifest(JSON.parse(existingRaw));

    if (manifest.version !== 2 || manifest.account !== account) {
      throw new Error('Existing candidate differs; review it privately.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    const startsAt = new Date().toISOString();
    manifest = parseRelationalCutoverManifest({
      version: 2,
      account,
      approvedAt: startsAt,
      coverage: { sinceBaseline: true },
      baseline: {
        mode: 'START_FROM',
        startsAt,
        priorCompletedActivity: 'EXCLUDED',
        noOutstandingWork: true,
      },
      legacyOrderLedgerSha256: null,
      excludedStandaloneOrderIds: [],
      reservations: [],
    });

    await fs.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  }

  const legacyFile =
    options.stateOverrides?.BFMR_AMAZON_ORDER_LEDGER_PATH ||
    path.join(options.directory, 'amazon-orders.json');

  return { manifestPath, manifest, legacyFile };
}
