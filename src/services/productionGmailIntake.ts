import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { QueuedEmail } from './gmailIntakeQueue';
import type { PostgresGmailIntakeStore } from './postgresGmailIntake';
import { GmailHistoryGapError, GmailReadRetryableError,
  type GmailPushProvider, type GmailPushSubscription, type PubSubDelivery } from './gmailPushTransport';

const DAY_MS = 24 * 60 * 60 * 1000;
const WATCH_MARGIN_MS = 5 * 60 * 1000;
type WakeReason = 'STARTUP' | 'RECONNECT' | 'NOTIFICATION';

/** Narrow persistence boundary permits deterministic offline failure injection. */
export type ProductionGmailIntakeStore = Pick<PostgresGmailIntakeStore,
  'validateSchema' | 'load' | 'startRun' | 'setWatch' | 'activate' | 'recordNotification'
  | 'pendingNotifications' | 'ingest' | 'markGap' | 'mark' | 'stopRun'>;

/** Do not silently start a new SQL mailbox over a previously used private queue.
 * Accepted source bytes remain a recovery boundary after explicit import.
 */
export async function assertLegacyGmailSource(store: Pick<PostgresGmailIntakeStore, 'legacySourceHash'>, file: string): Promise<void> {
  let hash: string | null = null;
  try { hash = createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Legacy Gmail source is unreadable; restore/reconcile before intake.'); }
  const accepted = await store.legacySourceHash();
  if (hash !== accepted) {
    throw new Error('Legacy Gmail queue needs an explicit reviewed import or source restoration. Intake does not reset or import it at startup.');
  }
}

/** Independent intake coordinator. Browser work cannot hold up notification
 * commits/ACKs or event-triggered history continuation. This class never starts
 * Gmail work from a quiet-mailbox timer and never lists the Inbox.
 */
export class ProductionGmailIntake {
  private runId: string | undefined;
  private active = false;
  private stopped = false;
  private failure: Error | undefined;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private renewal: Promise<void> = Promise.resolve();
  private deliveryTail: Promise<void> = Promise.resolve();
  private historyTask: Promise<void> | undefined;
  private readonly reasons = new Set<WakeReason>();
  private readonly buffered: PubSubDelivery[] = [];
  private readonly abort = new AbortController();
  private revision = 0;
  private readonly waiters = new Set<() => void>();
  private closing: Promise<void> | undefined;
  private watchExpiresAt = 0;

  constructor(private readonly options: {
    mailbox: string;
    topic: string;
    store: ProductionGmailIntakeStore;
    provider: GmailPushProvider;
    subscription: GmailPushSubscription;
    verifyOwnership: () => Promise<void>;
    admit: (email: QueuedEmail) => boolean;
    onFailure: (error: Error) => Promise<void>;
  }) {}

  assertHealthy(): void {
    if (this.active && Date.now() >= this.watchExpiresAt) this.fail(new Error('Gmail watch expired.'));
    if (this.failure) throw this.failure;
    if (this.stopped || !this.active) throw new Error('Production Gmail intake is not active; no new external work is allowed.');
  }

  private wake(): void {
    this.revision += 1;
    for (const resolve of [...this.waiters]) resolve();
  }

  private fail(error: unknown): void {
    if (this.failure || this.stopped) return;
    this.failure = error instanceof GmailHistoryGapError ? error
      : new Error('Production Gmail intake stopped; inspect its durable state and provider configuration before restarting.');
    clearTimeout(this.watchTimer);
    this.abort.abort();
    this.wake();
    // Stop deliveries immediately. No provider watch deletion: downtime history
    // and unacknowledged/redeliverable notifications remain recoverable.
    void this.options.subscription.close().catch(() => {});
    void this.options.provider.close().catch(() => {});
    void this.options.onFailure(this.failure).catch(() => {});
  }

  async start(allowInitialize = false): Promise<void> {
    if (this.runId || this.stopped) throw new Error('Production Gmail intake cannot be started twice.');
    const { store, provider, subscription } = this.options;
    try {
      await this.options.verifyOwnership();
      await store.validateSchema();
      const state = await store.load();
      if (!state && !allowInitialize) throw new Error('Gmail SQL state is missing; restore/import prior state or explicitly authorize authentic first-ever initialization.');
      if (state?.gap) throw new GmailHistoryGapError();
      const profile = await provider.getProfile();
      if (profile.mailbox !== this.options.mailbox) throw new Error('Configured and authenticated Gmail mailbox do not match.');
      await subscription.validate();
      this.runId = await store.startRun();
      await this.renewWatch(allowInitialize);
      await subscription.start(delivery => this.receive(delivery),
        () => { if (this.active && !this.stopped) this.requestHistory('RECONNECT'); },
        error => this.fail(error));
      if (this.failure || this.stopped) throw this.failure ?? new Error('Intake startup was interrupted.');
      await store.activate(this.runId);
      this.active = true;
      for (const delivery of this.buffered.splice(0)) this.receive(delivery);
      this.requestHistory('STARTUP');
      await this.historyTask;
      this.assertHealthy();
    } catch (error) {
      this.fail(error);
      await this.stop();
      // Exceptions from transports/store are deliberately sanitized; do not
      // surface OAuth payloads, email contents or database connection details.
      throw error instanceof GmailHistoryGapError ? error
        : new Error('Production Gmail startup failed; verify configuration, reviewed intake SQL, accepted legacy state and ownership.');
    }
  }

  private async renewWatch(allowInitialize: boolean): Promise<void> {
    if (this.stopped || this.failure) return;
    await this.options.verifyOwnership();
    const watch = await this.options.provider.watch(this.options.topic);
    if (this.stopped || this.failure) return;
    if (!Number.isSafeInteger(watch.expirationMs) || watch.expirationMs <= Date.now() + WATCH_MARGIN_MS) {
      throw new Error('Gmail watch expiration cannot establish safe notification coverage.');
    }
    await this.options.store.setWatch(this.runId!, watch, allowInitialize);
    if (this.stopped || this.failure) return;
    this.watchExpiresAt = watch.expirationMs;
    clearTimeout(this.watchTimer);
    const delay = Math.min(DAY_MS, watch.expirationMs - Date.now() - WATCH_MARGIN_MS);
    // This timer only renews the watch. It never initiates a Gmail history read.
    this.watchTimer = setTimeout(() => {
      this.renewal = this.renewWatch(false).catch(error => this.fail(error));
    }, Math.max(1, delay));
  }

  private receive(delivery: PubSubDelivery): void {
    if (this.stopped || this.failure) { void Promise.resolve(delivery.nack()).catch(() => {}); return; }
    if (!this.active) {
      // Transport flow control bounds all outstanding deliveries to ten.
      if (this.buffered.length >= 10) { void Promise.resolve(delivery.nack()).catch(() => {}); this.fail(new Error('Startup delivery buffer exceeded.')); }
      else this.buffered.push(delivery);
      return;
    }
    const task = this.deliveryTail.then(async () => {
      if (this.stopped || this.failure) { await delivery.nack(); return; }
      if (!delivery.id || delivery.id.length > 256) throw new Error('Pub/Sub delivery lacks a usable exact message identity.');
      let historyId: string | null = null;
      let rejection: string | null = null;
      try {
        const value = JSON.parse(delivery.data.toString('utf8')) as Record<string, unknown>;
        if (!value || Array.isArray(value) || typeof value !== 'object') rejection = 'INVALID_SHAPE';
        else if (typeof value.emailAddress !== 'string' || value.emailAddress.trim().toLowerCase() !== this.options.mailbox) rejection = 'MAILBOX_MISMATCH';
        else if (typeof value.historyId !== 'string' || !/^[1-9]\d*$/.test(value.historyId)) rejection = 'INVALID_HISTORY_ID';
        else historyId = value.historyId;
      } catch { rejection = 'INVALID_JSON'; }
      await this.options.store.recordNotification(this.runId!, {
        messageId: delivery.id, payloadSha256: createHash('sha256').update(delivery.data).digest('hex'), historyId, rejection,
      });
      // ACK (including poison/verified duplicate delivery) follows the successful
      // database commit. Storage errors can never fall through to ACK.
      await delivery.ack();
      if (!rejection) this.requestHistory('NOTIFICATION');
      this.wake();
    });
    this.deliveryTail = task.catch(async error => {
      await Promise.resolve(delivery.nack()).catch(() => {});
      this.fail(error);
    });
  }

  private requestHistory(reason: WakeReason): void {
    if (this.stopped || this.failure) return;
    this.reasons.add(reason);
    if (this.historyTask) return;
    this.historyTask = this.drainHistory().catch(error => this.fail(error)).finally(() => {
      this.historyTask = undefined;
      // A delivery can race the final await/finally. Never lose its wakeup.
      if (this.reasons.size && !this.stopped && !this.failure) this.requestHistory('NOTIFICATION');
    });
  }

  private async pause(ms: number): Promise<void> {
    if (this.abort.signal.aborted) throw new Error('Intake stopped.');
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(new Error('Intake stopped.')); };
      const timer = setTimeout(() => { this.abort.signal.removeEventListener('abort', stop); resolve(); }, ms);
      this.abort.signal.addEventListener('abort', stop, { once: true });
    });
  }

  private async drainHistory(): Promise<void> {
    while (this.reasons.size && !this.stopped && !this.failure) {
      const force = this.reasons.has('STARTUP') || this.reasons.has('RECONNECT');
      this.reasons.clear();
      const state = await this.options.store.load();
      if (!state || state.gap) throw new GmailHistoryGapError();
      const notifications = await this.options.store.pendingNotifications();
      const target = notifications.reduce((max, item) => BigInt(item.historyId) > max ? BigInt(item.historyId) : max, BigInt(state.cursor));
      if (!force && target <= BigInt(state.cursor)) {
        if (notifications.length) await this.options.store.ingest(state.cursor, state.cursor, [], notifications.map(item => item.messageId));
        if ((await this.options.store.pendingNotifications()).length) this.reasons.add('NOTIFICATION');
        continue;
      }
      let committed = false;
      for (let attempt = 0; attempt < 3 && !committed; attempt += 1) {
        if (this.stopped || this.failure) return;
        try {
          await this.options.verifyOwnership();
          const batch = await this.options.provider.historySince(state.cursor, new Set(state.work.map(item => item.id)));
          if (BigInt(batch.cursor) < target) throw new GmailReadRetryableError();
          const emails = batch.emails.map(email => ({ ...email,
            intakeDisposition: this.options.admit(email) ? 'ADMITTED' as const : 'IGNORED' as const }));
          if (this.stopped || this.failure) return;
          await this.options.store.ingest(state.cursor, batch.cursor, emails, notifications.map(item => item.messageId));
          committed = true;
          this.wake();
          if ((await this.options.store.pendingNotifications()).length) this.reasons.add('NOTIFICATION');
        } catch (error) {
          if (error instanceof GmailHistoryGapError) { await this.options.store.markGap(); throw error; }
          if (!(error instanceof GmailReadRetryableError) || attempt === 2) throw error;
          // Bounded retry of this triggered read, not quiet-mailbox polling.
          await this.pause(Math.max(5000 * 2 ** attempt + Math.floor(Math.random() * 1000), error.retryAfterMs));
        }
      }
    }
  }

  async hasIncomingMail(): Promise<boolean> {
    this.assertHealthy();
    const state = await this.options.store.load();
    if (!state || state.gap) throw new GmailHistoryGapError();
    return state.work.some(item => item.state !== 'DONE') || (await this.options.store.pendingNotifications()).length > 0;
  }

  async *emails(onIdle: (hasIncomingMail: () => Promise<boolean>) => Promise<void>): AsyncGenerator<QueuedEmail> {
    while (!this.stopped) {
      this.assertHealthy();
      const version = this.revision;
      const state = await this.options.store.load();
      if (!state || state.gap) throw new GmailHistoryGapError();
      if (state.work.some(item => item.state === 'PROCESSING')) throw new Error('Interrupted Gmail processing requires authoritative BFMR/Amazon reconciliation; no replay is allowed.');
      const item = state.work.find(item => item.state === 'PENDING');
      if (item) {
        if (!item.email) throw new Error('Queued Gmail payload is missing; restore/reconcile before processing.');
        // Recheck provenance/classification at the consumer boundary, including
        // older explicitly imported work that predates SQL admissions.
        if (!this.options.admit(item.email)) { await this.options.store.mark(item.id, 'DONE'); continue; }
        await this.options.store.mark(item.id, 'PROCESSING');
        yield item.email;
        this.assertHealthy();
        await this.options.store.mark(item.id, 'DONE');
        continue;
      }
      await onIdle(() => this.hasIncomingMail());
      if (this.stopped || this.failure || version !== this.revision) continue;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
        // Local browser/maintenance scheduling only: no Gmail call on this timer.
        const timer = setTimeout(done, 60000);
        this.waiters.add(done);
        if (this.stopped || this.failure || version !== this.revision) done();
      });
    }
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.active = false;
    clearTimeout(this.watchTimer);
    this.abort.abort();
    this.wake();
    this.closing = (async () => {
      for (const delivery of this.buffered.splice(0)) await Promise.resolve(delivery.nack()).catch(() => {});
      await this.options.subscription.close().catch(() => {});
      await this.options.provider.close().catch(() => {});
      await Promise.allSettled([this.deliveryTail, this.historyTask, this.renewal]);
      if (this.runId) await this.options.store.stopRun(this.runId).catch(() => {});
    })();
    return this.closing;
  }
}
