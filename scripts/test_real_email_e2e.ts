import { randomUUID } from 'node:crypto';
import { openRelationalRuntime, type RelationalRuntime } from '../src/services/relationalRuntime';
import { prepareRelationalReservation, captureRelationalReservation, recordVerifiedAmazonSupplier,
  recordConfirmedCancellation, readLockedPurchaseEvidence, readTrackerWithFailureEvidence } from '../src/services/relationalReservations';
import { readRelationalExposureCents } from '../src/services/relationalExposure';
import { relationalStartupHooks } from '../src/services/relationalStartup';
import { gmailIntakeQueue } from '../src/services/gmailIntakeQueue';
import { authenticateGmailSender, intakeMode, type MailHeader } from '../src/services/emailProvenance';
import './loadEnv';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { google } from 'googleapis';
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

const POLL_INTERVAL_MS = 15_000;
const intakeQueue = gmailIntakeQueue(process.env.BFMR_GMAIL_QUEUE_PATH || path.join(os.homedir(), '.local/state/bfmr/gmail-intake.json'));
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

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function collectBody(part: any): string[] {
  const contents: string[] = [];
  if (part.body?.data) contents.push(decodeBase64Url(part.body.data));
  for (const child of part.parts || []) contents.push(...collectBody(child));
  return contents;
}

function headerValue(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function makeGmailClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN are required for Gmail intake.');
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

async function fetchEmail(gmail: ReturnType<typeof makeGmailClient>, id: string): Promise<ReceivedEmail> {
  const response = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const message = response.data;
  const headers = message.payload?.headers || [];
  if (!message.internalDate || !/^\d+$/.test(message.internalDate)) throw new Error('Gmail message has no reliable receipt timestamp; cursor retained.');
  return {
    id,
    sender: headerValue(headers, 'from'),
    subject: headerValue(headers, 'subject'),
    headers,
    inboxAtFetch: message.labelIds?.includes('INBOX') ?? false,
    body: message.payload ? collectBody(message.payload).join('\n') : message.snippet || '',
    receivedAt: message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : headerValue(headers, 'date'),
  };
}

async function* qualifyingEmails(
  gmail: ReturnType<typeof makeGmailClient>,
  getStartupHistoryId: () => string | undefined,
  onIdle: (hasIncomingMail: () => Promise<boolean>) => Promise<void> = async () => {},
): AsyncGenerator<ReceivedEmail> {
  if (!getStartupHistoryId()) throw new Error('Durable Gmail queue must be initialized before listening.');
  while (true) {
    const state = await intakeQueue.load();
    if (!state || state.gap) throw new Error('GMAIL_HISTORY_GAP or missing saved Gmail cursor; intake stopped.');
    if (state.work.some(item => item.state === 'PROCESSING')) throw new Error('Interrupted Gmail work requires manual reconciliation; no automatic replay.');
    for (const item of state.work.filter(item => item.state === 'PENDING')) {
      const email = item.email!;
      const parsed = parseIncomingEmail({ ...email, messageId: email.id });
      if (!email.inboxAtFetch || !authenticateGmailSender(email.sender, email.headers ?? [], intakeMode(process.env.BFMR_INTAKE_MODE)) ||
        !((parsed.isSingleDeal && parsed.dealUrl) || parsed.isMultiDealAnnouncement)) {
        await intakeQueue.mark(item.id, 'DONE');
        continue;
      }
      await intakeQueue.mark(item.id, 'PROCESSING');
      yield email;
      // The consumer resumes this iterator only after processing succeeds.
      await intakeQueue.mark(item.id, 'DONE');
    }
    let pageToken: string | undefined;
    let latestHistoryId = state.cursor;
    const ids = new Set<string>();
    try {
      do {
        const response = await gmail.users.history.list({ userId: 'me', startHistoryId: state.cursor,
          historyTypes: ['messageAdded', 'labelAdded'], maxResults: 500, pageToken });
        if (response.data.historyId) latestHistoryId = response.data.historyId;
        for (const history of response.data.history ?? []) {
          for (const added of history.messagesAdded ?? []) if (added.message?.id) ids.add(added.message.id);
          for (const added of history.labelsAdded ?? []) if (added.labelIds?.includes('INBOX') && added.message?.id) ids.add(added.message.id);
        }
        pageToken = response.data.nextPageToken || undefined;
      } while (pageToken);
    } catch (error) {
      if ((error as { code?: number }).code === 404) await intakeQueue.save({ ...(await intakeQueue.load())!, gap: true });
      throw error;
    }
    const emails: ReceivedEmail[] = [];
    for (const id of ids) {
      if (!state.work.some(item => item.id === id)) emails.push(await fetchEmail(gmail, id));
    }
    emails.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt) || a.id.localeCompare(b.id));
    await intakeQueue.ingest(state.cursor, latestHistoryId, emails);
    if (emails.length) continue;
    await onIdle(async () => {
      const saved = await intakeQueue.load();
      if (!saved || saved.gap || saved.work.some(item => item.state !== 'DONE')) return true;
      const result = await gmail.users.history.list({ userId: 'me', startHistoryId: saved.cursor,
        historyTypes: ['messageAdded', 'labelAdded'], maxResults: 1 });
      return !!result.data.nextPageToken || !!result.data.history?.some(item => item.messagesAdded?.length || item.labelsAdded?.some(added => added.labelIds?.includes('INBOX')));
    });
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function reserveEmailDeal(
  browser: PlaywrightBfmrBrowser,
  deal: { canonicalDealId: string; dealUrl: string; dealTitle?: string },
  runtime: RelationalRuntime,
  email: (ReceivedEmail & { emailType: string }) | undefined,
  correlationId: string,
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
  console.log('[Live BFMR E2E] Submitting one unit through the deal page.');
  const submission = await browser.submitReservation(dealUrl, dealId);
  if (submission.status === 'CLOSED_NO_SLOTS') {
    console.log(`[Live BFMR E2E] SKIPPED: ${submission.errorDetail || 'Deal reservation page is unavailable'}. No reservation was attempted.`);
    return null;
  }
  if (submission.status === 'AUTH_REQUIRED') {
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

export async function processEmail(email: ReceivedEmail, browser: PlaywrightBfmrBrowser, runtime: RelationalRuntime) {
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
        localPdf ? undefined : { ...email, emailType: parsed.isMultiDealAnnouncement ? 'MULTI_DEAL' : 'SINGLE_DEAL' }, correlationId);
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
    const outcome = await finishLiveReservation(reference, 'EMAIL');
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
        beforeSubmit: async () => {
          await runtime.db.withTransaction(async tx => {
            const reservation = await tx.reservations.findByBfmrId(reference.reserveId);
            if (!reservation) throw new Error('Checkout reservation disappeared from the database.');
            await tx.evidence.appendWorkflow({ reservationId: reservation.id, correlationId,
              actionType: 'AMAZON_CHECKOUT', phase: 'INTENT', outcome: null,
              evidence: { bfmr_reservation_id: reference.reserveId, bfmr_deal_id: reference.dealId } });
          });
          await runtime.ownership.verifyOwnership();
        } });
    if (purchase.status === 'INELIGIBLE') {
      if (progress) { progress.orderFinished.push(reference.reserveId); await batchJournal.save(progress); }
      if (progress) { progress.cancelStarted.push(reference.reserveId); await batchJournal.save(progress); }
      await cancelConfirmedReservation(reference);
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
      await ensureBfmrPurchase(purchase.orderId, orderLedger);
      if (progress) { progress.orderFinished.push(reference.reserveId); await batchJournal.save(progress); }
      console.log(`[Live BFMR E2E] Amazon order ${purchase.orderId} recorded for BFMR reservation ${reference.reserveId}.`);
    }
  }
  if (missingPurchaseEvidence.length) throw new Error(`Amazon ordering requires manual review for reservation IDs: ${missingPurchaseEvidence.join(', ')}.`);
  if (progress) { progress.stage = 'COMPLETE'; await batchJournal.save(progress); }
}

async function main() {
  requireReservationAlerts();
  const account = process.env.BFMR_EXPECTED_ACCOUNT?.trim().toLowerCase();
  if (!account || !process.env.DATABASE_URL) throw new Error('BFMR_EXPECTED_ACCOUNT and DATABASE_URL are required for durable account ownership.');
  const gmail = makeGmailClient();
  const runtime = await openRelationalRuntime();
  const { ownership, ledger: orderLedger } = runtime;
  const browser = new PlaywrightBfmrBrowser({ headless: false });
  ownership.onOwnershipLost(() => { void browser.close(); });
  const readline = process.stdin.isTTY && process.stdout.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let startupHistoryId: string | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    readline?.close();
    await browser.close();
    await runtime.close();
    process.exit(0);
  };
  const onSignal = () => { void shutdown(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  readline?.on('SIGINT', onSignal);
  try {
    console.log('[Live BFMR E2E] Chromium stays open across emails. Press Ctrl+C to exit when attached to a terminal.');
    await ownership.verifyOwnership();
    let trackingFailureDay: string | null = null;
    let bfmrFailureDay: string | null = null;
    await runBrowserSession(browser, qualifyingEmails(gmail, () => startupHistoryId, async (hasIncomingMail) => {
      await ownership.verifyOwnership();
      try {
        await runDueAmazonTracking({
          browser, ledger: orderLedger, hasIncomingMail,
          afterCheck: async (order) => { await ensureBfmrTracking(order.orderId, orderLedger); },
          onOrderFailure: async (order, error) => {
            console.error(`[Amazon tracking] ${order.orderId}: ${error instanceof Error ? error.message : String(error)}`);
            await sendTrackingFailureAlert(order.orderId).catch((alertError) =>
              console.error(`[Amazon tracking] Alert delivery failed: ${alertError instanceof Error ? alertError.message : String(alertError)}`));
          },
        });
      } catch (error) {
        const today = new Date().toISOString().slice(0, 10);
        if (trackingFailureDay !== today) {
          trackingFailureDay = today;
          console.error(`[Amazon tracking] Nightly check could not continue: ${error instanceof Error ? error.message : String(error)}`);
          await sendTrackingFailureAlert('ORDER-LEDGER').catch((alertError) =>
            console.error(`[Amazon tracking] Alert delivery failed: ${alertError instanceof Error ? alertError.message : String(alertError)}`));
        }
      }
      try {
        await runDueBfmrStatusCheck({ store: statusStore, ledger: orderLedger, hasIncomingMail,
          readRows: () => readTrackerWithFailureEvidence(runtime),
          reconcile: async rows => runtime.sync.reconcile(rows, { complete: true, accountValidated: true,
            financialContractValidated: process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED === 'YES' }),
          notify: sendBfmrStatusAlert });
      } catch (error) {
        const today = new Date().toISOString().slice(0, 10);
        if (bfmrFailureDay !== today) {
          bfmrFailureDay = today;
          console.error(`[BFMR daily status] Check or Telegram delivery failed: ${error instanceof Error ? error.message : String(error)}`);
          await sendBfmrStatusAlert('BFMR daily status check failed. Inspect the runner and local BFMR status snapshot; the official status may be stale.').catch((alertError) =>
            console.error(`[BFMR daily status] Alert delivery failed: ${alertError instanceof Error ? alertError.message : String(alertError)}`));
        }
      }
    }), async (email) => {
      await ownership.verifyOwnership();
      const alertDeal = parseIncomingEmail({ ...email, messageId: email.id });
      await withReservationFailureAlert(`Email-triggered reservation processing stopped.\nDeal: ${alertDeal.dealUrl || alertDeal.deals.map(deal => deal.canonicalDealId).join(', ') || 'identity unavailable'}`, () => processEmail(email, browser, runtime));
      console.log('[Live BFMR E2E] Ready for the next qualifying email in the same browser.');
    }, async (error) => {
      console.error(`[Live BFMR E2E] PAUSED: ${error instanceof Error ? error.message : String(error)}`);
      console.log('Processing is stopped; no automatic retry.');
      if (!readline) { process.exitCode = 1; return; }
      console.log('Browser retained for inspection.');
      let answer = '';
      while (answer.trim() !== 'EXIT') {
        answer = await readline.question('Type EXIT to terminate the app, or press Ctrl+C: ');
      }
    }, async () => {
      const pendingBatch = await batchJournal.load();
      if (pendingBatch && pendingBatch.stage !== 'COMPLETE') {
        throw new Error(`Multi-deal email ${pendingBatch.messageId} is unfinished. Inspect ${process.env.BFMR_MULTI_DEAL_STATE_PATH || '~/.local/state/bfmr/multi-deal.json'} and reconcile My Tracker/Amazon Orders before starting another live run.`);
      }
      const profile = await gmail.users.getProfile({ userId: 'me' });
      if (!profile.data.emailAddress || !profile.data.historyId) throw new Error('Gmail profile did not identify the mailbox and cursor.');
      const savedIntake = await intakeQueue.initialize(profile.data.emailAddress, profile.data.historyId, process.env.BFMR_INITIALIZE_GMAIL_QUEUE === 'YES');
      startupHistoryId = savedIntake.cursor;
      if (!startupHistoryId) throw new Error('Gmail did not provide a pre-startup history cursor.');
      await runLiveTestStartup(browser, relationalStartupHooks(runtime));
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    readline?.close();
    await browser.close();
    await runtime.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[Live BFMR E2E] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
