import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** One account owner writes this private, atomically replaced and fsynced state. */
export function privateJsonStore<T>(file: string, validate: (value: unknown) => T) {
  return {
    async load(): Promise<T | null> {
      try { return validate(JSON.parse(await fs.readFile(file, 'utf8'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    async save(value: T): Promise<void> {
      validate(value);
      const directory = path.dirname(file);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
      const parent = await fs.open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    },
  };
}
