import './loadEnv';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresAccountOwnership } from '../src/db/postgresDatabase';
import { RelationalDatabase } from '../src/db/relationalDatabase';
import { assertRelationalCutoverReady, hashPrivateFile } from '../src/services/relationalCutover';
import { recordVerifiedPayment, validateVerifiedPaymentNotice } from '../src/services/relationalPayments';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options: Record<string, string | boolean> = {};
  const valueFlags = new Set(['--manifest', '--account', '--legacy-order-ledger', '--confirm-manifest-sha256']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (options[flag] !== undefined) throw new Error('Duplicate argument.');
    if (flag === '--apply') options[flag] = true;
    else if (valueFlags.has(flag) && args[index + 1] && !args[index + 1].startsWith('--')) options[flag] = args[++index];
    else throw new Error('Unknown argument or missing value.');
  }
  if (typeof options['--manifest'] !== 'string' || typeof options['--legacy-order-ledger'] !== 'string') {
    throw new Error('A private verified-payment manifest and the cutover legacy ledger path are required.');
  }
  const account = String(options['--account'] ?? process.env.BFMR_EXPECTED_ACCOUNT ?? '').trim().toLowerCase();
  if (!account || !process.env.DATABASE_URL) throw new Error('An exact account and DATABASE_URL are required.');
  const raw = await readFile(options['--manifest']);
  const input = validateVerifiedPaymentNotice(JSON.parse(raw.toString('utf8')));
  const manifestSha256 = createHash('sha256').update(raw).digest('hex');
  const ownership = new PostgresAccountOwnership(process.env.DATABASE_URL, account);
  const db = new RelationalDatabase(process.env.DATABASE_URL, () => ownership.verifyOwnership());
  try {
    if (!await ownership.claimAccount(`bfmr_worker_lock_${account}`)) throw new Error('Another account worker is active.');
    await db.validateSchema();
    await assertRelationalCutoverReady(db, { account, legacyOrderLedgerSha256: await hashPrivateFile(options['--legacy-order-ledger']) });
    if (!options['--apply']) {
      const report = await db.withTransaction(async tx => {
        const reservation = await tx.reservations.findByBfmrId(input.bfmrReservationId);
        const deal = await tx.deals.findByBfmrId(input.bfmrDealId);
        if (!reservation || !deal || reservation.deal_id !== deal.id) throw new Error('Payment subject identity is unresolved.');
        return { existingPayment: !!await tx.reimbursements.findByReservationId(reservation.id) };
      });
      console.log(JSON.stringify({ mode: 'REPORT', manifestValidated: true, manifestSha256, ...report }));
      return;
    }
    if (options['--confirm-manifest-sha256'] !== manifestSha256) throw new Error('The exact reviewed manifest hash is required to apply.');
    await recordVerifiedPayment(db, input, account);
    console.log(JSON.stringify({ mode: 'APPLIED', manifestSha256 }));
  } finally {
    try { await db.close(); } finally { await ownership.close(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Reimbursement recording stopped. Review the private payment evidence and exact reservation identity; no provider action was invoked.');
    process.exitCode = 1;
  });
}
