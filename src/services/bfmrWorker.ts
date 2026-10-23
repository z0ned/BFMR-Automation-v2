import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { WorkerActionControl, type RecoveryFileState } from './workerActionControl';
import { startupJournal } from './startupJournal';
import { postReservationJournal } from './postReservationJournal';
import { openRelationalRuntime, type RelationalRuntime } from './relationalRuntime';
import { readTrackerWithFailureEvidence } from './relationalReservations';
import { PostgresGmailIntakeStore } from './postgresGmailIntake';
import { ProductionGmailIntake, assertLegacyGmailSource } from './productionGmailIntake';
import { makeGmailPushAdapters } from './gmailPushTransport';
import type { QueuedEmail } from './gmailIntakeQueue';
import { authenticateGmailSender, exactSender, intakeMode } from './emailProvenance';
import { PlaywrightBfmrBrowser } from '../adapters/playwrightBrowser';
import { parseBfmrEmail as parseIncomingEmail } from './bfmrEmailLinks';
import { runBrowserSession } from './browserSession';
import { requireReservationAlerts, sendBfmrStatusAlert, sendTrackingFailureAlert, withReservationFailureAlert } from './reservationAlerts';
import { multiDealJournal } from './multiDealJournal';
import { runDueAmazonTracking } from './nightlyAmazonTracking';
import { ensureBfmrTracking } from './bfmrTrackingSubmission';
import { bfmrStatusStore, runDueBfmrStatusCheck } from './bfmrDailyStatus';
import { DealEmailWorkflowStore } from './dealEmailWorkflowStore';
import { processEmail, WorkflowReviewRequiredError } from './dealEmailWorkflow';

const legacyIntakeFile = process.env.BFMR_GMAIL_QUEUE_PATH || path.join(os.homedir(), '.local/state/bfmr/gmail-intake.json');
const batchJournal = multiDealJournal(process.env.BFMR_MULTI_DEAL_STATE_PATH || path.join(os.homedir(), '.local/state/bfmr/multi-deal.json'));
const statusStore = bfmrStatusStore(process.env.BFMR_STATUS_SNAPSHOT_PATH || path.join(os.homedir(), '.local/state/bfmr/bfmr-status.json'));

function admitGmailEmail(email: QueuedEmail): boolean {
  if (!email.inboxAtFetch) return false;
  const parsed = parseIncomingEmail({ ...email, messageId: email.id });
  const isProcessable =
    Boolean(parsed.isSingleDeal && parsed.dealUrl) ||
    Boolean(parsed.isMultiDealAnnouncement) ||
    Boolean(parsed.isPaymentNotice) ||
    Boolean(parsed.isInformationalUpdate);
  if (!isProcessable) return false;
  const mode = intakeMode(process.env.BFMR_INTAKE_MODE);
  const sender = exactSender(email.sender);
  const recognized = sender === 'deals@buyformeretail.com' || mode === 'testing' && sender === 'matt.ward@live.com';
  const authenticated = authenticateGmailSender(email.sender, email.headers ?? [], mode);
  if (recognized && !authenticated) throw new Error('Candidate Gmail message lacks verified sender provenance; cursor retained for review.');
  return authenticated;
}

export async function runBfmrWorker(options: { beforeProcessing?: (browser: PlaywrightBfmrBrowser, runtime: RelationalRuntime, guard: () => Promise<void>) => Promise<void> } = {}) {
  requireReservationAlerts();
  const account = process.env.BFMR_EXPECTED_ACCOUNT?.trim().toLowerCase();
  if (!account || !process.env.DATABASE_URL) throw new Error('BFMR_EXPECTED_ACCOUNT and DATABASE_URL are required for durable account ownership.');
  const adapters = makeGmailPushAdapters();
  let runtime: RelationalRuntime;
  try { runtime = await openRelationalRuntime(); }
  catch (error) {
    await Promise.allSettled([adapters.provider.close(), adapters.subscription.close()]);
    throw error;
  }
  const { ownership, ledger: orderLedger } = runtime;
  let browser: PlaywrightBfmrBrowser;
  let store: PostgresGmailIntakeStore;
  try {
    browser = new PlaywrightBfmrBrowser({ headless: false });
    store = new PostgresGmailIntakeStore(runtime.connectionString, {
      account, mailbox: adapters.mailbox, subscription: adapters.subscriptionName, topic: adapters.topic,
      verifyOwnership: () => ownership.verifyOwnership(),
    });
  } catch (error) {
    await Promise.allSettled([adapters.provider.close(), adapters.subscription.close(), runtime.close()]);
    throw error;
  }
  const control = new WorkerActionControl(runtime.db, account);
  const workflows = new DealEmailWorkflowStore(runtime.db, account);
  const intake = new ProductionGmailIntake({
    mailbox: adapters.mailbox, topic: adapters.topic, store, provider: adapters.provider, subscription: adapters.subscription,
    verifyOwnership: () => ownership.verifyOwnership(), admit: admitGmailEmail,
    onFailure: async () => {
      try { await control.block('GMAIL_INTAKE_FAILED'); } finally { await browser.close(); }
      await sendBfmrStatusAlert('Gmail intake stopped. New browser work is blocked; inspect durable intake state and provider configuration before restarting.');
    },
  });
  const assertActionsReady = async () => { intake.assertHealthy(); await control.assertReady(); await ownership.verifyOwnership(); await runtime.verifyRetailerAccount(); };
  browser.setActionGuard(assertActionsReady);
  ownership.onOwnershipLost(() => { void intake.stop(); void browser.close(); });
  const auditRecovery = async () => control.auditRecovery(async () => {
    const startupPath = process.env.BFMR_STARTUP_STATE_PATH || path.join(os.homedir(), '.local/state/bfmr/startup-reservation.json');
    const postPath = process.env.BFMR_POST_RESERVATION_STATE_PATH || path.join(os.homedir(), '.local/state/bfmr/post-reservation.json');
    const eventsPath = `${startupPath}.events.jsonl`;
    let eventsPresent = false;
    try { const info = await stat(eventsPath); if (!info.isFile()) throw new Error('Invalid startup event journal.'); eventsPresent = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const [startup, post, batch, status] = await Promise.all([
      startupJournal(startupPath).load(), postReservationJournal(postPath).load(), batchJournal.load(), statusStore.load(),
    ]);
    return {
      startup: { path: startupPath, present: startup !== null,
        unresolved: Boolean(startup && (!eventsPresent || !['CLEANED', 'SKIPPED', 'EXHAUSTED'].includes(startup.state))) },
      startupEvents: { path: eventsPath, present: eventsPresent, unresolved: eventsPresent && startup === null },
      postReservation: { path: postPath, present: post !== null,
        unresolved: Boolean(post && !['KEPT', 'CANCELLED'].includes(post.state)) },
      batch: { path: process.env.BFMR_MULTI_DEAL_STATE_PATH || path.join(os.homedir(), '.local/state/bfmr/multi-deal.json'),
        present: batch !== null, unresolved: Boolean(batch && batch.stage !== 'COMPLETE') },
      status: { path: process.env.BFMR_STATUS_SNAPSHOT_PATH || path.join(os.homedir(), '.local/state/bfmr/bfmr-status.json'),
        present: status !== null, unresolved: Boolean(status && status.nextAlert < status.pendingAlerts.length) },
    } satisfies Record<string, RecoveryFileState>;
  }, process.env.BFMR_ACCEPT_RECOVERY_BASELINE === 'YES');
  const readline = process.stdin.isTTY && process.stdout.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    readline?.close();
    const stopIntake = intake.stop();
    await browser.close();
    await stopIntake;
  };
  const onSignal = () => { void shutdown(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  readline?.on('SIGINT', onSignal);
  try {
    console.log('[BFMR worker] Chromium stays open across emails. Press Ctrl+C to exit when attached to a terminal.');
    await ownership.verifyOwnership();
    await store.validateSchema();
    await assertLegacyGmailSource(store, legacyIntakeFile);
    await auditRecovery();
    await workflows.assertNoUnfinished();
    await control.assertNoUncertainActions();
    const queued = await store.load();
    if (queued?.work.some(item => item.state === 'PROCESSING')) throw new Error('Interrupted Gmail work requires reconciliation before startup.');
    const orders = await orderLedger.load();
    if (orders.some(order => order.lastError || order.bfmrPurchaseIntentAt && !order.bfmrPurchaseId ||
        order.bfmrShipmentIntent && !order.bfmrShipmentId)) {
      throw new Error('Unresolved BFMR Purchase/Shipment intent requires reconciliation before new work.');
    }
    await intake.start(process.env.BFMR_INITIALIZE_GMAIL_QUEUE === 'YES');
    await runBrowserSession(browser, intake.emails(async (hasIncomingMail) => {
      await assertActionsReady();
      try {
        await runDueAmazonTracking({
          browser, ledger: orderLedger, hasIncomingMail, expectedAccountEmail: runtime.retailerAccount.email,
          afterCheck: async order => {
            await assertActionsReady();
            await ensureBfmrTracking(order.orderId, orderLedger, { beforeMutation: assertActionsReady });
          },
          onOrderFailure: async () => {
            await control.block('AMAZON_TRACKING_REQUIRES_REVIEW');
            await sendTrackingFailureAlert('RECONCILIATION-REQUIRED');
            throw new Error('Tracking requires review; new work is blocked.');
          },
        });
        await assertActionsReady();
        await runDueBfmrStatusCheck({ store: statusStore, ledger: orderLedger, hasIncomingMail,
          readRows: () => readTrackerWithFailureEvidence(runtime),
          reconcile: async rows => runtime.sync.reconcile(rows, { complete: true, accountValidated: true,
            financialContractValidated: process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED === 'YES' }),
          notify: sendBfmrStatusAlert,
          onDiscrepancies: () => control.block('BFMR_DISCREPANCIES_REQUIRE_REVIEW') });
        await auditRecovery();
      } catch (error) {
        await control.block('MAINTENANCE_OR_ALERT_REQUIRES_REVIEW');
        await sendBfmrStatusAlert('Maintenance or notification delivery stopped. New actions are blocked pending reconciliation.')
          .catch(() => {}); // The durable block already exists; never resume on failed delivery.
        throw error;
      }
    }), async (email) => {
      await assertActionsReady();
      const alertDeal = parseIncomingEmail({ ...email, messageId: email.id });
      await withReservationFailureAlert(`Email-triggered processing stopped.\nDeal: ${alertDeal.dealUrl || 'identity unavailable'}`, async () => {
        try {
          await processEmail(email, browser, runtime, assertActionsReady);
          await auditRecovery();
        } catch (error) {
          await control.block('EMAIL_ACTION_REQUIRES_REVIEW', error instanceof WorkflowReviewRequiredError ? error.workflowId : undefined);
          throw error;
        }
      });
      console.log('[BFMR worker] Ready for the next qualifying email in the same browser.');
    }, async (error) => {
      if (stopping) return;
      console.error(`[BFMR worker] PAUSED: ${error instanceof Error ? error.message : String(error)}`);
      console.log('Processing is stopped; no automatic retry.');
      if (!readline) { process.exitCode = 1; return; }
      console.log('Browser retained for inspection.');
      let answer = '';
      while (answer.trim() !== 'EXIT') {
        answer = await readline.question('Type EXIT to terminate the app, or press Ctrl+C: ');
      }
    }, async () => {
      await auditRecovery();
      await workflows.assertNoUnfinished();
      await control.assertNoUncertainActions();
      intake.assertHealthy();
      // Temporary CAPTCHA reservation/cleanup belongs only to explicit test
      // entrypoints. The production worker never creates a startup reservation.
      await options.beforeProcessing?.(browser, runtime, assertActionsReady);
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    readline?.close();
    await intake.stop();
    await browser.close();
    await store.close();
    await runtime.close();
  }
}
