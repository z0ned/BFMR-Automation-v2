import './loadEnv';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Explicit operator command only. Never imported by startup or cutover.
async function main() {
  const admin = process.env.BFMR_DATABASE_ADMIN_URL;
  if (!admin) throw new Error('Configure BFMR_DATABASE_ADMIN_URL privately with the approved PostgreSQL administrator login to bfmr.');
  let source: URL;
  try { source = new URL(admin); } catch { throw new Error('BFMR_DATABASE_ADMIN_URL is not a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(source.protocol) || !source.hostname || source.pathname !== '/bfmr' || source.search || source.hash) {
    throw new Error('The clone administrator URL must explicitly address bfmr, without query overrides.');
  }
  const db = new pg.Client({ connectionString: admin, connectionTimeoutMillis: 10000 });
  try { await db.connect(); } catch { throw new Error('Cannot connect to bfmr as administrator. Check private credentials and server access.'); }
  const role = await db.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
  if (!role.rows[0]?.rolsuper) {
    await db.end();
    throw new Error('The offline clone requires the PostgreSQL superuser to restore while connection limit is 0. No database was created.');
  }
  let created = false;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bfmr-clone-'));
  await chmod(directory, 0o700);
  const archive = path.join(directory, 'snapshot.dump');
  const run = (command: string, args: string[], url: string) => new Promise<void>((resolve, reject) => {
    const parsed = new URL(url);
    const child = spawn(command, args, { env: { ...process.env,
      PGHOST: parsed.hostname, PGPORT: parsed.port || '5432', PGDATABASE: parsed.pathname.slice(1),
      PGUSER: decodeURIComponent(parsed.username), PGPASSWORD: decodeURIComponent(parsed.password),
      PGSERVICE: '', PGSERVICEFILE: '', PGOPTIONS: '', PGHOSTADDR: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
    // Tool stderr can contain private SQL/data. Never copy it to logs.
    child.stderr.resume();
    child.once('error', () => reject(new Error(`${command} is unavailable; install matching PostgreSQL client tools.`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed; inspect the database privately.`)));
  });
  try {
    await db.query("SELECT pg_advisory_lock(hashtext('bfmr-clone-test-database'))");
    const existing = await db.query("SELECT 1 FROM pg_database WHERE datname = 'bfmr_test'");
    if (existing.rowCount) throw new Error('bfmr_test already exists; no database was overwritten.');
    // pg_dump provides a consistent snapshot without stopping or disconnecting production.
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', archive], admin);
    await db.query('CREATE DATABASE bfmr_test TEMPLATE template0 CONNECTION LIMIT 0');
    created = true;
    await db.query('REVOKE ALL ON DATABASE bfmr_test FROM PUBLIC');
    const target = new URL(admin); target.pathname = '/bfmr_test';
    await run('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--dbname', 'bfmr_test', archive], target.toString());
    console.log('Created bfmr_test from a consistent bfmr schema/data snapshot. Production was not modified.');
    console.log('The clone is administrator-only: runtime grants and separate test provider/account provisioning are required before startup.');
    console.log('Cloned Gmail cursors, recovery evidence and retailer accounts were preserved; no worker was started.');
  } catch (error) {
    if (created) console.error('bfmr_test was created but provisioning failed. Keep it offline; it was not dropped or retried.');
    throw error;
  } finally {
    await db.end();
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => {
  // Never print pg errors/URLs: those can contain credentials or production rows.
  console.error(error instanceof Error && !('code' in error) ? error.message : 'Database clone failed. Inspect connection/privileges privately.');
  process.exitCode = 1;
});
