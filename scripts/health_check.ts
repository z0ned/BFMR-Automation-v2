import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Client } from 'pg';

export interface HealthStatus {
  database: 'HEALTHY' | 'UNHEALTHY';
  worker: 'RUNNING' | 'STOPPED' | 'DEGRADED' | 'NOT_STARTED';
  exposure: 'OK' | 'EXCEEDED' | 'UNKNOWN';
  details: {
    postgresVersion?: string;
    workerPid?: number;
    workerLastHeartbeat?: string;
    exposureDollars?: number;
    issues: string[];
  };
}

export async function checkSystemHealth(dependencies: { connect?: () => Promise<Pick<Client, 'query' | 'end'>>; heartbeatPath?: string } = {}): Promise<HealthStatus> {
  const issues: string[] = [];
  let dbStatus: HealthStatus['database'] = 'UNHEALTHY';
  let workerStatus: HealthStatus['worker'] = 'NOT_STARTED';
  let exposureStatus: HealthStatus['exposure'] = 'UNKNOWN';
  let postgresVersion: string | undefined;
  let workerPid: number | undefined;
  let workerLastHeartbeat: string | undefined;
  let exposureDollars: number | undefined;
  let client: Pick<Client, 'query' | 'end'> | undefined;

  // 1. Database Check
  try {
    const connect = dependencies.connect ?? (await import('./validate_database_environment')).connectDatabaseClient;
    client = await connect();

    const verRes = await client.query<{ full: string }>('SELECT version() as full;');
    postgresVersion = verRes.rows[0].full.split(' ')[1];
    dbStatus = 'HEALTHY';

    // 2. Open Exposure Check
    try {
      const expRes = await client.query<{ total: string }>(`
        SELECT COALESCE(SUM(GREATEST(r.expected_payout - COALESCE(re.amount, 0), 0)), 0) AS total
        FROM public.reservations r
        LEFT JOIN public.reimbursements re ON re.reservation_id=r.id
        WHERE r.reservation_status_id != 2
      `);
      exposureDollars = parseFloat(expRes.rows[0].total);
      if (!Number.isFinite(exposureDollars)) throw new Error('Invalid exposure result.');
      exposureStatus = 'OK';
      if (exposureDollars > 200.00) {
        exposureStatus = 'EXCEEDED';
        issues.push(`Open financial exposure ($${exposureDollars.toFixed(2)}) exceeds configured limit of $200.00`);
      }
    } catch (err: any) {
      issues.push(`Failed to calculate exposure: ${err.message}`);
    }

  } catch (err: any) {
    dbStatus = 'UNHEALTHY';
    issues.push(`Database connection failed: ${err.message}`);
  } finally {
    await client?.end().catch(() => { issues.push('Database diagnostic connection did not close cleanly.'); });
  }

  // 3. Worker Heartbeat Check
  const heartbeatPath = dependencies.heartbeatPath || process.env.BFMR_HEARTBEAT_PATH || path.join(os.tmpdir(), 'bfmr-worker-heartbeat.json');
  try {
    if (fs.existsSync(heartbeatPath)) {
      const raw = fs.readFileSync(heartbeatPath, 'utf-8');
      const data = JSON.parse(raw);
      workerPid = data.pid;
      workerLastHeartbeat = data.timestamp;

      const ageMs = Date.now() - new Date(data.timestamp).getTime();
      if (!Number.isFinite(ageMs) || ageMs < 0 || !Number.isSafeInteger(data.pid) || data.pid < 1) throw new Error('Invalid worker heartbeat.');
      if (data.status === 'RUNNING') {
        if (ageMs > 120000) {
          // Heartbeat older than 2 minutes
          workerStatus = 'DEGRADED';
          issues.push(`Worker heartbeat is stale (${Math.round(ageMs / 1000)}s old)`);
        } else {
          workerStatus = 'RUNNING';
        }
      } else if (data.status === 'DEGRADED') {
        workerStatus = 'DEGRADED';
        issues.push(`Worker is in DEGRADED state: ${data.error || 'Unknown error'}`);
      } else if (data.status === 'STOPPED') {
        workerStatus = 'STOPPED';
      }
    } else {
      workerStatus = 'NOT_STARTED';
    }
  } catch (err: any) {
    workerStatus = 'DEGRADED';
    issues.push(`Failed to read worker heartbeat file: ${err.message}`);
  }

  return {
    database: dbStatus,
    worker: workerStatus,
    exposure: exposureStatus,
    details: {
      postgresVersion,
      workerPid,
      workerLastHeartbeat,
      exposureDollars,
      issues,
    },
  };
}

export function printHealthReport(health: HealthStatus): void {
  const green = '\x1b[32m';
  const red = '\x1b[31m';
  const yellow = '\x1b[33m';
  const bold = '\x1b[1m';
  const reset = '\x1b[0m';

  console.log(`\n${bold}====================================================${reset}`);
  console.log(`${bold}         BFMR Automation v2 - Health Status         ${reset}`);
  console.log(`${bold}====================================================${reset}\n`);

  const dbColor = health.database === 'HEALTHY' ? green : red;
  console.log(`  Database:  ${dbColor}${bold}${health.database}${reset} (PostgreSQL ${health.details.postgresVersion || 'N/A'})`);

  let workerColor = green;
  if (health.worker === 'DEGRADED') workerColor = yellow;
  else if (health.worker === 'STOPPED' || health.worker === 'NOT_STARTED') workerColor = red;
  console.log(`  Worker:    ${workerColor}${bold}${health.worker}${reset} (PID: ${health.details.workerPid ?? 'None'}, Last Heartbeat: ${health.details.workerLastHeartbeat ?? 'None'})`);

  const expColor = health.exposure === 'OK' ? green : red;
  console.log(`  Exposure:  ${expColor}${bold}${health.exposure}${reset} ($${health.details.exposureDollars?.toFixed(2) ?? 'unknown'} open / $200.00 max)`);

  if (health.details.issues.length > 0) {
    console.log(`\n${yellow}${bold}Reported Issues:${reset}`);
    for (const issue of health.details.issues) {
      console.log(`  - ${issue}`);
    }
  }

  console.log(`\n${bold}----------------------------------------------------${reset}\n`);
}

// Direct execution
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/health_check.ts'))) {
  checkSystemHealth()
    .then(health => {
      printHealthReport(health);
      const isCritical = health.database === 'UNHEALTHY' || health.worker !== 'RUNNING' || health.exposure !== 'OK';
      process.exit(isCritical ? 1 : 0);
    })
    .catch(err => {
      console.error(`Health check failed: ${err.message}`);
      process.exit(1);
    });
}
