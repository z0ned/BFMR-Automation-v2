import './helpers/offlineNetworkGuard';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { GmailQueueState, QueuedEmail } from '../src/services/gmailIntakeQueue';
import type { GmailNotificationEvidence } from '../src/services/postgresGmailIntake';
import { ProductionGmailIntake, assertLegacyGmailSource,
  type ProductionGmailIntakeStore } from '../src/services/productionGmailIntake';
import { GmailHistoryGapError, GmailReadRetryableError,
  type GmailPushProvider, type GmailPushSubscription, type PubSubDelivery } from '../src/services/gmailPushTransport';

const mailbox = 'offline@example.invalid';
const topic = 'projects/offline/topics/mail';
const email = (id: string): QueuedEmail => ({ id, sender: 'sender@example.invalid', subject: 'Synthetic',
  body: 'Synthetic body', receivedAt: '2026-10-22T00:00:00.000Z', inboxAtFetch: true });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i += 1) { if (check()) return; await setImmediate(); }
  assert.fail(`Offline fixture did not reach ${label}`);
}

/** Protocol fake only. Actual SQL constraints, transactions and recovery have a
 * separate embedded-PostgreSQL suite; this fake exposes controlled commit gates.
 */
class Store implements ProductionGmailIntakeStore {
  state: GmailQueueState | null = { mailbox, cursor: '100', gap: false, work: [] };
  events: string[] = [];
  notifications = new Map<string, GmailNotificationEvidence>();
  recordGate: Promise<void> = Promise.resolve();
  activateGate: Promise<void> = Promise.resolve();
  recordFailure = false;
  active = false;
  runs = 0;
  async validateSchema() { this.events.push('schema'); }
  async load() { return structuredClone(this.state); }
  async startRun() { this.events.push('run'); this.active = false; return `run-${++this.runs}`; }
  async setWatch(_id: string, watch: { historyId: string; expirationMs: number }, initialize: boolean) {
    this.events.push(`watch:${watch.historyId}`);
    if (!this.state) {
      assert.equal(initialize, true);
      this.state = { mailbox, cursor: watch.historyId, gap: false, work: [] };
    }
    return structuredClone(this.state);
  }
  async activate() { this.events.push('activating'); await this.activateGate; this.active = true; this.events.push('active'); }
  async recordNotification(_id: string, item: GmailNotificationEvidence) {
    this.events.push(`recording:${item.messageId}`);
    assert.equal(this.active, true);
    await this.recordGate;
    if (this.recordFailure) throw new Error('Synthetic database commit failure');
    const existing = this.notifications.get(item.messageId);
    if (existing) assert.deepEqual(item, existing);
    else this.notifications.set(item.messageId, structuredClone(item));
    this.events.push(`committed:${item.messageId}`);
  }
  async pendingNotifications() {
    return [...this.notifications.values()].filter(n => !n.rejection)
      .slice(0, 1000).map(n => ({ messageId: n.messageId, historyId: n.historyId! }));
  }
  async ingest(from: string, cursor: string, emails: QueuedEmail[], ids: string[]) {
    assert.equal(this.state!.cursor, from);
    for (const item of emails) if (!this.state!.work.some(work => work.id === item.id)) {
      this.state!.work.push(item.intakeDisposition === 'IGNORED' ? { id: item.id, state: 'DONE' }
        : { id: item.id, state: 'PENDING', email: structuredClone(item) });
    }
    this.state!.cursor = cursor;
    for (const id of ids) this.notifications.delete(id);
    this.events.push(`ingest:${from}:${cursor}`);
  }
  async markGap() { this.state!.gap = true; this.events.push('gap'); }
  async mark(id: string, state: 'PROCESSING' | 'DONE') {
    const item = this.state!.work.find(work => work.id === id)!;
    item.state = state;
    if (state === 'DONE') delete item.email;
    this.events.push(`${id}:${state}`);
  }
  async stopRun() { this.active = false; this.events.push('stopped'); }
}

function fixture(t: TestContext, store = new Store()) {
  let receive!: (delivery: PubSubDelivery) => void;
  let reconnect!: () => void;
  let fatal!: (error: Error) => void;
  const failures: Error[] = [];
  const reads: { cursor: string; known: string[] }[] = [];
  let owned = true;
  let onStart = () => {};
  const provider: GmailPushProvider = {
    async getProfile() { store.events.push('profile'); return { mailbox, historyId: '900' }; },
    async watch() { store.events.push('provider-watch'); return { historyId: '900', expirationMs: Date.now() + 7 * 86400000 }; },
    async historySince(cursor, known) { reads.push({ cursor, known: [...known] }); return { cursor, emails: [] }; },
    async close() { store.events.push('provider-close'); },
  };
  const subscription: GmailPushSubscription = {
    async validate() { store.events.push('subscription-validate'); },
    async start(onMessage, onReconnect, onFatal) {
      receive = onMessage; reconnect = onReconnect; fatal = onFatal;
      store.events.push('stream-start'); onStart();
    },
    async close() { store.events.push('stream-close'); },
  };
  let admit: (item: QueuedEmail) => boolean = () => true;
  const intake = new ProductionGmailIntake({ mailbox, topic, store, provider, subscription,
    verifyOwnership: async () => { if (!owned) throw new Error('Synthetic lost ownership'); },
    admit: item => admit(item), onFailure: async error => { failures.push(error); } });
  t.after(() => intake.stop());
  const makeDelivery = (id: string, value: unknown = { emailAddress: mailbox, historyId: '200' }) => {
    let acks = 0; let nacks = 0;
    const data = typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
    const delivery: PubSubDelivery = { id, data,
      async ack() { acks++; store.events.push(`ack:${id}`); },
      async nack() { nacks++; store.events.push(`nack:${id}`); } };
    return { delivery, get acks() { return acks; }, get nacks() { return nacks; } };
  };
  return { intake, store, provider, subscription, failures, reads, makeDelivery,
    deliver: (item: PubSubDelivery) => receive(item), reconnect: () => reconnect(), fatal: () => fatal(new Error('Synthetic fatal')),
    onStart(fn: () => void) { onStart = fn; }, loseOwnership() { owned = false; },
    admit(fn: (item: QueuedEmail) => boolean) { admit = fn; } };
}

test('startup validates identity and activation before saved-history continuation; watch never replaces cursor', async t => {
  const f = fixture(t);
  await f.intake.start();
  assert.deepEqual(f.reads, [{ cursor: '100', known: [] }]);
  assert.equal(f.store.state!.cursor, '100');
  const events = f.store.events;
  for (const [before, after] of [['schema', 'profile'], ['subscription-validate', 'run'],
    ['watch:900', 'stream-start'], ['stream-start', 'active']]) assert.ok(events.indexOf(before) < events.indexOf(after));
  await assert.rejects(f.intake.start(), /cannot be started twice/);
});

test('missing prior state stops before Gmail; explicit first initialization starts at watch baseline', async t => {
  const missing = new Store(); missing.state = null;
  const f = fixture(t, missing);
  await assert.rejects(f.intake.start(), /startup failed/);
  assert.ok(!missing.events.includes('profile'));
  const fresh = new Store(); fresh.state = null;
  const initialized = fixture(t, fresh);
  await initialized.intake.start(true);
  assert.equal(fresh.state!.cursor, '900');
  assert.equal(initialized.reads[0].cursor, '900');
});

test('mailbox mismatch fails before watch, StreamingPull and activation', async t => {
  const f = fixture(t);
  f.provider.getProfile = async () => ({ mailbox: 'different@example.invalid', historyId: '900' });
  await assert.rejects(f.intake.start(), /startup failed/);
  assert.ok(!f.store.events.includes('provider-watch'));
  assert.ok(!f.store.events.includes('active'));
  assert.equal(f.failures.length, 1);
});

test('callbacks delivered during startup stay buffered until ACTIVE commits', async t => {
  const f = fixture(t); const active = deferred(); f.store.activateGate = active.promise;
  const item = f.makeDelivery('during-start', { emailAddress: mailbox, historyId: '100' });
  f.onStart(() => f.deliver(item.delivery));
  const started = f.intake.start();
  await until(() => f.store.events.includes('activating'));
  assert.equal(item.acks, 0);
  assert.ok(!f.store.events.includes('recording:during-start'));
  active.resolve(); await started;
  await until(() => item.acks === 1);
  assert.ok(f.store.events.indexOf('active') < f.store.events.indexOf('committed:during-start'));
});

test('failed activation NACKs buffered callbacks without admitting or ACKing them', async t => {
  const f = fixture(t);
  f.store.activate = async () => { throw new Error('Synthetic activation commit failure'); };
  const item = f.makeDelivery('activation-failure');
  f.onStart(() => f.deliver(item.delivery));
  await assert.rejects(f.intake.start(), /startup failed/);
  assert.equal(item.nacks, 1); assert.equal(item.acks, 0);
  assert.equal(f.store.notifications.size, 0); assert.equal(f.reads.length, 0);
});

test('ACK waits for committed persistence, independently of the browser consumer', async t => {
  const f = fixture(t); await f.intake.start();
  const commit = deferred(); f.store.recordGate = commit.promise;
  f.provider.historySince = async cursor => { f.reads.push({ cursor, known: [] }); return { cursor: '200', emails: [email('new-mail')] }; };
  const item = f.makeDelivery('commit-barrier'); f.deliver(item.delivery);
  await until(() => f.store.events.includes('recording:commit-barrier'));
  assert.equal(item.acks, 0); assert.equal(f.store.notifications.size, 0);
  commit.resolve();
  await until(() => f.store.state!.cursor === '200');
  assert.equal(item.acks, 1); assert.equal(item.nacks, 0);
  assert.ok(f.store.events.indexOf('committed:commit-barrier') < f.store.events.indexOf('ack:commit-barrier'));
  assert.equal(f.store.state!.work[0].state, 'PENDING');
});

test('failed persistence NACKs, stops intake, and never ACKs or advances cursor', async t => {
  const f = fixture(t); await f.intake.start(); f.store.recordFailure = true;
  const item = f.makeDelivery('db-failure'); f.deliver(item.delivery);
  await until(() => f.failures.length === 1);
  assert.equal(item.acks, 0); assert.equal(item.nacks, 1);
  assert.equal(f.store.state!.cursor, '100'); assert.equal(f.reads.length, 1);
  assert.throws(() => f.intake.assertHealthy(), /stopped/);
});

test('failed ACK after a successful commit leaves durable pending evidence for restart', async t => {
  const f = fixture(t); await f.intake.start();
  const item = f.makeDelivery('ack-failure');
  item.delivery.ack = async () => { throw new Error('Synthetic provider ACK failure'); };
  f.deliver(item.delivery); await until(() => f.failures.length === 1);
  assert.equal(item.nacks, 1);
  assert.equal(f.store.notifications.get('ack-failure')!.historyId, '200');
  assert.equal(f.store.state!.cursor, '100');
  assert.equal(f.reads.length, 1);
});

test('poison notifications are durably rejected before ACK without triggering Gmail', async t => {
  const f = fixture(t); await f.intake.start();
  const cases: [string, unknown, string][] = [
    ['json', '{', 'INVALID_JSON'], ['shape', [], 'INVALID_SHAPE'],
    ['mailbox', { emailAddress: 'other@example.invalid', historyId: '200' }, 'MAILBOX_MISMATCH'],
    ['history', { emailAddress: mailbox, historyId: 200 }, 'INVALID_HISTORY_ID'],
  ];
  for (const [id, value, rejection] of cases) {
    const item = f.makeDelivery(id, value); f.deliver(item.delivery);
    await until(() => item.acks === 1);
    const evidence = f.store.notifications.get(id)!;
    assert.equal(evidence.rejection, rejection); assert.equal(evidence.historyId, null);
    assert.equal(evidence.payloadSha256, createHash('sha256').update(item.delivery.data).digest('hex'));
    assert.ok(f.store.events.indexOf(`committed:${id}`) < f.store.events.indexOf(`ack:${id}`));
  }
  assert.equal(f.reads.length, 1);
});

test('stale duplicate notifications ACK again without additional Gmail reads or work', async t => {
  const f = fixture(t); await f.intake.start();
  const item = f.makeDelivery('duplicate', { emailAddress: mailbox, historyId: '100' });
  f.deliver(item.delivery); await until(() => item.acks === 1);
  await until(() => f.store.notifications.size === 0);
  f.deliver(item.delivery); await until(() => item.acks === 2);
  await until(() => f.store.notifications.size === 0);
  assert.equal(f.reads.length, 1); assert.deepEqual(f.store.state!.work, []);
});

test('more than one pending notification batch drains without another provider event', async t => {
  const f = fixture(t);
  for (let i = 0; i < 1005; i++) f.store.notifications.set(`old-${i}`, {
    messageId: `old-${i}`, payloadSha256: 'a'.repeat(64), historyId: '100', rejection: null });
  await f.intake.start();
  assert.equal(f.store.notifications.size, 0);
  assert.equal(f.reads.length, 1);
  assert.equal(f.store.events.filter(e => e.startsWith('ingest:')).length, 2);
});

test('reconnect forces continuation from the consumed cursor and known message tombstones', async t => {
  const f = fixture(t); f.store.state!.work.push({ id: 'completed', state: 'DONE' });
  await f.intake.start(); f.reconnect();
  await until(() => f.reads.length === 2);
  assert.deepEqual(f.reads[1], { cursor: '100', known: ['completed'] });
});

test('arrival during an outstanding history read is not lost when the task finishes', async t => {
  const f = fixture(t); await f.intake.start();
  const read = deferred(); let calls = 0;
  f.provider.historySince = async () => { calls++; if (calls === 1) await read.promise;
    return { cursor: calls === 1 ? '200' : '300', emails: [] }; };
  const first = f.makeDelivery('first'); f.deliver(first.delivery);
  await until(() => calls === 1);
  const second = f.makeDelivery('second', { emailAddress: mailbox, historyId: '300' }); f.deliver(second.delivery);
  await until(() => second.acks === 1); read.resolve();
  await until(() => f.store.state!.cursor === '300');
  assert.equal(f.store.notifications.size, 0); assert.equal(calls, 2);
});

test('classification failure preserves the whole batch and cursor', async t => {
  const f = fixture(t);
  f.provider.historySince = async () => ({ cursor: '200', emails: [email('good'), email('bad')] });
  f.admit(item => { if (item.id === 'bad') throw new Error('Synthetic uncertain provenance'); return true; });
  await assert.rejects(f.intake.start(), /startup failed/);
  assert.equal(f.store.state!.cursor, '100'); assert.deepEqual(f.store.state!.work, []);
});

test('new mail admission marks ignored messages DONE while advancing the complete batch', async t => {
  const f = fixture(t);
  f.provider.historySince = async () => ({ cursor: '200', emails: [email('ignored'), email('allowed')] });
  f.admit(item => item.id === 'allowed'); await f.intake.start();
  assert.equal(f.store.state!.cursor, '200');
  assert.deepEqual(f.store.state!.work[0], { id: 'ignored', state: 'DONE' });
  assert.equal(f.store.state!.work[1].state, 'PENDING');
  assert.equal(f.store.state!.work[1].email!.intakeDisposition, 'ADMITTED');
});

test('expired history persists a stop that prevents a later startup from establishing another watch', async t => {
  const f = fixture(t); f.provider.historySince = async () => { throw new GmailHistoryGapError(); };
  await assert.rejects(f.intake.start(), GmailHistoryGapError);
  assert.equal(f.store.state!.gap, true); assert.equal(f.store.state!.cursor, '100');
  const restored = fixture(t, f.store); const watches = f.store.events.filter(e => e === 'provider-watch').length;
  await assert.rejects(restored.intake.start(), GmailHistoryGapError);
  assert.equal(f.store.events.filter(e => e === 'provider-watch').length, watches);
});

test('interrupted PROCESSING work is never replayed while independent intake still spools arrivals', async t => {
  const f = fixture(t); f.store.state!.work.push({ id: 'uncertain', state: 'PROCESSING', email: email('uncertain') });
  await f.intake.start();
  await assert.rejects(f.intake.emails(async () => {}).next(), /no replay/);
  f.provider.historySince = async () => ({ cursor: '200', emails: [email('later')] });
  const item = f.makeDelivery('later'); f.deliver(item.delivery);
  await until(() => f.store.state!.cursor === '200');
  assert.equal(item.acks, 1);
  assert.deepEqual(f.store.state!.work.map(w => [w.id, w.state]), [['uncertain', 'PROCESSING'], ['later', 'PENDING']]);
});

test('consumer marks PROCESSING before yield and DONE only after successful consumption', async t => {
  const f = fixture(t);
  f.store.state!.work.push({ id: 'one', state: 'PENDING', email: email('one') }, { id: 'two', state: 'PENDING', email: email('two') });
  await f.intake.start();
  const consumer = f.intake.emails(async () => {});
  assert.equal((await consumer.next()).value?.id, 'one');
  assert.equal(f.store.state!.work[0].state, 'PROCESSING');
  // The browser can hold this yield while notifications continue independently.
  f.provider.historySince = async () => ({ cursor: '200', emails: [email('three')] });
  const item = f.makeDelivery('while-browser-busy'); f.deliver(item.delivery);
  await until(() => f.store.state!.cursor === '200'); assert.equal(item.acks, 1);
  assert.equal((await consumer.next()).value?.id, 'two');
  assert.deepEqual(f.store.state!.work[0], { id: 'one', state: 'DONE' });
  await assert.rejects(consumer.throw(new Error('Synthetic browser uncertainty')), /browser uncertainty/);
  assert.equal(f.store.state!.work[1].state, 'PROCESSING');
});

test('consumer rechecks admission and tombstones ignored imported work without yielding it', async t => {
  const f = fixture(t);
  f.store.state!.work.push({ id: 'ignored', state: 'PENDING', email: email('ignored') }, { id: 'allowed', state: 'PENDING', email: email('allowed') });
  f.admit(item => item.id === 'allowed'); await f.intake.start();
  const consumer = f.intake.emails(async () => {});
  assert.equal((await consumer.next()).value?.id, 'allowed');
  assert.deepEqual(f.store.state!.work[0], { id: 'ignored', state: 'DONE' });
  await consumer.return(undefined);
});

test('idle maintenance and daily watch renewal never poll Gmail history', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-22T00:00:00Z') });
  const f = fixture(t); await f.intake.start();
  let idle = 0;
  const consumer = f.intake.emails(async hasIncoming => { idle++; assert.equal(await hasIncoming(), false); });
  const next = consumer.next(); await until(() => idle === 1);
  t.mock.timers.tick(60000); await until(() => idle === 2);
  t.mock.timers.tick(86400000); await until(() => f.store.events.filter(e => e === 'provider-watch').length === 2);
  await setImmediate();
  assert.equal(f.reads.length, 1); assert.equal(f.store.state!.cursor, '100');
  await f.intake.stop(); await next; await consumer.return(undefined);
});

test('expired watch blocks browser work even when the renewal callback has not run', async t => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = fixture(t);
  f.provider.watch = async () => ({ historyId: '900', expirationMs: now + 360000 });
  await f.intake.start(); t.mock.timers.setTime(now + 360000);
  assert.throws(() => f.intake.assertHealthy(), /stopped/);
  assert.equal(f.failures.length, 1); assert.equal(f.reads.length, 1);
});

test('transient reads retry only the triggered read, honor Retry-After, and stop after three attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-22T00:00:00Z') });
  const f = fixture(t); await f.intake.start();
  let attempts = 0;
  f.provider.historySince = async () => { attempts++; throw new GmailReadRetryableError(20000); };
  f.reconnect(); await until(() => attempts === 1); await setImmediate();
  t.mock.timers.tick(19999); await setImmediate(); assert.equal(attempts, 1);
  t.mock.timers.tick(1); await until(() => attempts === 2); await setImmediate();
  t.mock.timers.tick(20000); await until(() => f.failures.length === 1);
  assert.equal(attempts, 3); assert.equal(f.store.state!.cursor, '100');
});

test('ownership loss stops triggered reads before provider access or cursor advancement', async t => {
  const f = fixture(t); await f.intake.start(); f.loseOwnership(); f.reconnect();
  await until(() => f.failures.length === 1);
  assert.equal(f.reads.length, 1); assert.equal(f.store.state!.cursor, '100');
});

test('shutdown while a provider read is outstanding prevents late admissions and cursor commits', async t => {
  const f = fixture(t); await f.intake.start();
  const read = deferred(); let reading = false;
  f.provider.historySince = async () => { reading = true; await read.promise; return { cursor: '200', emails: [email('late')] }; };
  f.reconnect(); await until(() => reading);
  const stopped = f.intake.stop(); read.resolve(); await stopped;
  assert.equal(f.store.state!.cursor, '100'); assert.deepEqual(f.store.state!.work, []);
  assert.throws(() => f.intake.assertHealthy(), /not active/);
});

test('fatal stream failures block browser work and shutdown is idempotent', async t => {
  const f = fixture(t); await f.intake.start(); f.fatal();
  await until(() => f.failures.length === 1);
  assert.throws(() => f.intake.assertHealthy(), /stopped/);
  const first = f.intake.stop(); assert.equal(f.intake.stop(), first); await first;
  const item = f.makeDelivery('after-stop'); f.deliver(item.delivery);
  await until(() => item.nacks === 1); assert.equal(item.acks, 0);
});

test('legacy source requires the exact accepted bytes, including after an import', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bfmr-intake-source-'));
  try {
    const file = join(dir, 'legacy.json'); let accepted: string | null = null;
    const store = { async legacySourceHash() { return accepted; } };
    await assertLegacyGmailSource(store, file);
    await writeFile(file, 'synthetic-private-source');
    await assert.rejects(assertLegacyGmailSource(store, file), /reviewed import/);
    accepted = createHash('sha256').update('synthetic-private-source').digest('hex');
    await assertLegacyGmailSource(store, file);
    await writeFile(file, 'changed');
    await assert.rejects(assertLegacyGmailSource(store, file), /source restoration/);
    await rm(file); await assert.rejects(assertLegacyGmailSource(store, file), /source restoration/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
