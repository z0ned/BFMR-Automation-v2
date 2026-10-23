import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
/** Identify the code actually on disk, including uncommitted source changes. */
export function sourceIdentity() {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.recovery.json'];
  const walk = (directory: string) => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Source identity refuses symlinked source files.');
      if (entry.isDirectory()) walk(name);
      else if (/\.(ts|sql|psql|sh)$/.test(entry.name)) files.push(name);
    }
  };
  for (const directory of ['src', 'scripts', 'database']) walk(directory);
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(path.join(root, file))).update('\0');
  return { revision, dirty: Boolean(git(['status', '--porcelain', '--untracked-files=normal'])), codeSha256: hash.digest('hex') };
}
