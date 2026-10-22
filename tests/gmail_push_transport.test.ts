import './helpers/offlineNetworkGuard';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { google } from 'googleapis';
import { v1 } from '@google-cloud/pubsub';
import { makeGmailPushAdapters, GmailHistoryGapError, GmailReadRetryableError,
  type PubSubDelivery } from '../src/services/gmailPushTransport';

const config = {
  GMAIL_ACCOUNT_EMAIL: 'Intake@Example.org', GMAIL_CLIENT_ID: 'synthetic-client',
  GMAIL_CLIENT_SECRET: 'synthetic-secret', GMAIL_REFRESH_TOKEN: 'synthetic-refresh',
  GOOGLE_PUBSUB_TOPIC: 'projects/synthetic-project/topics/gmail',
  GOOGLE_PUBSUB_SUBSCRIPTION: 'projects/synthetic-project/subscriptions/gmail',
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const errorResponse = (status: number, retryAfter?: unknown) => Object.assign(new Error('PRIVATE_PROVIDER_DETAIL'), {
  response: { status, ...(retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } }) },
});
function textPart(text: string, mimeType = 'text/plain') {
  return { mimeType, body: { size: Buffer.byteLength(text), data: Buffer.from(text).toString('base64url') } };
}
function message(id: string, text = 'Synthetic offer', instant = 1_800_000_000_000, part: any = textPart(text)) {
  return { id, internalDate: String(instant), labelIds: ['INBOX'],
    payload: { ...part, headers: [{ name: 'From', value: 'Synthetic Sender <sender@example.org>' },
      { name: 'Subject', value: 'Synthetic subject' }, { name: 'Authentication-Results', value: 'synthetic auth evidence' }] } };
}
function history(ids: string[], cursor = '900') {
  return { historyId: cursor, history: ids.map((id, index) => ({ id: String(101 + index), messagesAdded: [{ message: { id } }] })) };
}

class FakePullStream extends Duplex {
  writes: any[] = [];
  cancelCount = 0;
  constructor() { super({ objectMode: true }); }
  _read() {}
  _write(value: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.writes.push(value); callback();
  }
  cancel() { this.cancelCount += 1; this.destroy(); }
  deliver(id = 'notification-1', ackId = 'ack-1', data = Buffer.from('{"emailAddress":"intake@example.org","historyId":"900"}')) {
    this.emit('data', { receivedMessages: [{ ackId, message: { messageId: id, data } }] });
  }
}

function harness(t: TestContext) {
  const calls = { profiles: [] as any[], watches: [] as any[], histories: [] as any[], messages: [] as any[] };
  const behavior = {
    profile: async (_params: any, _options: any): Promise<any> => ({ emailAddress: 'intake@example.org', historyId: '100' }),
    watch: async (_params: any, _options: any): Promise<any> => ({ historyId: '200', expiration: String(Date.now() + 7 * 86_400_000) }),
    history: async (_params: any, _options: any): Promise<any> => history([]),
    message: async (params: any, _options: any): Promise<any> => message(params.id),
  };
  const gmail = { users: {
    getProfile: async (params: any, options: any) => { calls.profiles.push({ params, options }); return { data: await behavior.profile(params, options) }; },
    watch: async (params: any, options: any) => { calls.watches.push({ params, options }); return { data: await behavior.watch(params, options) }; },
    history: { list: async (params: any, options: any) => { calls.histories.push({ params, options }); return { data: await behavior.history(params, options) }; } },
    messages: {
      get: async (params: any, options: any) => { calls.messages.push({ params, options }); return { data: await behavior.message(params, options) }; },
      list: async () => { throw new Error('INBOX_SWEEP_FORBIDDEN'); },
    },
  } };
  const clients: FakeSubscriberClient[] = [];
  class FakeSubscriberClient {
    metadata: any = { name: config.GOOGLE_PUBSUB_SUBSCRIPTION, topic: config.GOOGLE_PUBSUB_TOPIC };
    streams: FakePullStream[] = [];
    streamOptions: any[] = [];
    ackCalls: any[] = [];
    deadlineCalls: any[] = [];
    ackError: unknown;
    closeCalls = 0;
    constructor(readonly options: any) { clients.push(this); }
    async getSubscription(request: any, options: any) {
      assert.equal(request.subscription, config.GOOGLE_PUBSUB_SUBSCRIPTION);
      assert.equal(options.retry, null); return [this.metadata];
    }
    async initialize() { return { streamingPull: (options: any) => {
      this.streamOptions.push(options); const stream = new FakePullStream(); this.streams.push(stream); return stream;
    } }; }
    async acknowledge(request: any, options: any) {
      this.ackCalls.push({ request, options }); if (this.ackError) throw this.ackError;
      return [{}];
    }
    async modifyAckDeadline(request: any, options: any) { this.deadlineCalls.push({ request, options }); return [{}]; }
    async close() { this.closeCalls += 1; }
  }
  t.mock.method(google as unknown as { gmail: (options: unknown) => unknown }, 'gmail', () => gmail);
  // MockTracker preserves the original newTarget/prototype for constructors;
  // return an explicit fixture instance so the real SDK prototype is never used.
  const fixtureConstructor = function (options: unknown) { return new FakeSubscriberClient(options); };
  t.mock.method(v1, 'SubscriberClient', fixtureConstructor as unknown as typeof v1.SubscriberClient);
  const adapters = makeGmailPushAdapters(config);
  t.after(async () => { await adapters.provider.close(); await adapters.subscription.close(); });
  return { adapters, behavior, calls, client: clients[0], clients };
}

test('factory validates required mailbox, OAuth and same-project full resource names', async t => {
  const h = harness(t);
  assert.equal(h.adapters.mailbox, 'intake@example.org');
  assert.equal(h.client.options.projectId, 'synthetic-project');
  assert.throws(() => makeGmailPushAdapters({ ...config, GMAIL_ACCOUNT_EMAIL: '' }), /requires GMAIL_ACCOUNT_EMAIL/);
  assert.throws(() => makeGmailPushAdapters({ ...config, GMAIL_CLIENT_SECRET: '' }), /requires GMAIL_CLIENT_SECRET/);
  assert.throws(() => makeGmailPushAdapters({ ...config, GOOGLE_PUBSUB_TOPIC: 'gmail' }), /full resource names/);
  assert.throws(() => makeGmailPushAdapters({ ...config,
    GOOGLE_PUBSUB_SUBSCRIPTION: 'projects/another-project/subscriptions/gmail' }), /same configured project/);
  assert.equal(h.clients.length, 1);
});

test('profile identity and INBOX watch use explicit timeout and shared cancellation signal', async t => {
  const h = harness(t);
  assert.deepEqual(await h.adapters.provider.getProfile(), { mailbox: 'intake@example.org', historyId: '100' });
  const watch = await h.adapters.provider.watch(config.GOOGLE_PUBSUB_TOPIC);
  assert.equal(watch.historyId, '200'); assert.ok(watch.expirationMs > Date.now());
  assert.deepEqual(h.calls.watches[0].params.requestBody, {
    topicName: config.GOOGLE_PUBSUB_TOPIC, labelIds: ['INBOX'], labelFilterBehavior: 'include',
  });
  assert.equal(h.calls.profiles[0].options.timeout, 15_000);
  assert.equal(h.calls.watches[0].options.retry, false);
  assert.equal(h.calls.profiles[0].options.signal, h.calls.watches[0].options.signal);
  h.behavior.profile = async () => ({ emailAddress: 'other@example.org', historyId: '100' });
  await assert.rejects(h.adapters.provider.getProfile(), /GMAIL_PROFILE_OR_MAILBOX_VERIFICATION_FAILED/);
  h.behavior.watch = async () => ({ historyId: '200', expiration: '1' });
  await assert.rejects(h.adapters.provider.watch(config.GOOGLE_PUBSUB_TOPIC), /GMAIL_WATCH_ESTABLISHMENT_FAILED/);
});

test('history consumes every page, deduplicates events/tombstones and sorts complete fetched messages', async t => {
  const h = harness(t);
  h.behavior.history = async params => params.pageToken ? {
    historyId: '900', history: [{ id: '103', labelsAdded: [
      { labelIds: ['INBOX'], message: { id: 'm3' } },
      { labelIds: ['INBOX'], message: { id: 'm2' } },
      { labelIds: ['SENT'], message: { id: 'unrelated' } },
    ] }],
  } : { ...history(['m2', 'known']), nextPageToken: 'second-page' };
  h.behavior.message = async params => message(params.id, params.id, params.id === 'm3' ? 1_700_000_000_000 : 1_800_000_000_000);
  const batch = await h.adapters.provider.historySince('100', new Set(['known']));
  assert.equal(batch.cursor, '900'); assert.deepEqual(batch.emails.map(email => email.id), ['m3', 'm2']);
  assert.equal(batch.emails[0].inboxAtFetch, true);
  assert.equal(batch.emails[0].headers?.[2].value, 'synthetic auth evidence');
  assert.deepEqual(h.calls.messages.map(call => call.params.id), ['m2', 'm3']);
  assert.deepEqual(h.calls.histories.map(call => call.params.pageToken), [undefined, 'second-page']);
  for (const call of h.calls.histories) {
    assert.equal(call.params.startHistoryId, '100');
    assert.deepEqual(call.params.historyTypes, ['messageAdded', 'labelAdded']);
  }
  assert.ok(h.calls.messages.every(call => call.params.format === 'full'));
});

test('history rejects changing page cursors, page cycles and regressive event identity', async t => {
  const h = harness(t);
  h.behavior.history = async params => ({ historyId: params.pageToken ? '901' : '900', nextPageToken: params.pageToken ? undefined : 'p2' });
  await assert.rejects(h.adapters.provider.historySince('100', new Set()), /CURSOR_INCONSISTENT/);
  h.behavior.history = async () => ({ historyId: '900', nextPageToken: 'cycle' });
  await assert.rejects(h.adapters.provider.historySince('100', new Set()), /PAGE_CYCLE/);
  h.behavior.history = async () => ({ historyId: '99' });
  await assert.rejects(h.adapters.provider.historySince('100', new Set()), /CURSOR_INCONSISTENT/);
  h.behavior.history = async () => ({ historyId: '900', history: [{ id: '101' }, { id: '101' }] });
  await assert.rejects(h.adapters.provider.historySince('100', new Set()), /EVENT_ORDER_INVALID/);
  assert.equal(h.calls.messages.length, 0);
});

test('a failed later history page or message fetch never returns a partial batch', async t => {
  const h = harness(t);
  h.behavior.history = async params => {
    if (params.pageToken) throw errorResponse(503);
    return { ...history(['m1']), nextPageToken: 'p2' };
  };
  await assert.rejects(h.adapters.provider.historySince('100', new Set()), GmailReadRetryableError);
  assert.equal(h.calls.messages.length, 0);
  h.behavior.history = async () => history(['m1', 'm2']);
  h.behavior.message = async params => {
    if (params.id === 'm2') throw errorResponse(503);
    return message(params.id);
  };
  await assert.rejects(h.adapters.provider.historySince('100', new Set()), GmailReadRetryableError);
  assert.deepEqual(h.calls.messages.map(call => call.params.id), ['m1', 'm2']);
});

test('only an expired history read becomes a persistent gap signal; message absence is not a gap', async t => {
  const h = harness(t);
  h.behavior.history = async () => { throw errorResponse(404); };
  await assert.rejects(h.adapters.provider.historySince('100', new Set()), GmailHistoryGapError);
  h.behavior.history = async () => history(['m1']);
  h.behavior.message = async () => { throw errorResponse(404); };
  await assert.rejects(h.adapters.provider.historySince('100', new Set()), error => {
    assert.equal(error instanceof GmailHistoryGapError, false);
    assert.match((error as Error).message, /MESSAGE_FETCH_OR_VALIDATION_FAILED/);
    assert.equal((error as Error).message.includes('PRIVATE_PROVIDER_DETAIL'), false); return true;
  });
});

test('retryable reads retain bounded Retry-After seconds and HTTP dates', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 21, 0, 0, 0) });
  const h = harness(t);
  h.behavior.history = async () => { throw errorResponse(429, '17'); };
  await assert.rejects(h.adapters.provider.historySince('100', new Set()), error => {
    assert.ok(error instanceof GmailReadRetryableError); assert.equal(error.retryAfterMs, 17_000); return true;
  });
  h.behavior.history = async () => { throw { response: { status: 503,
    headers: new Headers({ 'Retry-After': new Date(Date.now() + 30_000).toUTCString() }) } }; };
  await assert.rejects(h.adapters.provider.historySince('100', new Set()), error => {
    assert.ok(error instanceof GmailReadRetryableError); assert.equal(error.retryAfterMs, 30_000); return true;
  });
});

test('invalid or oversized Retry-After fails closed without leaking provider/header contents', async t => {
  const h = harness(t);
  for (const value of ['61', 'PRIVATE_PROVIDER_DETAIL', ['1', '2']]) {
    h.behavior.history = async () => { throw errorResponse(429, value); };
    await assert.rejects(h.adapters.provider.historySince('100', new Set()), error => {
      assert.equal(error instanceof GmailReadRetryableError, false);
      assert.match((error as Error).message, /GMAIL_RETRY_AFTER_/);
      assert.equal((error as Error).message.includes('PRIVATE_PROVIDER_DETAIL'), false); return true;
    });
  }
});

test('MIME extraction preserves inline HTML hrefs and excludes binary/named attachments', async t => {
  const h = harness(t);
  h.behavior.history = async () => history(['m1']);
  const html = '<a href="https://www.bfmr.com/deals/synthetic-offer">Synthetic offer</a>';
  h.behavior.message = async () => message('m1', '', undefined, { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'multipart/alternative', parts: [textPart('Inline description'), textPart(html, 'text/html')] },
    { mimeType: 'application/octet-stream', body: { size: 99, data: 'not-base64' } },
    { ...textPart('ATTACHMENT_MUST_NOT_CLASSIFY'), filename: 'attached.txt' },
  ] });
  const batch = await h.adapters.provider.historySince('100', new Set());
  assert.equal(batch.emails[0].body, `Inline description\n${html}`);
});

test('attachment-only inline text or missing full payload cannot fall back to snippets', async t => {
  const h = harness(t);
  h.behavior.history = async () => history(['m1']);
  for (const payload of [{ mimeType: 'text/html', body: { size: 12, attachmentId: 'synthetic-attachment' } },
    { mimeType: 'text/plain', body: {} }, undefined]) {
    h.behavior.message = async () => ({ ...message('m1'), snippet: 'NEW DEAL synthetic snippet', payload: payload && {
      ...payload, headers: message('m1').payload.headers,
    } });
    await assert.rejects(h.adapters.provider.historySince('100', new Set()), /MESSAGE_FETCH_OR_VALIDATION_FAILED/);
  }
});

test('text size/encoding conflicts and unusable MIME shapes retain the cursor by rejecting the batch', async t => {
  const h = harness(t);
  h.behavior.history = async () => history(['m1']);
  for (const part of [{ ...textPart('abc'), body: { size: 4, data: 'YWJj' } },
    { mimeType: 'text/plain', body: { size: 1, data: 'a' } }, { mimeType: 'multipart/mixed', parts: [] }]) {
    h.behavior.message = async () => message('m1', '', undefined, part);
    await assert.rejects(h.adapters.provider.historySince('100', new Set()), /MESSAGE_FETCH_OR_VALIDATION_FAILED/);
  }
});

test('provider close aborts an in-flight Gmail read and prevents another page request', async t => {
  const h = harness(t);
  h.behavior.history = async (_params, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('synthetic abort'), { code: 'ERR_CANCELED' })), { once: true });
  });
  const reading = h.adapters.provider.historySince('100', new Set());
  const rejected = assert.rejects(reading, /GMAIL_HISTORY_READ_FAILED/);
  await h.adapters.provider.close(); await rejected;
  await assert.rejects(h.adapters.provider.historySince('100', new Set()), { name: 'AbortError' });
  assert.equal(h.calls.histories.length, 1);
  assert.equal(h.calls.histories[0].options.signal.aborted, true);
});

test('subscription metadata must identify the exact unfiltered pull subscription and topic', async t => {
  const h = harness(t);
  for (const extra of [{ topic: 'projects/synthetic-project/topics/wrong' }, { pushConfig: { pushEndpoint: 'https://invalid.example/' } },
    { filter: 'attributes.synthetic="true"' }, { detached: true }, { bigqueryConfig: { table: 'synthetic.table' } }]) {
    h.client.metadata = { name: config.GOOGLE_PUBSUB_SUBSCRIPTION, topic: config.GOOGLE_PUBSUB_TOPIC, ...extra };
    await assert.rejects(h.adapters.subscription.validate(), /SUBSCRIPTION_VALIDATION_FAILED/);
  }
  await assert.rejects(h.adapters.subscription.start(() => {}, () => {}, () => {}), /NOT_READY/);
  assert.equal(h.client.streams.length, 0);
});

test('StreamingPull exposes delivery without automatic ACK, then honors caller persistence completion', async t => {
  const h = harness(t); const deliveries: PubSubDelivery[] = [];
  let commit!: () => void;
  const persisted = new Promise<void>(resolve => { commit = resolve; });
  let completed: Promise<void> | undefined;
  await h.adapters.subscription.validate();
  await h.adapters.subscription.start(delivery => {
    deliveries.push(delivery); completed = persisted.then(() => delivery.ack());
  }, () => {}, error => { throw error; });
  h.client.streams[0].deliver();
  assert.equal(deliveries.length, 1); assert.equal(h.client.ackCalls.length, 0);
  commit(); await completed;
  assert.equal(h.client.ackCalls.length, 1);
  assert.deepEqual(h.client.ackCalls[0].request, { subscription: config.GOOGLE_PUBSUB_SUBSCRIPTION, ackIds: ['ack-1'] });
  await deliveries[0].ack(); assert.equal(h.client.ackCalls.length, 1);
  await assert.rejects(deliveries[0].nack(), /ALREADY_SETTLED/);
});

test('pending durable writes receive bounded leases; shutdown NACKs without inventing an ACK', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  const h = harness(t); let delivery!: PubSubDelivery;
  await h.adapters.subscription.validate();
  await h.adapters.subscription.start(value => { delivery = value; }, () => {}, () => {});
  h.client.streams[0].deliver();
  t.mock.timers.tick(20_000); await flush();
  assert.ok(h.client.deadlineCalls.some(call => call.request.ackDeadlineSeconds === 60 && call.request.ackIds[0] === 'ack-1'));
  await h.adapters.subscription.close();
  assert.ok(h.client.deadlineCalls.some(call => call.request.ackDeadlineSeconds === 0));
  assert.equal(h.client.ackCalls.length, 0); assert.equal(h.client.closeCalls, 1);
  await assert.rejects(delivery.ack(), /ALREADY_SETTLED|STOPPED_BEFORE_ACK/);
  const count = h.client.deadlineCalls.length;
  t.mock.timers.tick(600_000); await flush(); assert.equal(h.client.deadlineCalls.length, count);
});

test('stream interruption reconnects once; healthy quiet time has no deadline recycling or Gmail reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  t.mock.method(Math, 'random', () => 0);
  const h = harness(t); let reconnects = 0;
  await h.adapters.subscription.validate();
  await h.adapters.subscription.start(() => {}, () => { reconnects += 1; }, error => { throw error; });
  assert.deepEqual(h.client.streamOptions[0], { deadline: Infinity });
  assert.equal(h.client.streams[0].writes[0].maxOutstandingMessages, 10);
  h.client.streams[0].emit('error', { code: 14, message: 'PRIVATE_PROVIDER_DETAIL' });
  h.client.streams[0].emit('end'); h.client.streams[0].emit('close');
  t.mock.timers.tick(999); await flush(); assert.equal(h.client.streams.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(h.client.streams.length, 2); assert.equal(reconnects, 1);
  t.mock.timers.tick(3_600_000); await flush();
  assert.equal(h.client.streams.length, 2); assert.equal(reconnects, 1); assert.equal(h.calls.histories.length, 0);
});

test('permanent stream authorization failure stops rather than reconnecting or exposing raw errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  const h = harness(t); const failures: Error[] = [];
  await h.adapters.subscription.validate();
  await h.adapters.subscription.start(() => {}, () => {}, error => { failures.push(error); });
  h.client.streams[0].emit('error', { code: 7, message: 'PRIVATE_PROVIDER_DETAIL' });
  await h.adapters.subscription.close();
  t.mock.timers.tick(3_600_000); await flush();
  assert.equal(failures.length, 1); assert.equal(failures[0].message, 'PUBSUB_STREAM_PERMANENT_FAILURE');
  assert.equal(h.client.streams.length, 1); assert.equal(h.client.closeCalls, 1);
});

test('ACK transport failure is sanitized and not retried automatically', async t => {
  const h = harness(t); let delivery!: PubSubDelivery;
  await h.adapters.subscription.validate();
  await h.adapters.subscription.start(value => { delivery = value; }, () => {}, () => {});
  h.client.streams[0].deliver(); h.client.ackError = errorResponse(503);
  await assert.rejects(delivery.ack(), { message: 'PUBSUB_DELIVERY_SETTLEMENT_FAILED' });
  assert.equal(h.client.ackCalls.length, 1); assert.equal(h.client.ackCalls[0].options.retry, null);
  await h.adapters.subscription.close();
  assert.equal(h.client.ackCalls.length, 1);
});

test('unpersisted delivery exceeding its lease budget stops and NACKs instead of ACKing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  const h = harness(t); const failures: Error[] = [];
  await h.adapters.subscription.validate();
  await h.adapters.subscription.start(() => {}, () => {}, error => { failures.push(error); });
  h.client.streams[0].deliver();
  t.mock.timers.tick(320_000); await flush();
  await h.adapters.subscription.close();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, 'PUBSUB_DURABLE_PERSISTENCE_DEADLINE_EXCEEDED');
  assert.equal(h.client.ackCalls.length, 0);
  assert.ok(h.client.deadlineCalls.some(call => call.request.ackDeadlineSeconds === 0));
});

test('successive stream failures exhaust a bounded reconnect budget and stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  t.mock.method(Math, 'random', () => 0);
  const h = harness(t); const failures: Error[] = [];
  await h.adapters.subscription.validate();
  await h.adapters.subscription.start(() => {}, () => {}, error => { failures.push(error); });
  for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000]) {
    h.client.streams.at(-1)!.emit('error', { code: 14 });
    t.mock.timers.tick(delay); await flush();
  }
  assert.equal(h.client.streams.length, 7);
  h.client.streams.at(-1)!.emit('error', { code: 14 });
  await h.adapters.subscription.close();
  t.mock.timers.tick(3_600_000); await flush();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, 'PUBSUB_STREAM_RECONNECT_EXHAUSTED');
  assert.equal(h.client.streams.length, 7);
});
