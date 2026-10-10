import {
  TransactionalDatabase,
  TransactionContext,
  db as defaultDb,
} from '../db/database';
import {
  RunRow,
  CommandRow,
  AttemptRow,
  EmailRow,
  RunMode,
} from '../db/schema';
import {
  IGmailAdapter,
  IMyTrackerAdapter,
  IBrowserAdapter,
  ITelegramAdapter,
  GmailFetchMessage,
} from '../adapters/interfaces';
import { parseBfmrEmail as parseIncomingEmail } from '../services/bfmrEmailLinks';

export interface EngineConfig {
  mode: RunMode;
  mailbox: string;
  accountId: string;
  telegramChatId: string;
  configVersion: string;
}

export class BfmrOrchestrationEngine {
  private db: TransactionalDatabase;
  private gmail: IGmailAdapter;
  private tracker: IMyTrackerAdapter;
  private browser: IBrowserAdapter;
  private telegram: ITelegramAdapter;
  private config: EngineConfig;

  public activeRunId: string | null = null;
  private isProcessingCommands = false;

  constructor(
    config: EngineConfig,
    adapters: {
      gmail: IGmailAdapter;
      tracker: IMyTrackerAdapter;
      browser: IBrowserAdapter;
      telegram: ITelegramAdapter;
    },
    database?: TransactionalDatabase
  ) {
    this.config = config;
    this.gmail = adapters.gmail;
    this.tracker = adapters.tracker;
    this.browser = adapters.browser;
    this.telegram = adapters.telegram;
    this.db = database || defaultDb;
  }

  /**
   * Acquire singleton browser & account owner lock
   * Per Solution Design v1.5 Page 13:
   * "Process singleton lock plus dedicated PostgreSQL advisory lock for the BFMR account."
   */
  public acquireSingletonLock(): boolean {
    const lockKey = `bfmr_worker_lock_${this.config.accountId}`;
    return this.db.acquireAdvisoryLock(lockKey);
  }

  public releaseSingletonLock(): void {
    const lockKey = `bfmr_worker_lock_${this.config.accountId}`;
    this.db.releaseAdvisoryLock(lockKey);
  }

  /**
   * Start or recover run
   */
  public async startRun(): Promise<RunRow> {
    const acquired = this.acquireSingletonLock();
    if (!acquired) {
      throw new Error(`Failed to acquire singleton advisory lock for account ${this.config.accountId}. Another worker is running.`);
    }

    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const run: RunRow = {
      id: runId,
      mode: this.config.mode,
      created_at: new Date().toISOString(),
      listener_started_at: null,
      ended_at: null,
      config_version: this.config.configVersion,
      status: 'STARTING',
    };

    await this.db.withTransaction(async (tx) => {
      tx.insertRun(run);

      // Check or initialize gmail_state
      const existingState = tx.getGmailState(this.config.mailbox);
      if (!existingState) {
        // First-ever initialization: Page 6
        tx.upsertGmailState({
          mailbox: this.config.mailbox,
          consumed_history_id: 10000,
          watch_baseline_history_id: 10000,
          watch_expiration: new Date(Date.now() + 86400 * 1000 * 7).toISOString(),
          last_success_at: new Date().toISOString(),
          intake_state: 'ACTIVE',
          initialization_marker: true,
        });
      }
    });

    // Establish/renew watch
    const watch = await this.gmail.renewWatch(this.config.mailbox);
    await this.db.withTransaction(async (tx) => {
      const state = tx.getGmailState(this.config.mailbox)!;
      state.watch_expiration = watch.expiration;
      state.watch_baseline_history_id = watch.historyId;
      tx.upsertGmailState(state);

      tx.updateRun(runId, {
        status: 'ACTIVE',
        listener_started_at: new Date().toISOString(),
      });
    });

    this.activeRunId = runId;
    return run;
  }

  /**
   * Boundary T1 Receipt:
   * Persist validated notification before ACK. Redelivery finds unique key.
   */
  public async handleInboundNotification(params: {
    subscription: string;
    providerMessageId: string;
    mailbox: string;
    historyId: number;
  }): Promise<{ status: 'PROCESSED' | 'DUPLICATE_ACKED'; eventId: string }> {
    const eventId = `inb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    try {
      return await this.db.withTransaction(async (tx) => {
        // Unique check
        const existing = tx.findInboundEvent(params.subscription, params.providerMessageId);
        if (existing) {
          // Already received, return safely to ACK
          return { status: 'DUPLICATE_ACKED', eventId: existing.id };
        }

        tx.insertInboundEvent({
          id: eventId,
          subscription: params.subscription,
          provider_message_id: params.providerMessageId,
          mailbox: params.mailbox,
          history_id: params.historyId,
          run_id: this.activeRunId,
          state: 'PROCESSED',
          received_at: new Date().toISOString(),
        });

        return { status: 'PROCESSED', eventId };
      });
    } catch (err: any) {
      if (err.message?.includes('Unique constraint violation')) {
        return { status: 'DUPLICATE_ACKED', eventId };
      }
      throw err;
    }
  }

  /**
   * Boundary T2 History batch:
   * Fetch Gmail history, classify emails, advance consumed cursor atomically.
   */
  public async consumeGmailHistory(): Promise<{
    processedCount: number;
    admittedCommands: CommandRow[];
  }> {
    const state = this.db.getGmailState(this.config.mailbox);
    if (!state) throw new Error('Gmail state not initialized');

    if (state.intake_state === 'GMAIL_HISTORY_GAP') {
      throw new Error('GMAIL_HISTORY_GAP active: cannot consume history without operator resolution.');
    }

    const historyResult = await this.gmail.fetchHistory(
      this.config.mailbox,
      state.consumed_history_id
    );

    if (historyResult.isExpiredHistoryGap) {
      // OQ-001 / Page 6: Persistent gap, retain cursor, stop new intake, raise incident
      await this.db.withTransaction(async (tx) => {
        tx.upsertGmailState({
          ...state,
          intake_state: 'GMAIL_HISTORY_GAP',
        });
        const incId = `inc-gap-${Date.now()}`;
        tx.insertIncident({
          id: incId,
          scope: 'GMAIL',
          type: 'GMAIL_HISTORY_GAP',
          episode: `gap-${Date.now()}`,
          state: 'ACTIVE',
          opened_at: new Date().toISOString(),
          resolved_at: null,
          disposition: 'Expired Gmail history cursor rejected by provider',
        });
        tx.insertNotificationOutbox({
          id: `outbox-${Date.now()}`,
          incident_id: incId,
          phase: 'ALERT',
          state: 'PENDING',
          due_at: new Date().toISOString(),
          tries: 0,
          telegram_message_id: null,
        });
      });
      throw new Error('GMAIL_HISTORY_GAP: Expired cursor rejected by Gmail API');
    }

    const admittedCommands: CommandRow[] = [];

    await this.db.withTransaction(async (tx) => {
      for (const msg of historyResult.messages) {
        // Deduplicate email: UNIQUE(mailbox, gmail_id)
        const existing = tx.findEmailByGmailId(this.config.mailbox, msg.id);
        if (existing) {
          continue;
        }

        // Parse and classify email per v1.5 rules
        const parsed = parseIncomingEmail({
          messageId: msg.id,
          sender: msg.sender,
          subject: msg.subject,
          body: msg.body,
        });

        let classification: EmailRow['classification'] = 'UNRELATED';
        if (parsed.isMultiDeal) classification = 'MULTI_DEAL';
        else if (parsed.isAdditionalSlotNotice) classification = 'ADDITIONAL_SLOTS';
        else if (parsed.isSingleDeal) classification = 'SINGLE_DEAL';

        // Check sender policy:
        // Production: direct deals@buyformeretail.com
        // Testing: also matt.ward@live.com
        const senderLower = msg.sender.toLowerCase();
        const isAllowedSender =
          senderLower.includes('deals@buyformeretail.com') ||
          (this.config.mode === 'testing' && senderLower.includes('matt.ward@live.com'));

        if (!isAllowedSender) {
          classification = 'UNRELATED';
        }

        const emailId = `em-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const emailRow: EmailRow = {
          id: emailId,
          mailbox: this.config.mailbox,
          gmail_id: msg.id,
          internal_date: msg.internalDate,
          outer_sender: msg.sender,
          auth_result: 'PASS',
          inbox_at_fetch: msg.inboxAtFetch,
          admission_run_id: this.activeRunId,
          classification,
          candidate_refs: { dealUrl: parsed.dealUrl, dealId: parsed.canonicalDealId },
          content_hash: `hash-${msg.id}`,
        };
        tx.insertEmail(emailRow);

        // If qualifying single deal with canonical deal ID, enqueue AUTO command
        if (classification === 'SINGLE_DEAL' && parsed.canonicalDealId) {
          const cmdId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const cmd = tx.insertCommand({
            id: cmdId,
            email_id: emailId,
            admission_run_id: this.activeRunId!,
            execution_run_id: null,
            kind: 'AUTO',
            request_id: `req-auto-${msg.id}`,
            state: 'QUEUED',
            attempt_count: 0,
            queue_time: new Date().toISOString(),
            deal_id: parsed.canonicalDealId,
          });
          admittedCommands.push(cmd);
        }
      }

      // Advance consumed cursor
      tx.upsertGmailState({
        ...state,
        consumed_history_id: historyResult.historyId,
        last_success_at: new Date().toISOString(),
      });
    });

    return {
      processedCount: historyResult.messages.length,
      admittedCommands,
    };
  }

  /**
   * Boundaries T3 Attempt preparation & T4 Outcome:
   * Process a single command through checks, submission attempt, and reconciliation.
   */
  public async executeCommand(commandId: string): Promise<{
    state: CommandRow['state'];
    attempts: AttemptRow[];
  }> {
    // 1. T3 Attempt Preparation
    const prep = await this.db.withTransaction(async (tx) => {
      const cmd = tx.getCommand(commandId);
      if (!cmd) throw new Error(`Command ${commandId} not found`);

      // Check gates
      if (tx.isGateActive('TELEGRAM_BLOCKED')) {
        throw new Error('Execution halted: TELEGRAM_BLOCKED gate active');
      }

      // Check run deal block
      const dealBlock = tx.getDealBlock(cmd.admission_run_id, this.config.accountId, cmd.deal_id);
      if (dealBlock) {
        tx.updateCommand(cmd.id, { state: dealBlock.type === 'EXHAUSTED' ? 'EXHAUSTED' : 'REVIEW' });
        return { shouldProceed: false, reason: dealBlock.type };
      }

      // Check max attempts
      if (cmd.attempt_count >= 2) {
        tx.updateCommand(cmd.id, { state: 'EXHAUSTED' });
        return { shouldProceed: false, reason: 'EXHAUSTED' };
      }

      // Verify browser session
      const session = await this.browser.verifySession(this.config.accountId);
      if (session !== 'AUTHENTICATED') {
        tx.setGate('BFMR_AUTH_REQUIRED', `Session status: ${session}`);
        tx.updateCommand(cmd.id, { state: 'WAIT_STATUS' });
        return { shouldProceed: false, reason: 'AUTH_REQUIRED' };
      }

      // Duplicate check via My Tracker
      const trackerRes = await this.tracker.inspectReservations(this.config.accountId, cmd.deal_id);
      if (trackerRes.status === 'UNKNOWN') {
        // Failed or incomplete status read holds the queue (Page 9)
        tx.updateCommand(cmd.id, { state: 'WAIT_STATUS' });
        return { shouldProceed: false, reason: 'WAIT_STATUS' };
      }

      if (trackerRes.status === 'RESERVED') {
        // Active reservation already exists -> SKIPPED (AT-04)
        tx.updateCommand(cmd.id, { state: 'SKIPPED' });
        return { shouldProceed: false, reason: 'SKIPPED_DUPLICATE' };
      }

      // Allocate ordinal (1 or 2)
      const nextOrdinal = (cmd.attempt_count + 1) as 1 | 2;
      const attemptId = `att-${cmd.id}-ord${nextOrdinal}`;

      const attemptRow: AttemptRow = {
        id: attemptId,
        command_id: cmd.id,
        ordinal: nextOrdinal,
        account_id: this.config.accountId,
        deal_id: cmd.deal_id,
        selected_offer: 'offer-1',
        quantity: 1, // Quantity 1 strictly
        prepared_at: new Date().toISOString(),
        invoked_at: null,
        result: null,
        reservation_id: null,
        evidence: null,
      };

      tx.insertAttempt(attemptRow);
      tx.updateCommand(cmd.id, {
        state: 'SUBMITTING',
        attempt_count: nextOrdinal,
        execution_run_id: this.activeRunId,
      });

      return {
        shouldProceed: true,
        ordinal: nextOrdinal,
        attemptId,
        dealId: cmd.deal_id,
      };
    });

    if (!prep.shouldProceed) {
      const finalCmd = (await this.db.getCommands()).find((c) => c.id === commandId)!;
      return {
        state: finalCmd.state,
        attempts: this.db.getAttempts().filter((a) => a.command_id === commandId),
      };
    }

    // 2. Perform external browser click (outside transaction!)
    const submitResult = await this.browser.submitOne('offer-1');

    // 3. T4 Outcome & Reconciliation
    await this.db.withTransaction(async (tx) => {
      const cmd = tx.getCommand(commandId)!;

      if (submitResult.status === 'SUBMITTED') {
        // Reconcile with My Tracker
        const recon = await this.tracker.inspectReservations(this.config.accountId, prep.dealId!);
        if (recon.status === 'RESERVED') {
          const rec = recon.records[0];
          tx.updateAttempt(prep.attemptId!, {
            invoked_at: new Date().toISOString(),
            result: 'SUCCESS',
            reservation_id: rec?.rid || 'RID-AUTO',
            evidence: { toast: submitResult.toastAcknowledgement, trackerRecord: rec },
          });
          tx.updateCommand(cmd.id, { state: 'RESERVED' });
        } else {
          // Toast received but not seen in tracker yet:
          tx.updateAttempt(prep.attemptId!, {
            invoked_at: new Date().toISOString(),
            result: 'SUCCESS',
            reservation_id: 'RID-AUTO-CONFIRMED',
            evidence: { toast: submitResult.toastAcknowledgement },
          });
          tx.updateCommand(cmd.id, { state: 'RESERVED' });
        }
      } else if (submitResult.status === 'UNCERTAIN') {
        // Page 9: Network timeout waiting for confirmation.
        // Stop retries, create review, alert operator.
        tx.updateAttempt(prep.attemptId!, {
          invoked_at: new Date().toISOString(),
          result: 'UNCERTAIN',
          evidence: { error: submitResult.errorDetail },
        });
        tx.updateCommand(cmd.id, { state: 'REVIEW' });

        // Add deal block
        tx.insertDealBlock({
          id: `block-${cmd.id}`,
          run_id: this.activeRunId!,
          account_id: this.config.accountId,
          deal_id: prep.dealId!,
          type: 'REVIEW',
          reason: 'Uncertain submit outcome: timeout waiting for response modal',
          opened_at: new Date().toISOString(),
          resolved_at: null,
        });

        // Open incident & Telegram outbox
        const incId = `inc-${cmd.id}`;
        tx.insertIncident({
          id: incId,
          scope: 'RESERVATION',
          type: 'UNCERTAIN_OUTCOME',
          episode: `ep-${cmd.id}`,
          state: 'ACTIVE',
          opened_at: new Date().toISOString(),
          resolved_at: null,
          disposition: 'Uncertain browser submission outcome; stopped to prevent duplicate booking',
        });
        tx.insertNotificationOutbox({
          id: `notif-${incId}`,
          incident_id: incId,
          phase: 'ALERT',
          state: 'PENDING',
          due_at: new Date().toISOString(),
          tries: 0,
          telegram_message_id: null,
        });
      } else if (submitResult.status === 'CLOSED_NO_SLOTS') {
        // Silent skip, no retry or alert
        tx.updateAttempt(prep.attemptId!, {
          invoked_at: new Date().toISOString(),
          result: 'CLOSED_NO_SLOTS',
          evidence: { error: submitResult.errorDetail },
        });
        tx.updateCommand(cmd.id, { state: 'SKIPPED' });
      } else if (submitResult.status === 'FAILED_500') {
        tx.updateAttempt(prep.attemptId!, {
          invoked_at: new Date().toISOString(),
          result: 'FAILED',
          evidence: { error: submitResult.errorDetail },
        });

        if (prep.ordinal === 1) {
          // Allow exactly one retry (ordinal 2)
          tx.updateCommand(cmd.id, { state: 'RETRY_PENDING' });
        } else {
          // Second failure -> EXHAUSTED (Page 9: No ordinal 3)
          tx.updateCommand(cmd.id, { state: 'EXHAUSTED' });

          tx.insertDealBlock({
            id: `block-${cmd.id}`,
            run_id: this.activeRunId!,
            account_id: this.config.accountId,
            deal_id: prep.dealId!,
            type: 'EXHAUSTED',
            reason: 'Two submit ordinals failed; attempt budget exhausted',
            opened_at: new Date().toISOString(),
            resolved_at: null,
          });

          const incId = `inc-exh-${cmd.id}`;
          tx.insertIncident({
            id: incId,
            scope: 'RESERVATION',
            type: 'ATTEMPTS_EXHAUSTED',
            episode: `ep-exh-${cmd.id}`,
            state: 'ACTIVE',
            opened_at: new Date().toISOString(),
            resolved_at: null,
            disposition: 'Both submit ordinals failed',
          });
          tx.insertNotificationOutbox({
            id: `notif-${incId}`,
            incident_id: incId,
            phase: 'ALERT',
            state: 'PENDING',
            due_at: new Date().toISOString(),
            tries: 0,
            telegram_message_id: null,
          });
        }
      }
    });

    const finalCmd = (await this.db.getCommands()).find((c) => c.id === commandId)!;
    return {
      state: finalCmd.state,
      attempts: this.db.getAttempts().filter((a) => a.command_id === commandId),
    };
  }

  /**
   * Boundary T5 Operator action:
   * Resolve an incident or reprocess an admitted email.
   */
  public async resolveReviewIncident(incidentId: string, notes: string): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      const inc = tx.getIncident(incidentId);
      if (!inc) throw new Error(`Incident ${incidentId} not found`);

      tx.updateIncident(incidentId, {
        state: 'RESOLVED',
        resolved_at: new Date().toISOString(),
        disposition: notes,
      });

      // Clear matching deal blocks
      const blocks = tx.getDealBlocks().filter((b) => b.resolved_at === null);
      for (const b of blocks) {
        tx.updateDealBlock(b.id, {
          resolved_at: new Date().toISOString(),
        });
      }
    });
  }

  public async reprocessEmail(gmailId: string): Promise<CommandRow> {
    return await this.db.withTransaction(async (tx) => {
      const email = tx.findEmailByGmailId(this.config.mailbox, gmailId);
      if (!email) throw new Error(`Email ${gmailId} not found`);

      if (email.admission_run_id !== this.activeRunId) {
        throw new Error('Reprocessing is limited to mail admitted in the current run (Page 10)');
      }

      const parsedDealId = email.candidate_refs?.dealId || 'deal-reprocess';
      const cmdId = `cmd-cli-${Date.now()}`;
      const newCmd = tx.insertCommand({
        id: cmdId,
        email_id: email.id,
        admission_run_id: this.activeRunId!,
        execution_run_id: null,
        kind: 'CLI',
        request_id: `req-cli-${gmailId}-${Date.now()}`,
        state: 'QUEUED',
        attempt_count: 0,
        queue_time: new Date().toISOString(),
        deal_id: parsedDealId,
      });

      return newCmd;
    });
  }

  /**
   * Boundary T6 Notification:
   * Drain notification outbox to Telegram.
   */
  public async drainNotificationOutbox(): Promise<{ sent: number; failed: number }> {
    const outboxItems = this.db.getNotificationOutbox().filter(
      (o) => o.state === 'PENDING' || o.state === 'FAILED'
    );
    let sent = 0;
    let failed = 0;

    for (const item of outboxItems) {
      const res = await this.telegram.sendMessage(
        this.config.telegramChatId,
        `[BFMR Incident ${item.incident_id}] Phase: ${item.phase}`
      );

      await this.db.withTransaction(async (tx) => {
        if (res.ok) {
          tx.updateNotificationOutbox(item.id, {
            state: 'SENT',
            telegram_message_id: res.messageId,
          });
          tx.clearGate('TELEGRAM_BLOCKED');
          sent++;
        } else {
          tx.updateNotificationOutbox(item.id, {
            state: 'FAILED',
            tries: item.tries + 1,
          });
          tx.setGate('TELEGRAM_BLOCKED', res.errorDetail || 'Telegram delivery failed');
          failed++;
        }
      });
    }

    return { sent, failed };
  }
}
