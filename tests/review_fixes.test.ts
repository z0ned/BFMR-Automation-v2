import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { createRelationalFixture } from './helpers/relationalPglite';
import { DealEmailWorkflowStore, emailSourceSha256, type DealEmailState, LegacyWorkflowSnapshotError } from '../src/services/dealEmailWorkflowStore';
import { missingIntakePrivileges, IntakePrivilegeError } from '../src/db/intakePrivileges';
import { readLockedPurchaseEvidence } from '../src/services/relationalReservations';
import type { RelationalRuntime } from '../src/services/relationalRuntime';

// Synthetic identities only; all SQL goes to disposable PGlite, all provider
// reads are injected. No CLI environment loader or private database connection.
async function recoveryFixture(step: 'SKIPPED' | 'RESERVING' = 'SKIPPED') {
  const f = await createRelationalFixture();
  await f.db.validateSchema();
  await f.embedded.exec(await readFile(new URL('../database/gmail_intake.sql', import.meta.url), 'utf8'));
  const account = 'synthetic@example.invalid';
  const email = { id: 'synthetic-mail', sender: 'synthetic@example.invalid', subject: 'Synthetic', body: 'Synthetic', receivedAt: '2026-10-22T12:00:00Z' };
  await f.query(`INSERT INTO public.gmail_intake_state(account_namespace,mailbox,subscription,topic,consumed_cursor)
    VALUES($1,$1,'projects/synthetic/subscriptions/test','projects/synthetic/topics/test','100')`, [account]);
  await f.query(`INSERT INTO public.gmail_intake_work(account_namespace,gmail_message_id,state,payload,payload_sha256,received_at)
    VALUES($1,$2,'PROCESSING',$3::jsonb,$4,$5)`, [account, email.id, JSON.stringify(email), 'a'.repeat(64), email.receivedAt]);
  const state: DealEmailState = { schemaVersion: 1, workflowId: randomUUID(), account, source: 'GMAIL', messageId: email.id,
    messageType: 'SINGLE_DEAL', sourceSha256: emailSourceSha256(email), retailerAccountId: '1', startedAt: email.receivedAt,
    status: 'PAUSED', deals: [{ dealUrl: 'https://bfmr.com/deals/synthetic', step }] };
  const revision = await f.db.withTransaction(async tx => {
    const snapshot = await tx.evidence.appendWorkflow({ correlationId: state.workflowId, actionType: 'DEAL_EMAIL_WORKFLOW', phase: 'SNAPSHOT', outcome: state.status, evidence: JSON.parse(JSON.stringify(state)) });
    await tx.evidence.appendWorkflow({ correlationId: state.workflowId, actionType: 'WORKER_ACTION_CONTROL', phase: 'BLOCKED', outcome: 'EMAIL_ACTION_REQUIRES_REVIEW', evidence: { account, workflow_id: state.workflowId } });
    await tx.evidence.appendWorkflow({ correlationId: randomUUID(), actionType: 'WORKER_ACTION_CONTROL', phase: 'BLOCKED', outcome: 'EMAIL_ACTION_REQUIRES_REVIEW', evidence: { account, workflow_id: randomUUID() } });
    return snapshot.id;
  });
  return { ...f, account, state, checkpoint: { revision, state }, store: new DealEmailWorkflowStore(f.db, account) };
}

test('repair preflight reports missing runtime grants before any state change', async () => {
  const f = await recoveryFixture();
  await f.query('CREATE ROLE synthetic_no_intake');
  await f.query('SET ROLE synthetic_no_intake');
  try {
    const missing = await missingIntakePrivileges(f);
    assert.ok(missing.includes('public.gmail_intake_work:SELECT'));
    assert.ok(missing.includes('public.gmail_intake_work.state:UPDATE'));
    await assert.rejects(f.store.applyReviewedRepair(f.checkpoint, { ...f.state, status: 'COMPLETE' }, 'b'.repeat(64), async () => {}), IntakePrivilegeError);
  } finally { await f.query('RESET ROLE'); }
  assert.equal((await f.query('SELECT state FROM public.gmail_intake_work')).rows[0].state, 'PROCESSING');
  assert.equal((await f.store.load('GMAIL', f.state.messageId))!.revision, f.checkpoint.revision);
  await f.db.close();
});

test('existing-install grant template supplies exact intake privileges without granting deletion or DDL', async () => {
  const f = await recoveryFixture();
  await f.query('CREATE ROLE synthetic_intake_runtime');
  const template = await readFile(new URL('../database/runtime_intake_grants.psql', import.meta.url), 'utf8');
  const sql = template.split('\n').filter(line => !line.startsWith('\\')).join('\n').replaceAll(':"runtime_role"', 'synthetic_intake_runtime');
  await f.embedded.exec(sql);
  await f.query('SET ROLE synthetic_intake_runtime');
  try {
    assert.deepEqual(await missingIntakePrivileges(f), []);
    await assert.rejects(f.query('DELETE FROM public.gmail_intake_work'), (e: any) => e.code === '42501');
    await assert.rejects(f.query('CREATE TABLE public.synthetic_forbidden(id int)'), (e: any) => e.code === '42501');
  } finally { await f.query('RESET ROLE'); }
  await f.db.close();
});

for (const failAt of ['queue', 'incident']) test(`repair rolls back workflow, queue and incident writes on ${failAt} failure`, async () => {
  const f = await recoveryFixture();
  await assert.rejects(f.store.applyReviewedRepair(f.checkpoint, { ...f.state, status: 'COMPLETE' }, 'b'.repeat(64), async tx => {
    const query = tx.query.bind(tx);
    tx.query = async <T extends QueryResultRow>(sql: string, values?: unknown[]) => {
      if (failAt === 'queue' && sql.startsWith('UPDATE public.gmail_intake_work') ||
          failAt === 'incident' && sql.startsWith('INSERT INTO public.workflow_evidence') && values?.includes('RESOLVED')) {
        throw Object.assign(new Error('Synthetic permission failure'), { code: '42501' });
      }
      return query<T>(sql, values);
    };
  }), /Synthetic permission failure/);
  assert.equal((await f.query('SELECT state FROM public.gmail_intake_work')).rows[0].state, 'PROCESSING');
  assert.equal((await f.store.load('GMAIL', f.state.messageId))!.revision, f.checkpoint.revision);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE phase IN ('RESOLVED','APPLIED')")).rows.length, 0);
  await f.db.close();
});

test('exact committed repair is idempotent and resolves only its scoped incident', async () => {
  const f = await recoveryFixture();
  let calls = 0;
  const next: DealEmailState = { ...f.state, status: 'COMPLETE' };
  const apply = () => f.store.applyReviewedRepair(f.checkpoint, next, 'b'.repeat(64), async () => { calls++; });
  await apply();
  const count = (await f.query('SELECT id FROM public.workflow_evidence')).rows.length;
  await apply();
  assert.equal(calls, 1);
  assert.equal((await f.query('SELECT id FROM public.workflow_evidence')).rows.length, count);
  assert.equal((await f.query('SELECT state,payload FROM public.gmail_intake_work')).rows[0].state, 'DONE');
  assert.equal((await f.query('SELECT payload FROM public.gmail_intake_work')).rows[0].payload, null);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE phase='RESOLVED'")).rows.length, 1);
  assert.equal(await f.store.repairAlreadyApplied(next, 'b'.repeat(64)), true);
  await assert.rejects(f.store.applyReviewedRepair(f.checkpoint, next, 'c'.repeat(64), async () => {}), /reviewed state/);
  await f.db.close();
});

test('stale snapshot and changed Gmail source remain blocked', async () => {
  const f = await recoveryFixture();
  await assert.rejects(f.store.applyReviewedRepair({ ...f.checkpoint, revision: '999999' }, { ...f.state, status: 'COMPLETE' }, 'b'.repeat(64), async () => {}), /reviewed state/);
  await f.query("UPDATE public.gmail_intake_work SET payload=jsonb_set(payload,'{body}','\"Changed\"')");
  await assert.rejects(f.store.applyReviewedRepair(f.checkpoint, { ...f.state, status: 'COMPLETE' }, 'b'.repeat(64), async () => {}), /changed Gmail work/);
  await f.db.close();
});

async function checkoutFixture() {
  const f = await createRelationalFixture();
  await f.db.validateSchema();
  await f.db.withTransaction(async tx => {
    const deal = await tx.deals.upsert({ bfmrDealId: 'D101', slug: 'synthetic', title: 'Synthetic', reimbursementAmountCents: 8000 });
    await tx.reservations.create({ bfmrReservationId: 'R101', dealId: deal.id, quantity: 1, payoutPerItemCents: 8000 });
  });
  const runtime = { db: f.db } as RelationalRuntime;
  const reference = { reserveId: 'R101', dealId: 'D101' };
  return { ...f, runtime, reference };
}
for (const current of [9500, 7000]) test(`checkout preserves locked $80 payout when current deal rate is ${current} cents`, async () => {
  const f = await checkoutFixture();
  const evidence = await readLockedPurchaseEvidence(f.runtime, f.reference, {
    fetchLivePayout: async () => current,
    readAmazonEvidence: async () => ({ productUrl: 'https://www.amazon.com/dp/B000000001', payoutCents: current }),
  });
  assert.equal(evidence.payoutCents, 8000);
  const stored = await f.db.withTransaction(tx => tx.reservations.findByBfmrId('R101'));
  assert.equal(stored!.payout_per_item, '80.00');
  assert.equal(stored!.expected_payout, '80.00');
  assert.equal((await f.db.withTransaction(tx => tx.deals.findByBfmrId('D101')))!.reimbursement_amount, (current / 100).toFixed(2));
  await f.db.close();
});

test('checkout propagates provider and SQL failures without stale fallback', async () => {
  const f = await checkoutFixture();
  const readAmazonEvidence = async () => ({ productUrl: 'https://www.amazon.com/dp/B000000001', payoutCents: 9999 });
  await assert.rejects(readLockedPurchaseEvidence(f.runtime, f.reference, {
    readAmazonEvidence, fetchLivePayout: async () => { throw new Error('Synthetic provider failure'); },
  }), /Synthetic provider failure/);
  await f.query("CREATE FUNCTION synthetic_deny_deal_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic SQL failure' USING ERRCODE='42501'; END $$");
  await f.query('CREATE TRIGGER synthetic_deny_deal_write BEFORE INSERT OR UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION synthetic_deny_deal_write()');
  await assert.rejects(readLockedPurchaseEvidence(f.runtime, f.reference, { readAmazonEvidence, fetchLivePayout: async () => 9000 }), /Synthetic SQL failure/);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='CHECKOUT_PAYOUT'")).rows.length, 0);
  await f.db.close();
});

test('exposure trigger counts partial payments and protects inserts, status changes and payment removal', async () => {
  const f = await checkoutFixture();
  // PGlite has no competing connections. This exercises real trigger SQL and
  // accounting only; native concurrent-session/SSI acceptance remains separate.
  await f.embedded.exec(await readFile(new URL('../database/optimizations.sql', import.meta.url), 'utf8'));
  await f.db.validateSchema(); // Retired ccv may be absent after the upgrade.
  const create = (id: string, cents: number) => f.db.withTransaction(async tx => {
    const deal = (await tx.deals.findByBfmrId('D101'))!;
    return tx.reservations.create({ bfmrReservationId: id, dealId: deal.id, quantity: 1, payoutPerItemCents: cents });
  });
  await create('R102', 12000); // exactly $200
  await assert.rejects(create('R103', 1), (e: any) => e.code === '23514');
  const payment = await f.db.withTransaction(async tx => {
    const email = await tx.emails.upsert({ gmailMessageId: 'payment', subject: 'Synthetic', receivedAt: '2026-10-22T12:00:00Z', emailType: 'PAYMENT_SENT' });
    const r = (await tx.reservations.findByBfmrId('R101'))!;
    return tx.reimbursements.create({ reservationId: r.id, paymentEmailId: email.id, amountCents: 1000, paidAt: '2026-10-22T12:00:00Z' });
  });
  await assert.rejects(create('R103', 1001), (e: any) => e.code === '23514');
  await create('R103', 1000);
  await assert.rejects(f.db.withTransaction(tx => tx.query('DELETE FROM public.reimbursements WHERE id=$1', [payment.id])), (e: any) => e.code === '23514');
  const cancelled = await f.db.withTransaction(async tx => {
    const deal = (await tx.deals.findByBfmrId('D101'))!;
    return tx.reservations.create({ bfmrReservationId: 'R104', dealId: deal.id, quantity: 1, payoutPerItemCents: 5000, reservationStatusId: '2' });
  });
  await assert.rejects(f.db.withTransaction(tx => tx.reservations.updateStatus(cancelled.id, '1')), (e: any) => e.code === '23514');
  await f.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await assert.rejects(f.query('UPDATE public.reservations SET reservation_status_id=reservation_status_id'), (e: any) => e.code === '25000');
  await f.query('ROLLBACK');
  await f.db.close();
});


async function appendLegacyCompletion(f: Awaited<ReturnType<typeof recoveryFixture>>, changes: object = {}, correlationId = f.state.workflowId) {
  return f.db.withTransaction(tx => tx.evidence.appendWorkflow({ correlationId,
    actionType: 'DEAL_EMAIL_WORKFLOW', phase: 'SNAPSHOT', outcome: 'COMPLETE',
    evidence: JSON.parse(JSON.stringify({ ...f.state, status: 'COMPLETE', ...changes })) }));
}

test('legacy forced completion is readable only for reconciliation with exact predecessor provenance', async () => {
  const f = await recoveryFixture('RESERVING');
  const forced = await appendLegacyCompletion(f);
  const before = (await f.query('SELECT id FROM public.workflow_evidence')).rows.length;
  await assert.rejects(f.store.load('GMAIL', f.state.messageId), /Incomplete reservations/);
  const checkpoint = (await f.store.loadForReconciliation(f.state.messageId))!;
  assert.equal(checkpoint.revision, forced.id);
  assert.equal(checkpoint.state.status, 'PAUSED');
  assert.equal(checkpoint.state.deals[0].step, 'RESERVING');
  assert.equal(checkpoint.legacyStatusOverride?.predecessorRevision, f.checkpoint.revision);
  assert.match(checkpoint.legacyStatusOverride!.invalidSnapshotSha256, /^[0-9a-f]{64}$/);
  assert.equal((await f.query('SELECT id FROM public.workflow_evidence')).rows.length, before);
  assert.equal((await f.query('SELECT state FROM public.gmail_intake_work')).rows[0].state, 'PROCESSING');
  assert.equal((await f.query('SELECT evidence FROM public.workflow_evidence WHERE id=$1', [forced.id])).rows[0].evidence.status, 'COMPLETE');
  await f.db.close();
});

for (const change of ['action', 'correlation', 'missing-history']) test(`legacy completion recovery refuses ${change} differences`, async () => {
  const f = await recoveryFixture('RESERVING');
  await appendLegacyCompletion(f, change === 'action' ? { deals: [{ ...f.state.deals[0], dealId: 'UNPROVEN' }] }
    : change === 'missing-history' ? { messageId: 'unproven-message' } : {},
  change === 'correlation' ? randomUUID() : f.state.workflowId);
  await assert.rejects(f.store.loadForReconciliation(change === 'missing-history' ? 'unproven-message' : f.state.messageId), LegacyWorkflowSnapshotError);
  assert.equal((await f.query('SELECT state FROM public.gmail_intake_work')).rows[0].state, 'PROCESSING');
  await f.db.close();
});

test('reviewed legacy completion repair appends correction and preserves original evidence atomically', async () => {
  const f = await recoveryFixture('RESERVING');
  const forced = await appendLegacyCompletion(f);
  const checkpoint = (await f.store.loadForReconciliation(f.state.messageId))!;
  const next: DealEmailState = { ...checkpoint.state, status: 'READY', deals: [{ ...checkpoint.state.deals[0], step: 'PENDING' }] };
  // This store test models an already-reviewed plan; only the report CLI can
  // establish provider outcomes. Loading a predecessor alone never applies it.
  await f.store.applyReviewedRepair(checkpoint, next, 'd'.repeat(64), async () => {});
  const repaired = (await f.store.load('GMAIL', f.state.messageId))!;
  assert.equal(repaired.state.status, 'READY');
  assert.equal(repaired.state.deals[0].step, 'PENDING');
  assert.equal((await f.query('SELECT state FROM public.gmail_intake_work')).rows[0].state, 'PENDING');
  const original = (await f.query('SELECT evidence FROM public.workflow_evidence WHERE id=$1', [forced.id])).rows[0].evidence;
  assert.equal(original.status, 'COMPLETE');
  assert.equal(original.deals[0].step, 'RESERVING');
  const receipt = (await f.query("SELECT evidence FROM public.workflow_evidence WHERE action_type='DEAL_EMAIL_REPAIR'")).rows[0].evidence;
  assert.deepEqual(receipt.legacy_status_override, checkpoint.legacyStatusOverride);
  const count = (await f.query('SELECT id FROM public.workflow_evidence')).rows.length;
  await f.store.applyReviewedRepair(checkpoint, next, 'd'.repeat(64), async () => { throw new Error('Must not replay'); });
  assert.equal((await f.query('SELECT id FROM public.workflow_evidence')).rows.length, count);
  await f.db.close();
});

test('legacy completion repair rejects stale provenance before local writes', async () => {
  const f = await recoveryFixture('RESERVING');
  await appendLegacyCompletion(f);
  const checkpoint = (await f.store.loadForReconciliation(f.state.messageId))!;
  const next: DealEmailState = { ...checkpoint.state, status: 'READY' };
  await assert.rejects(f.store.applyReviewedRepair({ ...checkpoint, legacyStatusOverride: {
    ...checkpoint.legacyStatusOverride!, invalidSnapshotSha256: '0'.repeat(64),
  } }, next, 'd'.repeat(64), async () => { throw new Error('Must not write'); }), /provenance changed/);
  assert.equal((await f.query('SELECT state FROM public.gmail_intake_work')).rows[0].state, 'PROCESSING');
  await f.db.close();
});

test('failed legacy completion queue repair rolls back corrected snapshot and receipt', async () => {
  const f = await recoveryFixture('RESERVING');
  const forced = await appendLegacyCompletion(f);
  const checkpoint = (await f.store.loadForReconciliation(f.state.messageId))!;
  await assert.rejects(f.store.applyReviewedRepair(checkpoint, { ...checkpoint.state, status: 'READY' }, 'd'.repeat(64), async tx => {
    const query = tx.query.bind(tx);
    tx.query = async <T extends QueryResultRow>(sql: string, values?: unknown[]) => {
      if (sql.startsWith('UPDATE public.gmail_intake_work')) throw new Error('Synthetic queue failure');
      return query<T>(sql, values);
    };
  }), /Synthetic queue failure/);
  assert.equal((await f.store.loadForReconciliation(f.state.messageId))!.revision, forced.id);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE action_type='DEAL_EMAIL_REPAIR'")).rows.length, 0);
  assert.equal((await f.query('SELECT state FROM public.gmail_intake_work')).rows[0].state, 'PROCESSING');
  await f.db.close();
});
