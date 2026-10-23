import { lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A lost SQL COMMIT response or failed state publication is never a restart. */
export function assertNoIncompleteRestore(): void {
  const directories = new Set([path.join(os.homedir(), '.local/state/bfmr'), process.env.BFMR_STATE_DIR].filter((p): p is string => Boolean(p)));
  for (const directory of directories) {
    try { lstatSync(`${directory}.restore-incomplete`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('Restore boundary cannot be inspected; keep workers stopped.');
    }
    throw new Error('A database/local-state restore is incomplete. Reconcile both stores before startup.');
  }
}
