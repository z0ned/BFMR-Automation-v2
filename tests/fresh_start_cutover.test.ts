import './helpers/offlineNetworkGuard';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRelationalFixture } from './helpers/relationalPglite';
import { prepareFreshStartCutover, type FreshStartPreparationOptions } from '../src/services/freshStartCutoverPreparation';
import { applyRelationalCutover, assertEmailSinceCutover, assertRelationalCutoverReady,
  parseRelationalCutoverManifest, readPrivateCutoverSources, reconcileRelationalCutover,
  type RelationalCutoverManifest } from '../src/services/relationalCutover';
import { prepareRelationalReservation } from '../src/services/relationalReservations';
import type { RelationalRuntime } from '../src/services/relationalRuntime';

// No provider or native/private database connection is permitted.
globalThis.fetch = async () => { throw new Error('OFFLINE_TEST_PROVIDER_FORBIDDEN'); };
const account = 'synthetic@example.invalid';
const startsAt = '2026-01-02T12:00:00.000Z';
const manifestHash = 'b'.repeat(64);
function manifest(): RelationalCutoverManifest {
  return { version: 2, account, approvedAt: startsAt, coverage: { sinceBaseline: true },
    baseline: { mode: 'START_FROM', startsAt, priorCompletedActivity: 'EXCLUDED', noOutstandingWork: true },
    legacyOrderLedgerSha256: null, excludedStandaloneOrderIds: [], reservations: [] };
}
function historical(): RelationalCutoverManifest {
  return { version: 1, account, approvedAt: startsAt,
    coverage: { allReservations: true, allOrders: true, actualPayments: true },
    legacyOrderLedgerSha256: null, excludedStandaloneOrderIds: [], reservations: [] };
}
async function fixture(t: TestContext) {
  const f = await createRelationalFixture();
  t.after(() => f.db.close());
  await f.embedded.exec(await fs.readFile(new URL('../database/gmail_intake.sql', import.meta.url), 'utf8'));
  await f.db.validateSchema();
  return f;
}
async function privateDirectory(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bfmr-fresh-synthetic-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const prepOptions = (directory: string): FreshStartPreparationOptions => ({ account, directory, confirmedNoOutstandingWork: true });
async function capture(f: Awaited<ReturnType<typeof fixture>>) {
  return f.db.withTransaction(async tx => {
    const deal = await tx.deals.upsert({ bfmrDealId: 'D101', slug: 'synthetic', title: 'Synthetic item', reimbursementAmountCents: 1000 });
    return tx.reservations.create({ bfmrReservationId: 'R1001', dealId: deal.id, quantity: 1, payoutPerItemCents: 1000 });
  });
}

test('fresh manifest explicitly excludes completed history without claiming historical coverage', () => {
  const checked = parseRelationalCutoverManifest(manifest());
  assert.equal(checked.version, 2);
  assert.deepEqual(checked.coverage, { sinceBaseline: true });
  assert.equal(checked.baseline?.priorCompletedActivity, 'EXCLUDED');
  assert.equal(checked.baseline?.startsAt, startsAt);
});

test('fresh manifest rejects missing assertions, contradictory coverage, future boundaries and historical imports', () => {
  const base = manifest();
  const invalid: unknown[] = [
    { ...base, version: 3 }, { ...base, baseline: undefined },
    { ...base, baseline: { ...base.baseline, noOutstandingWork: false } },
    { ...base, baseline: { ...base.baseline, priorCompletedActivity: 'IMPORTED' } },
    { ...base, baseline: { ...base.baseline, mode: 'RESET' } },
    { ...base, baseline: { ...base.baseline, startsAt: 'invalid' } },
    { ...base, baseline: { ...base.baseline, startsAt: '2026-01-03T00:00:00Z' } },
    { ...base, approvedAt: '2999-01-01T00:00:00Z' },
    { ...base, coverage: historical().coverage },
    { ...base, coverage: { sinceBaseline: true, allReservations: true } },
    { ...base, coverage: 'malformed' }, { ...base, coverage: null },
    { ...base, legacyOrderLedgerSha256: 'a'.repeat(64) },
    { ...base, excludedStandaloneOrderIds: ['synthetic-order'] },
    { ...base, reservations: [{}] },
  ];
  for (const candidate of invalid) assert.throws(() => parseRelationalCutoverManifest(candidate), /cutover|manifest/i);
});

test('historical manifests retain full coverage semantics and cannot acquire a fresh boundary', () => {
  assert.deepEqual(parseRelationalCutoverManifest(historical()), historical());
  for (const candidate of [
    { ...historical(), baseline: manifest().baseline },
    { ...historical(), coverage: { sinceBaseline: true } },
    { ...historical(), coverage: { ...historical().coverage, sinceBaseline: true } },
    { ...historical(), coverage: 'malformed' },
  ]) assert.throws(() => parseRelationalCutoverManifest(candidate), /Historical cutover/);
});

test('private preparation creates a restricted candidate, preserves rerun bytes/time and creates no replacement ledger', async t => {
  const directory = await privateDirectory(t);
  const first = await prepareFreshStartCutover(prepOptions(directory));
  const bytes = await fs.readFile(first.manifestPath);
  assert.equal((await fs.stat(first.manifestPath)).mode & 0o777, 0o600);
  assert.equal(first.manifest.account, account);
  assert.ok(Date.now() - Date.parse(first.manifest.baseline!.startsAt) < 10_000);
  const second = await prepareFreshStartCutover(prepOptions(directory));
  assert.deepEqual(second.manifest, first.manifest);
  assert.deepEqual(await fs.readFile(second.manifestPath), bytes);
  assert.deepEqual(await fs.readdir(directory), ['cutover-start-from.json']);
  const sources = await readPrivateCutoverSources(first.manifestPath, first.legacyFile);
  assert.equal(sources.manifestSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(sources.legacyOrders, []);
  await fs.writeFile(first.legacyFile, '[]');
  await assert.rejects(readPrivateCutoverSources(first.manifestPath, first.legacyFile), /changed or is missing/);
});

test('private preparation refuses each existing recovery file without overwriting it', async t => {
  const directory = await privateDirectory(t);
  for (const name of ['amazon-orders.json', 'gmail-intake.json', 'multi-deal.json',
    'startup-reservation.json', 'post-reservation.json', 'bfmr-status.json']) {
    const file = path.join(directory, name);
    await fs.writeFile(file, 'synthetic-recovery-state');
    await assert.rejects(prepareFreshStartCutover(prepOptions(directory)), /Existing private recovery state/);
    assert.equal(await fs.readFile(file, 'utf8'), 'synthetic-recovery-state');
    assert.deepEqual(await fs.readdir(directory), [name]);
    await fs.unlink(file);
  }
});

test('an override cannot conceal default recovery state, and existing override state also stops preparation', async t => {
  const directory = await privateDirectory(t);
  const override = path.join(directory, 'alternate.json');
  const defaults = path.join(directory, 'amazon-orders.json');
  const options = { ...prepOptions(directory), stateOverrides: { BFMR_AMAZON_ORDER_LEDGER_PATH: override } };
  await fs.writeFile(defaults, 'synthetic-default');
  await assert.rejects(prepareFreshStartCutover(options), /Existing private recovery state/);
  await fs.unlink(defaults);
  await fs.writeFile(override, 'synthetic-override');
  await assert.rejects(prepareFreshStartCutover(options), /Existing private recovery state/);
  assert.equal(await fs.readFile(override, 'utf8'), 'synthetic-override');
});

test('private preparation refuses missing confirmation and invalid paths without creating a candidate', async t => {
  const directory = await privateDirectory(t);
  for (const options of [
    { ...prepOptions(directory), confirmedNoOutstandingWork: false },
    { ...prepOptions(directory), account: '' },
    { ...prepOptions(directory), directory: 'relative-directory' },
    { ...prepOptions(directory), stateOverrides: { BFMR_GMAIL_QUEUE_PATH: 'relative-queue' } },
  ]) await assert.rejects(prepareFreshStartCutover(options), /requires|absolute/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('corrupt or conflicting candidates remain unchanged instead of being regenerated', async t => {
  const directory = await privateDirectory(t);
  const file = path.join(directory, 'cutover-start-from.json');
  for (const contents of ['not-json', JSON.stringify(historical()), JSON.stringify({ ...manifest(), account: 'other@example.invalid' })]) {
    await fs.writeFile(file, contents);
    await assert.rejects(prepareFreshStartCutover(prepOptions(directory)));
    assert.equal(await fs.readFile(file, 'utf8'), contents);
  }
});

test('uninspectable or dangling recovery paths stop preparation instead of proving absence', async t => {
  const directory = await privateDirectory(t);
  const blocker = path.join(directory, 'synthetic-parent-file');
  await fs.writeFile(blocker, 'synthetic');
  await assert.rejects(prepareFreshStartCutover({ ...prepOptions(directory),
    stateOverrides: { BFMR_GMAIL_QUEUE_PATH: path.join(blocker, 'queue.json') }
  }), /could not be inspected/);
  const link = path.join(directory, 'gmail-intake.json');
  await fs.symlink(path.join(directory, 'absent-target'), link);
  await assert.rejects(prepareFreshStartCutover(prepOptions(directory)), /Existing private recovery state/);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test('fresh report is read-only; explicit apply records one scoped marker and imports no business records', async t => {
  const f = await fixture(t);
  const input = manifest();
  const report = await reconcileRelationalCutover(f.db, input, []);
  assert.equal(report.ready, true);
  assert.deepEqual(report.baseline, input.baseline);
  assert.equal((await f.query('SELECT id FROM public.workflow_evidence')).rows.length, 0);
  await assert.rejects(assertRelationalCutoverReady(f.db, { account, legacyOrderLedgerSha256: null }), /not accepted/);
  await applyRelationalCutover(f.db, { manifest: input, manifestSha256: manifestHash, legacyOrders: [] });
  assert.equal(await assertRelationalCutoverReady(f.db, { account, legacyOrderLedgerSha256: null }), startsAt);
  const marker = (await f.query<{ evidence: Record<string, unknown> }>("SELECT evidence FROM public.workflow_evidence WHERE outcome='ACCEPTED'")).rows[0].evidence;
  assert.equal(marker.version, 2);
  assert.deepEqual(marker.baseline, input.baseline);
  assert.equal(marker.manifestSha256, manifestHash);
  assert.equal(marker.reservationCount, 0);
  for (const table of ['reservations', 'orders', 'shipments', 'reimbursements', 'gmail_intake_state']) {
    assert.equal((await f.query(`SELECT 1 FROM public.${table}`)).rows.length, 0);
  }
  await applyRelationalCutover(f.db, { manifest: input, manifestSha256: manifestHash, legacyOrders: [] });
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE outcome='ACCEPTED'")).rows.length, 1);
  await assert.rejects(assertRelationalCutoverReady(f.db, { account: 'other@example.invalid', legacyOrderLedgerSha256: null }), /not accepted/);
  await assert.rejects(assertRelationalCutoverReady(f.db, { account, legacyOrderLedgerSha256: 'a'.repeat(64) }), /not accepted/);
});

test('fresh cutover refuses existing business records and retains their original identity', async t => {
  const f = await fixture(t);
  const saved = await capture(f);
  const report = await reconcileRelationalCutover(f.db, manifest(), []);
  assert.equal(report.ready, false);
  assert.ok(report.issues.some(issue => /existing database reservation/i.test(issue)));
  await assert.rejects(applyRelationalCutover(f.db, { manifest: manifest(), manifestSha256: manifestHash, legacyOrders: [] }), /no authoritative import/);
  assert.equal((await f.query('SELECT id FROM public.reservations')).rows[0].id, saved.id);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE outcome='ACCEPTED'")).rows.length, 0);
});

test('fresh cutover refuses existing SQL Gmail state without resetting its cursor', async t => {
  const f = await fixture(t);
  await f.query(`INSERT INTO public.gmail_intake_state(account_namespace,mailbox,subscription,topic,consumed_cursor,history_gap)
    VALUES($1,$1,'projects/synthetic/subscriptions/test','projects/synthetic/topics/test','123',true)`, [account]);
  await f.query(`INSERT INTO public.gmail_intake_work(account_namespace,gmail_message_id,state,payload,payload_sha256,received_at)
    VALUES($1,'synthetic-mail','PROCESSING',$2::jsonb,$3,$4)`, [account, JSON.stringify({ id: 'synthetic-mail',
    sender: account, subject: 'Synthetic', body: 'Synthetic', receivedAt: startsAt }), 'a'.repeat(64), startsAt]);
  const report = await reconcileRelationalCutover(f.db, manifest(), []);
  assert.equal(report.ready, false);
  assert.ok(report.issues.some(issue => /Existing SQL Gmail state/.test(issue)));
  await assert.rejects(applyRelationalCutover(f.db, { manifest: manifest(), manifestSha256: manifestHash, legacyOrders: [] }), /no authoritative import/);
  assert.deepEqual((await f.query('SELECT consumed_cursor,history_gap FROM public.gmail_intake_state')).rows,
    [{ consumed_cursor: '123', history_gap: true }]);
  assert.deepEqual((await f.query('SELECT gmail_message_id,state FROM public.gmail_intake_work')).rows,
    [{ gmail_message_id: 'synthetic-mail', state: 'PROCESSING' }]);
});

test('a historical accepted marker retains its meaning and prevents a fresh-start replacement', async t => {
  const f = await fixture(t);
  await applyRelationalCutover(f.db, { manifest: historical(), manifestSha256: manifestHash, legacyOrders: [] });
  assert.equal(await assertRelationalCutoverReady(f.db, { account, legacyOrderLedgerSha256: null }), null);
  assert.equal((await reconcileRelationalCutover(f.db, manifest(), [])).ready, false);
  await assert.rejects(applyRelationalCutover(f.db, { manifest: manifest(), manifestSha256: manifestHash, legacyOrders: [] }), /no authoritative import/);
  assert.equal(await assertRelationalCutoverReady(f.db, { account, legacyOrderLedgerSha256: null }), null);
});

test('duplicate accepted markers stop startup and fresh report rather than choosing an arbitrary marker', async t => {
  const f = await fixture(t);
  await applyRelationalCutover(f.db, { manifest: manifest(), manifestSha256: manifestHash, legacyOrders: [] });
  await f.query(`INSERT INTO public.workflow_evidence(correlation_id,action_type,phase,outcome,evidence)
    SELECT '00000000-0000-4000-8000-000000000002',action_type,phase,outcome,evidence
    FROM public.workflow_evidence WHERE outcome='ACCEPTED'`);
  await assert.rejects(assertRelationalCutoverReady(f.db, { account, legacyOrderLedgerSha256: null }), /not accepted/);
  assert.equal((await reconcileRelationalCutover(f.db, manifest(), [])).ready, false);
});

test('an accepted boundary cannot be moved or replaced by a historical declaration', async t => {
  const f = await fixture(t);
  const input = manifest();
  await applyRelationalCutover(f.db, { manifest: input, manifestSha256: manifestHash, legacyOrders: [] });
  const changed = { ...input, baseline: { ...input.baseline!, startsAt: '2026-01-01T00:00:00Z' } };
  assert.equal((await reconcileRelationalCutover(f.db, changed, [])).ready, false);
  for (const candidate of [changed, historical()]) {
    await assert.rejects(applyRelationalCutover(f.db, { manifest: candidate, manifestSha256: manifestHash, legacyOrders: [] }), /no authoritative import/);
  }
  assert.equal(await assertRelationalCutoverReady(f.db, { account, legacyOrderLedgerSha256: null }), startsAt);
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE outcome='ACCEPTED'")).rows.length, 1);
});

test('startup rejects malformed accepted-boundary evidence rather than falling back to history mode', async t => {
  for (const changes of [
    { version: '2' }, { baseline: null },
    { baseline: { ...manifest().baseline, noOutstandingWork: false } },
    { baseline: { ...manifest().baseline, startsAt: 'invalid' } },
    { baseline: { ...manifest().baseline, priorCompletedActivity: 'IMPORTED' } },
    { approvedAt: '2999-01-01T00:00:00Z' },
    { version: 1 },
  ]) {
    const f = await fixture(t);
    const evidence = { version: 2, account, approvedAt: startsAt, manifestSha256: manifestHash,
      legacyOrderLedgerSha256: null, baseline: manifest().baseline, ...changes };
    await f.query(`INSERT INTO public.workflow_evidence(correlation_id,action_type,phase,outcome,evidence)
      VALUES('00000000-0000-4000-8000-000000000001','RELATIONAL_CUTOVER','CONFIRMED','ACCEPTED',$1::jsonb)`, [JSON.stringify(evidence)]);
    await assert.rejects(assertRelationalCutoverReady(f.db, { account, legacyOrderLedgerSha256: null }), /boundary is invalid|not accepted/);
  }
});

test('ownership loss cannot produce a fresh report or acceptance marker', async t => {
  const f = await fixture(t);
  f.loseOwnership();
  await assert.rejects(reconcileRelationalCutover(f.db, manifest(), []), /ownership was lost/);
  await assert.rejects(applyRelationalCutover(f.db, { manifest: manifest(), manifestSha256: manifestHash, legacyOrders: [] }));
  assert.equal((await f.query("SELECT id FROM public.workflow_evidence WHERE outcome='ACCEPTED'")).rows.length, 0);
});

test('receipt-time guard accepts equality and later instants; rejects old, missing and invalid times', () => {
  for (const value of [startsAt, '2026-01-03T00:00:00Z', '2026-01-02T07:00:00-05:00']) {
    assert.doesNotThrow(() => assertEmailSinceCutover(startsAt, value));
  }
  for (const value of ['2026-01-02T11:59:59.999Z', '', 'invalid', '2026-01-02']) {
    assert.throws(() => assertEmailSinceCutover(startsAt, value), /predates.*boundary|invalid timestamp/);
  }
  assert.doesNotThrow(() => assertEmailSinceCutover(null, 'legacy receipt handling is unchanged'));
});

test('old email is blocked at reservation preparation before provider reads, account checks or intent writes', async () => {
  let accountChecks = 0;
  const runtime = { baselineStartsAt: startsAt,
    async verifyRetailerAccount() { accountChecks++; throw new Error('Must not reach account/provider work.'); }
  } as unknown as RelationalRuntime;
  await assert.rejects(prepareRelationalReservation(runtime, {
    dealUrl: 'https://www.bfmr.com/deals/synthetic', dealId: 'D101', title: 'Synthetic item',
    email: { id: 'synthetic-old', subject: 'Synthetic', emailType: 'NEW_DEAL', receivedAt: '2026-01-01T00:00:00Z' },
  }), /predates.*boundary/);
  assert.equal(accountChecks, 0);
});
