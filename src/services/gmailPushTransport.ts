import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { google } from 'googleapis';
import { v1 } from '@google-cloud/pubsub';
import type { QueuedEmail } from './gmailIntakeQueue';

export interface GmailHistoryBatch { cursor: string; emails: QueuedEmail[] }
export interface GmailPushProvider {
  getProfile(): Promise<{ mailbox: string; historyId: string }>;
  watch(topic: string): Promise<{ historyId: string; expirationMs: number }>;
  historySince(cursor: string, knownIds: ReadonlySet<string>): Promise<GmailHistoryBatch>;
  close(): Promise<void>;
}
export interface PubSubDelivery {
  id: string;
  data: Buffer;
  ack(): Promise<void>;
  nack(): Promise<void>;
}
export interface GmailPushSubscription {
  validate(): Promise<void>;
  start(onMessage: (delivery: PubSubDelivery) => void, onReconnect: () => void,
    onFatal: (error: Error) => void): Promise<void>;
  close(): Promise<void>;
}

export class GmailHistoryGapError extends Error {
  constructor() { super('GMAIL_HISTORY_GAP: the saved Gmail history cursor was rejected; preserve it for review.'); }
}
export class GmailReadRetryableError extends Error {
  constructor(readonly retryAfterMs: number = 0) {
    super('GMAIL_READ_TRANSIENT_FAILURE: saved cursor is unchanged.');
  }
}

function required(config: NodeJS.ProcessEnv, name: string): string {
  const value = config[name]?.trim();
  if (!value) throw new Error(`Production Gmail intake requires ${name}.`);
  return value;
}

function historyId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error('GMAIL_HISTORY_ID_INVALID');
  return value;
}

function providerCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; response?: { status?: unknown } };
  const code = candidate.response?.status ?? candidate.code;
  return typeof code === 'number' && Number.isInteger(code) ? code : undefined;
}

function transientGmailRead(error: unknown): boolean {
  const status = providerCode(error);
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) return true;
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; cause?: { code?: unknown } };
  return [value.code, value.cause?.code].some(code => typeof code === 'string' &&
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_NETWORK',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNABORTED'].includes(code));
}

/** Retry only within the bounded read policy; never retry ahead of Retry-After. */
function gmailRetryAfterMs(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const headers = (error as { response?: { headers?: unknown } }).response?.headers;
  if (headers == null) return 0;
  let value: unknown;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    try { value = (headers as { get(name: string): unknown }).get('retry-after'); }
    catch { throw new Error('GMAIL_RETRY_AFTER_INVALID'); }
  } else if (typeof headers === 'object') {
    const matches = Object.entries(headers).filter(([name]) => name.toLowerCase() === 'retry-after');
    if (matches.length > 1) throw new Error('GMAIL_RETRY_AFTER_INVALID');
    value = matches[0]?.[1];
  } else throw new Error('GMAIL_RETRY_AFTER_INVALID');
  if (value == null) return 0;
  if (typeof value !== 'string') throw new Error('GMAIL_RETRY_AFTER_INVALID');
  value = value.trim();
  let delay: number;
  if (/^\d+$/.test(value as string)) delay = Number(value) * 1000;
  else {
    const parsed = Date.parse(value as string);
    if (!Number.isFinite(parsed) || new Date(parsed).toUTCString() !== value) throw new Error('GMAIL_RETRY_AFTER_INVALID');
    delay = Math.max(0, parsed - Date.now());
  }
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 60_000) {
    throw new Error('GMAIL_RETRY_AFTER_EXCEEDS_BOUNDED_READ_POLICY');
  }
  return delay;
}

function bodyText(part: unknown): string {
  let count = 0;
  let bytes = 0;
  const chunks: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 40 || ++count > 500) throw new Error('GMAIL_MIME_SHAPE_INVALID');
    const item = value as { mimeType?: unknown; filename?: unknown;
      body?: { data?: unknown; size?: unknown; attachmentId?: unknown }; parts?: unknown[] };
    if (typeof item.mimeType !== 'string' || !item.mimeType.trim() ||
        (item.filename != null && typeof item.filename !== 'string')) throw new Error('GMAIL_MIME_SHAPE_INVALID');
    // Attached files, including attached messages/text, are not the current
    // message's inline body and cannot supply deal-classification content.
    if (typeof item.filename === 'string' && item.filename.trim()) return;
    const mime = item.mimeType.toLowerCase().split(';', 1)[0].trim();
    if (mime.startsWith('multipart/')) {
      if (!Array.isArray(item.parts) || item.parts.length === 0) throw new Error('GMAIL_MIME_PARTS_INVALID');
      for (const child of item.parts) visit(child, depth + 1);
      return;
    }
    if (mime !== 'text/plain' && mime !== 'text/html') return;
    if (!item.body || (item.parts !== undefined && (!Array.isArray(item.parts) || item.parts.length !== 0)) ||
        typeof item.body.size !== 'number' || !Number.isSafeInteger(item.body.size) || item.body.size < 0) {
      throw new Error('GMAIL_TEXT_PART_SHAPE_INVALID');
    }
    if (item.body.size > 8 * 1024 * 1024) throw new Error('GMAIL_MESSAGE_TOO_LARGE');
    if (item.body.data === undefined || item.body.data === null) {
      if (item.body.size !== 0 || item.body.attachmentId != null) throw new Error('GMAIL_TEXT_PART_REQUIRES_ATTACHMENT_FETCH');
      return; // Only an explicitly empty inline text part is known empty.
    }
    if (typeof item.body.data !== 'string' || item.body.data.length > Math.ceil(8 * 1024 * 1024 / 3) * 4 ||
        !/^[A-Za-z0-9_-]*={0,2}$/.test(item.body.data)) throw new Error('GMAIL_MIME_DATA_INVALID');
    const decoded = Buffer.from(item.body.data, 'base64url');
    if (decoded.toString('base64url') !== item.body.data.replace(/=+$/, '') || decoded.length !== item.body.size) {
      throw new Error('GMAIL_TEXT_PART_SIZE_OR_ENCODING_INVALID');
    }
    bytes += decoded.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('GMAIL_MESSAGE_TOO_LARGE');
    // Keep HTML as supplied so trusted link extraction retains href targets.
    chunks.push(decoded.toString('utf8'));
  };
  visit(part, 0);
  return chunks.join('\n');
}

/** Provider errors are converted to bounded local labels; no response/page/token data is logged. */
function gmailProvider(config: NodeJS.ProcessEnv, expectedMailbox: string): GmailPushProvider {
  const cancellation = new AbortController();
  const auth = new google.auth.OAuth2({ clientId: required(config, 'GMAIL_CLIENT_ID'),
    clientSecret: required(config, 'GMAIL_CLIENT_SECRET'),
    transporterOptions: { timeout: 15_000, retry: false, signal: cancellation.signal } });
  auth.setCredentials({ refresh_token: required(config, 'GMAIL_REFRESH_TOKEN') });
  const gmail = google.gmail({ version: 'v1', auth });
  const requestOptions = { timeout: 15_000, retry: false, signal: cancellation.signal };
  return {
    async getProfile() {
      try {
        const { data } = await gmail.users.getProfile({ userId: 'me' }, requestOptions);
        const mailbox = data.emailAddress?.trim().toLowerCase();
        if (mailbox !== expectedMailbox) throw new Error('GMAIL_MAILBOX_MISMATCH');
        return { mailbox, historyId: historyId(data.historyId) };
      } catch { throw new Error('GMAIL_PROFILE_OR_MAILBOX_VERIFICATION_FAILED'); }
    },
    async watch(topic) {
      try {
        const { data } = await gmail.users.watch({ userId: 'me', requestBody: {
          topicName: topic, labelIds: ['INBOX'], labelFilterBehavior: 'include',
        } }, requestOptions);
        if (typeof data.expiration !== 'string' || !/^\d+$/.test(data.expiration)) throw new Error('GMAIL_WATCH_EXPIRATION_INVALID');
        const expirationMs = Number(data.expiration);
        if (!Number.isSafeInteger(expirationMs) || expirationMs <= Date.now()) throw new Error('GMAIL_WATCH_EXPIRATION_INVALID');
        return { historyId: historyId(data.historyId), expirationMs };
      } catch { throw new Error('GMAIL_WATCH_ESTABLISHMENT_FAILED'); }
    },
    async historySince(cursor, knownIds) {
      cancellation.signal.throwIfAborted();
      historyId(cursor);
      const ids = new Set<string>();
      const tokens = new Set<string>();
      let pageToken: string | undefined;
      let nextCursor: string | undefined;
      let previousEvent = BigInt(cursor);
      for (let page = 0; ; page += 1) {
        cancellation.signal.throwIfAborted();
        if (page >= 1000) throw new Error('GMAIL_HISTORY_PAGE_LIMIT_REACHED');
        let response;
        try {
          response = await gmail.users.history.list({ userId: 'me', startHistoryId: cursor,
            historyTypes: ['messageAdded', 'labelAdded'], maxResults: 500, pageToken }, requestOptions);
        } catch (error) {
          if (providerCode(error) === 404) throw new GmailHistoryGapError();
          if (transientGmailRead(error)) throw new GmailReadRetryableError(gmailRetryAfterMs(error));
          throw new Error('GMAIL_HISTORY_READ_FAILED');
        }
        const current = historyId(response.data.historyId);
        if (BigInt(current) < BigInt(cursor) || (nextCursor !== undefined && nextCursor !== current)) {
          throw new Error('GMAIL_HISTORY_CURSOR_INCONSISTENT');
        }
        nextCursor = current;
        const histories = response.data.history ?? [];
        if (!Array.isArray(histories)) throw new Error('GMAIL_HISTORY_SHAPE_INVALID');
        const add = (id: unknown) => {
          if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('GMAIL_MESSAGE_ID_INVALID');
          if (!knownIds.has(id)) ids.add(id);
          if (ids.size > 10_000) throw new Error('GMAIL_HISTORY_MESSAGE_LIMIT_REACHED');
        };
        for (const item of histories) {
          const eventId = BigInt(historyId(item.id));
          if (eventId <= previousEvent || eventId > BigInt(current)) throw new Error('GMAIL_HISTORY_EVENT_ORDER_INVALID');
          previousEvent = eventId;
          if (item.messagesAdded !== undefined && !Array.isArray(item.messagesAdded)) throw new Error('GMAIL_HISTORY_SHAPE_INVALID');
          for (const added of item.messagesAdded ?? []) add(added.message?.id);
          if (item.labelsAdded !== undefined && !Array.isArray(item.labelsAdded)) throw new Error('GMAIL_HISTORY_SHAPE_INVALID');
          for (const added of item.labelsAdded ?? []) {
            if (!Array.isArray(added.labelIds)) throw new Error('GMAIL_HISTORY_SHAPE_INVALID');
            if (added.labelIds.includes('INBOX')) add(added.message?.id);
          }
        }
        const next = response.data.nextPageToken;
        if (!next) break;
        if (typeof next !== 'string' || tokens.has(next)) throw new Error('GMAIL_HISTORY_PAGE_CYCLE');
        tokens.add(next); pageToken = next;
      }
      const emails: QueuedEmail[] = [];
      let batchBytes = 0;
      for (const id of ids) {
        cancellation.signal.throwIfAborted();
        try {
          const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' }, requestOptions);
          if (data.id !== id || typeof data.internalDate !== 'string' || !/^\d+$/.test(data.internalDate) ||
              !Number.isSafeInteger(Number(data.internalDate))) throw new Error('GMAIL_MESSAGE_ID_OR_DATE_INVALID');
          const receivedAt = new Date(Number(data.internalDate)).toISOString();
          const headers = data.payload?.headers;
          if (!Array.isArray(headers) || headers.length > 1000 || !headers.every(item => item && typeof item.name === 'string' &&
              typeof item.value === 'string') || !Array.isArray(data.labelIds) ||
              !data.labelIds.every(label => typeof label === 'string')) throw new Error('GMAIL_MESSAGE_SHAPE_INVALID');
          if (Buffer.byteLength(JSON.stringify(headers), 'utf8') > 512 * 1024) throw new Error('GMAIL_MESSAGE_HEADERS_TOO_LARGE');
          const header = (name: string) => headers.find(item => item.name?.toLowerCase() === name)?.value ?? '';
          // A missing/unrecognized full payload fails; the snippet is never a
          // substitute for the authenticated full body used in classification.
          const email = { id, sender: header('from'), subject: header('subject'), receivedAt,
            headers, inboxAtFetch: data.labelIds.includes('INBOX'), body: bodyText(data.payload) };
          batchBytes += Buffer.byteLength(JSON.stringify(email), 'utf8');
          if (batchBytes > 32 * 1024 * 1024) throw new Error('GMAIL_HISTORY_BATCH_TOO_LARGE');
          emails.push(email);
        } catch (error) {
          if (transientGmailRead(error)) throw new GmailReadRetryableError(gmailRetryAfterMs(error));
          throw new Error('GMAIL_MESSAGE_FETCH_OR_VALIDATION_FAILED');
        }
      }
      emails.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt) || a.id.localeCompare(b.id));
      return { cursor: nextCursor!, emails };
    },
    async close() { cancellation.abort(); },
  };
}

/** Owned StreamingPull RPC: every reconnect is observable; no unstable SDK debug parsing. */
function pubsubSubscription(projectId: string, subscriptionName: string, topic: string,
  config: NodeJS.ProcessEnv): GmailPushSubscription {
  const client = new v1.SubscriberClient({ projectId,
    ...(config.GOOGLE_APPLICATION_CREDENTIALS?.trim() ? { keyFilename: config.GOOGLE_APPLICATION_CREDENTIALS.trim() } : {}) });
  const clientId = randomUUID();
  const pending = new Map<string, { createdAt: number; nack: () => Promise<void> }>();
  type PullStream = Duplex & { cancel(): void };
  let stub: Awaited<ReturnType<typeof client.initialize>> | undefined;
  let stream: PullStream | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let validated = false;
  let started = false;
  let everOpened = false;
  let failures = 0;
  let serial = 0;
  let onMessage: (delivery: PubSubDelivery) => void;
  let onReconnect: () => void;
  let onFatal: (error: Error) => void;
  let resolveStarted: (() => void) | undefined;
  let rejectStarted: ((error: Error) => void) | undefined;
  let closePromise: Promise<void> | undefined;
  const unary = { timeout: 15_000, retry: null };
  const transient = new Set([1, 4, 8, 10, 13, 14]);

  const clearTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    if (leaseTimer) clearInterval(leaseTimer);
    reconnectTimer = undefined; keepaliveTimer = undefined; leaseTimer = undefined;
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    stopping = true; serial += 1; clearTimers();
    const current = stream; stream = undefined; current?.cancel();
    closePromise = (async () => {
      await Promise.allSettled([...pending.values()].map(item => item.nack()));
      pending.clear();
      await client.close().catch(() => {});
      rejectStarted?.(new Error('PUBSUB_CLOSED_BEFORE_START')); rejectStarted = undefined; resolveStarted = undefined;
    })();
    return closePromise;
  };
  const fatal = (reason: string) => {
    if (stopping) return;
    const error = new Error(reason);
    rejectStarted?.(error); rejectStarted = undefined; resolveStarted = undefined;
    try { onFatal?.(error); } catch { /* Transport shutdown must not throw from an emitter callback. */ }
    finally { void close(); }
  };

  const open = () => {
    if (stopping) return;
    const generation = ++serial;
    let active: PullStream;
    // The generated GAX StreamingPull wrapper installs a finite deadline even
    // when timeout is omitted. Its public initialize() returns the authenticated
    // gRPC service stub, whose documented Infinity deadline keeps this owned
    // stream open until provider/network interruption or explicit cancellation.
    // Do not manufacture periodic reconnects (and Gmail catch-up reads).
    try {
      if (!stub || typeof stub.streamingPull !== 'function') throw new Error();
      active = stub.streamingPull({ deadline: Infinity }) as PullStream;
    }
    catch { fatal('PUBSUB_STREAM_OPEN_FAILED'); return; }
    stream = active;
    let ended = false;
    const disconnected = (code: number = 14) => {
      if (ended || stopping || generation !== serial) return;
      ended = true; stream = undefined;
      if (keepaliveTimer) clearInterval(keepaliveTimer); keepaliveTimer = undefined;
      active.cancel();
      if (!transient.has(code)) { fatal('PUBSUB_STREAM_PERMANENT_FAILURE'); return; }
      failures += 1;
      if (failures > 6) { fatal('PUBSUB_STREAM_RECONNECT_EXHAUSTED'); return; }
      const delay = Math.min(60_000, 1000 * 2 ** (failures - 1)) + Math.floor(Math.random() * 250);
      reconnectTimer = setTimeout(() => { reconnectTimer = undefined; open(); }, delay);
    };
    active.on('error', (error: unknown) => disconnected(providerCode(error) ?? 2));
    active.on('end', () => disconnected());
    active.on('close', () => disconnected());
    active.on('data', (response: { receivedMessages?: Array<{ ackId?: string; message?: {
      messageId?: string; data?: Uint8Array | string | null;
    } }> }) => {
      if (stopping || generation !== serial || ended) return;
      failures = 0;
      try {
        if (!response || (response.receivedMessages !== undefined && !Array.isArray(response.receivedMessages))) throw new Error();
        for (const received of response.receivedMessages ?? []) {
          if (stopping) break;
          const ackId = received.ackId;
          const id = received.message?.messageId;
          if (typeof ackId !== 'string' || !ackId || typeof id !== 'string' || !id || pending.size >= 10 || pending.has(ackId)) throw new Error();
          const encoded = received.message?.data;
          const data = encoded == null ? Buffer.alloc(0) : typeof encoded === 'string'
            ? Buffer.from(encoded, 'base64') : Buffer.from(encoded);
          let decision: 'ACK' | 'NACK' | undefined;
          const settle = async (next: 'ACK' | 'NACK') => {
            if (decision === next) return;
            if (decision) throw new Error('PUBSUB_DELIVERY_ALREADY_SETTLED');
            if (stopping && next === 'ACK') throw new Error('PUBSUB_STOPPED_BEFORE_ACK');
            decision = next;
            try {
              if (next === 'ACK') await client.acknowledge({ subscription: subscriptionName, ackIds: [ackId] }, unary);
              else await client.modifyAckDeadline({ subscription: subscriptionName, ackIds: [ackId], ackDeadlineSeconds: 0 }, unary);
              pending.delete(ackId);
            } catch {
              decision = undefined;
              throw new Error('PUBSUB_DELIVERY_SETTLEMENT_FAILED');
            }
          };
          const delivery: PubSubDelivery = { id, data, ack: () => settle('ACK'), nack: () => settle('NACK') };
          pending.set(ackId, { createdAt: Date.now(), nack: delivery.nack });
          try { onMessage(delivery); } catch { void delivery.nack().catch(() => {}); throw new Error(); }
        }
      } catch { fatal('PUBSUB_DELIVERY_OR_HANDLER_FAILED'); }
    });
    const opened = (error?: Error | null) => {
      if (stopping || ended || generation !== serial) return;
      if (error) { disconnected(providerCode(error) ?? 14); return; }
      keepaliveTimer = setInterval(() => {
        if (!stopping && stream === active && !ended) {
          try { active.write({}, (writeError?: Error | null) => {
            if (writeError) disconnected(providerCode(writeError) ?? 14);
          }); } catch { disconnected(); }
        }
      }, 30_000);
      const reconnect = everOpened; everOpened = true;
      resolveStarted?.(); resolveStarted = undefined; rejectStarted = undefined;
      if (reconnect) { try { onReconnect(); } catch { fatal('PUBSUB_RECONNECT_HANDLER_FAILED'); } }
    };
    try { active.write({ subscription: subscriptionName, streamAckDeadlineSeconds: 60, clientId,
      maxOutstandingMessages: 10, maxOutstandingBytes: 1024 * 1024,
    }, opened); } catch { disconnected(); }
  };

  return {
    async validate() {
      if (stopping) throw new Error('PUBSUB_SUBSCRIPTION_CLOSED');
      try {
        const [metadata] = await client.getSubscription({ subscription: subscriptionName }, unary);
        if (metadata.name !== subscriptionName) {
          throw new Error(`PUBSUB_SUBSCRIPTION_CONTRACT_MISMATCH: name mismatch (expected "${subscriptionName}", got "${metadata.name}")`);
        }
        if (metadata.topic !== topic) {
          throw new Error(`PUBSUB_SUBSCRIPTION_CONTRACT_MISMATCH: topic mismatch (expected "${topic}", got "${metadata.topic}")`);
        }
        if (metadata.detached) {
          throw new Error('PUBSUB_SUBSCRIPTION_CONTRACT_MISMATCH: subscription is detached');
        }
        if (metadata.pushConfig?.pushEndpoint) {
          throw new Error('PUBSUB_SUBSCRIPTION_CONTRACT_MISMATCH: subscription has pushEndpoint (must be pull/streamingPull)');
        }
        stub = await client.initialize();
        if (typeof stub.streamingPull !== 'function') throw new Error('PUBSUB_STREAM_STUB_UNAVAILABLE');
        validated = true;
      } catch (err: any) {
        console.error(`\n[PubSub Validation Error] ${err?.message || err}`);
        if (err?.code) console.error(`[PubSub Validation Error] Code: ${err.code}`);
        if (err?.details) console.error(`[PubSub Validation Error] Details: ${err.details}`);
        throw new Error(`PUBSUB_SUBSCRIPTION_VALIDATION_FAILED: ${err?.message || err}`);
      }
    },
    async start(message, reconnect, failure) {
      if (!validated || started || stopping) throw new Error('PUBSUB_SUBSCRIPTION_NOT_READY');
      started = true; onMessage = message; onReconnect = reconnect; onFatal = failure;
      leaseTimer = setInterval(() => {
        if (stopping || pending.size === 0) return;
        if ([...pending.values()].some(item => Date.now() - item.createdAt > 5 * 60_000)) {
          fatal('PUBSUB_DURABLE_PERSISTENCE_DEADLINE_EXCEEDED'); return;
        }
        void Promise.resolve().then(() => client.modifyAckDeadline({ subscription: subscriptionName,
          ackIds: [...pending.keys()], ackDeadlineSeconds: 60 }, unary))
          .catch(() => fatal('PUBSUB_LEASE_EXTENSION_FAILED'));
      }, 20_000);
      await new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; open(); });
    },
    close,
  };
}

export function makeGmailPushAdapters(config: NodeJS.ProcessEnv = process.env) {
  const mailbox = required(config, 'GMAIL_ACCOUNT_EMAIL').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(mailbox)) throw new Error('GMAIL_ACCOUNT_EMAIL must identify the intended mailbox.');
  const topic = required(config, 'GOOGLE_PUBSUB_TOPIC');
  const subscriptionName = required(config, 'GOOGLE_PUBSUB_SUBSCRIPTION');
  const topicParts = /^projects\/([^/\s]+)\/topics\/([^/\s]+)$/.exec(topic);
  const subscriptionParts = /^projects\/([^/\s]+)\/subscriptions\/([^/\s]+)$/.exec(subscriptionName);
  if (!topicParts || !subscriptionParts || topicParts[1] !== subscriptionParts[1]) {
    throw new Error('Pub/Sub topic/subscription must be full resource names in the same configured project.');
  }
  return { mailbox, topic, subscriptionName, provider: gmailProvider(config, mailbox),
    subscription: pubsubSubscription(topicParts[1], subscriptionName, topic, config) };
}
