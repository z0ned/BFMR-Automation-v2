import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDatabaseConfig, runDatabaseValidation, type CheckResult } from '../scripts/validate_database_environment';

test('database validator uses the mode-selected URL and never legacy or PG fallbacks', () => {
  const origEnv = { ...process.env };
  try {
    process.env.DATABASE_URL_PRODUCTION = 'postgresql://synthetic:production@db.invalid/production';
    process.env.DATABASE_URL_TEST = 'postgresql://synthetic:testing@db.invalid/testing';
    process.env.DATABASE_URL = 'postgresql://legacy:ignored@legacy.invalid/wrong';
    process.env.BFMR_INTAKE_MODE = 'production';
    assert.equal(getDatabaseConfig().connectionString, process.env.DATABASE_URL_PRODUCTION);
    process.env.BFMR_INTAKE_MODE = 'testing';
    assert.equal(getDatabaseConfig().connectionString, process.env.DATABASE_URL_TEST);
    delete process.env.DATABASE_URL_TEST;
    process.env.PGDATABASE = 'wrong-default';
    assert.throws(getDatabaseConfig, /DATABASE_URL_TEST is required/);
  } finally { process.env = origEnv; }
});

test('validator records successful modeled checks and fails an undemonstrated exposure ceiling', async () => {
  const queriesExecuted: string[] = [];

  const mockClient = {
    query: async (sql: string, _params?: any[]) => {
      queriesExecuted.push(sql);
      if (sql.includes('server_version_num')) {
        return { rows: [{ num: '160001', full: 'PostgreSQL 16.1 on x86_64-pc-linux-gnu' }] };
      }
      if (sql.includes('pg_roles')) {
        return { rows: [{ current_user: 'bfmr_app', rolsuper: false, rolcreatedb: false, rolcreaterole: false }] };
      }
      if (sql.includes('pg_tables')) {
        const tables = [
          'retailers', 'retailer_accounts', 'deals', 'deal_retailers', 'emails', 'email_deals',
          'reservation_status', 'reservations', 'order_status', 'orders', 'shipment_status',
          'shipments', 'reimbursements', 'workflow_evidence', 'sync_runs', 'provider_observations',
        ];
        return { rows: tables.map(t => ({ tablename: t, tableowner: 'bfmr_owner' })) };
      }
      if (sql.includes('CREATE TABLE public.__bfmr_probe_ddl_test')) {
        const err: any = new Error('permission denied for schema public');
        err.code = '42501';
        throw err;
      }
      if (sql.includes('INSERT INTO public.workflow_evidence')) {
        return { rows: [{ id: '1' }] };
      }
      if (sql.includes('UPDATE public.workflow_evidence')) {
        const err: any = new Error('workflow_evidence is append-only');
        err.code = '55000';
        throw err;
      }
      if (sql.includes('INSERT INTO public.deals')) {
        return { rows: [{ id: 'deal-1' }] };
      }
      if (sql.includes('INSERT INTO public.reservations')) {
        return { rows: [{ id: 'res-1', expected_payout: '136.50' }] };
      }
      if (sql.includes('INSERT INTO public.emails')) {
        return { rows: [{ id: 'email-1' }] };
      }
      if (sql.includes('INSERT INTO public.reimbursements')) {
        // First insert succeeds, second fails with 23505
        if (queriesExecuted.filter(q => q.includes('INSERT INTO public.reimbursements')).length > 1) {
          const err: any = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          throw err;
        }
        return { rows: [{ id: 'reimb-1' }] };
      }
      if (sql.includes('SELECT ccv FROM public.retailer_accounts')) {
        const err: any = new Error('permission denied for column ccv');
        err.code = '42501';
        throw err;
      }
      return { rows: [] };
    },
  };

  const summary = await runDatabaseValidation(mockClient as any);

  assert.equal(summary.failed, 1);
  assert.equal(summary.results.find(r => r.name === 'Probe: Exposure Limit ($200.00 Cap)')?.status, 'FAIL');
  assert.ok(summary.passed >= 6);

  const verResult = summary.results.find(r => r.name === 'PostgreSQL Version');
  assert.equal(verResult?.status, 'PASS');

  const roleResult = summary.results.find(r => r.name === 'Non-Superuser Runtime Role');
  assert.equal(roleResult?.status, 'PASS');

  const ddlResult = summary.results.find(r => r.name === 'Probe: DDL Permission Denied');
  assert.equal(ddlResult?.status, 'PASS');

  const triggerResult = summary.results.find(r => r.name === 'Probe: Append-Only Trigger');
  assert.equal(triggerResult?.status, 'PASS');

  const generatedResult = summary.results.find(r => r.name === 'Probe: Generated Column (expected_payout)');
  assert.equal(generatedResult?.status, 'PASS');

  const uniqResult = summary.results.find(r => r.name === 'Probe: Reimbursement Uniqueness');
  assert.equal(uniqResult?.status, 'PASS');

  const ccvResult = summary.results.find(r => r.name === 'Probe: CCV Column Access');
  assert.equal(ccvResult?.status, 'PASS');

  // Verify ROLLBACK was executed
  assert.ok(queriesExecuted.includes('ROLLBACK;'));
});
