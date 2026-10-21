import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReservationReference } from './amazonEvaluation';
import type { PrivateStateStore } from './privateJsonStore';

export interface MultiDealProgress {
  messageId: string;
  stage: 'RESERVING' | 'EVALUATING' | 'ORDERING' | 'COMPLETE';
  confirmed: ReservationReference[];
  evaluated: string[];
  orderStarted: string[];
  orderFinished: string[];
  cancelStarted: string[];
  cancelFinished: string[];
}

/** Local live-run guard; an incomplete batch requires manual reconciliation on restart. */
export type MultiDealStore = PrivateStateStore<MultiDealProgress>;
export function multiDealJournal(file: string): MultiDealStore {
  return {
    async load(): Promise<MultiDealProgress | null> {
      let contents: string;
      try { contents = await fs.readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      const value: unknown = JSON.parse(contents);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid multi-deal journal; manual review required.');
      const task = value as Record<string, unknown>;
      if (typeof task.messageId !== 'string' || !task.messageId ||
        !['RESERVING', 'EVALUATING', 'ORDERING', 'COMPLETE'].includes(String(task.stage)) ||
        !Array.isArray(task.confirmed) || !task.confirmed.every(reference =>
          reference && typeof reference.reserveId === 'string' && reference.reserveId &&
          typeof reference.dealId === 'string' && reference.dealId) ||
        ![task.evaluated, task.orderStarted, task.orderFinished, task.cancelStarted, task.cancelFinished].every(field =>
          Array.isArray(field) && field.every(id => typeof id === 'string' && id))) {
        throw new Error('Invalid multi-deal journal; manual review required.');
      }
      return task as unknown as MultiDealProgress;
    },
    async save(task: MultiDealProgress): Promise<void> {
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
