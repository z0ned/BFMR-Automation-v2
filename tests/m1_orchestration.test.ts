import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TransactionalDatabase } from '../src/db/database';
import { BfmrOrchestrationEngine } from '../src/orchestrator/engine';
import {
  FakeGmailAdapter,
  FakeMyTrackerAdapter,
  FakeBrowserAdapter,
  FakeTelegramAdapter,
} from '../src/adapters/fakes';

describe('Milestone M1: Durable Orchestration & Invariant Tests', () => {
  let db: TransactionalDatabase;
  let gmail: FakeGmailAdapter;
  let tracker: FakeMyTrackerAdapter;
  let browser: FakeBrowserAdapter;
  let telegram: FakeTelegramAdapter;
  let engine: BfmrOrchestrationEngine;

  const config = {
    mode: 'testing' as const,
    mailbox: 'deals@buyformeretail.com',
    accountId: 'bfmr-acc-matt',
    telegramChatId: '-1004928172',
    configVersion: 'v1.5',
  };

  beforeEach(async () => {
    db = new TransactionalDatabase();
    gmail = new FakeGmailAdapter();
    tracker = new FakeMyTrackerAdapter();
    browser = new FakeBrowserAdapter();
    telegram = new FakeTelegramAdapter();

    engine = new BfmrOrchestrationEngine(
      config,
      { gmail, tracker, browser, telegram },
      db
    );

    await engine.startRun();
  });

  it('AT-01: Valid Pub/Sub delivery is durably stored before ACK; duplicate delivery is deduplicated', async () => {
    const sub = 'projects/p/subscriptions/s';
    const msgId = 'provider-msg-101';

    // First delivery -> PROCESSED
    const res1 = await engine.handleInboundNotification({
      subscription: sub,
      providerMessageId: msgId,
      mailbox: config.mailbox,
      historyId: 10001,
    });
    assert.equal(res1.status, 'PROCESSED');

    const inbounds = db.getInboundEvents();
    assert.equal(inbounds.length, 1);
    assert.equal(inbounds[0].provider_message_id, msgId);

    // Duplicate delivery -> DUPLICATE_ACKED without duplicate row
    const res2 = await engine.handleInboundNotification({
      subscription: sub,
      providerMessageId: msgId,
      mailbox: config.mailbox,
      historyId: 10001,
    });
    assert.equal(res2.status, 'DUPLICATE_ACKED');
    assert.equal(db.getInboundEvents().length, 1);
  });

  it('AT-05: Singleton worker lock prevents concurrent execution', async () => {
    // Current engine owns the lock
    const secondEngine = new BfmrOrchestrationEngine(
      config,
      { gmail, tracker, browser, telegram },
      db
    );

    // Attempting to start run on second engine must fail
    await assert.rejects(
      async () => {
        await secondEngine.startRun();
      },
      /Failed to acquire singleton advisory lock/
    );

    // Release lock on first engine, then second engine can acquire
    engine.releaseSingletonLock();
    const secondRun = await secondEngine.startRun();
    assert.ok(secondRun.id);
  });

  it('AT-04 & AT-05: Existing reservation in My Tracker skips creation; failed read transitions to WAIT_STATUS', async () => {
    // Seed email in gmail
    gmail.messagesQueue = [
      {
        id: 'gmail-msg-ipad',
        internalDate: Date.now(),
        sender: 'deals@buyformeretail.com',
        headers: [{ name: 'From', value: 'deals@buyformeretail.com' }, { name: 'Received', value: 'from mail.example by mx.google.com with ESMTPS' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=buyformeretail.com; dkim=pass header.d=buyformeretail.com' }],
        subject: 'New Deal: iPad Pro M4 11-inch',
        body: 'We posted a new deal. Deal link: https://www.buyformeretail.com/deals/ipad-m4',
        inboxAtFetch: true,
      },
    ];

    // Consume history
    const batch = await engine.consumeGmailHistory();
    assert.equal(batch.admittedCommands.length, 1);
    const cmdId = batch.admittedCommands[0].id;

    // Case 1: Active reservation exists in My Tracker -> SKIPPED
    tracker.addReservation('ipad-m4');
    const exec1 = await engine.executeCommand(cmdId);
    assert.equal(exec1.state, 'SKIPPED');
    assert.equal(exec1.attempts.length, 0); // No browser attempt allocated!

    // Case 2: Failed tracker read -> WAIT_STATUS
    tracker.reservations = [];
    tracker.shouldFailRead = true;
    // Reset command state to QUEUED to test retry
    await db.withTransaction(async tx => { tx.updateCommand(db.getCommands()[0].id, { state: 'QUEUED' }); });

    const exec2 = await engine.executeCommand(cmdId);
    assert.equal(exec2.state, 'WAIT_STATUS');
    assert.equal(exec2.attempts.length, 0);
  });

  it('AT-08 & AT-14: Submit timeout results in UNCERTAIN, halts automatic retry, opens review block & alerts Telegram', async () => {
    gmail.messagesQueue = [
      {
        id: 'gmail-msg-sony',
        internalDate: Date.now(),
        sender: 'deals@buyformeretail.com',
        headers: [{ name: 'From', value: 'deals@buyformeretail.com' }, { name: 'Received', value: 'from mail.example by mx.google.com with ESMTPS' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=buyformeretail.com; dkim=pass header.d=buyformeretail.com' }],
        subject: 'New Deal: Sony WH-1000XM5',
        body: 'We posted a new deal. Deal link: https://www.buyformeretail.com/deals/sony-xm5',
        inboxAtFetch: true,
      },
    ];

    const batch = await engine.consumeGmailHistory();
    const cmdId = batch.admittedCommands[0].id;

    // Set browser to timeout / UNCERTAIN
    browser.submitOutcome = 'UNCERTAIN';

    const exec = await engine.executeCommand(cmdId);
    assert.equal(exec.state, 'REVIEW');
    assert.equal(exec.attempts.length, 1);
    assert.equal(exec.attempts[0].ordinal, 1);
    assert.equal(exec.attempts[0].result, 'UNCERTAIN');

    // Assert deal block was created
    const blocks = db.getDealBlocks();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].deal_id, 'sony-xm5');
    assert.equal(blocks[0].type, 'REVIEW');

    // Assert Incident and Outbox entry created
    const incidents = db.getIncidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].type, 'UNCERTAIN_OUTCOME');

    const outbox = db.getNotificationOutbox();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].phase, 'ALERT');

    // Trying to re-execute without resolving must not submit
    const execRetry = await engine.executeCommand(cmdId);
    assert.equal(execRetry.state, 'REVIEW');
    assert.equal(browser.submitCallCount, 1); // Zero additional submit calls!
  });

  it('AT-09: Maximum two submit ordinals per command; second failure enters EXHAUSTED with zero ordinal 3', async () => {
    gmail.messagesQueue = [
      {
        id: 'gmail-msg-switch',
        internalDate: Date.now(),
        sender: 'deals@buyformeretail.com',
        headers: [{ name: 'From', value: 'deals@buyformeretail.com' }, { name: 'Received', value: 'from mail.example by mx.google.com with ESMTPS' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=buyformeretail.com; dkim=pass header.d=buyformeretail.com' }],
        subject: 'New Deal: Nintendo Switch OLED',
        body: 'We posted a new deal. Deal link: https://www.buyformeretail.com/deals/switch-oled',
        inboxAtFetch: true,
      },
    ];

    const batch = await engine.consumeGmailHistory();
    const cmdId = batch.admittedCommands[0].id;

    // Set browser to fail with 500
    browser.submitOutcome = 'FAILED_500';

    // Attempt 1 -> RETRY_PENDING (ordinal 1 consumed)
    const exec1 = await engine.executeCommand(cmdId);
    assert.equal(exec1.state, 'RETRY_PENDING');
    assert.equal(exec1.attempts.length, 1);
    assert.equal(exec1.attempts[0].ordinal, 1);
    assert.equal(browser.submitCallCount, 1);

    // Attempt 2 (Retry) -> EXHAUSTED (ordinal 2 consumed)
    const exec2 = await engine.executeCommand(cmdId);
    assert.equal(exec2.state, 'EXHAUSTED');
    assert.equal(exec2.attempts.length, 2);
    assert.equal(exec2.attempts[1].ordinal, 2);
    assert.equal(browser.submitCallCount, 2);

    // Attempt 3 -> Rejected by budget, never invokes browser!
    const exec3 = await engine.executeCommand(cmdId);
    assert.equal(exec3.state, 'EXHAUSTED');
    assert.equal(browser.submitCallCount, 2); // Strictly no ordinal 3!
  });

  it('AT-11 & AT-18: Notification failure halts new deal work via TELEGRAM_BLOCKED; successful send clears gate', async () => {
    gmail.messagesQueue = [
      {
        id: 'gmail-msg-bose',
        internalDate: Date.now(),
        sender: 'deals@buyformeretail.com',
        headers: [{ name: 'From', value: 'deals@buyformeretail.com' }, { name: 'Received', value: 'from mail.example by mx.google.com with ESMTPS' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=buyformeretail.com; dkim=pass header.d=buyformeretail.com' }],
        subject: 'New Deal: Bose Headphones',
        body: 'We posted a new deal. Deal link: https://www.buyformeretail.com/deals/bose-qc',
        inboxAtFetch: true,
      },
    ];

    const batch = await engine.consumeGmailHistory();
    const cmdId = batch.admittedCommands[0].id;

    // Force failure on Telegram
    telegram.shouldFail = true;

    // Trigger incident to populate outbox
    browser.submitOutcome = 'UNCERTAIN';
    await engine.executeCommand(cmdId);

    // Drain outbox -> Fails
    const drainFail = await engine.drainNotificationOutbox();
    assert.equal(drainFail.failed, 1);
    assert.equal(db.getRuntimeGates().length, 1);
    assert.equal(db.getRuntimeGates()[0].gate_name, 'TELEGRAM_BLOCKED');

    // New deal command must be blocked while TELEGRAM_BLOCKED is active
    const nextCmd = db.getCommands()[0];
    await assert.rejects(
      async () => {
        await engine.executeCommand(nextCmd.id);
      },
      /TELEGRAM_BLOCKED/
    );

    // Now restore Telegram delivery
    telegram.shouldFail = false;
    const drainSuccess = await engine.drainNotificationOutbox();
    assert.equal(drainSuccess.sent, 1);
    assert.equal(db.getRuntimeGates().length, 0); // Gate cleared!
  });

  it('AT-10: Operator review resolution and explicit current-run replay', async () => {
    gmail.messagesQueue = [
      {
        id: 'gmail-msg-camera',
        internalDate: Date.now(),
        sender: 'deals@buyformeretail.com',
        headers: [{ name: 'From', value: 'deals@buyformeretail.com' }, { name: 'Received', value: 'from mail.example by mx.google.com with ESMTPS' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=buyformeretail.com; dkim=pass header.d=buyformeretail.com' }],
        subject: 'New Deal: Canon EOS R50',
        body: 'We posted a new deal. Deal link: https://www.buyformeretail.com/deals/canon-r50',
        inboxAtFetch: true,
      },
    ];

    const batch = await engine.consumeGmailHistory();
    const cmdId = batch.admittedCommands[0].id;

    // Trigger review
    browser.submitOutcome = 'UNCERTAIN';
    await engine.executeCommand(cmdId);

    const incidents = db.getIncidents();
    assert.equal(incidents.length, 1);
    const incId = incidents[0].id;

    // Operator resolves review
    await engine.resolveReviewIncident(incId, 'Confirmed manual non-creation');
    const updatedInc = db.getIncidents()[0];
    assert.equal(updatedInc.state, 'RESOLVED');

    // Operator requests reprocessing for the email
    const reprocessedCmd = await engine.reprocessEmail('gmail-msg-camera');
    assert.equal(reprocessedCmd.kind, 'CLI');
    assert.equal(reprocessedCmd.attempt_count, 0);
    assert.equal(reprocessedCmd.state, 'QUEUED');

    // Replay executes with fresh budget (no duplicate active before submit)
    browser.submitOutcome = 'SUBMITTED';
    const originalSubmit = browser.submitOne.bind(browser);
    browser.submitOne = async offer => { const result = await originalSubmit(offer); tracker.addReservation(db.getCommands().find(cmd => cmd.state === 'SUBMITTING')!.deal_id, offer); return result; };
    tracker.reservations = [];
    const execReplay = await engine.executeCommand(reprocessedCmd.id);
    assert.equal(execReplay.state, 'RESERVED');
  });

  it('OQ-001 / Page 6: Expired Gmail cursor halts intake with GMAIL_HISTORY_GAP instead of unauthorized sweep', async () => {
    gmail.shouldSimulateExpiredGap = true;

    await assert.rejects(
      async () => {
        await engine.consumeGmailHistory();
      },
      /GMAIL_HISTORY_GAP/
    );

    const state = db.getGmailState(config.mailbox);
    assert.equal(state?.intake_state, 'GMAIL_HISTORY_GAP');

    const incidents = db.getIncidents().filter((i) => i.type === 'GMAIL_HISTORY_GAP');
    assert.equal(incidents.length, 1);
  });

  it('AT-15: Restart in RETRY_PENDING preserves ordinal 2 only; terminal EXHAUSTED is not re-enqueued', async () => {
    // Command created and failed once in run 1
    gmail.messagesQueue = [
      {
        id: 'gmail-msg-restart-test',
        internalDate: Date.now(),
        sender: 'deals@buyformeretail.com',
        headers: [{ name: 'From', value: 'deals@buyformeretail.com' }, { name: 'Received', value: 'from mail.example by mx.google.com with ESMTPS' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=buyformeretail.com; dkim=pass header.d=buyformeretail.com' }],
        subject: 'New Deal: Pixel 9 Pro',
        body: 'We posted a new deal. Deal link: https://www.buyformeretail.com/deals/pixel-9-pro',
        inboxAtFetch: true,
      },
    ];
    const batch = await engine.consumeGmailHistory();
    const cmdId = batch.admittedCommands[0].id;

    browser.submitOutcome = 'FAILED_500';
    const firstExec = await engine.executeCommand(cmdId);
    assert.equal(firstExec.state, 'RETRY_PENDING');
    assert.equal(firstExec.attempts.length, 1);
    assert.equal(firstExec.attempts[0].ordinal, 1);

    // Simulate restart with new engine / new run
    engine.releaseSingletonLock();
    const restartedEngine = new BfmrOrchestrationEngine(
      config,
      { gmail, tracker, browser, telegram },
      db
    );
    await restartedEngine.startRun();

    // Command should retain attempt_count = 1 and only execute ordinal 2
    browser.submitOutcome = 'SUBMITTED';
    const originalSubmit = browser.submitOne.bind(browser);
    browser.submitOne = async offer => { const result = await originalSubmit(offer); tracker.addReservation(db.getCommands().find(cmd => cmd.state === 'SUBMITTING')!.deal_id, offer); return result; };
    const retryExec = await restartedEngine.executeCommand(cmdId);
    assert.equal(retryExec.state, 'RESERVED');
    assert.equal(retryExec.attempts.length, 2);
    assert.equal(retryExec.attempts[1].ordinal, 2);
  });

  it('AT-16 & AT-17: Quantity invariant strictly enforces quantity=1 and rejects illegal quantity writes', async () => {
    // Attempting to record attempt with quantity != 1 must throw check constraint violation
    await assert.rejects(
      async () => {
        await db.withTransaction(async (tx) => {
          tx.insertAttempt({
            id: 'illegal-att-qty-2',
            command_id: 'cmd-dummy',
            ordinal: 1,
            account_id: config.accountId,
            deal_id: 'deal-dummy',
            selected_offer: 'offer-1',
            quantity: 2 as any, // Illegal quantity!
            prepared_at: new Date().toISOString(),
            invoked_at: null,
            result: null,
            reservation_id: null,
            evidence: null,
          });
        });
      },
      /Check constraint violation: quantity must be 1 strictly/
    );
  });

  it('AT-19: Database/lock loss halts execution and prevents concurrent browser instances', async () => {
    // Release advisory lock to simulate lock loss
    engine.releaseSingletonLock();
    assert.equal(db.isAdvisoryLockHeld(`bfmr_worker_lock_${config.accountId}`), false);

    // Another process cannot operate without reacquiring singleton lock
    const rivalEngine = new BfmrOrchestrationEngine(
      config,
      { gmail, tracker, browser, telegram },
      db
    );
    const acquired = rivalEngine.acquireSingletonLock();
    assert.equal(acquired, true);

    // Now original engine cannot acquire lock
    assert.equal(engine.acquireSingletonLock(), false);
  });
});
