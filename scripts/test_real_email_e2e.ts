import { stat } from 'node:fs/promises';
import { WorkerActionControl, type RecoveryFileState } from '../src/services/workerActionControl';
import { startupJournal } from '../src/services/startupJournal';
import { postReservationJournal } from '../src/services/postReservationJournal';
import { readRecentReservedRows } from '../src/services/bfmrTrackerApi';
import { randomUUID } from 'node:crypto';
import { openRelationalRuntime, type RelationalRuntime } from '../src/services/relationalRuntime';
import { prepareRelationalReservation, captureRelationalReservation, recordVerifiedAmazonSupplier,
  recordConfirmedCancellation, readLockedPurchaseEvidence, readTrackerWithFailureEvidence, recordReservationNotAttempted } from '../src/services/relationalReservations';
import { readRelationalExposureCents } from '../src/services/relationalExposure';
import { relationalStartupHooks } from '../src/services/relationalStartup';
import { PostgresGmailIntakeStore } from '../src/services/postgresGmailIntake';
import { ProductionGmailIntake, assertLegacyGmailSource } from '../src/services/productionGmailIntake';
import { makeGmailPushAdapters } from '../src/services/gmailPushTransport';
import type { QueuedEmail } from '../src/services/gmailIntakeQueue';
import { authenticateGmailSender, exactSender, intakeMode, type MailHeader } from '../src/services/emailProvenance';
import './loadEnv';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { parseBfmrEmail as parseIncomingEmail } from '../src/services/bfmrEmailLinks';
import { checkDealReservation, resolveBfmrDealId } from '../src/services/bfmrTrackerApi';
import { runBrowserSession } from '../src/services/browserSession';
import { runLiveTestStartup } from './live_test_startup';
import { automaticConfirmation } from '../src/services/automaticConfirmation';
import { requireReservationAlerts, sendBfmrStatusAlert, sendTrackingFailureAlert, withReservationFailureAlert } from '../src/services/reservationAlerts';
import { finishLiveReservation } from './post_reservation';
import type { ReservationReference } from '../src/services/amazonEvaluation';
import { purchaseReservedDeal } from './purchase_reserved_deal';
import { multiDealJournal, type MultiDealProgress } from '../src/services/multiDealJournal';
import { cancelConfirmedReservation } from '../src/services/reservationCancellation';
import { runDueAmazonTracking } from '../src/services/nightlyAmazonTracking';
import { ensureBfmrPurchase, ensureBfmrTracking } from '../src/services/bfmrTrackingSubmission';
import { bfmrStatusStore, runDueBfmrStatusCheck } from '../src/services/bfmrDailyStatus';

const legacyIntakeFile = process.env.BFMR_GMAIL_QUEUE_PATH || path.join(os.homedir(), '.local/state/bfmr/gmail-intake.json');
const batchJournal = multiDealJournal(process.env.BFMR_MULTI_DEAL_STATE_PATH || path.join(os.homedir(), '.local/state/bfmr/multi-deal.json'));
const statusStore = bfmrStatusStore(process.env.BFMR_STATUS_SNAPSHOT_PATH || path.join(os.homedir(), '.local/state/bfmr/bfmr-status.json'));

interface ReceivedEmail {
  id: string;
  sender: string;
  subject: string;
  body: string;
  receivedAt: string;
  headers?: MailHeader[];
  inboxAtFetch?: boolean;
  source?: 'GMAIL' | 'LOCAL_PDF_TEST';
}

function admitGmailEmail(email: QueuedEmail): boolean {
  if (!email.inboxAtFetch) return false;
  const parsed = parseIncomingEmail({ ...email, messageId: email.id });
  if (!((parsed.isSingleDeal && parsed.dealUrl) || parsed.isMultiDealAnnouncement)) return false;
  const mode = intakeMode(process.env.BFMR_INTAKE_MODE);
  const sender = exactSender(email.sender);
  const recognized = sender === 'deals@buyformeretail.com' || mode === 'testing' && sender === 'matt.ward@live.com';
  const authenticated = authenticateGmailSender(email.sender, email.headers ?? [], mode);
  if (recognized && !authenticated) throw new Error('Candidate Gmail message lacks verified sender provenance; cursor retained for review.');
  return authenticated;
}

async function reserveEmailDeal(
  browser: PlaywrightBfmrBrowser,
  deal: { canonicalDealId: string; dealUrl: string; dealTitle?: string },
  runtime: RelationalRuntime,
  email: (ReceivedEmail & { emailType: string }) | undefined,
  correlationId: string,
  assertIntakeReady: () => void | Promise<void>,
): Promise<ReservationReference | null> {
  const dealUrl = deal.dealUrl;
  console.log(`\n[Live BFMR E2E] Reserving one BFMR offer: ${dealUrl}`);

  const session = await browser.verifySession(process.env.BFMR_EXPECTED_ACCOUNT, dealUrl);
  if (session !== 'AUTHENTICATED' && session !== 'CHALLENGE') {
    throw new Error(`BFMR session/deal verification failed: ${session}. No reservation was attempted.`);
  }
  if (session === 'CHALLENGE') {
    throw new Error('Unexpected access challenge after startup. No reservation was attempted; inspect the browser.');
  }
  console.log('[Live BFMR E2E] Quantity-one reservation is authorized; running preflight checks.');

  const unavailableReason = await browser.getCurrentDealUnavailableReason();
  if (unavailableReason) {
    console.log(`[Live BFMR E2E] SKIPPED: ${unavailableReason}. No reservation was attempted.`);
    return null;
  }

  if (!(await browser.confirmCurrentDealPageAfterManualAccess(dealUrl))) {
    const reason = await browser.getCurrentDealUnavailableReason();
    if (reason) {
      console.log(`[Live BFMR E2E] SKIPPED: ${reason}. No reservation was attempted.`);
      return null;
    }
    throw new Error('The BFMR page still shows a challenge or is not a usable deal page. No reservation was attempted.');
  }

  const visibleDealTitle = await browser.getVisibleDealTitle();
  // BFMR can replace the detail page with a full message during rendering.
  const updatedUnavailableReason = await browser.getCurrentDealUnavailableReason();
  if (updatedUnavailableReason) {
    console.log(`[Live BFMR E2E] SKIPPED: ${updatedUnavailableReason}. No reservation was attempted.`);
    return null;
  }
  if (!visibleDealTitle) throw new Error('BFMR did not expose a visible deal title for the My Tracker check. No reservation was attempted.');
  console.log(`[Live BFMR E2E] BFMR deal title: ${visibleDealTitle}`);

  const dealId = await resolveBfmrDealId((await browser.init()).url());
  const before = await checkDealReservation(dealId, visibleDealTitle);
  if (before.status === 'UNKNOWN') throw new Error(`My Tracker preflight failed: ${before.error}. No reservation was attempted.`);
  if (before.status === 'CONFIRMED' || before.status === 'EXISTING') {
    console.log(`[Live BFMR E2E] SKIPPED: My Tracker already has a reserved row for this deal (quantity ${before.quantity}). No reservation was attempted.`);
    return null;
  }

  const prepared = await prepareRelationalReservation(runtime, {
    dealUrl: (await browser.init()).url(), dealId, title: visibleDealTitle, email, correlationId,
  });
  await runtime.ownership.verifyOwnership();
  await assertIntakeReady();
  console.log('[Live BFMR E2E] Submitting one unit through the deal page.');
  const submission = await browser.submitReservation(dealUrl, dealId);
  if (submission.status === 'CLOSED_NO_SLOTS') {
    await recordReservationNotAttempted(runtime, prepared);
    console.log(`[Live BFMR E2E] SKIPPED: ${submission.errorDetail || 'Deal reservation page is unavailable'}. No reservation was attempted.`);
    return null;
  }
  if (submission.status === 'AUTH_REQUIRED') {
    await recordReservationNotAttempted(runtime, prepared);
    throw new Error(`The reservation form was not submitted: ${submission.errorDetail || submission.status}.`);
  }

  console.log('[Live BFMR E2E] Checking My Tracker automatically; no further form submission.');
  const result = await automaticConfirmation(() => checkDealReservation(dealId, visibleDealTitle, 'CONFIRMATION'));
  if (result.status !== 'CONFIRMED') {
    const detail = result.status === 'UNKNOWN'
      ? result.error
      : result.status === 'EXISTING'
        ? `My Tracker shows quantity ${result.quantity}`
        : 'no matching quantity-one reserved row became visible';
    throw new Error(`My Tracker did not confirm this reservation (${detail}). Check My Tracker before any retry.`);
  }

  console.log(`[Live BFMR E2E] PASS: My Tracker API confirmed quantity one for ${dealId}.`);
  if (!result.reference) throw new Error('My Tracker confirmed quantity one but omitted the exact reservation ID; review before evaluating or ordering.');
  await captureRelationalReservation(runtime, result.reference, prepared);
  return result.reference;
}

export async function processEmail(email: ReceivedEmail, browser: PlaywrightBfmrBrowser, runtime: RelationalRuntime,
  assertIntakeReady: () => void | Promise<void> = () => {}) {
  await assertIntakeReady();
  if (!runtime) throw new Error('Relational persistence must be initialized before processing live work.');
  const localPdf = email.source === 'LOCAL_PDF_TEST';
  if (localPdf ? !/^pdf-[a-f0-9]{64}$/.test(email.id) :
    (!email.inboxAtFetch || !authenticateGmailSender(email.sender, email.headers ?? [], intakeMode(process.env.BFMR_INTAKE_MODE)))) {
    throw new Error('The processing boundary requires authenticated Gmail provenance or the separately invoked local PDF test.');
  }
  await runtime.ownership.verifyOwnership();
  const reconciliation = await runtime.sync.reconcile(await readTrackerWithFailureEvidence(runtime), {
    complete: true, accountValidated: true,
    financialContractValidated: process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED === 'YES',
  });
  if (!reconciliation.promoted) throw new Error('Relational reconciliation requires review before new reservation work.');
  const orderLedger = runtime.ledger;
  const correlationId = randomUUID();
  const parsed = parseIncomingEmail({ ...email, messageId: email.id });
  if (!parsed.isSingleDeal && !parsed.isMultiDealAnnouncement) {
    throw new Error('The received email no longer parses as a supported new-deal announcement with complete trusted deal links.');
  }
  console.log(`\n[Live BFMR E2E] New qualifying email: ${email.subject || '(no subject)'}`);
  console.log(`[Live BFMR E2E] ${parsed.deals.length} trusted deal-detail link(s) from ${email.sender}.`);
  let progress: MultiDealProgress | null = null;
  if (parsed.isMultiDealAnnouncement) {
    const previous = await batchJournal.load();
    if (previous && previous.stage !== 'COMPLETE') throw new Error(`Multi-deal email ${previous.messageId} is unfinished; inspect its journal and My Tracker before another batch.`);
    progress = { messageId: email.id, stage: 'RESERVING', confirmed: [], evaluated: [], orderStarted: [], orderFinished: [], cancelStarted: [], cancelFinished: [] };
    await batchJournal.save(progress);
  }
  const confirmed: ReservationReference[] = [];
  let reservationError: unknown;
  for (const deal of parsed.deals) {
    try {
      const reference = await reserveEmailDeal(browser, deal, runtime,
        localPdf ? undefined : { ...email, emailType: parsed.isMultiDealAnnouncement ? 'MULTI_DEAL' : 'SINGLE_DEAL' }, correlationId, assertIntakeReady);
      if (reference) {
        confirmed.push(reference);
        if (progress) {
          progress.confirmed.push(reference);
          await batchJournal.save(progress);
        }
      }
    } catch (error) {
      reservationError = error;
      break;
    }
  }
  // An uncertain reservation/capture or lost database ownership stops the batch
  // before supplier evaluation, cancellation, or checkout of earlier members.
  if (reservationError) throw reservationError;
  // Finish the first pass before any supplier evaluation or Amazon cart action.
  if (progress) { progress.stage = 'EVALUATING'; await batchJournal.save(progress); }
  const kept: ReservationReference[] = [];
  for (const reference of confirmed) {
    await assertIntakeReady();
    const outcome = await finishLiveReservation(reference, 'EMAIL', async () => { await assertIntakeReady(); await runtime.ownership.verifyOwnership(); });
    if (outcome === 'KEPT') {
      await recordVerifiedAmazonSupplier(runtime, reference);
      kept.push(reference);
    } else await recordConfirmedCancellation(runtime, reference);
    if (progress) { progress.evaluated.push(reference.reserveId); await batchJournal.save(progress); }
  }
  if (!parsed.isMultiDealAnnouncement) return;
  // Every confirmed reservation has now been evaluated before the first order.
  if (progress) { progress.stage = 'ORDERING'; await batchJournal.save(progress); }
  const missingPurchaseEvidence: string[] = [];
  for (const reference of kept) {
    await assertIntakeReady();
    const evidence = await readLockedPurchaseEvidence(runtime, reference);
    if (!evidence) {
      missingPurchaseEvidence.push(reference.reserveId);
      console.error(`[Live BFMR E2E] Amazon product link or exact payout is missing or ambiguous for reservation ${reference.reserveId}; reservation retained for review.`);
      continue;
    }
    if (progress) { progress.orderStarted.push(reference.reserveId); await batchJournal.save(progress); }
    const purchase = await purchaseReservedDeal(browser, reference, evidence.productUrl, evidence.payoutCents,
      async () => {
        const readback = await runtime.sync.reconcile(await readTrackerWithFailureEvidence(runtime), {
          complete: true, accountValidated: true,
          financialContractValidated: process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED === 'YES',
        });
        if (!readback.promoted) throw new Error('Latest reservation/payment reconciliation requires review; no order was submitted.');
        return readRelationalExposureCents(runtime.db, reference);
      }, { readPurchaseEvidence: ref => readLockedPurchaseEvidence(runtime, ref),
        beforeMutation: async () => { await assertIntakeReady(); await runtime.ownership.verifyOwnership(); },
        beforeSubmit: async () => {
          await assertIntakeReady();
          await runtime.db.withTransaction(async tx => {
            const reservation = await tx.reservations.findByBfmrId(reference.reserveId);
            if (!reservation) throw new Error('Checkout reservation disappeared from the database.');
            await tx.evidence.appendWorkflow({ reservationId: reservation.id, correlationId,
              actionType: 'AMAZON_CHECKOUT', phase: 'INTENT', outcome: null,
              evidence: { bfmr_reservation_id: reference.reserveId, bfmr_deal_id: reference.dealId } });
          });
          await runtime.ownership.verifyOwnership();
          await assertIntakeReady();
        } });
    if (purchase.status === 'INELIGIBLE') {
      if (progress) { progress.orderFinished.push(reference.reserveId); await batchJournal.save(progress); }
      if (progress) { progress.cancelStarted.push(reference.reserveId); await batchJournal.save(progress); }
      await assertIntakeReady();
      await cancelConfirmedReservation(reference, false, { readRows: readRecentReservedRows, request: fetch,
        wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
        beforeMutation: async () => { await assertIntakeReady(); await runtime.ownership.verifyOwnership(); } });
      await recordConfirmedCancellation(runtime, reference);
      if (progress) { progress.cancelFinished.push(reference.reserveId); await batchJournal.save(progress); }
      console.log(`[Live BFMR E2E] Checkout limits rejected reservation ${reference.reserveId}; My Tracker confirmed cancellation.`);
      if (!purchase.cartCleared) throw new Error('The rejected Amazon cart item could not be confirmed removed; stop before processing another order.');
    } else {
      await orderLedger.add({
        orderId: purchase.orderId, reserveId: reference.reserveId, dealId: reference.dealId,
        asin: purchase.asin, totalCents: purchase.totalCents, purchasedAt: new Date().toISOString(),
        status: 'PENDING', packages: [],
      });
      await assertIntakeReady();
      await ensureBfmrPurchase(purchase.orderId, orderLedger, {
        beforeMutation: async () => { await assertIntakeReady(); await runtime.ownership.verifyOwnership(); } });
      if (progress) { progress.orderFinished.push(reference.reserveId); await batchJournal.save(progress); }
      console.log(`[Live BFMR E2E] Amazon order ${purchase.orderId} recorded for BFMR reservation ${reference.reserveId}.`);
    }
  }
  if (missingPurchaseEvidence.length) throw new Error(`Amazon ordering requires manual review for reservation IDs: ${missingPurchaseEvidence.join(', ')}.`);
  if (progress) { progress.stage = 'COMPLETE'; await batchJournal.save(progress); }
}

export async function runBfmrWorker(options: { testStartupReservation?: boolean } = {}) {
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
    store = new PostgresGmailIntakeStore(process.env.DATABASE_URL!, {
      account, mailbox: adapters.mailbox, subscription: adapters.subscriptionName, topic: adapters.topic,
      verifyOwnership: () => ownership.verifyOwnership(),
    });
  } catch (error) {
    await Promise.allSettled([adapters.provider.close(), adapters.subscription.close(), runtime.close()]);
    throw error;
  }
  const control = new WorkerActionControl(runtime.db, account);
  const intake = new ProductionGmailIntake({
    mailbox: adapters.mailbox, topic: adapters.topic, store, provider: adapters.provider, subscription: adapters.subscription,
    verifyOwnership: () => ownership.verifyOwnership(), admit: admitGmailEmail,
    onFailure: async () => {
      try { await control.block('GMAIL_INTAKE_FAILED'); } finally { await browser.close(); }
      await sendBfmrStatusAlert('Gmail intake stopped. New browser work is blocked; inspect durable intake state and provider configuration before restarting.');
    },
  });
  const assertActionsReady = async () => { intake.assertHealthy(); await control.assertReady(); await ownership.verifyOwnership(); };
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
    console.log('[Live BFMR E2E] Chromium stays open across emails. Press Ctrl+C to exit when attached to a terminal.');
    await ownership.verifyOwnership();
    await store.validateSchema();
    await assertLegacyGmailSource(store, legacyIntakeFile);
    await auditRecovery();
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
          browser, ledger: orderLedger, hasIncomingMail,
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
          await control.block('EMAIL_ACTION_REQUIRES_REVIEW');
          throw error;
        }
      });
      console.log('[Live BFMR E2E] Ready for the next qualifying email in the same browser.');
    }, async (error) => {
      if (stopping) return;
      console.error(`[Live BFMR E2E] PAUSED: ${error instanceof Error ? error.message : String(error)}`);
      console.log('Processing is stopped; no automatic retry.');
      if (!readline) { process.exitCode = 1; return; }
      console.log('Browser retained for inspection.');
      let answer = '';
      while (answer.trim() !== 'EXIT') {
        answer = await readline.question('Type EXIT to terminate the app, or press Ctrl+C: ');
      }
    }, async () => {
      await auditRecovery();
      await control.assertNoUncertainActions();
      intake.assertHealthy();
      // Temporary CAPTCHA reservation/cleanup belongs only to explicit test
      // entrypoints. The production worker never creates a startup reservation.
      if (options.testStartupReservation) await runLiveTestStartup(browser, {
        ...relationalStartupHooks(runtime), beforeMutation: assertActionsReady });
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBfmrWorker({ testStartupReservation: true }).catch((error: unknown) => {
    console.error(`[Live BFMR E2E] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
