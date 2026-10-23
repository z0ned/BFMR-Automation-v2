import './loadEnv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDatabaseClient } from './validate_database_environment';

export async function applyDatabaseOptimizations(): Promise<boolean> {
  const bold = '\x1b[1m';
  const green = '\x1b[32m';
  const red = '\x1b[31m';
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

  try {
    const client = await connectDatabaseClient();
    try {
      console.log('[Database] Connected to PostgreSQL.');
      console.log('[Optimizations] Executing database optimizations and exposure hard cap trigger...');

      await client.query(sqlContent);

      console.log(`\n${green}${bold}[SUCCESS] Database optimizations applied successfully!${reset}`);
      console.log('Applied:');
      console.log('  - idx_workflow_evidence_cutover (accelerates cutover status checks)');
      console.log('  - idx_reservations_open_exposure (accelerates open financial exposure checks)');
      console.log('  - idx_orders_order_id (accelerates retailer order lookup)');
      console.log('  - trg_enforce_exposure_cap trigger on public.reservations (enforces $200.00 hard limit)\n');
      return true;
    } finally {
      await client.end();
    }
  } catch (err: any) {
    console.error(`${red}ERROR applying optimizations: ${err.message}${reset}\n`);
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
