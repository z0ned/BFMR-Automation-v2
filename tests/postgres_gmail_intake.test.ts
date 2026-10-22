import './helpers/offlineNetworkGuard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GmailQueueState, QueuedEmail } from '../src/services/gmailIntakeQueue';
import { validateLegacyGmailQueue } from '../src/services/postgresGmailIntake';
import { createGmailIntakeFixture } from './helpers/gmailIntakePglite';

const payloadHash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const watch = (historyId = '100') => ({ historyId, expirationMs: Date.now() + 7 * 86400000 });
const email = (id = 'm1', disposition: 'ADMITTED' | 'IGNORED' = 'ADMITTED'): QueuedEmail => ({
  id, sender: 'synthetic@example.org', subject: 'Synthetic offer', body: 'Synthetic body only',
  receivedAt: '2026-10-21T12:00:00.000Z', inboxAtFetch: true,
  headers: [{ name: 'From', value: 'synthetic@example.org' }], intakeDisposition: disposition,
});
const notification = (messageId = 'n1', historyId = '110') => ({
  messageId, payloadSha256: payloadHash, historyId, rejection: null,
});
async function active(fixture: Awaited<ReturnType<typeof createGmailIntakeFixture>>) {
  await fixture.store.validateSchema();
  const run = await fixture.store.startRun();
  await fixture.store.setWatch(run, watch(), true);
  await fixture.store.activate(run);
  return run;
}

test('installed operational schema validates read-only and tampered checks or missing uniqueness fail closed', async () => {
  const f = await createGmailIntakeFixture();
  await f.store.validateSchema();
  assert.equal(f.statements.some(sql => /^\s*(?:CREATE|ALTER|INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i.test(sql)), false);
  await f.query('ALTER TABLE gmail_intake_work DROP CONSTRAINT gmail_intake_work_state_ck');
  await f.query('ALTER TABLE gmail_intake_work ADD CONSTRAINT gmail_intake_work_state_ck CHECK (true)');
  await assert.rejects(f.store.validateSchema(), /GMAIL_INTAKE_SCHEMA_CHECKS_INVALID/);
  const g = await createGmailIntakeFixture();
  await g.query('DROP INDEX gmail_intake_one_live_run_idx');
  await assert.rejects(g.store.validateSchema(), /GMAIL_INTAKE_SCHEMA_RUN_INDEX_INVALID/);
});

test('first initialization is explicit and watch renewal keeps consumed history independent', async () => {
  const f = await createGmailIntakeFixture();
  await f.store.validateSchema();
  const run = await f.store.startRun();
  await assert.rejects(f.store.setWatch(run, watch(), false), /EXPLICIT_FIRST_INITIALIZATION_REQUIRED/);
  assert.equal(await f.store.load(), null);
  await f.store.setWatch(run, watch(), true);
  await f.store.activate(run);
  await f.store.ingest('100', '110', [], []);
  await f.store.setWatch(run, watch('900'), false);
  assert.equal((await f.store.load())?.cursor, '110');
  const row = (await f.query('SELECT consumed_cursor,watch_baseline,watch_expires_at,watch_renewed_at FROM gmail_intake_state')).rows[0];
  assert.equal(row.consumed_cursor, '110');
  assert.equal(row.watch_baseline, '900');
  assert.ok(row.watch_expires_at > row.watch_renewed_at);
  assert.ok((await f.store.watchState())!.expirationMs > Date.now());
});

test('activation is a durable notification barrier and restart retires the prior run without deleting evidence', async () => {
  const f = await createGmailIntakeFixture();
  await f.store.validateSchema();
  const first = await f.store.startRun();
  await assert.rejects(f.store.recordNotification(first, notification()), /RUN_NOT_ACTIVE/);
  await assert.rejects(f.store.activate(first), /ACTIVATION_NOT_READY/);
  await f.store.setWatch(first, watch(), true);
  await f.store.activate(first);
  await f.store.recordNotification(first, notification());
  const second = await f.store.startRun();
  assert.notEqual(first, second);
  await assert.rejects(f.store.recordNotification(first, notification('n2')), /RUN_NOT_ACTIVE/);
  const rows = (await f.query('SELECT id,state FROM gmail_intake_runs ORDER BY started_at,id')).rows;
  assert.equal(rows.find(row => row.id === first)?.state, 'STOPPED');
  assert.equal(rows.find(row => row.id === second)?.state, 'STARTING');
  assert.deepEqual(await f.store.pendingNotifications(), [{ messageId: 'n1', historyId: '110' }]);
});

test('notification duplicates are idempotent and changed identities or poison evidence cannot overwrite them', async () => {
  const f = await createGmailIntakeFixture(); const run = await active(f);
  await f.store.recordNotification(run, notification());
  await f.store.recordNotification(run, notification());
  await assert.rejects(f.store.recordNotification(run, { ...notification(), payloadSha256: otherHash }), /NOTIFICATION_IDENTITY_CONFLICT/);
  await assert.rejects(f.store.recordNotification(run, { ...notification(), historyId: '111' }), /NOTIFICATION_IDENTITY_CONFLICT/);
  const poison = { messageId: 'bad1', payloadSha256: otherHash, historyId: null, rejection: 'WRONG_MAILBOX' };
  await f.store.recordNotification(run, poison);
  await f.store.recordNotification(run, poison);
  await assert.rejects(f.store.recordNotification(run, { ...poison, rejection: 'MALFORMED_PAYLOAD' }), /NOTIFICATION_IDENTITY_CONFLICT/);
  const rows = (await f.query('SELECT message_id,state,rejection FROM gmail_intake_notifications ORDER BY message_id')).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.message_id === 'bad1')?.state, 'REJECTED');
  assert.deepEqual(await f.store.pendingNotifications(), [{ messageId: 'n1', historyId: '110' }]);
});

test('message admission, ignored tombstones, notification consumption and cursor commit together', async () => {
  const f = await createGmailIntakeFixture(); const run = await active(f);
  await f.store.recordNotification(run, notification());
  await f.store.ingest('100', '110', [email('m1'), email('m2', 'IGNORED')], ['n1']);
  const state = (await f.store.load())!;
  assert.equal(state.cursor, '110');
  assert.deepEqual(state.work.map(item => [item.id, item.state]), [['m1', 'PENDING'], ['m2', 'DONE']]);
  assert.equal(state.work[1].email, undefined);
  assert.equal(state.work[0].email?.body, 'Synthetic body only');
  assert.deepEqual(await f.store.pendingNotifications(), []);
  const ignored = (await f.query('SELECT payload,payload_sha256 FROM gmail_intake_work WHERE gmail_message_id=$1', ['m2'])).rows[0];
  assert.equal(ignored.payload, null);
  assert.match(ignored.payload_sha256, /^[0-9a-f]{64}$/);
});

test('an uncovered notification rolls back message inserts and preserves cursor and notification state', async () => {
  const f = await createGmailIntakeFixture(); const run = await active(f);
  await f.store.recordNotification(run, notification('n1', '200'));
  await assert.rejects(f.store.ingest('100', '110', [email()], ['n1']), /NOTIFICATION_COVERAGE_INCOMPLETE/);
  assert.equal((await f.store.load())?.cursor, '100');
  assert.deepEqual((await f.store.load())?.work, []);
  assert.deepEqual(await f.store.pendingNotifications(), [{ messageId: 'n1', historyId: '200' }]);
});

test('storage failure during commit batch rolls back all three effects with sanitized diagnostics', async () => {
  const f = await createGmailIntakeFixture(); const run = await active(f);
  await f.store.recordNotification(run, notification());
  f.setFault(sql => { if (/UPDATE public\.gmail_intake_state SET consumed_cursor/.test(sql)) throw Error('PRIVATE PROVIDER BODY'); });
  await assert.rejects(f.store.ingest('100', '110', [email()], ['n1']), error => {
    assert.match(String(error), /STORAGE_FAILURE_RECONCILE_BEFORE_RETRY/);
    assert.equal(String(error).includes('PRIVATE'), false); return true;
  });
  f.setFault();
  assert.equal((await f.store.load())?.cursor, '100');
  assert.deepEqual((await f.store.load())?.work, []);
  assert.equal((await f.store.pendingNotifications()).length, 1);
});

test('ownership loss before commit rolls back admission and never advances the cursor', async () => {
  const f = await createGmailIntakeFixture(); await active(f);
  f.setFault(sql => { if (/UPDATE public\.gmail_intake_state SET consumed_cursor/.test(sql)) f.loseOwnership(); });
  await assert.rejects(f.store.ingest('100', '110', [email()], []), /STORAGE_FAILURE_RECONCILE_BEFORE_RETRY/);
  f.setFault(); f.restoreOwnership();
  assert.equal((await f.store.load())?.cursor, '100');
  assert.deepEqual((await f.store.load())?.work, []);
});

test('exact message repeats are idempotent while changed bodies or dispositions reject without partial advancement', async () => {
  const f = await createGmailIntakeFixture(); await active(f);
  await f.store.ingest('100', '110', [email()], []);
  await f.store.ingest('110', '120', [email()], []);
  assert.equal((await f.store.load())?.work.length, 1);
  await assert.rejects(f.store.ingest('120', '130', [{ ...email(), body: 'changed' }], []), /EMAIL_IDENTITY_CONFLICT/);
  await assert.rejects(f.store.ingest('120', '130', [email('m1', 'IGNORED')], []), /EMAIL_IDENTITY_CONFLICT/);
  await assert.rejects(f.store.ingest('110', '130', [], []), /CURSOR_CONFLICT/);
  await assert.rejects(f.store.ingest('120', '119', [], []), /BATCH_INVALID/);
  assert.equal((await f.store.load())?.cursor, '120');
});

test('interrupted PROCESSING work stays blocked for the browser while new intake can spool after restart', async () => {
  const f = await createGmailIntakeFixture(); const first = await active(f);
  await f.store.ingest('100', '110', [email()], []);
  await f.store.mark('m1', 'PROCESSING');
  const second = await f.store.startRun();
  await f.store.setWatch(second, watch('500'), false);
  await f.store.activate(second);
  await f.store.recordNotification(second, notification('n2', '120'));
  await f.store.ingest('110', '120', [email('m2')], ['n2']);
  assert.deepEqual((await f.store.load())?.work.map(item => [item.id, item.state]), [['m1', 'PROCESSING'], ['m2', 'PENDING']]);
  await assert.rejects(f.store.mark('m1', 'PROCESSING'), /TRANSITION_INVALID/);
  await f.store.stopRun(second); await f.store.stopRun(second);
  await assert.rejects(f.store.recordNotification(first, notification('n3')), /RUN_NOT_ACTIVE/);
});

test('a persisted history gap survives restart and refuses initialization, renewal and further work', async () => {
  const f = await createGmailIntakeFixture(); const run = await active(f);
  await f.store.ingest('100', '110', [email()], []);
  await f.store.markGap();
  const saved = (await f.store.load())!;
  assert.equal(saved.gap, true); assert.equal(saved.cursor, '110'); assert.equal(saved.work.length, 1);
  await assert.rejects(f.store.startRun(), /GMAIL_HISTORY_GAP/);
  await assert.rejects(f.store.setWatch(run, watch('900'), true), /GMAIL_HISTORY_GAP/);
  await assert.rejects(f.store.ingest('110', '120', [email('m2')], []), /CURSOR_CONFLICT/);
  assert.equal((await f.store.load())?.cursor, '110');
});

test('legacy report is read-only and accepted repeated imports preserve cursor advancement and tombstones', async () => {
  const f = await createGmailIntakeFixture(); await f.store.validateSchema();
  const legacy: GmailQueueState = { mailbox: f.options.mailbox, cursor: '40', gap: false,
    work: [{ id: 'old1', state: 'DONE' }, { id: 'm1', state: 'PENDING', email: email() }] };
  assert.deepEqual(await f.store.assessLegacyImport(legacy, payloadHash), { ready: true, alreadyAccepted: false });
  assert.equal((await f.query('SELECT count(*)::integer AS n FROM gmail_intake_state')).rows[0].n, 0);
  await f.store.importLegacy(legacy, payloadHash);
  const run = await f.store.startRun(); await f.store.setWatch(run, watch('100'), false); await f.store.activate(run);
  await f.store.mark('m1', 'PROCESSING'); await f.store.mark('m1', 'DONE');
  await f.store.ingest('40', '110', [email('m2')], []);
  const before = await f.store.load();
  assert.deepEqual(await f.store.assessLegacyImport(legacy, payloadHash), { ready: true, alreadyAccepted: true });
  await f.store.importLegacy(legacy, payloadHash);
  assert.deepEqual(await f.store.load(), before);
  assert.equal(await f.store.legacySourceHash(), payloadHash);
  assert.deepEqual(await f.store.assessLegacyImport(legacy, otherHash), { ready: false, alreadyAccepted: false });
  await assert.rejects(f.store.importLegacy(legacy, otherHash), /LEGACY_IMPORT_CONFLICT/);
});

test('legacy import refuses unsafe state or live uninitialized namespaces and validates exact account scope', async () => {
  const f = await createGmailIntakeFixture(); await f.store.validateSchema();
  const legacy: GmailQueueState = { mailbox: f.options.mailbox, cursor: '40', gap: false, work: [] };
  assert.throws(() => validateLegacyGmailQueue({ ...legacy, gap: true }, f.options.mailbox), /LEGACY_RECONCILIATION_REQUIRED/);
  assert.throws(() => validateLegacyGmailQueue({ ...legacy, work: [{ id: 'm1', state: 'PROCESSING', email: email() }] }, f.options.mailbox), /LEGACY_RECONCILIATION_REQUIRED/);
  await f.store.startRun();
  assert.deepEqual(await f.store.assessLegacyImport(legacy, payloadHash), { ready: false, alreadyAccepted: false });
  await assert.rejects(f.store.importLegacy(legacy, payloadHash), /LEGACY_IMPORT_CONFLICT/);
  const other = f.createStore({ mailbox: 'other@example.org' }); await other.validateSchema();
  await assert.rejects(other.load(), /SCOPE_CONFLICT/);
});

test('shutdown closes the pool once and rejects subsequent callbacks without additional SQL', async () => {
  const f = await createGmailIntakeFixture(); const run = await active(f);
  await Promise.all([f.store.close(), f.store.close()]);
  assert.equal(f.poolEndCalls(), 1);
  const prior = f.statements.length;
  await assert.rejects(f.store.recordNotification(run, notification()), /STORAGE_UNAVAILABLE/);
  await assert.rejects(f.store.load(), /STORAGE_UNAVAILABLE/);
  assert.equal(f.statements.length, prior);
});
