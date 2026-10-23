import './loadEnv';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectDatabaseClient } from './validate_database_environment';

export async function applyDatabaseOptimizations(): Promise<boolean> {
  const bold = '\x1b[1m';
  const green = '\x1b[32m';
  const red = '\x1b[31m';
  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';

  console.log(`\n${bold}====================================================${reset}`);
  console.log(`${bold}  BFMR Automation v2 - Apply Database Optimizations ${reset}`);
  console.log(`${bold}====================================================${reset}\n`);

  const sqlFile = path.resolve('database/optimizations.sql');
  if (!fs.existsSync(sqlFile)) {
    console.error(`${red}ERROR: File not found: ${sqlFile}${reset}\n`);
    return false;
  }

  const sqlContent = fs.readFileSync(sqlFile, 'utf8');

  // The operator must explicitly choose Docker; otherwise use the configured
  // direct connection. Never select another database merely because it exists.
  const container = process.env.BFMR_POSTGRES_CONTAINER;
  if (container) {
    try {
      console.log('[Optimizations] Applying reviewed optimizations via the explicitly selected container...');
      execFileSync('docker', ['exec', '-i', '--env', 'PGHOST', '--env', 'PGPORT', '--env', 'PGUSER',
        '--env', 'PGPASSWORD', '--env', 'PGDATABASE', container, 'psql', '-X', '--set=ON_ERROR_STOP=1'], {
        input: sqlContent, stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env,
          PGDATABASE: process.env.DATABASE_URL ?? process.env.PGDATABASE ?? 'bfmr', PGUSER: process.env.PGUSER ?? 'bfmr' },
      });

      console.log(`\n${green}${bold}[SUCCESS] Database optimizations applied successfully via the selected container!${reset}`);
      console.log('Applied:');
      console.log('  - idx_workflow_evidence_cutover (accelerates cutover status checks)');
      console.log('  - idx_reservations_open_exposure (accelerates open financial exposure checks)');
      console.log('  - idx_orders_order_id (accelerates retailer order lookup)');
      console.log('  - conservative unpaid-reservation-payout ceiling; native concurrency acceptance remains separate\n');
      return true;
    } catch {
      console.error('Database optimization application failed or its outcome is uncertain. Inspect the installed state before retrying.');
      return false;
    }
  }

  // Attempt 2: Direct connection with SET ROLE bfmr_owner
  try {
    const client = await connectDatabaseClient();
    try {
      console.log('[Database] Connected to PostgreSQL. Attempting SET ROLE bfmr_owner...');
      await client.query('SET ROLE bfmr_owner;');
      await client.query(sqlContent);

      console.log(`\n${green}${bold}[SUCCESS] Database optimizations applied successfully!${reset}`);
      return true;
    } finally {
      await client.end();
    }
  } catch {
    console.error('Database optimization application failed or its outcome is uncertain. Inspect the configured target and installed state before retrying.');
    console.error('Use its reviewed owner/administrator connection; this command does not infer the cause or change runtime role privileges.');
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyDatabaseOptimizations()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(() => {
      process.exit(1);
    });
}
