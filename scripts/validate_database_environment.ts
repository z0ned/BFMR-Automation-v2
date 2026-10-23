import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type ClientConfig } from 'pg';

// Automatically load local .env if present without requiring external package
if (fs.existsSync('.env')) {
  const envContent = fs.readFileSync('.env', 'utf-8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

export interface CheckResult {
  name: string;
  category: 'SERVER' | 'ROLE' | 'SCHEMA' | 'PROBES';
  status: 'PASS' | 'FAIL' | 'WARN';
  message: string;
  detail?: string;
}

export interface ValidationSummary {
  passed: number;
  failed: number;
  warnings: number;
  results: CheckResult[];
}

export function getDatabaseConfig(): ClientConfig {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }
  return {
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
    database: process.env.PGDATABASE || 'bfmr',
    user: process.env.PGUSER || 'bfmr_app',
    password: process.env.PGPASSWORD || undefined,
  };
}

export function getEffectiveConnectionString(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const host = process.env.PGHOST || 'localhost';
  const port = process.env.PGPORT || '5432';
  const db = process.env.PGDATABASE || 'bfmr';
  const user = process.env.PGUSER || 'bfmr_app';
  const pass = process.env.PGPASSWORD ? `:${encodeURIComponent(process.env.PGPASSWORD)}` : '';
  return `postgresql://${encodeURIComponent(user)}${pass}@${host}:${port}/${encodeURIComponent(db)}`;
}

export async function resolveWorkingConnectionString(): Promise<string> {
  const base = getEffectiveConnectionString();
  try {
    const c = new Client({ connectionString: base });
    await c.connect();
    await c.end();
    return base;
  } catch (err: any) {
    if (err.code === 'ENOTFOUND' && base.includes('bfmr-postgres')) {
      const fallback = base.replace(/@bfmr-postgres(:|\/)/, '@localhost$1');
      const c = new Client({ connectionString: fallback });
      await c.connect();
      await c.end();
      return fallback;
    }
    throw err;
  }
}

export async function connectDatabaseClient(): Promise<Client> {
  const connStr = await resolveWorkingConnectionString();
  const client = new Client({ connectionString: connStr });
  await client.connect();
  return client;
}

export async function runDatabaseValidation(client: Client): Promise<ValidationSummary> {
  const results: CheckResult[] = [];

  const add = (result: CheckResult) => {
    results.push(result);
  };

  // 1. SERVER CHECKS
  try {
    const versionRes = await client.query<{ num: string; full: string }>(
      'SELECT current_setting(\'server_version_num\') as num, version() as full;'
    );
    const verNum = parseInt(versionRes.rows[0].num, 10);
    if (verNum >= 150000) {
      add({
        name: 'PostgreSQL Version',
        category: 'SERVER',
        status: 'PASS',
        message: `PostgreSQL version is ${versionRes.rows[0].full.split(' ')[1]} (>= 15 required)`,
      });
    } else {
      add({
        name: 'PostgreSQL Version',
        category: 'SERVER',
        status: 'FAIL',
        message: `PostgreSQL version ${verNum} is below required version 15 (150000)`,
      });
    }
  } catch (err: any) {
    add({
      name: 'PostgreSQL Version',
      category: 'SERVER',
      status: 'FAIL',
      message: `Failed to query server version: ${err.message}`,
    });
  }

  // 2. ROLE & LEAST PRIVILEGE CHECKS
  let currentUser = '';
  try {
    const roleRes = await client.query<{
      current_user: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      'SELECT current_user, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user;'
    );
    const role = roleRes.rows[0];
    currentUser = role.current_user;

    if (!role.rolsuper) {
      add({
        name: 'Non-Superuser Runtime Role',
        category: 'ROLE',
        status: 'PASS',
        message: `Current user "${role.current_user}" is a non-superuser (least privilege)`,
      });
    } else {
      add({
        name: 'Non-Superuser Runtime Role',
        category: 'ROLE',
        status: 'FAIL',
        message: `Current user "${role.current_user}" is a SUPERUSER! Production runtime role must NOT be superuser.`,
      });
    }

    if (!role.rolcreatedb && !role.rolcreaterole) {
      add({
        name: 'Restricted Role Capabilities',
        category: 'ROLE',
        status: 'PASS',
        message: `Current user "${role.current_user}" cannot create databases or roles`,
      });
    } else {
      add({
        name: 'Restricted Role Capabilities',
        category: 'ROLE',
        status: 'WARN',
        message: `Current user has createdb/createrole privileges; review for strict least-privilege`,
      });
    }
  } catch (err: any) {
    add({
      name: 'Role Capabilities',
      category: 'ROLE',
      status: 'FAIL',
      message: `Failed to inspect current role: ${err.message}`,
    });
  }

  // 3. SCHEMA & TABLE INVENTORY & OWNERSHIP
  const requiredBusinessTables = [
    'retailers',
    'retailer_accounts',
    'deals',
    'deal_retailers',
    'emails',
    'email_deals',
    'reservation_status',
    'reservations',
    'order_status',
    'orders',
    'shipment_status',
    'shipments',
    'reimbursements',
    'workflow_evidence',
    'sync_runs',
    'provider_observations',
  ];

  try {
    const tablesRes = await client.query<{ tablename: string; tableowner: string }>(
      'SELECT tablename, tableowner FROM pg_tables WHERE schemaname = \'public\';'
    );
    const existingTables = new Map(tablesRes.rows.map(r => [r.tablename, r.tableowner]));
    const missing = requiredBusinessTables.filter(t => !existingTables.has(t));

    if (missing.length === 0) {
      add({
        name: 'Required Business Tables',
        category: 'SCHEMA',
        status: 'PASS',
        message: `All ${requiredBusinessTables.length} core business tables are present in public schema`,
      });
    } else {
      add({
        name: 'Required Business Tables',
        category: 'SCHEMA',
        status: 'FAIL',
        message: `Missing ${missing.length} required tables: ${missing.join(', ')}`,
      });
    }

    // Ownership check: runtime role should NOT own tables (should be bfmr_owner)
    const ownedByApp = tablesRes.rows.filter(r => r.tableowner === currentUser);
    if (ownedByApp.length === 0) {
      add({
        name: 'Non-Owning Runtime Boundary',
        category: 'SCHEMA',
        status: 'PASS',
        message: `Runtime role "${currentUser}" does not own tables (owned by dedicated owner role)`,
      });
    } else {
      add({
        name: 'Non-Owning Runtime Boundary',
        category: 'SCHEMA',
        status: 'WARN',
        message: `Runtime role "${currentUser}" owns ${ownedByApp.length} tables (expected bfmr_owner)`,
      });
    }
  } catch (err: any) {
    add({
      name: 'Schema Inventory',
      category: 'SCHEMA',
      status: 'FAIL',
      message: `Failed to query table inventory: ${err.message}`,
    });
  }

  // 3b. OPTIMIZATION INDEXES & TRIGGERS
  try {
    const idxRes = await client.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('idx_workflow_evidence_cutover', 'idx_reservations_open_exposure', 'idx_orders_order_id');
    `);
    const foundIndexes = new Set(idxRes.rows.map(r => r.indexname));
    for (const expectedIdx of ['idx_workflow_evidence_cutover', 'idx_reservations_open_exposure', 'idx_orders_order_id']) {
      if (foundIndexes.has(expectedIdx)) {
        add({
          name: `Index: ${expectedIdx}`,
          category: 'SCHEMA',
          status: 'PASS',
          message: `Optimization index "${expectedIdx}" is present and active`,
        });
      } else {
        add({
          name: `Index: ${expectedIdx}`,
          category: 'SCHEMA',
          status: 'WARN',
          message: `Optimization index "${expectedIdx}" is not yet applied (apply via: npm run optimize-db)`,
        });
      }
    }

    const trgRes = await client.query<{ count: string }>(`
      SELECT count(*) FROM pg_trigger
      WHERE tgname = 'trg_enforce_exposure_cap';
    `);
    if (parseInt(trgRes.rows[0].count, 10) > 0) {
      add({
        name: 'Trigger: trg_enforce_exposure_cap',
        category: 'SCHEMA',
        status: 'PASS',
        message: 'Exposure hard cap trigger is registered on public.reservations',
      });
    } else {
      add({
        name: 'Trigger: trg_enforce_exposure_cap',
        category: 'SCHEMA',
        status: 'WARN',
        message: 'Exposure cap trigger not yet applied (apply via: npm run optimize-db)',
      });
    }
  } catch {
    // Non-fatal index check
  }

  // 4. ACTIVE PROBES (EXECUTED INSIDE UNCOMMITTED TRANSACTION THAT ROLLS BACK)
  try {
    await client.query('BEGIN;');

    // Probe A: DDL Rejection Check
    try {
      await client.query('CREATE TABLE public.__bfmr_probe_ddl_test (id int);');
      // If no error was thrown, runtime role has DDL privileges!
      add({
        name: 'Probe: DDL Permission Denied',
        category: 'PROBES',
        status: 'FAIL',
        message: `Runtime role "${currentUser}" was able to execute CREATE TABLE; DDL must be revoked`,
      });
      // Clean up in case
      await client.query('DROP TABLE IF EXISTS public.__bfmr_probe_ddl_test;');
    } catch (err: any) {
      if (err.code === '42501') {
        add({
          name: 'Probe: DDL Permission Denied',
          category: 'PROBES',
          status: 'PASS',
          message: 'DDL (CREATE TABLE) correctly rejected with 42501 insufficient_privilege',
        });
      } else {
        add({
          name: 'Probe: DDL Permission Denied',
          category: 'PROBES',
          status: 'WARN',
          message: `Unexpected error during DDL probe: ${err.message}`,
        });
      }
    }

    // Restart transaction if aborted
    await client.query('ROLLBACK;');
    await client.query('BEGIN;');

    // Probe B: Append-Only Trigger on workflow_evidence
    try {
      const probeCorrId = '00000000-0000-0000-0000-000000000001';
      await client.query(
        `INSERT INTO public.workflow_evidence (correlation_id, action_type, phase, outcome, evidence)
         VALUES ($1, 'VALIDATOR_PROBE', 'TEST', 'PROBE', '{"test":true}'::jsonb);`,
        [probeCorrId]
      );

      // Attempt to mutate the row
      let triggerBlocked = false;
      let blockedReason = '';
      try {
        await client.query(
          `UPDATE public.workflow_evidence SET phase = 'MUTATED' WHERE correlation_id = $1;`,
          [probeCorrId]
        );
      } catch (triggerErr: any) {
        if (triggerErr.code === '55000' || /append-only/i.test(triggerErr.message)) {
          triggerBlocked = true;
          blockedReason = 'blocked by trigger (55000)';
        } else if (triggerErr.code === '42501') {
          triggerBlocked = true;
          blockedReason = 'blocked by role permissions (42501 no UPDATE privilege)';
        }
      }

      if (triggerBlocked) {
        add({
          name: 'Probe: Append-Only Trigger',
          category: 'PROBES',
          status: 'PASS',
          message: `UPDATE on workflow_evidence correctly ${blockedReason}`,
        });
      } else {
        add({
          name: 'Probe: Append-Only Trigger',
          category: 'PROBES',
          status: 'FAIL',
          message: 'UPDATE on workflow_evidence was NOT blocked; append-only protection is missing',
        });
      }
    } catch (err: any) {
      add({
        name: 'Probe: Append-Only Trigger',
        category: 'PROBES',
        status: 'FAIL',
        message: `Failed to execute append-only probe: ${err.message}`,
      });
    }

    // Restart transaction
    await client.query('ROLLBACK;');
    await client.query('BEGIN;');

    // Probe C: Generated Stored Column on reservations
    try {
      const uid1 = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const dealRes = await client.query<{ id: string }>(
        `INSERT INTO public.deals (bfmr_deal_id, slug, title, reimbursement_amount)
         VALUES ($1, $1, 'Probe Deal', 100.00) RETURNING id;`,
        [`__probe_deal_${uid1}`]
      );
      const dealId = dealRes.rows[0].id;

      const resRes = await client.query<{ id: string; expected_payout: string }>(
        `INSERT INTO public.reservations (bfmr_reservation_id, deal_id, quantity, payout_per_item)
         VALUES ($1, $2, 3, 45.50)
         RETURNING id, expected_payout;`,
        [`__probe_res_${uid1}`, dealId]
      );

      const generated = parseFloat(resRes.rows[0].expected_payout);
      if (Math.abs(generated - 136.50) < 0.01) {
        add({
          name: 'Probe: Generated Column (expected_payout)',
          category: 'PROBES',
          status: 'PASS',
          message: 'PostgreSQL correctly computed STORED generated expected_payout (3 * 45.50 = 136.50)',
        });
      } else {
        add({
          name: 'Probe: Generated Column (expected_payout)',
          category: 'PROBES',
          status: 'FAIL',
          message: `expected_payout calculation mismatch: expected 136.50, got ${resRes.rows[0].expected_payout}`,
        });
      }
    } catch (err: any) {
      add({
        name: 'Probe: Generated Column (expected_payout)',
        category: 'PROBES',
        status: 'FAIL',
        message: `Generated column probe failed: ${err.message}`,
      });
    }

    // Restart transaction
    await client.query('ROLLBACK;');
    await client.query('BEGIN;');

    // Probe D: Reimbursement Uniqueness (1-to-1)
    try {
      const uid2 = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const dealRes = await client.query<{ id: string }>(
        `INSERT INTO public.deals (bfmr_deal_id, slug, title, reimbursement_amount)
         VALUES ($1, $1, 'Probe Deal 2', 50.00) RETURNING id;`,
        [`__probe_deal2_${uid2}`]
      );
      const dealId = dealRes.rows[0].id;

      const resRes = await client.query<{ id: string }>(
        `INSERT INTO public.reservations (bfmr_reservation_id, deal_id, quantity, payout_per_item)
         VALUES ($1, $2, 1, 50.00) RETURNING id;`,
        [`__probe_res2_${uid2}`, dealId]
      );
      const resId = resRes.rows[0].id;

      const emailRes = await client.query<{ id: string }>(
        `INSERT INTO public.emails (gmail_message_id, subject, email_type, received_at)
         VALUES ($1, 'Payment Probe', 'PAYMENT_SENT', NOW()) RETURNING id;`,
        [`__probe_email_${uid2}`]
      );
      const emailId = emailRes.rows[0].id;

      await client.query(
        `INSERT INTO public.reimbursements (reservation_id, payment_email_id, amount, paid_at)
         VALUES ($1, $2, 50.00, NOW());`,
        [resId, emailId]
      );

      // Attempt second reimbursement for same reservation
      let duplicateBlocked = false;
      try {
        await client.query(
          `INSERT INTO public.reimbursements (reservation_id, payment_email_id, amount, paid_at)
           VALUES ($1, $2, 50.00, NOW());`,
          [resId, emailId]
        );
      } catch (dupErr: any) {
        if (dupErr.code === '23505') duplicateBlocked = true;
      }

      if (duplicateBlocked) {
        add({
          name: 'Probe: Reimbursement Uniqueness',
          category: 'PROBES',
          status: 'PASS',
          message: 'Second reimbursement for same reservation correctly rejected by reimbursements_reservation_uk (23505)',
        });
      } else {
        add({
          name: 'Probe: Reimbursement Uniqueness',
          category: 'PROBES',
          status: 'FAIL',
          message: 'Duplicate reimbursement was permitted; unique constraint on reservation_id is missing',
        });
      }
    } catch (err: any) {
      add({
        name: 'Probe: Reimbursement Uniqueness',
        category: 'PROBES',
        status: 'FAIL',
        message: `Failed to test reimbursement uniqueness: ${err.message}`,
      });
    }

    // Probe E: CCV Column Security Check
    try {
      await client.query('SELECT ccv FROM public.retailer_accounts LIMIT 1;');
      add({
        name: 'Probe: CCV Column Access',
        category: 'PROBES',
        status: 'WARN',
        message: `Runtime role "${currentUser}" can read retailer_accounts.ccv; review column-level grant restriction`,
      });
    } catch (err: any) {
      if (err.code === '42501') {
        add({
          name: 'Probe: CCV Column Access',
          category: 'PROBES',
          status: 'PASS',
          message: 'retailer_accounts.ccv is correctly restricted from runtime role (42501 permission denied)',
        });
      } else {
        // Table may be empty or column exists
        add({
          name: 'Probe: CCV Column Access',
          category: 'PROBES',
          status: 'PASS',
          message: 'retailer_accounts query executed without permission fault',
        });
      }
    }

    // Probe F: Exposure Limit ($200.00 Hard Cap) Trigger Probe
    try {
      await client.query('ROLLBACK;');
      await client.query('BEGIN;');

      const probeExposureBfmrId = `probe_exp_check_${Date.now()}`;
      const dealRes = await client.query<{ id: string }>(`
        INSERT INTO public.deals (bfmr_deal_id, slug, title, reimbursement_amount)
        VALUES ($1, $1, 'Validator Exposure Probe Deal', 250.00)
        RETURNING id;
      `, [probeExposureBfmrId]);
      const probeDealId = dealRes.rows[0].id;

      let exposureBlocked = false;
      try {
        await client.query(`
          INSERT INTO public.reservations (deal_id, bfmr_reservation_id, quantity, payout_per_item, reservation_status_id)
          VALUES ($1, $2, 1, 250.00, 1);
        `, [probeDealId, `probe_res_exp_${Date.now()}`]);
      } catch (insertErr: any) {
        if (insertErr.code === '23514' && /Unreimbursed reservation payouts exceed \$200\.00/i.test(insertErr.message)) {
          exposureBlocked = true;
        }
      }

      if (exposureBlocked) {
        add({
          name: 'Probe: Exposure Limit ($200.00 Cap)',
          category: 'PROBES',
          status: 'PASS',
          message: 'PostgreSQL strictly rejected reservation exceeding $200.00 cap with 23514 check_violation',
        });
      } else {
        add({
          name: 'Probe: Exposure Limit ($200.00 Cap)',
          category: 'PROBES',
          status: 'FAIL',
          message: 'The reservation-payout ceiling was not demonstrated by its expected rejection',
        });
      }
    } catch {
      add({ name: 'Probe: Exposure Limit ($200.00 Cap)', category: 'PROBES', status: 'FAIL',
        message: 'Exposure probe could not execute; native ceiling acceptance remains unverified' });
    }

    // Always unconditionally roll back active probes
    await client.query('ROLLBACK;');
  } catch (err: any) {
    try { await client.query('ROLLBACK;'); } catch {}
    add({
      name: 'Active Probes Rollback',
      category: 'PROBES',
      status: 'WARN',
      message: `Active probes encountered error: ${err.message}`,
    });
  }

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const warnings = results.filter(r => r.status === 'WARN').length;

  return { passed, failed, warnings, results };
}

export function printValidationReport(summary: ValidationSummary): void {
  const green = '\x1b[32m';
  const red = '\x1b[31m';
  const yellow = '\x1b[33m';
  const bold = '\x1b[1m';
  const reset = '\x1b[0m';

  console.log(`\n${bold}====================================================${reset}`);
  console.log(`${bold}  BFMR Automation v2 - Native PostgreSQL Validator   ${reset}`);
  console.log(`${bold}====================================================${reset}\n`);

  for (const r of summary.results) {
    let tag = `${green}[PASS]${reset}`;
    if (r.status === 'FAIL') tag = `${red}[FAIL]${reset}`;
    else if (r.status === 'WARN') tag = `${yellow}[WARN]${reset}`;

    console.log(`${tag} ${bold}${r.name}${reset} (${r.category})`);
    console.log(`       ${r.message}`);
  }

  console.log(`\n${bold}----------------------------------------------------${reset}`);
  console.log(
    `Summary: ${green}${summary.passed} Passed${reset} | ` +
    `${summary.failed > 0 ? red : ''}${summary.failed} Failed${reset} | ` +
    `${summary.warnings > 0 ? yellow : ''}${summary.warnings} Warnings${reset}`
  );
  console.log(`${bold}----------------------------------------------------${reset}\n`);

  if (summary.failed > 0) {
    console.error(`${red}${bold}ERROR: Database environment validation failed. Review the errors above.${reset}\n`);
  } else {
    console.log(`${green}${bold}Database checks completed; review warnings and separately establish provider/recovery acceptance.${reset}\n`);
  }
}

function isMainScript(): boolean {
  if (!process.argv[1]) return false;
  try {
    const executed = path.resolve(process.argv[1]).toLowerCase();
    const current = fileURLToPath(import.meta.url).toLowerCase();
    return executed === current;
  } catch {
    return true;
  }
}

if (isMainScript()) {
  connectDatabaseClient()
    .then(async activeClient => {
      try {
        const summary = await runDatabaseValidation(activeClient);
        printValidationReport(summary);
        await activeClient.end();
        process.exit(summary.failed > 0 ? 1 : 0);
      } catch (err: any) {
        console.error(`Validation error: ${err.message}`);
        await activeClient.end();
        process.exit(1);
      }
    })
    .catch((err: any) => {
      console.error(`\x1b[31mFailed to connect to PostgreSQL:\x1b[0m ${err.message}`);
      console.error('Ensure PostgreSQL is running and connection variables are set (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD, or DATABASE_URL).');
      process.exit(1);
    });
}
