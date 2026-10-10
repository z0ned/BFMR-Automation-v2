import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StartupAttempt } from './startupReservation';
import { isTrustedBfmrDealUrl } from './bfmrUrl';

/** Local live-test recovery evidence; not the production PostgreSQL attempt store. */
export function startupJournal(file: string) {
  return {
    async load(): Promise<StartupAttempt | null> {
      let contents: string;
      try { contents = await fs.readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      const value = JSON.parse(contents);
      if (!value || !isTrustedBfmrDealUrl(value.url) || typeof value.id !== 'string' || !value.id ||
        typeof value.title !== 'string' || !value.title || ![1, 2].includes(value.ordinal) ||
        !['SUBMITTING', 'CONFIRMED', 'RETRY_PENDING', 'REVIEW', 'EXHAUSTED', 'SKIPPED', 'CLEANUP_PENDING', 'CLEANED'].includes(value.state) ||
        (value.state === 'RETRY_PENDING' && value.ordinal !== 1)) throw new Error('Invalid startup attempt journal; refusing to reset recovery evidence.');
      if (value.reference !== undefined && (typeof value.reference?.reserveId !== 'string' || !value.reference.reserveId.trim() ||
        typeof value.reference?.dealId !== 'string' || !value.reference.dealId.trim())) {
        throw new Error('Invalid startup reservation reference; refusing cleanup.');
      }
      return value;
    },
    async save(value: StartupAttempt): Promise<void> {
      const directory = path.dirname(file);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
      const directoryHandle = await fs.open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      // Keep transition evidence when the latest-attempt snapshot is replaced.
      const audit = await fs.open(`${file}.events.jsonl`, 'a', 0o600);
      try { await audit.writeFile(`${JSON.stringify({ ...value, recordedAt: new Date().toISOString() })}\n`); await audit.sync(); }
      finally { await audit.close(); }
    },
  };
}
