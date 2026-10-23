import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { Client } from 'pg';
import { checkSystemHealth } from '../scripts/health_check';
import { sourceIdentity } from '../scripts/sourceIdentity';
import { assertNoIncompleteRestore } from '../src/services/restoreBoundary';

async function restoreFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bfmr-review-'));
  const backup = path.join(root, 'backup');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state/bfmr');
  const archiveRoot = path.join(root, 'archive');
  await Promise.all([mkdir(backup), mkdir(bin), mkdir(state, { recursive: true }), mkdir(path.join(archiveRoot, 'bfmr'), { recursive: true })]);
  await writeFile(path.join(state, 'old.json'), 'old');
  await writeFile(path.join(archiveRoot, 'bfmr/new.json'), 'new');
  await writeFile(path.join(backup, 'database_bfmr.sql.gz'), gzipSync('SELECT 1;\n'));
  execFileSync('tar', ['-czf', path.join(backup, 'local_state.tar.gz'), '-C', archiveRoot, 'bfmr']);
  const capture = path.join(root, 'captured.sql');
  await writeFile(path.join(bin, 'psql'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$RESTORE_ARGS"\ncat > "$RESTORE_CAPTURE"\nexit "${RESTORE_EXIT:-0}"\n', { mode: 0o700 });
  const checksums = async () => {
    const names = ['database_bfmr.sql.gz', 'local_state.tar.gz'];
    const lines = await Promise.all(names.map(async name => `${createHash('sha256').update(await readFile(path.join(backup, name))).digest('hex')}  ${name}\n`));
    await writeFile(path.join(backup, 'SHA256SUMS'), lines.join(''));
  };
  await checksums();
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, PGUSER: 'synthetic', PGDATABASE: 'synthetic',
    BFMR_RESTORE_WORKER_STOPPED: 'YES', BFMR_STATE_DIR: state, RESTORE_CAPTURE: capture, RESTORE_ARGS: path.join(root, 'args') };
  const run = (overrides: Record<string, string> = {}) => spawnSync('bash', ['scripts/restore_production_state.sh', backup], { cwd: process.cwd(), env: { ...env, ...overrides }, encoding: 'utf8' });
  return { root, backup, state, capture, checksums, run };
}

test('restore SQL failure preserves prior state and incomplete marker without reporting success', async t => {
  const f = await restoreFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = f.run({ RESTORE_EXIT: '3' });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(f.state, 'old.json'), 'utf8'), 'old');
  assert.ok(await stat(`${f.state}.restore-incomplete`));
  assert.doesNotMatch(result.stdout, /Restore completed/);
  const args = await readFile(path.join(f.root, 'args'), 'utf8');
  assert.match(args, /ON_ERROR_STOP=1/);
  assert.match(args, /--single-transaction/);
  assert.match(args, /--file=-/);
  assert.match(await readFile(f.capture, 'utf8'), /empty replacement database/);
  const old = process.env.BFMR_STATE_DIR;
  process.env.BFMR_STATE_DIR = f.state;
  try { assert.throws(assertNoIncompleteRestore, /restore is incomplete/); }
  finally { if (old === undefined) delete process.env.BFMR_STATE_DIR; else process.env.BFMR_STATE_DIR = old; }
});

test('successful restore publishes staged private state and preserves the previous directory', async t => {
  const f = await restoreFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(f.state, 'new.json'), 'utf8'), 'new');
  assert.equal((await stat(path.join(f.state, 'new.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.state)).mode & 0o777, 0o700);
  await assert.rejects(stat(`${f.state}.restore-incomplete`), { code: 'ENOENT' });
  const staging = (await readdir(path.dirname(f.state))).find(name => name.startsWith('.bfmr-restore.'))!;
  assert.equal(await readFile(path.join(path.dirname(f.state), staging, 'previous-state/old.json'), 'utf8'), 'old');
});

for (const fault of ['missing-checksum', 'corruption', 'missing-dump', 'worker-not-stopped']) test(`restore refuses ${fault} before invoking SQL`, async t => {
  const f = await restoreFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  if (fault === 'missing-checksum') await rm(path.join(f.backup, 'SHA256SUMS'));
  if (fault === 'corruption') await writeFile(path.join(f.backup, 'database_bfmr.sql.gz'), 'corrupt');
  if (fault === 'missing-dump') await rm(path.join(f.backup, 'database_bfmr.sql.gz'));
  const result = f.run(fault === 'worker-not-stopped' ? { BFMR_RESTORE_WORKER_STOPPED: '' } : {});
  assert.notEqual(result.status, 0);
  await assert.rejects(stat(f.capture), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.state, 'old.json'), 'utf8'), 'old');
});

test('health reports UNKNOWN exposure on SQL failure and closes the client', async () => {
  let closed = false;
  const client = { query: async (sql: string) => {
    if (sql.includes('version()')) return { rows: [{ full: 'PostgreSQL 17.11' }] };
    throw new Error('Synthetic missing privilege');
  }, end: async () => { closed = true; } } as unknown as Pick<Client, 'query' | 'end'>;
  const report = await checkSystemHealth({ connect: async () => client, heartbeatPath: '/nonexistent/synthetic-heartbeat' });
  assert.equal(report.exposure, 'UNKNOWN');
  assert.equal(report.details.exposureDollars, undefined);
  assert.equal(closed, true);
});

for (const fail of [false, true]) test(`coordinated backup ${fail ? 'retains an incomplete boundary on dump failure' : 'creates a checksummed SQL/state pair'}`, async t => {
  const f = await restoreFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const bin = path.join(f.root, 'bin');
  await writeFile(path.join(bin, 'pg_dump'), fail ? '#!/bin/bash\nexit 3\n' : '#!/bin/bash\nprintf "SELECT 1;\\n"\n', { mode: 0o700 });
  const backupRoot = path.join(f.root, 'new-backups');
  const result = spawnSync('bash', ['scripts/backup_production_state.sh'], { encoding: 'utf8', env: {
    PATH: `${bin}:/usr/bin:/bin`, HOME: f.root, PGUSER: 'synthetic', PGDATABASE: 'synthetic',
    BFMR_BACKUP_DIR: backupRoot, BFMR_STATE_DIR: f.state, BFMR_BACKUP_WORKER_STOPPED: 'YES',
  } });
  const target = path.join(backupRoot, (await readdir(backupRoot))[0]);
  if (fail) {
    assert.notEqual(result.status, 0);
    assert.ok(await stat(path.join(target, 'INCOMPLETE')));
    assert.doesNotMatch(result.stdout, /backup completed/);
  } else {
    assert.equal(result.status, 0, result.stderr);
    const entries = (await readFile(path.join(target, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      const [digest, file] = entry.split('  ');
      assert.equal(createHash('sha256').update(await readFile(path.join(target, file))).digest('hex'), digest);
    }
    await assert.rejects(stat(path.join(target, 'INCOMPLETE')), { code: 'ENOENT' });
    assert.equal((await stat(target)).mode & 0o777, 0o700);
  }
});

test('source identity fingerprints the actual checkout deterministically', () => {
  const first = sourceIdentity();
  const second = sourceIdentity();
  assert.match(first.revision, /^[0-9a-f]{40}$/);
  assert.match(first.codeSha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof first.dirty, 'boolean');
  assert.deepEqual(second, first);
});

test('failed state publication retains the incomplete boundary and both state directories', async t => {
  const f = await restoreFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(path.join(f.root, 'bin/mv'), '#!/bin/bash\nif [ "$3" = "$BFMR_STATE_DIR" ]; then exit 4; fi\nexec /usr/bin/mv "$@"\n', { mode: 0o700 });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.ok(await stat(`${f.state}.restore-incomplete`));
  assert.doesNotMatch(result.stdout, /Restore completed/);
  const staging = (await readdir(path.dirname(f.state))).find(name => name.startsWith('.bfmr-restore.'))!;
  assert.equal(await readFile(path.join(path.dirname(f.state), staging, 'previous-state/old.json'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(path.dirname(f.state), staging, 'bfmr/new.json'), 'utf8'), 'new');
});

test('restore rejects archive links before invoking SQL', async t => {
  const f = await restoreFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  execFileSync('python3', ['-c', "import sys,tarfile\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n m=tarfile.TarInfo('bfmr/link');m.type=tarfile.SYMTYPE;m.linkname='../../escape';t.addfile(m)", path.join(f.backup, 'local_state.tar.gz')]);
  await f.checksums();
  const result = f.run();
  assert.notEqual(result.status, 0);
  await assert.rejects(stat(f.capture), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.state, 'old.json'), 'utf8'), 'old');
});
