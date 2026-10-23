import { selectDatabase } from '../src/db/databaseConfig';
import './loadEnv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresAccountOwnership } from '../src/db/postgresDatabase';
import { RelationalDatabase } from '../src/db/relationalDatabase';
import { applyRelationalCutover, readPrivateCutoverSources, reconcileRelationalCutover } from '../src/services/relationalCutover';

function argumentsFor(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  const values = new Set(['--manifest', '--legacy-order-ledger', '--account', '--confirm-account', '--confirm-manifest-sha256']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (result[key] !== undefined) throw new Error('Duplicate argument.');
    if (key === '--apply' || key === '--report') result[key] = true;
    else if (values.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) result[key] = args[++i];
    else throw new Error('Unknown argument or missing value.');
  }
  return result;
}

/** Source-only import tooling. It never opens Gmail, BFMR, Amazon or a browser. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = argumentsFor(args);
  if (typeof options['--manifest'] !== 'string' || typeof options['--legacy-order-ledger'] !== 'string') {
    throw new Error('Supply --manifest and --legacy-order-ledger; default mode is a read-only report.');
  }
  const account = String(options['--account'] ?? process.env.BFMR_EXPECTED_ACCOUNT ?? '').trim().toLowerCase();
  const connection = selectDatabase().connectionString;
  if (!account) throw new Error('An exact account is required.');
  const ownership = new PostgresAccountOwnership(connection, account);
  const db = new RelationalDatabase(connection, () => ownership.verifyOwnership());
  try {
    if (!await ownership.claimAccount(`bfmr_worker_lock_${account}`)) throw new Error('Another account worker is active.');
    await db.validateSchema();
    const source = await readPrivateCutoverSources(options['--manifest'], options['--legacy-order-ledger']);
    if (source.manifest.account !== account) throw new Error('Manifest account differs from the selected account.');
    if (!options['--apply']) {
      const report = await reconcileRelationalCutover(db, source.manifest, source.legacyOrders);
      console.log(JSON.stringify({ mode: 'REPORT', manifestSha256: source.manifestSha256, ...report }, null, 2));
      if (!report.ready) process.exitCode = 1;
      return;
    }
    if (options['--report'] || options['--confirm-account'] !== account || options['--confirm-manifest-sha256'] !== source.manifestSha256) {
      throw new Error('Apply requires the exact reviewed --confirm-account and --confirm-manifest-sha256, without --report.');
    }
    const report = await applyRelationalCutover(db, source);
    console.log(JSON.stringify({ mode: 'APPLIED', manifestSha256: source.manifestSha256, ...report }, null, 2));
  } finally {
    try { await db.close(); } finally { await ownership.close(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Relational cutover stopped. Review the private manifest, reconciliation report and database evidence; no provider actions were invoked.');
    process.exitCode = 1;
  });
}
