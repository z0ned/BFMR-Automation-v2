import './loadEnv';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PostgresAccountOwnership } from '../src/db/postgresDatabase';
import { PostgresGmailIntakeStore, validateLegacyGmailQueue } from '../src/services/postgresGmailIntake';

/** Separate report-first database import. No Gmail, watch, Pub/Sub, browser,
 * BFMR, Amazon, notification or business-record mutation path is imported.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node --import tsx scripts/import_gmail_intake.ts [--source <private queue path>]');
    console.log('Default is a read-only report. Reviewed database apply additionally requires:');
    console.log('  --apply --confirm-account <exact BFMR account> --confirm-source-sha256 <reviewed source hash>');
    console.log('Stop the writer and preserve backups first. Never repair PROCESSING work or a history gap by resetting it.');
    return;
  }
  const values = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--apply' && !apply) { apply = true; continue; }
    if (!['--source', '--confirm-account', '--confirm-source-sha256'].includes(flag) ||
      values.has(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid import arguments.');
    values.set(flag, args[++i]);
  }
  const account = process.env.BFMR_EXPECTED_ACCOUNT?.trim().toLowerCase();
  const mailbox = process.env.GMAIL_ACCOUNT_EMAIL?.trim().toLowerCase();
  const subscription = process.env.GOOGLE_PUBSUB_SUBSCRIPTION?.trim();
  const topic = process.env.GOOGLE_PUBSUB_TOPIC?.trim();
  const connection = process.env.DATABASE_URL;
  if (!account || !mailbox || !subscription || !topic || !connection) throw new Error('Private account/mailbox/PubSub/database configuration is required.');
  const source = values.get('--source') ?? process.env.BFMR_GMAIL_QUEUE_PATH ?? path.join(os.homedir(), '.local/state/bfmr/gmail-intake.json');
  const bytes = await fs.readFile(source);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const queue: unknown = JSON.parse(bytes.toString('utf8'));
  validateLegacyGmailQueue(queue, mailbox);
  if (apply && (values.get('--confirm-account') !== account || values.get('--confirm-source-sha256') !== sourceSha256)) {
    throw new Error('Apply requires the exact reviewed account and source hash.');
  }
  const ownership = new PostgresAccountOwnership(connection, account);
  const store = new PostgresGmailIntakeStore(connection, { account, mailbox, subscription, topic,
    verifyOwnership: () => ownership.verifyOwnership() });
  try {
    if (!await ownership.claimAccount(`bfmr_worker_lock_${account}`)) throw new Error('Another worker owns the account.');
    await store.validateSchema();
    const { ready, alreadyAccepted } = await store.assessLegacyImport(queue, sourceSha256);
    if (apply) {
      if (!ready) throw new Error('SQL state conflicts with this legacy source.');
      // Source bytes are imported once, with their actual cursor and tombstones.
      // A repeated accepted source cannot rewind SQL state or replay completed work.
      await store.importLegacy(queue, sourceSha256);
    }
    console.log(JSON.stringify({ mode: apply ? 'APPLIED' : 'REPORT', sourceSha256, ready,
      pending: queue.work.filter(item => item.state === 'PENDING').length,
      completed: queue.work.filter(item => item.state === 'DONE').length,
      alreadyAccepted }, null, 2));
    if (!ready) process.exitCode = 1;
  } finally { try { await store.close(); } finally { await ownership.close(); } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Gmail intake import stopped. Review the private source, durable SQL state, installed operational schema and exact account/hash. No provider actions were invoked.');
    process.exitCode = 1;
  });
}
