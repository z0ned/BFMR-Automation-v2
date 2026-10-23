import './loadEnv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { PostgresAccountOwnership } from '../src/db/postgresDatabase';
import { RelationalDatabase } from '../src/db/relationalDatabase';
import { prepareFreshStartCutover } from '../src/services/freshStartCutoverPreparation';
import { applyRelationalCutover, assertRelationalCutoverReady, reconcileRelationalCutover } from '../src/services/relationalCutover';
import { resolveWorkingConnectionString } from './validate_database_environment';

export interface CutoverCliOptions {
  account?: string;
  dryRun?: boolean;
  skipBackup?: boolean;
  nonInteractive?: boolean;
  stateDir?: string;
}

export function parseArgs(args: string[]): CutoverCliOptions {
  const options: CutoverCliOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run' || arg === '--report') {
      options.dryRun = true;
    } else if (arg === '--yes' || arg === '--non-interactive') {
      options.nonInteractive = true;
    } else if (arg === '--skip-backup') {
      options.skipBackup = true;
    } else if (arg === '--account' && args[i + 1]) {
      options.account = args[++i];
    } else if (arg === '--dir' && args[i + 1]) {
      options.stateDir = args[++i];
    }
  }
  return options;
}

export function computeFileSha256(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

export async function executePreCutoverBackup(stateDirectory?: string): Promise<boolean> {
  const backupScript = path.resolve('scripts/backup_production_state.sh');
  try {
    const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    execFileSync(shell, [backupScript], { stdio: 'inherit', env: { ...process.env,
      ...(stateDirectory ? { BFMR_STATE_DIR: stateDirectory } : {}) } });
    return true;
  } catch {
    console.error('Coordinated pre-cutover backup failed; cutover stopped. No database-only backup fallback is accepted.');
    return false;
  }
}

export async function runProductionCutover(options: CutoverCliOptions = {}): Promise<boolean> {
  const bold = '\x1b[1m';
  const green = '\x1b[32m';
  const red = '\x1b[31m';
  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';

  console.log(`\n${bold}====================================================${reset}`);
  console.log(`${bold}  BFMR Automation v2 - Controlled Production Cutover  ${reset}`);
  console.log(`${bold}====================================================${reset}\n`);

  // 1. Account & Connection Resolution
  const account = String(options.account ?? process.env.BFMR_EXPECTED_ACCOUNT ?? '').trim().toLowerCase();
  if (!account) {
    console.error(`${red}ERROR: BFMR_EXPECTED_ACCOUNT is required in .env or via --account <name>.${reset}\n`);
    return false;
  }

  const connStr = await resolveWorkingConnectionString();
  const stateDirectory = options.stateDir ?? process.env.BFMR_STATE_DIR ?? path.join(os.homedir(), '.local/state/bfmr');

  console.log(`[Config] Target Account:    ${bold}${account}${reset}`);
  console.log(`[Config] State Directory:   ${stateDirectory}`);
  console.log(`[Config] Database:          Connected`);

  // 2. Pre-flight Account Ownership & Schema Validation
  const ownership = new PostgresAccountOwnership(connStr, account);
  const db = new RelationalDatabase(connStr, () => ownership.verifyOwnership());

  try {
    const lockKey = `bfmr_worker_lock_${account}`;
    const acquired = await ownership.claimAccount(lockKey);
    if (!acquired) {
      console.error(`${red}ERROR: Could not acquire account advisory lock '${lockKey}'. Another worker or cutover process is active.${reset}\n`);
      return false;
    }
    console.log(`[Lock]   Acquired exclusive account lock: ${lockKey}`);

    await db.validateSchema();
    console.log('[Schema] PostgreSQL relational schema validated.');

    // 3. Inspect Existing Cutover in Database
    const existingMarkers = await db.withTransaction(async tx => {
      const res = await tx.query<{ evidence: any; recorded_at: string }>(`
        SELECT evidence, recorded_at FROM public.workflow_evidence
        WHERE action_type='RELATIONAL_CUTOVER' AND phase='CONFIRMED' AND outcome='ACCEPTED'
        ORDER BY id DESC
      `);
      return res.rows;
    });

    if (existingMarkers.length > 0) {
      const activeEvidence = existingMarkers[0].evidence;
      console.log(`\n${bold}[Cutover Status] Existing cutover record found in PostgreSQL:${reset}`);
      console.log(`  Account:            ${bold}${activeEvidence.account}${reset}`);
      console.log(`  Version:            ${activeEvidence.version}`);
      console.log(`  Boundary Timestamp: ${bold}${activeEvidence.baseline?.startsAt ?? 'N/A'}${reset}`);
      console.log(`  Manifest SHA-256:   ${activeEvidence.manifestSha256}`);
      console.log(`  Recorded At:        ${existingMarkers[0].recorded_at}`);

      if (activeEvidence.account === account && activeEvidence.version === 2) {
        // Synchronize local cutover-start-from.json on disk with the accepted database record
        const manifestPath = path.join(stateDirectory, 'cutover-start-from.json');
        await fs.promises.mkdir(stateDirectory, { recursive: true });
        const synchronizedManifest = {
          version: 2,
          account,
          approvedAt: activeEvidence.approvedAt ?? activeEvidence.baseline?.startsAt,
          coverage: { sinceBaseline: true },
          baseline: { ...activeEvidence.baseline },
          legacyOrderLedgerSha256: null,
          excludedStandaloneOrderIds: [],
          reservations: [],
        };
        fs.writeFileSync(manifestPath, JSON.stringify(synchronizedManifest, null, 2) + '\n', 'utf8');
        const activeManifestSha256 = computeFileSha256(manifestPath);

        const acceptedStartsAt = await assertRelationalCutoverReady(db, {
          account,
          legacyOrderLedgerSha256: null,
        });

        console.log(`\n${green}${bold}====================================================${reset}`);
        console.log(`${green}${bold}  Production Cutover is ALREADY ACCEPTED & ACTIVE!   ${reset}`);
        console.log(`${green}${bold}====================================================${reset}\n`);
        console.log(`  Account:            ${bold}${account}${reset}`);
        console.log(`  Boundary Timestamp: ${bold}${acceptedStartsAt}${reset}`);
        console.log(`  Manifest SHA-256:   ${bold}${activeManifestSha256}${reset}`);
        console.log(`  Manifest File:      ${manifestPath}`);
        console.log(`  Status:             ${green}${bold}ACCEPTED & VERIFIED${reset}\n`);
        console.log('The production cutover boundary was already successfully established in PostgreSQL.');
        console.log('Local manifest file is now synchronized. You may start the worker:');
        console.log(`  ${bold}npm run supervise${reset}\n`);
        return true;
      }
    }

    // 4. Automated Pre-Cutover Backup (if not skipped)
    if (!options.skipBackup) {
      if (!await executePreCutoverBackup(stateDirectory)) return false;
    } else {
      console.log('[Backup] Pre-cutover backup skipped via flag.');
    }

    // 5. Fresh-Start Manifest Generation
    console.log('\n[Manifest] Generating fresh-start boundary candidate...');
    let candidate;
    try {
      candidate = await prepareFreshStartCutover({
        account,
        confirmedNoOutstandingWork: true,
        directory: stateDirectory,
      });
    } catch (err: any) {
      console.error(`${red}ERROR: Failed to prepare fresh-start cutover: ${err.message}${reset}\n`);
      return false;
    }

    const manifestSha256 = computeFileSha256(candidate.manifestPath);
    console.log(`[Manifest] Candidate Path:    ${candidate.manifestPath}`);
    console.log(`[Manifest] Manifest SHA-256:  ${bold}${manifestSha256}${reset}`);
    console.log(`[Manifest] Boundary StartsAt: ${candidate.manifest.baseline?.startsAt ?? candidate.manifest.approvedAt}`);

    // 6. Pre-application Reconciliation Inspection
    const reconciliation = await reconcileRelationalCutover(db, candidate.manifest, []);
    if (!reconciliation.ready) {
      console.error(`${red}ERROR: Cutover reconciliation failed with issues:${reset}`);
      for (const issue of reconciliation.issues) {
        console.error(`  - ${issue}`);
      }
      return false;
    }
    console.log(`[Inspect] Reconciliation check: ${green}READY TO APPLY${reset}`);

    // 6. Operator Authorization
    if (options.dryRun) {
      console.log(`\n${yellow}[DRY-RUN] Mode is report-only; cutover boundary was NOT applied to the database.${reset}\n`);
      return true;
    }

    if (!options.nonInteractive) {
      console.log(`\n${bold}----------------------------------------------------${reset}`);
      console.log(`${bold}  AUTHORIZATION REQUIRED                            ${reset}`);
      console.log(`${bold}----------------------------------------------------${reset}`);
      console.log(`You are about to anchor account '${account}' to a fresh-start`);
      console.log(`cutover boundary (SHA-256: ${manifestSha256}).`);
      console.log('Prior completed activity will be strictly excluded from worker replay.\n');

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(`${bold}Type 'YES' to confirm and apply this production cutover boundary:${reset} `);
        if (answer.trim() !== 'YES') {
          console.log(`\n${yellow}Cutover canceled by operator. Database remains unchanged.${reset}\n`);
          return false;
        }
      } finally {
        rl.close();
      }
    }

    // 7. Atomic Cutover Application
    console.log('\n[Apply] Applying cutover boundary to PostgreSQL...');
    await applyRelationalCutover(db, {
      manifest: candidate.manifest,
      manifestSha256,
      legacyOrders: [],
    });

    // 8. Post-Cutover Verification
    console.log('[Verify] Verifying stored cutover acceptance evidence in database...');
    const acceptedStartsAt = await assertRelationalCutoverReady(db, {
      account,
      legacyOrderLedgerSha256: null,
    });

    console.log(`\n${green}${bold}====================================================${reset}`);
    console.log(`${green}${bold}  Production Cutover Applied & Verified Successfully! ${reset}`);
    console.log(`${green}${bold}====================================================${reset}\n`);
    console.log(`  Account:            ${bold}${account}${reset}`);
    console.log(`  Boundary Timestamp: ${bold}${acceptedStartsAt}${reset}`);
    console.log(`  Manifest SHA-256:   ${bold}${manifestSha256}${reset}`);
    console.log(`  Status:             ${green}${bold}ACCEPTED${reset}\n`);
    console.log('The production intake boundary is now locked. You may start the worker:');
    console.log(`  ${bold}npm run supervise${reset}\n`);

    return true;
  } finally {
    try {
      await db.close();
    } finally {
      await ownership.close();
    }
  }
}

// Direct CLI entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  runProductionCutover(options)
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(err => {
      console.error(`\x1b[31mFatal cutover error:\x1b[0m ${err.message}`);
      process.exit(1);
    });
}
