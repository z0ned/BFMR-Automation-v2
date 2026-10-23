import './loadEnv';
import { Pool } from 'pg';
import { resolveWorkingConnectionString } from '../src/services/relationalRuntime';

async function inspectLastEmail() {
  const bold = '\x1b[1m';
  const green = '\x1b[32m';
  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';

  console.log(`\n${bold}====================================================${reset}`);
  console.log(`${bold}  BFMR Automation v2 - Email Ingestion Inspection   ${reset}`);
  console.log(`${bold}====================================================${reset}\n`);

  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    console.error('ERROR: DATABASE_URL is not set.');
    return;
  }

  const connStr = await resolveWorkingConnectionString(rawUrl);
  const pool = new Pool({ connectionString: connStr, max: 1 });
  const client = await pool.connect();

  try {
    console.log('[1. Latest Ingested Emails in PostgreSQL: public.emails]');
    const emailsRes = await client.query(`
      SELECT id, gmail_message_id, subject, email_type, received_at
      FROM public.emails
      ORDER BY id DESC LIMIT 5;
    `);

    if (emailsRes.rows.length === 0) {
      console.log('  (No emails recorded in public.emails yet)');
    } else {
      for (const row of emailsRes.rows) {
        console.log(`  - [ID ${row.id}] ${bold}${row.email_type}${reset}: "${row.subject}" (${row.gmail_message_id}) at ${row.received_at}`);
      }
    }

    console.log('\n[2. Latest Workflow Evidence in PostgreSQL: public.workflow_evidence]');
    const evidenceRes = await client.query(`
      SELECT id, correlation_id, action_type, phase, outcome, evidence, recorded_at
      FROM public.workflow_evidence
      WHERE recorded_at >= NOW() - INTERVAL '2 hours'
      ORDER BY id DESC LIMIT 10;
    `);

    if (evidenceRes.rows.length === 0) {
      console.log('  (No workflow evidence events recorded in the last 2 hours)');
    } else {
      for (const row of evidenceRes.rows) {
        console.log(`  - [ID ${row.id}] ${bold}${row.action_type}${reset} | ${row.phase} | ${green}${row.outcome}${reset}`);
        if (row.evidence) {
          console.log(`    Evidence: ${JSON.stringify(row.evidence)}`);
        }
      }
    }

    console.log('\n[3. Latest Gmail Intake Notifications: public.gmail_intake_notifications]');
    const notifRes = await client.query(`
      SELECT id, message_id, history_id, rejection, recorded_at
      FROM public.gmail_intake_notifications
      ORDER BY id DESC LIMIT 5;
    `);
    for (const row of notifRes.rows) {
      console.log(`  - [ID ${row.id}] Message: ${row.message_id}, HistoryId: ${row.history_id}, Rejection: ${row.rejection || 'NONE (ACCEPTED)'}`);
    }

    console.log('\n');
  } finally {
    client.release();
    await pool.end();
  }
}

inspectLastEmail().catch(err => {
  console.error(`Error inspecting emails: ${err.message}`);
  process.exit(1);
});
