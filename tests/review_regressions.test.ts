import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authenticateGmailSender, type MailHeader } from '../src/services/emailProvenance';
import { gmailIntakeQueue } from '../src/services/gmailIntakeQueue';
import { checkDealReservation, resolveBfmrDealId } from '../src/services/bfmrTrackerApi';
import { openBfmrExposureCents } from '../src/services/bfmrOpenExposure';
import { bfmrStatusStore, runDueBfmrStatusCheck } from '../src/services/bfmrDailyStatus';
import { amazonOrderLedger } from '../src/services/amazonOrderLedger';
import { TransactionalDatabase } from '../src/db/database';
import { BfmrOrchestrationEngine } from '../src/orchestrator/engine';
import { FakeGmailAdapter, FakeMyTrackerAdapter, FakeBrowserAdapter, FakeTelegramAdapter } from '../src/adapters/fakes';
import { INITIAL_TESTS, MILESTONES, runAcceptanceTest } from '../src/services/acceptanceTests';

const sender = 'deals@buyformeretail.com';
const auth = (address = sender): MailHeader[] => [{ name: 'From', value: address },
  { name: 'Received', value: 'from mail.example by mx.google.com with ESMTPS' },
  { name: 'Authentication-Results', value: `mx.google.com; dmarc=pass header.from=${address.split('@')[1]}; dkim=pass header.d=${address.split('@')[1]}` }];

test('sender authentication rejects forged, ambiguous and unauthenticated headers; test sender requires explicit mode', () => {
  assert.equal(authenticateGmailSender(sender, auth(), 'production'), true);
  assert.equal(authenticateGmailSender(sender, [], 'production'), false);
  assert.equal(authenticateGmailSender(sender, [...auth(), auth()[2]], 'production'), false);
  assert.equal(authenticateGmailSender(`${sender} <attacker@example.org>`, auth(), 'production'), false);
  assert.equal(authenticateGmailSender(sender, auth().map(h => ({ ...h, value: h.value?.replace('dmarc=pass', 'dmarc=fail') })), 'production'), false);
  assert.equal(authenticateGmailSender(sender, auth().map(h => ({ ...h, value: h.value?.replace('dkim=pass', 'dkim=fail (dkim=pass)') })), 'production'), false);
  assert.equal(authenticateGmailSender('matt.ward@live.com', auth('matt.ward@live.com'), 'production'), false);
  assert.equal(authenticateGmailSender('matt.ward@live.com', auth('matt.ward@live.com'), 'testing'), true);
});

test('exact deal IDs block purchased/shipped duplicates; confirmation requires a reserved ID and quantity one', async () => {
  const read = async () => [{ reserve_id: 'R1', deal_id: 'D1', title: 'Same product', qty: 1, status: 'Purchased' }];
  assert.equal((await checkDealReservation('D2', 'Same product', 'DUPLICATE', read)).status, 'NOT_VISIBLE_YET');
  assert.equal((await checkDealReservation('D1', 'Same product', 'DUPLICATE', read)).status, 'EXISTING');
  assert.equal((await checkDealReservation('D1', 'Same product', 'CONFIRMATION', read)).status, 'NOT_VISIBLE_YET');
  assert.equal((await checkDealReservation('D1', 'Same product', 'DUPLICATE', async () => [{ ...(await read())[0], status: 'Shipped' }])).status, 'EXISTING');
  assert.equal((await checkDealReservation('D1', 'Same product', 'CONFIRMATION', async () => [{ ...(await read())[0], status: 'Reserved' }])).status, 'CONFIRMED');
  assert.equal((await checkDealReservation('D1', 'Same product', 'CONFIRMATION', async () => [{ deal_id: 'D1', qty: 1, status: 'Reserved' }])).status, 'UNKNOWN');
  assert.equal((await checkDealReservation('D1', 'Same product', 'DUPLICATE', async () => [{ title: 'Same product', qty: 1, status: 'Reserved' }])).status, 'UNKNOWN');
});

test('deal detail API establishes the ID and rejects a mismatched canonical slug', async () => {
  const oldKey = process.env.BFMR_API_KEY; const oldSecret = process.env.BFMR_API_SECRET;
  process.env.BFMR_API_KEY = 'synthetic'; process.env.BFMR_API_SECRET = 'synthetic';
  try {
    const request = async (input: unknown) => { assert.equal(String(input), 'https://api.bfmr.com/api/v2/deals/canonical-slug'); return new Response(JSON.stringify({ deal: { deal_id: 'D99', slug: 'canonical-slug' } })); };
    assert.equal(await resolveBfmrDealId('https://www.bfmr.com/deals/canonical-slug', request as typeof fetch), 'D99');
    await assert.rejects(resolveBfmrDealId('https://www.bfmr.com/deals/canonical-slug', (async () => new Response(JSON.stringify({ deal: { deal_id: 'D99', slug: 'other' } }))) as typeof fetch), /authoritative/);
  } finally {
    if (oldKey === undefined) delete process.env.BFMR_API_KEY; else process.env.BFMR_API_KEY = oldKey;
    if (oldSecret === undefined) delete process.env.BFMR_API_SECRET; else process.env.BFMR_API_SECRET = oldSecret;
  }
});

test('durable Gmail queue resumes the old cursor and work, dedupes, and holds interrupted effects and history gaps', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bfmr-queue-test-'));
  try {
    const file = path.join(dir, 'queue.json'); let queue = gmailIntakeQueue(file);
    await assert.rejects(queue.initialize('test@example.org', '100'), /First setup/);
    await queue.initialize('test@example.org', '100', true);
    const email = { id: 'M1', sender, subject: 'New deal', body: 'synthetic', receivedAt: '2026-10-12T00:00:00Z', headers: auth() };
    await queue.ingest('100', '200', [email]);
    queue = gmailIntakeQueue(file);
    assert.equal((await queue.initialize('test@example.org', '999')).cursor, '200');
    assert.equal((await queue.load())!.work[0].email?.id, 'M1');
    await queue.ingest('200', '201', [email]);
    assert.equal((await queue.load())!.work.length, 1);
    await assert.rejects(queue.ingest('100', '300', []), /cursor changed/);
    assert.equal((await queue.load())!.cursor, '201');
    await queue.mark('M1', 'PROCESSING');
    await assert.rejects(gmailIntakeQueue(file).initialize('test@example.org', '999'), /interrupted/);
    await queue.mark('M1', 'DONE');
    assert.equal((await queue.load())!.work[0].email, undefined);
    await queue.save({ ...(await queue.load())!, gap: true });
    await assert.rejects(queue.initialize('test@example.org', '999'), /GMAIL_HISTORY_GAP/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('shared exposure lifecycle counts multi-quantity unpaid processed/package-received rows and ignores terminal history', () => {
  const current = { reserveId: 'R0', dealId: 'D0' };
  const rows = [{ reserve_id: 'R0', deal_id: 'D0', qty: 1, status: 'Reserved' },
    { reserve_id: 'R1', qty: 2, status: 'processed', payout_price: '40.00', amount_paid: '10.00' },
    { reserve_id: 'R2', qty: 1, status: 'pkg_received', expected_payout: '20.00' },
    { reserve_id: 'old', status: 'Closed' }, { reserve_id: 'old2', status: 'Paid' }];
  assert.equal(openBfmrExposureCents(rows, current), 9000);
  assert.throws(() => openBfmrExposureCents([...rows, { reserve_id: 'R3', status: 'unknown' }], current), /unrecognized/);
  assert.throws(() => openBfmrExposureCents([...rows, { reserve_id: 'R3', status: 'purchased', qty: 2, payout_price: 10, expected_payout: 10 }], current), /unambiguous/);
});

test('daily history retains missing reservations across days and preserves their paid transition', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bfmr-history-test-'));
  try {
    const store = bfmrStatusStore(path.join(dir, 'status.json')); const ledger = amazonOrderLedger(path.join(dir, 'orders.json'));
    let rows = [{ reserve_id: 'R1', deal_id: 'D1', qty: 1, status: 'Reserved' }];
    let day = 12;
    const options = { store, ledger, now: () => new Date(`2026-10-${day}T08:00:00Z`), readRows: async () => rows,
      hasIncomingMail: async () => false, notify: async () => {} };
    await runDueBfmrStatusCheck(options);
    rows = []; day++; await runDueBfmrStatusCheck(options);
    day++; await runDueBfmrStatusCheck(options);
    const missing = await store.load();
    assert.equal(missing!.reservations!.length, 1);
    assert.ok(missing!.reservations![0].missingSince);
    assert.equal(missing!.discrepancies!.find(item => item.detail.includes('previously open'))!.resolvedAt, null);
    rows = [{ reserve_id: 'R1', deal_id: 'D1', qty: 1, status: 'Paid' }]; day++; await runDueBfmrStatusCheck(options);
    const paid = await store.load();
    assert.equal(paid!.reservations![0].history.at(-1)!.status, 'paid');
    assert.equal(paid!.reservations![0].history[0].status, 'reserved');
    assert.equal(paid!.reservations![0].missingSince, null);
    assert.ok(paid!.discrepancies!.find(item => item.detail.includes('previously open'))!.resolvedAt);
    day++; rows = []; await runDueBfmrStatusCheck(options);
    assert.equal((await store.load())!.reservations![0].history.at(-1)!.status, 'paid');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('isolated transactions serialize rollback and hide uncommitted and mutable state', async () => {
  const db = new TransactionalDatabase();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let proceed!: () => void; const pending = new Promise<void>(resolve => { proceed = resolve; });
  const failed = db.withTransaction(async tx => { tx.setGate('uncommitted', 'test'); entered(); await pending; throw new Error('rollback'); });
  await started;
  assert.equal(db.getRuntimeGates().length, 0);
  const committed = db.withTransaction(async tx => { tx.setGate('committed', 'test'); });
  proceed(); await assert.rejects(failed, /rollback/); await committed;
  assert.deepEqual(db.getRuntimeGates().map(row => row.gate_name), ['committed']);
  db.getRuntimeGates()[0].reason = 'outside mutation';
  assert.equal(db.getRuntimeGates()[0].reason, 'test');
});

async function setupEngine() {
  const db = new TransactionalDatabase(); const gmail = new FakeGmailAdapter(); const tracker = new FakeMyTrackerAdapter();
  const browser = new FakeBrowserAdapter(); const telegram = new FakeTelegramAdapter();
  const engine = new BfmrOrchestrationEngine({ mode: 'testing', mailbox: 'test@example.org', accountId: 'account-test', telegramChatId: 'synthetic', configVersion: 'test' }, { gmail, tracker, browser, telegram }, db);
  await engine.startRun();
  return { db, gmail, tracker, browser, engine };
}
async function admit(context: Awaited<ReturnType<typeof setupEngine>>, suffix: string) {
  context.gmail.messagesQueue = [{ id: suffix, internalDate: Date.now(), sender, headers: auth(), subject: 'New Deal',
    body: `We posted a new deal. https://www.bfmr.com/deals/${suffix}`, inboxAtFetch: true }];
  return (await context.engine.consumeGmailHistory()).admittedCommands[0];
}
test('an acknowledged submission without exact tracker confirmation remains uncertain and is never retried', async () => {
  const context = await setupEngine(); const cmd = await admit(context, 'unconfirmed');
  const result = await context.engine.executeCommand(cmd.id);
  assert.equal(result.state, 'REVIEW'); assert.equal(result.attempts[0].result, 'UNCERTAIN');
  assert.equal(result.attempts[0].reservation_id, null);
  await context.engine.executeCommand(cmd.id); assert.equal(context.browser.submitCallCount, 1);
});
test('resolving one incident leaves other deal blocks intact', async () => {
  const context = await setupEngine();
  await context.engine.executeCommand((await admit(context, 'first')).id);
  await context.engine.executeCommand((await admit(context, 'second')).id);
  const incidents = context.db.getIncidents(); assert.equal(incidents.length, 2);
  await context.engine.resolveReviewIncident(incidents[0].id, 'authoritative manual disposition');
  const blocks = context.db.getDealBlocks();
  assert.ok(blocks.find(row => row.incident_id === incidents[0].id)!.resolved_at);
  assert.equal(blocks.find(row => row.incident_id === incidents[1].id)!.resolved_at, null);
});
test('dashboard starts without passing evidence and cannot simulate an acceptance pass', async () => {
  assert.ok(INITIAL_TESTS.every(row => row.status === 'PENDING' && !row.lastRun));
  assert.ok(MILESTONES.every(row => row.status !== 'COMPLETED'));
  assert.equal((await runAcceptanceTest('AT-05')).status, 'PENDING');
});
