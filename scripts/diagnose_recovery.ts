import { loadConfiguration } from '../src/config/loadConfiguration';
import { selectDatabase, databaseIdentity, DatabaseConfigurationError } from '../src/db/databaseConfig';
import { Client } from 'pg';
import { missingIntakePrivileges } from '../src/db/intakePrivileges';
import { sourceIdentity } from './sourceIdentity';

async function main() {
  loadConfiguration();
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: npm run recovery:diagnose -- --message-id <private Gmail ID> [--expect-revision <full commit SHA>]');
    console.log('Read-only SQL/code diagnostic. No payloads, provider access, grants or state repair.');
    return;
  }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--message-id', '--expect-revision'].includes(args[i]) || values.has(args[i]) || !args[i + 1]) throw new Error('Invalid diagnostic arguments.');
    values.set(args[i], args[i + 1]);
  }
  const message = values.get('--message-id');
  if (!message || !/^[A-Za-z0-9_-]{1,256}$/.test(message)) throw new Error('Exact private Gmail message ID is required.');
  const source = sourceIdentity();
  console.log(JSON.stringify({ source }));
  const expected = values.get('--expect-revision');
  if (expected && (!/^[0-9a-f]{40}$/.test(expected) || source.revision !== expected)) throw new Error('Checkout revision differs from the expected full commit SHA.');
  // Parse only the selected local file; do not chmod files or inspect home config.
  const account = process.env.BFMR_EXPECTED_ACCOUNT?.trim().toLowerCase();
  if (!account) throw new Error('BFMR_EXPECTED_ACCOUNT is required.');
  const selected = selectDatabase();
  console.log(JSON.stringify({ database: databaseIdentity(selected) }));
  const client = new Client({ connectionString: selected.connectionString });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const role = await client.query(`SELECT current_user AS name,rolsuper AS superuser,rolcreatedb AS create_database,
      rolcreaterole AS create_role FROM pg_roles WHERE rolname=current_user`);
    console.log(JSON.stringify({ runtimeRole: role.rows[0] }));
    const missing = await missingIntakePrivileges(client);
    const canRead = await client.query<{ allowed: boolean }>(`SELECT COALESCE(has_table_privilege(current_user,
      (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='workflow_evidence'),'SELECT'),false) AS allowed`);
    if (missing.length || !canRead.rows[0].allowed) {
      console.log(JSON.stringify({ privilegesReady: false, missing: [...missing,
        ...(!canRead.rows[0].allowed ? ['public.workflow_evidence:SELECT'] : [])], state: 'NOT_INSPECTED' }));
      process.exitCode = 1;
    } else {
      const work = await client.query<{ state: string }>(`SELECT state FROM public.gmail_intake_work
        WHERE account_namespace=$1 AND gmail_message_id=$2`, [account, message]);
      const workflow = await client.query<{ status: string; revision: string }>(`SELECT evidence->>'status' AS status,id::text AS revision
        FROM public.workflow_evidence WHERE action_type='DEAL_EMAIL_WORKFLOW' AND evidence->>'account'=$1
        AND evidence->>'source'='GMAIL' AND evidence->>'messageId'=$2 ORDER BY id DESC LIMIT 1`, [account, message]);
      const blocked = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.workflow_evidence b
        WHERE b.action_type='WORKER_ACTION_CONTROL' AND b.phase='BLOCKED' AND b.evidence->>'account'=$1
        AND NOT EXISTS (SELECT 1 FROM public.workflow_evidence r WHERE r.action_type='WORKER_ACTION_CONTROL'
          AND r.phase='RESOLVED' AND r.evidence->>'account'=$1 AND r.evidence->>'blocked_event_id'=b.id::text)`, [account]);
      console.log(JSON.stringify({ privilegesReady: true, queueState: work.rows[0]?.state ?? 'MISSING',
        workflow: workflow.rows[0] ?? null, unresolvedAccountIncidents: blocked.rows[0].count,
        providerOutcomesVerified: false, repaired: false }));
    }
    await client.query('COMMIT');
  } finally { await client.end(); }
}
main().catch(error => {
  if (error instanceof DatabaseConfigurationError) console.error(error.message);
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'DIAGNOSTIC_STOPPED';
  console.error(`Recovery diagnostic stopped (${code}); verify revision, configuration and database access. No state was changed.`);
  process.exitCode = 1;
});
