import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PostReservationTask } from './postReservation';

/** Local test recovery only. No credentials or raw provider payloads are stored. */
export function postReservationJournal(file: string) {
  return {
    async load(): Promise<PostReservationTask | null> {
      let text: string;
      try { text = await fs.readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      const value = JSON.parse(text);
      if (!value || !['STARTUP', 'EMAIL'].includes(value.kind) ||
        !['EVALUATE', 'CANCEL_PENDING', 'KEPT', 'CANCELLED'].includes(value.state) ||
        typeof value.reference?.reserveId !== 'string' || !value.reference.reserveId.trim() ||
        typeof value.reference?.dealId !== 'string' || !value.reference.dealId.trim()) {
        throw new Error('Invalid post-reservation journal; manual review required.');
      }
      return value;
    },
    async save(task: PostReservationTask): Promise<void> {
      const directory = path.dirname(file);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(task)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
      const parent = await fs.open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    },
  };
}
