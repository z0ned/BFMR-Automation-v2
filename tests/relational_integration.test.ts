import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BfmrRelationalSync, ReservationReviewRequiredError } from '../src/services/bfmrRelationalSync';
import { readRelationalExposureCents } from '../src/services/relationalExposure';
import { numericToCents, centsToNumeric } from '../src/db/relationalRepositories';
import { normalizeTrackerReservation } from '../src/services/relationalTrackerTerms';
import { readCanonicalDealTerms } from '../src/services/relationalDealTerms';
import { recordVerifiedPaymentInTransaction, type VerifiedPaymentNotice } from '../src/services/relationalPayments';
import { relationalOrderLedger, validateRelationalRetailerAccount } from '../src/services/relationalOrderLedger';
import { applyRelationalCutover, assertRelationalCutoverReady, parseRelationalCutoverManifest,
  reconcileRelationalCutover, type RelationalCutoverManifest } from '../src/services/relationalCutover';
import type { AmazonOrderRecord } from '../src/services/amazonOrderLedger';
import type { RelationalRuntime } from '../src/services/relationalRuntime';
import { relationalStartupHooks } from '../src/services/relationalStartup';
import { recoverLivePostReservation } from '../scripts/post_reservation';
import { createRelationalFixture, databaseTestOptions } from './helpers/relationalPglite';

const instant = () => new Date(Date.now() - 1_000).toISOString();
async function fixture(t: TestContext) {
  const f = await createRelationalFixture();
  t.after(() => f.db.close());
  await f.db.validateSchema();
  return f;
}
async function capture(f: Awaited<ReturnType<typeof createRelationalFixture>>, reserveId = 'R1001', payoutCents = 8000, dealId = 'D101') {
  const at = instant();
  return new BfmrRelationalSync(f.db).captureConfirmedReservation({
    reference: { reserveId, dealId }, email: { id: `synthetic-${reserveId}`, subject: 'Synthetic new deal', receivedAt: '2026-10-20T10:00:00Z' },
    deal: { slug: `synthetic-${dealId}`, title: 'Synthetic item', currentPayoutCents: payoutCents },
    creationTerms: { quantity: 1, payoutPerItemCents: payoutCents }, observedAt: at,
  });
}
const row = (reserveId = 'R1001', payout = '80.00', status = 'reserved', dealId = 'D101', amountPaid = '0.00') =>
  ({ reserve_id: reserveId, deal_id: dealId, quantity: 1, expected_payout: payout, status, amount_paid: amountPaid });
const metadata = () => ({ complete: true, accountValidated: true, financialContractValidated: true, observedAt: instant() });
const paymentNotice = (amountCents = 8000): VerifiedPaymentNotice => ({
  bfmrReservationId: 'R1001', bfmrDealId: 'D101', amountCents,
  email: { gmailMessageId: 'synthetic-payment-1', subject: 'Synthetic payment notice', emailType: 'PAYMENT_SENT', receivedAt: '2026-10-20T12:00:00Z' },
  paidAt: '2026-10-20T11:59:00Z', paymentReference: 'synthetic-payment-ref',
  verification: { authenticatedGmailApi: true, paymentContractValidated: true, sourceSha256: 'a'.repeat(64), verifiedAt: '2026-10-20T12:01:00Z' },
});

async function amazonAccount(f: Awaited<ReturnType<typeof createRelationalFixture>>) {
  return f.db.withTransaction(async tx => {
    const retailer = (await tx.query<{ id: string }>("INSERT INTO public.retailers(name,primary_url) VALUES('Amazon','https://amazon.com') RETURNING id")).rows[0];
    const account = (await tx.query<{ id: string }>("INSERT INTO public.retailer_accounts(retailer_id,email,ccv) VALUES($1,'synthetic@example.invalid',repeat('0',3)) RETURNING id", [retailer.id])).rows[0];
    await tx.deals.ensureRetailer((await tx.deals.findByBfmrId('D101'))!.id, retailer.id);
    return { retailerAccountId: account.id, expectedAccountEmail: 'synthetic@example.invalid' };
  });
}
const syntheticOrder = (reserveId = 'R1001', orderId = '111-1111111-1111111'): AmazonOrderRecord => ({
  orderId, reserveId, dealId: 'D101', asin: 'B000000001', totalCents: 7999,
  purchasedAt: '2026-10-20T12:00:00Z', status: 'PENDING', packages: [],
});

test('provider terms reject conflicting representations and parse USD without floating-point drift', () => {
  assert.equal(numericToCents(centsToNumeric(29)), 29);
  assert.equal(normalizeTrackerReservation(row()).expectedPayoutCents, 8000);
  assert.throws(() => normalizeTrackerReservation({ ...row(), payout: '95.00' }), /conflicting/);
  assert.throws(() => normalizeTrackerReservation({ ...row(), qty: 2 }), /conflicting/);
  assert.throws(() => normalizeTrackerReservation({ ...row(), status: 'unrecognized provider status' }), /unknown/);
  assert.throws(() => normalizeTrackerReservation({ ...row(), expected_payout: '0.001' }), /decimal/);
});

test('canonical deal capture is contract-gated and rejects conflicting identity or rate evidence before submission', async t => {
  const keys = ['BFMR_CREATION_TERMS_CONTRACT_VALIDATED', 'BFMR_API_KEY', 'BFMR_API_SECRET'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
  delete process.env.BFMR_CREATION_TERMS_CONTRACT_VALIDATED;
  process.env.BFMR_API_KEY = 'synthetic-key';
  process.env.BFMR_API_SECRET = 'synthetic-secret';
  let calls = 0;
  let deal = { deal_id: 'D101', slug: 'synthetic', title: 'Synthetic item', payout: '80.00', payout_price: '80.00' };
  const request: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ deal })); };
  const read = () => readCanonicalDealTerms('https://bfmr.com/deals/synthetic', 'D101', 'Synthetic item', request);
  await assert.rejects(read(), /not validated/);
  assert.equal(calls, 0);
  process.env.BFMR_CREATION_TERMS_CONTRACT_VALIDATED = 'YES';
  assert.deepEqual(await read(), { slug: 'synthetic', title: 'Synthetic item', currentPayoutCents: 8000 });
  deal = { ...deal, deal_id: 'D999' };
  await assert.rejects(read(), /identity or title conflicts/);
  deal = { ...deal, deal_id: 'D101', payout_price: '95.00' };
  await assert.rejects(read(), /payout is missing or conflicting/);
});

test('startup validates the installed schema without DDL and refuses disabled immutable guard', databaseTestOptions, async t => {
  const f = await fixture(t);
  assert.ok(f.statements.every(sql => !/^\s*(?:CREATE|ALTER|DROP)/i.test(sql)));
  await f.query('ALTER TABLE public.reservations DISABLE TRIGGER reservations_immutable_payout');
  await assert.rejects(f.db.validateSchema(), /immutable payout/);
  await assert.rejects(f.db.withTransaction(tx => tx.reservations.list()), /Validate the installed/);
  await f.query('DROP TRIGGER reservations_immutable_payout ON public.reservations');
  await f.query(`CREATE TRIGGER reservations_immutable_payout AFTER UPDATE OF reservation_status_id
    ON public.reservations FOR EACH ROW EXECUTE FUNCTION public.reject_reservation_payout_change()`);
  await f.query('ALTER TABLE public.reservations ENABLE ALWAYS TRIGGER reservations_immutable_payout');
  await assert.rejects(f.db.validateSchema(), /immutable payout/);
});

test('generated payout stays creation-locked through status updates and compensating-edit attempts', databaseTestOptions, async t => {
  const f = await fixture(t);
  const reservation = await capture(f);
  await f.db.withTransaction(tx => tx.reservations.updateStatus(reservation.id, '2'));
  for (const sql of [
    'UPDATE public.reservations SET quantity=2 WHERE id=$1',
    'UPDATE public.reservations SET payout_per_item=95 WHERE id=$1',
    'UPDATE public.reservations SET quantity=2,payout_per_item=40 WHERE id=$1',
  ]) await assert.rejects(f.db.withTransaction(tx => tx.query(sql, [reservation.id])), error => (error as { code?: string }).code === '23514');
  const stored = await f.db.withTransaction(tx => tx.reservations.findByBfmrId('R1001'));
  assert.equal(stored?.quantity, 1);
  assert.equal(stored?.payout_per_item, '80.00');
  assert.equal(stored?.expected_payout, '80.00');
  assert.equal(stored?.reservation_status_id, '2');
  const future = await capture(f, 'R1002', 9500);
  assert.equal(future.expected_payout, '95.00');
  assert.equal((await f.db.withTransaction(tx => tx.reservations.findByBfmrId('R1001')))?.expected_payout, '80.00');
});

test('a creation-term conflict retains review evidence after rolling back the rejected capture', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  await assert.rejects(capture(f, 'R1001', 9500), ReservationReviewRequiredError);
  const result = await f.query<{ expected_payout: string }>('SELECT expected_payout FROM public.reservations');
  assert.equal(result.rows[0].expected_payout, '80.00');
  const evidence = await f.query<{ response_data: { observed_payout_per_item_cents: number } }>(
    "SELECT response_data FROM public.provider_observations WHERE resource_type='RESERVATION_CREATION_CONFLICT'");
  assert.equal(evidence.rows.length, 1);
  assert.equal(evidence.rows[0].response_data.observed_payout_per_item_cents, 9500);
});

test('repeated creation capture preserves a newer deal rate and the original reservation snapshot', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  await capture(f, 'R1002', 9500);
  await capture(f);
  const stored = await f.query<{ reimbursement_amount: string }>('SELECT reimbursement_amount FROM public.deals');
  assert.equal(stored.rows[0].reimbursement_amount, '95.00');
  const reservations = await f.query<{ bfmr_reservation_id: string; expected_payout: string }>(
    'SELECT bfmr_reservation_id, expected_payout FROM public.reservations ORDER BY id');
  assert.deepEqual(reservations.rows, [
    { bfmr_reservation_id: 'R1001', expected_payout: '80.00' },
    { bfmr_reservation_id: 'R1002', expected_payout: '95.00' },
  ]);
});

test('reconciliation promotes all permitted status changes atomically and preserves conflicting observations', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  await capture(f, 'R1002');
  const sync = new BfmrRelationalSync(f.db);
  const conflict = await sync.reconcile([row('R1001', '80.00', 'canceled'), row('R1002', '95.00')], metadata());
  assert.equal(conflict.promoted, false);
  assert.ok(conflict.issues.includes('LOCKED_RESERVATION_PAYOUT_CONFLICT'));
  assert.deepEqual((await f.query<{ reservation_status_id: string }>('SELECT reservation_status_id FROM public.reservations ORDER BY id')).rows.map(r => r.reservation_status_id), ['1', '1']);
  assert.equal((await f.query('SELECT id FROM public.provider_observations WHERE sync_run_id=$1', [conflict.runId])).rows.length, 2);
  const valid = await sync.reconcile([row('R1001', '80.00', 'canceled'), row('R1002')], metadata());
  assert.equal(valid.promoted, true);
  assert.deepEqual((await f.query<{ reservation_status_id: string }>('SELECT reservation_status_id FROM public.reservations ORDER BY id')).rows.map(r => r.reservation_status_id), ['2', '1']);
  const run = (await f.query<{ status: string; is_complete: boolean }>('SELECT status,is_complete FROM public.sync_runs WHERE id=$1', [valid.runId])).rows[0];
  assert.deepEqual(run, { status: 'COMPLETED', is_complete: true });
});

test('incomplete and unknown legacy reads never manufacture creation terms or erase authoritative state', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  const sync = new BfmrRelationalSync(f.db);
  const incomplete = await sync.reconcile([], { ...metadata(), complete: false });
  assert.equal(incomplete.promoted, false);
  assert.equal((await f.query<{ status: string }>('SELECT status FROM public.sync_runs WHERE id=$1', [incomplete.runId])).rows[0].status, 'INCOMPLETE');
  const unknown = await sync.reconcile([row(), row('R9999')], metadata());
  assert.equal(unknown.promoted, false);
  assert.ok(unknown.issues.includes('LEGACY_RESERVATION_REQUIRES_CREATION_EVIDENCE'));
  assert.equal((await f.query('SELECT id FROM public.reservations')).rows.length, 1);
  assert.equal((await f.query('SELECT id FROM public.provider_observations WHERE sync_run_id=$1', [unknown.runId])).rows.length, 2);
});

test('locked exposure requires complete fresh payment evidence and blocks the latest failed sync', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  await capture(f, 'R1002', 9500);
  const sync = new BfmrRelationalSync(f.db);
  await sync.reconcile([row(), row('R1002', '95.00')], metadata());
  const exposure = () => readRelationalExposureCents(f.db, { reserveId: 'R1002', dealId: 'D101' }, { contractValidated: true, now: new Date(Date.now() + 1000) });
  assert.equal(await exposure(), 8000);
  await sync.reconcile([row('R1001', '95.00'), row('R1002', '95.00')], metadata());
  await assert.rejects(exposure(), ReservationReviewRequiredError);
  await f.db.withTransaction(tx => recordVerifiedPaymentInTransaction(tx, paymentNotice()));
  await sync.reconcile([row('R1001', '80.00', 'paid', 'D101', '80.00'), row('R1002', '95.00')], metadata());
  assert.equal(await exposure(), 0);
  await sync.reconcile([{ ...row('R1001', '80.00', 'paid', 'D101', '80.00'), amount_paid: undefined }, row('R1002', '95.00')], metadata());
  await assert.rejects(exposure(), ReservationReviewRequiredError);
});

test('actual payments are idempotent by exact evidence and a second different payment is rejected atomically', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  const first = await f.db.withTransaction(tx => recordVerifiedPaymentInTransaction(tx, paymentNotice()));
  const duplicate = await f.db.withTransaction(tx => recordVerifiedPaymentInTransaction(tx, paymentNotice()));
  assert.equal(first.id, duplicate.id);
  await assert.rejects(f.db.withTransaction(tx => recordVerifiedPaymentInTransaction(tx, {
    ...paymentNotice(1000), email: { ...paymentNotice().email, gmailMessageId: 'synthetic-payment-2' },
  })), /different reimbursement/);
  assert.equal((await f.query('SELECT id FROM public.reimbursements')).rows.length, 1);
  assert.equal((await f.query("SELECT id FROM public.emails WHERE gmail_message_id='synthetic-payment-2'")).rows.length, 0);
  const unpaid = await capture(f, 'R1002');
  await assert.rejects(f.db.withTransaction(tx => tx.reimbursements.create({ reservationId: unpaid.id, paymentEmailId: '99999', amountCents: 1, paidAt: instant() })), error => (error as { code?: string }).code === '23503');
});

test('loss of ownership before commit rolls back business and evidence writes without retry', databaseTestOptions, async t => {
  const f = await fixture(t);
  let attempts = 0;
  await assert.rejects(f.db.withTransaction(async tx => {
    attempts++;
    await tx.deals.upsert({ bfmrDealId: 'D999', slug: 'synthetic', title: 'Synthetic rollback', reimbursementAmountCents: 1 });
    f.loseOwnership();
  }), /ownership was lost/);
  f.restoreOwnership();
  assert.equal(attempts, 1);
  assert.equal((await f.query('SELECT id FROM public.deals')).rows.length, 0);
});

test('orders use relational identity and allow the same account/deal across separate reservations', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  await capture(f, 'R1002');
  const account = await f.db.withTransaction(async tx => {
    const retailer = (await tx.query<{ id: string }>("INSERT INTO public.retailers(name,primary_url) VALUES('Amazon','https://www.amazon.com') RETURNING id")).rows[0];
    // Synthetic placeholder required by the current DDL; no actual card data is used or selected.
    const value = (await tx.query<{ id: string }>("INSERT INTO public.retailer_accounts(retailer_id,email,ccv) VALUES($1,'synthetic@example.invalid',repeat('0',3)) RETURNING id", [retailer.id])).rows[0];
    const deal = await tx.deals.findByBfmrId('D101');
    await tx.deals.ensureRetailer(deal!.id, retailer.id);
    return { retailerId: retailer.id, retailerAccountId: value.id, expectedAccountEmail: 'synthetic@example.invalid' };
  });
  await validateRelationalRetailerAccount(f.db, account);
  await assert.rejects(validateRelationalRetailerAccount(f.db, { ...account, expectedAccountEmail: 'other@example.invalid' }), /identity does not match/);
  const ledger = relationalOrderLedger(f.db, account);
  const order: AmazonOrderRecord = { orderId: '111-1111111-1111111', reserveId: 'R1001', dealId: 'D101',
    asin: 'B000000001', totalCents: 7999, purchasedAt: '2026-10-20T12:00:00Z', status: 'PENDING', packages: [] };
  await ledger.add(order);
  await ledger.add({ ...order, orderId: '111-1111111-1111112', reserveId: 'R1002' });
  assert.equal((await ledger.load()).length, 2);
  await assert.rejects(ledger.add({ ...order, orderId: '111-1111111-1111113' }), /different retailer order/);
  await assert.rejects(ledger.update({ ...order, totalCents: 8000 }), /identity, cost/);
  assert.equal((await ledger.load()).find(value => value.reserveId === 'R1001')?.totalCents, 7999);
  assert.equal((await f.query('SELECT id FROM public.orders')).rows.length, 2);
  const observed = await f.query<{ resource_type: string }>("SELECT resource_type FROM public.provider_observations WHERE resource_type='ORDER_CONFLICT'");
  assert.equal(observed.rows.length, 1); // The local cost edit is not a provider read.
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='AMAZON_ORDER_REVIEW' AND outcome='BLOCKED'")).rows.length, 2);
});

test('shipment conflicts remain review evidence and never add or overwrite authoritative tracking', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  const options = await f.db.withTransaction(async tx => {
    const retailer = (await tx.query<{ id: string }>("INSERT INTO public.retailers(name,primary_url) VALUES('Amazon','https://amazon.com') RETURNING id")).rows[0];
    const account = (await tx.query<{ id: string }>("INSERT INTO public.retailer_accounts(retailer_id,email,ccv) VALUES($1,'synthetic@example.invalid',repeat('0',3)) RETURNING id", [retailer.id])).rows[0];
    await tx.deals.ensureRetailer((await tx.deals.findByBfmrId('D101'))!.id, retailer.id);
    return { retailerAccountId: account.id, expectedAccountEmail: 'synthetic@example.invalid' };
  });
  const ledger = relationalOrderLedger(f.db, options);
  const order: AmazonOrderRecord = { orderId: '111-1111111-1111111', reserveId: 'R1001', dealId: 'D101',
    asin: 'B000000001', totalCents: 7999, purchasedAt: '2026-10-20T12:00:00Z', status: 'PENDING', packages: [] };
  await ledger.add(order);
  const pkg = { trackingNumber: '1Z0000000000000001', carrier: 'UPS', status: 'SHIPPED' as const,
    firstSeenAt: '2026-10-20T15:00:00Z', lastSeenAt: '2026-10-20T15:00:00Z' };
  await assert.rejects(ledger.update({ ...order, status: 'SHIPPED', packages: [{ ...pkg, carrier: null }] }, 'AMAZON'), /carrier is unknown/);
  await assert.rejects(ledger.update({ ...order, status: 'SHIPPED', packages: [pkg, { ...pkg, trackingNumber: '1Z0000000000000002' }] }, 'AMAZON'), /Multiple provider tracking/);
  assert.equal((await f.query('SELECT id FROM public.shipments')).rows.length, 0);
  const shipped = { ...order, status: 'SHIPPED' as const, packages: [pkg] };
  await ledger.update(shipped, 'AMAZON');
  await ledger.update({ ...shipped, bfmrPurchaseIntentAt: '2026-10-20T15:01:00Z' }, 'OPERATIONAL');
  const loaded = (await ledger.load())[0];
  assert.equal(loaded.bfmrPurchaseIntentAt, '2026-10-20T15:01:00Z');
  await assert.rejects(ledger.update({ ...loaded, packages: [{ ...pkg, trackingNumber: '1Z0000000000000003' }] }, 'AMAZON'), /shipment identity/);
  await assert.rejects(ledger.update({ ...loaded, bfmrPurchaseIntentAt: undefined }, 'OPERATIONAL'), /intent cannot be replaced/);
  const canonical = (await f.query<{ tracking_number: string }>('SELECT tracking_number FROM public.shipments')).rows;
  assert.deepEqual(canonical, [{ tracking_number: pkg.trackingNumber }]);
  const observations = await f.query<{ resource_type: string }>("SELECT resource_type FROM public.provider_observations WHERE provider='AMAZON' AND is_complete");
  assert.deepEqual(observations.rows.map(value => value.resource_type), ['ORDER_CONFIRMATION', 'ORDER_TRACKING']);
});

test('historical canceled and non-unit orders retain business records while allowing new account/deal work', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  await capture(f, 'R1002');
  const options = await amazonAccount(f);
  const ledger = relationalOrderLedger(f.db, options);
  await ledger.add(syntheticOrder());
  await f.db.withTransaction(async tx => {
    const old = await tx.orders.findByExternalId('111-1111111-1111111');
    await tx.orders.updateStatus(old!.id, '8', 1);
    const deal = await tx.deals.findByBfmrId('D101');
    const reservation = await tx.reservations.create({ bfmrReservationId: 'R1003', dealId: deal!.id,
      quantity: 2, payoutPerItemCents: 8000 });
    const account = (await tx.query<{ retailer_id: string }>('SELECT retailer_id FROM public.retailer_accounts WHERE id=$1', [options.retailerAccountId])).rows[0];
    await tx.orders.create({ orderId: '111-1111111-1111113', reservationId: reservation.id, dealId: deal!.id,
      retailerId: account.retailer_id, retailerAccountId: options.retailerAccountId, quantity: 2,
      totalCostCents: 15998, purchaseDate: '2026-10-20', productIdentifier: 'B000000001' });
  });
  assert.deepEqual(await ledger.load(), []);
  await ledger.add(syntheticOrder('R1002', '111-1111111-1111112'));
  assert.deepEqual((await ledger.load()).map(order => order.reserveId), ['R1002']);
  await ledger.load();
  assert.equal((await f.query('SELECT id FROM public.orders')).rows.length, 3);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='AMAZON_AUTOMATION_SCOPE' AND outcome='EXCLUDED'")).rows.length, 2);
});

test('corrupt active order evidence blocks projection and retains a local review without inventing provider observations', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  const options = await amazonAccount(f);
  const ledger = relationalOrderLedger(f.db, options);
  await f.db.withTransaction(async tx => {
    const reservation = await tx.reservations.findByBfmrId('R1001');
    const account = (await tx.query<{ retailer_id: string }>('SELECT retailer_id FROM public.retailer_accounts WHERE id=$1', [options.retailerAccountId])).rows[0];
    await tx.orders.create({ orderId: '111-1111111-1111111', reservationId: reservation!.id, dealId: reservation!.deal_id,
      retailerId: account.retailer_id, retailerAccountId: options.retailerAccountId, quantity: 1,
      totalCostCents: 7999, purchaseDate: '2026-10-20', productIdentifier: 'B000000001' });
  });
  await assert.rejects(ledger.load(), /reconcil/i);
  await assert.rejects(ledger.load(), /reconcil/i);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='AMAZON_ORDER_REVIEW' AND outcome='BLOCKED'")).rows.length, 1);
  assert.equal((await f.query("SELECT id FROM public.provider_observations WHERE provider='AMAZON'")).rows.length, 0);
  assert.equal((await f.query('SELECT id FROM public.orders')).rows.length, 1);
});

test('mismatched BFMR readback is retained without replacing accepted provider identities', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  const ledger = relationalOrderLedger(f.db, await amazonAccount(f));
  await ledger.add(syntheticOrder());
  await ledger.update({ ...(await ledger.load())[0], bfmrPurchaseId: 'synthetic-purchase-1' }, 'BFMR');
  const accepted = (await ledger.load())[0];
  await assert.rejects(ledger.update({ ...accepted, bfmrPurchaseId: 'synthetic-purchase-2' }, 'OPERATIONAL'), /cannot be replaced/);
  await assert.rejects(ledger.update({ ...accepted, bfmrOfficial: {
    status: 'purchased', quantity: 1, purchaseId: 'synthetic-purchase-1', shipmentId: null,
    orderNo: '111-1111111-9999999', trackingNumber: null, observedAt: '2026-10-20T15:00:00Z',
  } }, 'BFMR'), /official observation conflicts/);
  const current = (await ledger.load())[0];
  assert.equal(current.bfmrPurchaseId, 'synthetic-purchase-1');
  assert.equal(current.bfmrOfficial, undefined);
  assert.equal((await f.query("SELECT id FROM public.provider_observations WHERE provider='BFMR' AND resource_type='ORDER_CONFLICT'")).rows.length, 1);
});

test('unknown legacy startup recovery cannot reach provider cancellation before relational identity validation', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bfmr-relational-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journalFile = path.join(directory, 'synthetic-post-reservation.json');
  await writeFile(journalFile, JSON.stringify({ reference: { reserveId: 'R-UNKNOWN', dealId: 'D101' },
    kind: 'STARTUP', state: 'CANCEL_PENDING' }));
  const priorPath = process.env.BFMR_POST_RESERVATION_STATE_PATH;
  const priorFetch = globalThis.fetch;
  process.env.BFMR_POST_RESERVATION_STATE_PATH = journalFile;
  let providerCalls = 0, ownershipChecks = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error('No provider access is allowed in this test.'); };
  t.after(() => {
    if (priorPath === undefined) delete process.env.BFMR_POST_RESERVATION_STATE_PATH;
    else process.env.BFMR_POST_RESERVATION_STATE_PATH = priorPath;
    globalThis.fetch = priorFetch;
  });
  const runtime = { sync: { readLockedPayoutCents: async () => { throw new Error('Unknown creation terms require review.'); } },
    ownership: { verifyOwnership: async () => { ownershipChecks++; } } } as unknown as RelationalRuntime;
  await assert.rejects(recoverLivePostReservation(relationalStartupHooks(runtime)), /creation terms require review/);
  assert.equal(providerCalls, 0);
  assert.equal(ownershipChecks, 0);
});

test('a full sync rejects crossed provider order and shipment identities before any authoritative promotion', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  await capture(f, 'R1002', 9500);
  const ledger = relationalOrderLedger(f.db, await amazonAccount(f));
  await ledger.add(syntheticOrder());
  const pkg = { trackingNumber: '1Z0000000000000001', carrier: 'UPS', status: 'SHIPPED' as const,
    firstSeenAt: '2026-10-20T15:00:00Z', lastSeenAt: '2026-10-20T15:00:00Z' };
  await ledger.update({ ...(await ledger.load())[0], status: 'SHIPPED', packages: [pkg] }, 'AMAZON');
  await ledger.update({ ...(await ledger.load())[0], bfmrPurchaseId: 'synthetic-purchase-1',
    bfmrShipmentId: 'synthetic-shipment-1', bfmrTrackingSubmittedAt: '2026-10-20T15:00:00Z' }, 'BFMR');
  const providerRow = { ...row('R1001', '80.00', 'shipped'), order_no: '111-1111111-1111111',
    purchase_id: 'synthetic-purchase-1', shipment_id: 'synthetic-shipment-1', tracking_number: pkg.trackingNumber };
  const sync = new BfmrRelationalSync(f.db);
  assert.equal((await sync.reconcile([providerRow, row('R1002', '95.00')], metadata())).promoted, true);
  for (const change of [
    { order_no: '111-1111111-9999999' },
    { purchase_id: 'synthetic-wrong-purchase' },
    { shipment_id: 'synthetic-wrong-shipment' },
    { tracking_number: '1Z0000000000000099' },
  ]) {
    const result = await sync.reconcile([{ ...providerRow, ...change }, row('R1002', '95.00', 'canceled')], metadata());
    assert.equal(result.promoted, false);
    assert.ok(result.issues.some(issue => /IDENTITY|MISMATCH/.test(issue)));
    const reservations = await f.query<{ reservation_status_id: string }>('SELECT reservation_status_id FROM public.reservations ORDER BY id');
    assert.deepEqual(reservations.rows.map(value => value.reservation_status_id), ['1', '1']);
    assert.equal((await f.query('SELECT id FROM public.provider_observations WHERE sync_run_id=$1 AND NOT is_complete', [result.runId])).rows.length, 2);
    await assert.rejects(readRelationalExposureCents(f.db, { reserveId: 'R1002', dealId: 'D101' }, { contractValidated: true }), ReservationReviewRequiredError);
  }
  assert.equal((await sync.reconcile([providerRow, row('R1002', '95.00')], metadata())).promoted, true);
  assert.equal(await readRelationalExposureCents(f.db, { reserveId: 'R1002', dealId: 'D101' }, { contractValidated: true }), 8000);
  assert.equal((await f.query<{ tracking_number: string }>('SELECT tracking_number FROM public.shipments')).rows[0].tracking_number, pkg.trackingNumber);
});

test('cutover report is read-only, imports only reviewed historical records, and requires the exact account/source marker', databaseTestOptions, async t => {
  const f = await fixture(t);
  const manifest: RelationalCutoverManifest = {
    version: 1, account: 'synthetic@example.invalid', approvedAt: '2026-10-20T12:00:00Z',
    coverage: { allReservations: true, allOrders: true, actualPayments: true },
    legacyOrderLedgerSha256: null, excludedStandaloneOrderIds: [], reservations: [{
      bfmrReservationId: 'R1001', deal: { bfmrDealId: 'D101', slug: 'synthetic-D101', title: 'Synthetic item', reimbursementAmountCents: 9500 },
      quantity: 1, payoutPerItemCents: 8000, reservationStatusId: '1',
      creationEvidence: { authoritativeCreationTerms: true, sourceSha256: 'a'.repeat(64), verifiedAt: '2026-10-20T11:00:00Z' },
    }],
  };
  assert.throws(() => parseRelationalCutoverManifest({ ...manifest, reservations: [{ ...manifest.reservations[0], creationEvidence: undefined }] }), /authoritative creation evidence/);
  await assert.rejects(assertRelationalCutoverReady(f.db, { account: manifest.account, legacyOrderLedgerSha256: null }), /not accepted/);
  const report = await reconcileRelationalCutover(f.db, manifest, []);
  assert.equal(report.ready, true);
  assert.equal((await f.query('SELECT id FROM public.reservations')).rows.length, 0);
  assert.equal((await f.query('SELECT id FROM public.workflow_evidence')).rows.length, 0);
  const fetchBefore = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error('Offline cutover must never call a provider.'); };
  t.after(() => { globalThis.fetch = fetchBefore; });
  const applied = await applyRelationalCutover(f.db, { manifest, manifestSha256: 'b'.repeat(64), legacyOrders: [] });
  assert.equal(applied.ready, true);
  const imported = (await f.query<{ expected_payout: string }>('SELECT expected_payout FROM public.reservations')).rows[0];
  assert.equal(imported.expected_payout, '80.00');
  assert.equal((await f.query<{ reimbursement_amount: string }>('SELECT reimbursement_amount FROM public.deals')).rows[0].reimbursement_amount, '95.00');
  assert.equal(providerCalls, 0);
  await applyRelationalCutover(f.db, { manifest, manifestSha256: 'b'.repeat(64), legacyOrders: [] });
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='RELATIONAL_CUTOVER' AND outcome='ACCEPTED'")).rows.length, 1);
  await assertRelationalCutoverReady(f.db, { account: manifest.account, legacyOrderLedgerSha256: null });
  await assert.rejects(assertRelationalCutoverReady(f.db, { account: 'another@example.invalid', legacyOrderLedgerSha256: null }), /not accepted/);
  await assert.rejects(assertRelationalCutoverReady(f.db, { account: manifest.account, legacyOrderLedgerSha256: 'c'.repeat(64) }), /not accepted/);
});

test('conflicting cutover imports preserve business state and retain a rejected-attempt marker', databaseTestOptions, async t => {
  const f = await fixture(t);
  await capture(f);
  const reservation = (id: string, rate: number) => ({
    bfmrReservationId: id,
    deal: { bfmrDealId: 'D101', slug: 'synthetic-D101', title: 'Synthetic item', reimbursementAmountCents: 8000 },
    quantity: 1, payoutPerItemCents: rate, reservationStatusId: '1' as const,
    creationEvidence: { authoritativeCreationTerms: true as const, sourceSha256: 'a'.repeat(64), verifiedAt: '2026-10-20T11:00:00Z' },
  });
  const manifest: RelationalCutoverManifest = {
    version: 1, account: 'synthetic@example.invalid', approvedAt: '2026-10-20T12:00:00Z',
    coverage: { allReservations: true, allOrders: true, actualPayments: true },
    legacyOrderLedgerSha256: null, excludedStandaloneOrderIds: [],
    reservations: [reservation('R1002', 8000), reservation('R1001', 9500)],
  };
  await assert.rejects(applyRelationalCutover(f.db, { manifest, manifestSha256: 'b'.repeat(64), legacyOrders: [] }), /no authoritative import/);
  assert.deepEqual((await f.query<{ bfmr_reservation_id: string; expected_payout: string }>(
    'SELECT bfmr_reservation_id, expected_payout FROM public.reservations')).rows,
  [{ bfmr_reservation_id: 'R1001', expected_payout: '80.00' }]);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='RELATIONAL_CUTOVER' AND outcome='ACCEPTED'")).rows.length, 0);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='RELATIONAL_CUTOVER' AND outcome='REJECTED'")).rows.length, 1);
});

test('cutover preserves historical canceled and non-unit status without manufacturing active automation snapshots', databaseTestOptions, async t => {
  const f = await fixture(t);
  const account = await f.db.withTransaction(async tx => {
    const retailer = (await tx.query<{ id: string }>("INSERT INTO public.retailers(name,primary_url) VALUES('Amazon','https://amazon.com') RETURNING id")).rows[0];
    const value = (await tx.query<{ id: string }>("INSERT INTO public.retailer_accounts(retailer_id,email,ccv) VALUES($1,'synthetic@example.invalid',repeat('0',3)) RETURNING id", [retailer.id])).rows[0];
    return { retailerId: retailer.id, retailerAccountId: value.id, expectedAccountEmail: 'synthetic@example.invalid' };
  });
  const item = (id: string, quantity: number, statusId: string, canceledQuantity: number) => ({
    bfmrReservationId: id,
    deal: { bfmrDealId: 'D101', slug: 'synthetic-D101', title: 'Synthetic item', reimbursementAmountCents: 8000 },
    quantity, payoutPerItemCents: 8000, reservationStatusId: statusId === '8' ? '2' as const : '1' as const,
    creationEvidence: { authoritativeCreationTerms: true as const, sourceSha256: 'a'.repeat(64), verifiedAt: '2026-10-20T11:00:00Z' },
    order: { orderId: id === 'R1001' ? '111-1111111-1111111' : '111-1111111-1111112',
      retailerId: account.retailerId, retailerAccountId: account.retailerAccountId,
      quantity, totalCostCents: 7999 * quantity, purchaseDate: '2026-10-20', productIdentifier: 'B000000001',
      purchasedAt: '2026-10-20T12:00:00Z', statusId, canceledQuantity,
      importEvidence: { confirmedOrderIdentity: true as const, retailerEligibilityVerified: true as const,
        sourceSha256: 'b'.repeat(64), verifiedAt: '2026-10-20T12:01:00Z' } },
  });
  const manifest: RelationalCutoverManifest = {
    version: 1, account: 'synthetic@example.invalid', approvedAt: '2026-10-20T12:02:00Z',
    coverage: { allReservations: true, allOrders: true, actualPayments: true },
    legacyOrderLedgerSha256: null, excludedStandaloneOrderIds: [],
    reservations: [item('R1001', 1, '8', 1), item('R1002', 2, '1', 0)],
  };
  assert.equal((await applyRelationalCutover(f.db, { manifest, manifestSha256: 'c'.repeat(64), legacyOrders: [] })).ready, true);
  assert.deepEqual((await f.query<{ status_id: string; quantity: number; canceled_quantity: number }>(
    'SELECT status_id, quantity, canceled_quantity FROM public.orders ORDER BY id')).rows,
  [{ status_id: '8', quantity: 1, canceled_quantity: 1 }, { status_id: '1', quantity: 2, canceled_quantity: 0 }]);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='AMAZON_ORDER_STATE'")).rows.length, 0);
  const imported = await f.query<{ evidence: { automationManaged: boolean } }>(
    "SELECT evidence FROM public.workflow_evidence WHERE action_type='RETAILER_ORDER_IMPORT'");
  assert.deepEqual(imported.rows.map(value => value.evidence.automationManaged), [false, false]);
  assert.deepEqual(await relationalOrderLedger(f.db, account).load(), []);
});

test('cutover keeps active orders with unsupported Amazon identities outside the automation projection', databaseTestOptions, async t => {
  const f = await fixture(t);
  const account = await f.db.withTransaction(async tx => {
    const retailer = (await tx.query<{ id: string }>("INSERT INTO public.retailers(name,primary_url) VALUES('Amazon','https://amazon.com') RETURNING id")).rows[0];
    const value = (await tx.query<{ id: string }>("INSERT INTO public.retailer_accounts(retailer_id,email,ccv) VALUES($1,'synthetic@example.invalid',repeat('0',3)) RETURNING id", [retailer.id])).rows[0];
    return { retailerId: retailer.id, retailerAccountId: value.id, expectedAccountEmail: 'synthetic@example.invalid' };
  });
  const item = (id: string, orderId: string, productIdentifier: string) => ({
    bfmrReservationId: id,
    deal: { bfmrDealId: 'D101', slug: 'synthetic-D101', title: 'Synthetic item', reimbursementAmountCents: 8000 },
    quantity: 1, payoutPerItemCents: 8000, reservationStatusId: '1' as const,
    creationEvidence: { authoritativeCreationTerms: true as const, sourceSha256: 'a'.repeat(64), verifiedAt: '2026-10-20T11:00:00Z' },
    order: { orderId, retailerId: account.retailerId, retailerAccountId: account.retailerAccountId,
      quantity: 1, totalCostCents: 7999, purchaseDate: '2026-10-20', productIdentifier,
      purchasedAt: '2026-10-20T12:00:00Z', statusId: '1',
      importEvidence: { confirmedOrderIdentity: true as const, retailerEligibilityVerified: true as const,
        sourceSha256: 'b'.repeat(64), verifiedAt: '2026-10-20T12:01:00Z' } },
  });
  const manifest: RelationalCutoverManifest = {
    version: 1, account: 'synthetic@example.invalid', approvedAt: '2026-10-20T12:02:00Z',
    coverage: { allReservations: true, allOrders: true, actualPayments: true },
    legacyOrderLedgerSha256: null, excludedStandaloneOrderIds: [],
    reservations: [item('R1001', 'synthetic-unsupported-order', 'B000000001'),
      item('R1002', '111-1111111-1111112', 'synthetic-unsupported-product')],
  };
  assert.equal((await reconcileRelationalCutover(f.db, manifest, [])).ready, true);
  assert.equal((await applyRelationalCutover(f.db, { manifest, manifestSha256: 'c'.repeat(64), legacyOrders: [] })).ready, true);
  assert.deepEqual((await f.query<{ order_id: string; product_identifier: string }>(
    'SELECT order_id, product_identifier FROM public.orders ORDER BY id')).rows,
  [{ order_id: 'synthetic-unsupported-order', product_identifier: 'B000000001' },
    { order_id: '111-1111111-1111112', product_identifier: 'synthetic-unsupported-product' }]);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='AMAZON_ORDER_STATE'")).rows.length, 0);
  const imported = await f.query<{ evidence: { automationManaged: boolean } }>(
    "SELECT evidence FROM public.workflow_evidence WHERE action_type='RETAILER_ORDER_IMPORT'");
  assert.deepEqual(imported.rows.map(value => value.evidence.automationManaged), [false, false]);
  const ledger = relationalOrderLedger(f.db, account);
  assert.deepEqual(await ledger.load(), []);
  assert.deepEqual(await ledger.load(), []);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='AMAZON_AUTOMATION_SCOPE' AND outcome='EXCLUDED'")).rows.length, 2);
  assert.equal((await f.query('SELECT id FROM public.orders')).rows.length, 2);
});

test('cutover reports incoherent order and shipment states before any acceptance or business import', databaseTestOptions, async t => {
  const f = await fixture(t);
  const account = await f.db.withTransaction(async tx => {
    const retailer = (await tx.query<{ id: string }>("INSERT INTO public.retailers(name,primary_url) VALUES('Amazon','https://amazon.com') RETURNING id")).rows[0];
    const value = (await tx.query<{ id: string }>("INSERT INTO public.retailer_accounts(retailer_id,email,ccv) VALUES($1,'synthetic@example.invalid',repeat('0',3)) RETURNING id", [retailer.id])).rows[0];
    return { retailerId: retailer.id, retailerAccountId: value.id };
  });
  const shipment = { trackingNumber: '1Z0000000000000001', shippingCompany: 'UPS', quantity: 1,
    statusId: '3', firstSeenAt: '2026-10-20T12:30:00Z', lastSeenAt: '2026-10-20T13:00:00Z' };
  const manifest = (statusId: string, declaredShipment?: typeof shipment): RelationalCutoverManifest => ({
    version: 1, account: 'synthetic@example.invalid', approvedAt: '2026-10-20T14:00:00Z',
    coverage: { allReservations: true, allOrders: true, actualPayments: true },
    legacyOrderLedgerSha256: null, excludedStandaloneOrderIds: [], reservations: [{
      bfmrReservationId: 'R1001',
      deal: { bfmrDealId: 'D101', slug: 'synthetic-D101', title: 'Synthetic item', reimbursementAmountCents: 8000 },
      quantity: 1, payoutPerItemCents: 8000, reservationStatusId: '1',
      creationEvidence: { authoritativeCreationTerms: true, sourceSha256: 'a'.repeat(64), verifiedAt: '2026-10-20T11:00:00Z' },
      order: { orderId: '111-1111111-1111111', retailerId: account.retailerId, retailerAccountId: account.retailerAccountId,
        quantity: 1, totalCostCents: 7999, purchaseDate: '2026-10-20', productIdentifier: 'B000000001',
        purchasedAt: '2026-10-20T12:00:00Z', statusId, shipment: declaredShipment,
        importEvidence: { confirmedOrderIdentity: true, retailerEligibilityVerified: true,
          sourceSha256: 'b'.repeat(64), verifiedAt: '2026-10-20T12:01:00Z' } },
    }],
  });
  for (const [label, candidate] of [
    ['pending order with shipment', manifest('1', shipment)],
    ['delivered order without shipment', manifest('5')],
    ['delivered order with undelivered shipment', manifest('5', { ...shipment, statusId: '1' })],
  ] as const) {
    const report = await reconcileRelationalCutover(f.db, candidate, []);
    assert.equal(report.ready, false, label);
    assert.ok(report.issues.length > 0, label);
    await assert.rejects(applyRelationalCutover(f.db, { manifest: candidate,
      manifestSha256: 'c'.repeat(64), legacyOrders: [] }), /no authoritative import/, label);
    assert.equal((await f.query('SELECT id FROM public.reservations')).rows.length, 0, label);
    assert.equal((await f.query('SELECT id FROM public.orders')).rows.length, 0, label);
    assert.equal((await f.query('SELECT id FROM public.shipments')).rows.length, 0, label);
    assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='RELATIONAL_CUTOVER' AND outcome='ACCEPTED'")).rows.length, 0, label);
  }
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='RELATIONAL_CUTOVER' AND outcome='REJECTED'")).rows.length, 3);
  assert.equal((await reconcileRelationalCutover(f.db, manifest('5', shipment), [])).ready, true);
});
