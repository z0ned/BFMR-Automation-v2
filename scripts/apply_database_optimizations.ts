import './loadEnv';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
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

  // Attempt 1: Apply via Docker container 'bfmr-postgres' as administrative owner
  try {
    const checkDocker = execSync('docker ps --filter name=bfmr-postgres --format "{{.Names}}"', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (checkDocker.includes('bfmr-postgres')) {
      console.log('[Optimizations] Applying optimizations via Docker container "bfmr-postgres" as admin...');
      execSync('docker exec -i bfmr-postgres psql -U bfmr -d bfmr', {
        input: sqlContent,
        stdio: ['pipe', 'inherit', 'inherit'],
      });

      console.log(`\n${green}${bold}[SUCCESS] Database optimizations applied successfully via bfmr-postgres!${reset}`);
      console.log('Applied:');
      console.log('  - idx_workflow_evidence_cutover (accelerates cutover status checks)');
      console.log('  - idx_reservations_open_exposure (accelerates open financial exposure checks)');
      console.log('  - idx_orders_order_id (accelerates retailer order lookup)');
      console.log('  - trg_enforce_exposure_cap trigger on public.reservations (enforces $200.00 hard limit)\n');
      return true;
    }
  } catch {
    // Docker execution not available or failed; fallback to direct connection
  }

  // Attempt 2: Direct connection with SET ROLE bfmr_owner
  try {
    const client = await connectDatabaseClient();
    try {
      console.log('[Database] Connected to PostgreSQL. Attempting SET ROLE bfmr_owner...');
      await client.query('SET ROLE bfmr_owner;').catch(() => {});
      await client.query(sqlContent);

      console.log(`\n${green}${bold}[SUCCESS] Database optimizations applied successfully!${reset}`);
      return true;
    } finally {
      await client.end();
    }
  } catch (err: any) {
    console.error(`\n${yellow}Note: The runtime application user (bfmr_app) is correctly restricted by least-privilege principles.${reset}`);
    console.error(`${bold}To apply DDL indexes and triggers with table ownership privileges, run:${reset}`);
    console.log(`\n  ${bold}docker exec -i bfmr-postgres psql -U bfmr -d bfmr < database/optimizations.sql${reset}\n`);
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
