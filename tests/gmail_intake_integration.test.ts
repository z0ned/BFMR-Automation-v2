import './helpers/offlineNetworkGuard';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ProductionGmailIntake } from '../src/services/productionGmailIntake';
import type { PostgresGmailIntakeStore } from '../src/services/postgresGmailIntake';
import type { GmailPushProvider, GmailPushSubscription, PubSubDelivery } from '../src/services/gmailPushTransport';
import { createGmailIntakeFixture } from './helpers/gmailIntakePglite';

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i += 1) { if (await check()) return; await delay(5); }
  assert.fail('Embedded intake fixture did not settle');
}
function coordinator(t: TestContext, fixture: Awaited<ReturnType<typeof createGmailIntakeFixture>>,
  store: PostgresGmailIntakeStore, history: GmailPushProvider['historySince']) {
  let receive!: (delivery: PubSubDelivery) => void;
  const failures: Error[] = [];
  const provider: GmailPushProvider = {
    async getProfile() { return { mailbox: fixture.options.mailbox, historyId: '900' }; },
    async watch() { return { historyId: '100', expirationMs: Date.now() + 7 * 86400000 }; },
    historySince: history, async close() {},
  };
  const subscription: GmailPushSubscription = {
    async validate() {}, async start(handler) { receive = handler; }, async close() {},
  };
  const intake = new ProductionGmailIntake({ mailbox: fixture.options.mailbox, topic: fixture.options.topic,
    store, provider, subscription, verifyOwnership: fixture.options.verifyOwnership,
    admit: () => true, onFailure: async error => { failures.push(error); } });
  t.after(async () => { await intake.stop(); await store.close(); });
  function deliver(id: string, historyId: string, acknowledge: () => Promise<void>) {
    let acks = 0; let nacks = 0;
    receive({ id, data: Buffer.from(JSON.stringify({ emailAddress: fixture.options.mailbox, historyId })),
      async ack() { await acknowledge(); acks += 1; }, async nack() { nacks += 1; } });
    return { get acks() { return acks; }, get nacks() { return nacks; } };
  }
  return { intake, failures, deliver };
}

test('actual SQL commits notification evidence before ACK and failed COMMIT never ACKs or advances history', async t => {
  const f = await createGmailIntakeFixture(); let reads = 0;
  const c = coordinator(t, f, f.store, async cursor => ({ cursor: ++reads === 1 ? cursor : '110', emails: [] }));
  await c.intake.start(true);
  const accepted = c.deliver('n1', '110', async () => {
    const proof = (await f.query(`SELECT state,txid_current_if_assigned() IS NULL AS prior_write_committed
      FROM gmail_intake_notifications WHERE message_id='n1'`)).rows[0];
    assert.equal(proof.state, 'PENDING'); assert.equal(proof.prior_write_committed, true);
  });
  await until(() => accepted.acks === 1);
  await until(async () => (await f.store.load())?.cursor === '110');
  let failCommit = true; let recordingSecondNotification = false;
  f.setFault(sql => {
    if (sql.includes('INSERT INTO public.gmail_intake_notifications')) recordingSecondNotification = true;
    if (sql === 'COMMIT' && recordingSecondNotification && failCommit) {
      failCommit = false; throw Error('Synthetic notification commit failure');
    }
  });
  const failed = c.deliver('n2', '120', async () => assert.fail('Uncommitted notification must never be ACKed'));
  await until(() => c.failures.length === 1);
  f.setFault();
  assert.equal(failed.acks, 0); assert.equal(failed.nacks, 1);
  assert.equal((await f.store.load())?.cursor, '110');
  assert.equal((await f.query(`SELECT count(*)::integer AS n FROM gmail_intake_notifications WHERE message_id='n2'`)).rows[0].n, 0);
  assert.equal(reads, 2);
});

test('ACK failure recovers committed pending SQL evidence on restart without replaying a completed tombstone', async t => {
  const f = await createGmailIntakeFixture();
  const first = coordinator(t, f, f.store, async cursor => ({ cursor, emails: [] }));
  await first.intake.start(true);
  const lostAck = first.deliver('n1', '110', async () => { throw Error('Synthetic lost ACK'); });
  await until(() => first.failures.length === 1);
  assert.equal(lostAck.acks, 0); assert.equal(lostAck.nacks, 1);
  assert.deepEqual(await f.store.pendingNotifications(), [{ messageId: 'n1', historyId: '110' }]);
  assert.equal((await f.store.load())?.cursor, '100');
  await first.intake.stop(); await f.store.close();

  const restartedStore = f.createStore(); let reads = 0;
  const second = coordinator(t, f, restartedStore, async (cursor, known) => {
    reads += 1; assert.equal(cursor, '100'); assert.equal(known.has('m1'), false);
    return { cursor: '110', emails: [{ id: 'm1', sender: 'synthetic@example.org', subject: 'Synthetic',
      body: 'Offline message', receivedAt: '2026-10-21T12:00:00.000Z', inboxAtFetch: true }] };
  });
  await second.intake.start();
  assert.equal((await restartedStore.load())?.cursor, '110');
  assert.deepEqual(await restartedStore.pendingNotifications(), []);
  await restartedStore.mark('m1', 'PROCESSING'); await restartedStore.mark('m1', 'DONE');
  const replay = second.deliver('n1', '110', async () => {
    assert.equal((await f.query(`SELECT state FROM gmail_intake_notifications WHERE message_id='n1'`)).rows[0].state, 'CONSUMED');
  });
  await until(() => replay.acks === 1);
  await delay(15);
  assert.equal(reads, 1);
  assert.deepEqual((await restartedStore.load())?.work, [{ id: 'm1', state: 'DONE' }]);
  assert.equal(second.failures.length, 0);
});
