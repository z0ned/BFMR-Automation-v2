import './loadEnv';
import { createInterface } from 'node:readline/promises';
import { google } from 'googleapis';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { parseBfmrEmail as parseIncomingEmail } from '../src/services/bfmrEmailLinks';
import { checkDealReservation } from '../src/services/bfmrTrackerApi';
import { runBrowserSession } from '../src/services/browserSession';
import { runLiveTestStartup } from './live_test_startup';
import { automaticConfirmation } from '../src/services/automaticConfirmation';
import { requireReservationAlerts, withReservationFailureAlert } from '../src/services/reservationAlerts';
import { finishLiveReservation } from './post_reservation';

const ALLOWED_SENDERS = new Set(['deals@buyformeretail.com', 'matt.ward@live.com']);
const POLL_INTERVAL_MS = 15_000;

interface ReceivedEmail {
  id: string;
  sender: string;
  subject: string;
  body: string;
  receivedAt: string;
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

function senderAddress(header: string): string {
  const angleAddress = header.match(/<\s*([^>\s]+)\s*>/);
  const candidate = angleAddress?.[1] || header.trim();
  return candidate.toLowerCase();
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
  return {
    id,
    sender: headerValue(headers, 'from'),
    subject: headerValue(headers, 'subject'),
    body: message.payload ? collectBody(message.payload).join('\n') : message.snippet || '',
    receivedAt: message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : headerValue(headers, 'date'),
  };
}

async function* qualifyingEmails(gmail: ReturnType<typeof makeGmailClient>, getStartupHistoryId: () => string | undefined): AsyncGenerator<ReceivedEmail> {
  const initialHistoryId = getStartupHistoryId();
  if (!initialHistoryId) throw new Error('Gmail did not return a history cursor; cannot safely watch only new messages.');
  let historyId: string = initialHistoryId;
  const seen = new Set<string>();

  console.log(`[Gmail] Listening for a new BFMR deal email in ${process.env.GMAIL_ACCOUNT_EMAIL || 'the configured mailbox'}.`);
  console.log('[Gmail] Pre-startup inbox history is excluded; emails arriving during startup are retained.');

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const foundIds: string[] = [];
    let pageToken: string | undefined;
    let latestHistoryId: string = historyId;

    do {
      const response = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: historyId,
        historyTypes: ['messageAdded'],
        maxResults: 500,
        pageToken,
      });
      if (response.data.historyId) latestHistoryId = response.data.historyId;
      for (const item of response.data.history || []) {
        for (const added of item.messagesAdded || []) {
          if (added.message?.id) foundIds.push(added.message.id);
        }
      }
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);

    historyId = latestHistoryId;
    for (const id of [...new Set(foundIds)]) {
      if (seen.has(id)) continue;
      const email = await fetchEmail(gmail, id);
      seen.add(id);
      if (!ALLOWED_SENDERS.has(senderAddress(email.sender))) continue;
      const parsed = parseIncomingEmail({
        id: email.id,
        messageId: email.id,
        sender: email.sender,
        subject: email.subject,
        body: email.body,
        receivedAt: email.receivedAt,
      });
      if (parsed.isSingleDeal && parsed.canonicalDealId && parsed.dealUrl) {
        yield email;
        continue;
      }
      const reason = parsed.isMultiDeal ? 'multiple distinct deals or roundup' :
        parsed.isAdditionalSlotNotice ? 'additional-slot notice' :
          !parsed.isSingleDeal ? 'not a new-deal subject' : 'no supported trusted BFMR deal link';
      console.log(`[Gmail] Skipped a new message (${reason}): ${email.subject || '(no subject)'}`);
    }
  }
}

async function processEmail(
  email: ReceivedEmail,
  browser: PlaywrightBfmrBrowser,
) {
  const parsed = parseIncomingEmail({
    id: email.id,
    messageId: email.id,
    sender: email.sender,
    subject: email.subject,
    body: email.body,
    receivedAt: email.receivedAt,
  });
  const dealId = parsed.canonicalDealId;
  const dealUrl = parsed.dealUrl;
  const dealTitle = parsed.dealTitle;
  if (!parsed.isSingleDeal || !dealId || !dealUrl || !dealTitle) {
    throw new Error('The received email no longer parses as a single deal with a trusted link.');
  }

  console.log('\n[Live BFMR E2E] New qualifying deal email received.');
  console.log(`From: ${email.sender}`);
  console.log(`Subject: ${email.subject}`);
  console.log(`Deal: ${parsed.dealTitle}`);
  console.log(`Link: ${parsed.dealUrl}`);
  console.log('');

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
    return;
  }

  if (!(await browser.confirmCurrentDealPageAfterManualAccess(dealUrl))) {
    const reason = await browser.getCurrentDealUnavailableReason();
    if (reason) {
      console.log(`[Live BFMR E2E] SKIPPED: ${reason}. No reservation was attempted.`);
      return;
    }
    throw new Error('The BFMR page still shows a challenge or is not a usable deal page. No reservation was attempted.');
  }

  const visibleDealTitle = await browser.getVisibleDealTitle();
  // BFMR can replace the detail page with a full message during rendering.
  const updatedUnavailableReason = await browser.getCurrentDealUnavailableReason();
  if (updatedUnavailableReason) {
    console.log(`[Live BFMR E2E] SKIPPED: ${updatedUnavailableReason}. No reservation was attempted.`);
    return;
  }
  if (!visibleDealTitle) throw new Error('BFMR did not expose a visible deal title for the My Tracker check. No reservation was attempted.');
  console.log(`[Live BFMR E2E] BFMR deal title: ${visibleDealTitle}`);

  const before = await checkDealReservation(dealId, visibleDealTitle);
  if (before.status === 'UNKNOWN') throw new Error(`My Tracker preflight failed: ${before.error}. No reservation was attempted.`);
  if (before.status === 'CONFIRMED' || before.status === 'EXISTING') {
    console.log(`[Live BFMR E2E] SKIPPED: My Tracker already has a reserved row for this deal (quantity ${before.quantity}). No reservation was attempted.`);
    return;
  }

  console.log('[Live BFMR E2E] Submitting one unit through the deal page.');
  const submission = await browser.submitReservation(dealUrl, dealId);
  if (submission.status === 'CLOSED_NO_SLOTS') {
    console.log(`[Live BFMR E2E] SKIPPED: ${submission.errorDetail || 'Deal reservation page is unavailable'}. No reservation was attempted.`);
    return;
  }
  if (submission.status === 'AUTH_REQUIRED') {
    throw new Error(`The reservation form was not submitted: ${submission.errorDetail || submission.status}.`);
  }

  console.log('[Live BFMR E2E] Checking My Tracker automatically; no further form submission.');
  const result = await automaticConfirmation(() => checkDealReservation(dealId, visibleDealTitle));
  if (result.status !== 'CONFIRMED') {
    const detail = result.status === 'UNKNOWN'
      ? result.error
      : result.status === 'EXISTING'
        ? `My Tracker shows quantity ${result.quantity}`
        : 'no matching quantity-one reserved row became visible';
    throw new Error(`My Tracker did not confirm this reservation (${detail}). Check My Tracker before any retry.`);
  }

  console.log(`[Live BFMR E2E] PASS: My Tracker API confirmed quantity one for ${dealId}.`);
  await finishLiveReservation(result.reference, 'EMAIL');
}

async function main() {
  if (!process.stdin.isTTY) throw new Error('This live end-to-end test requires an interactive terminal.');
  requireReservationAlerts();
  const gmail = makeGmailClient();
  const browser = new PlaywrightBfmrBrowser({ headless: false });
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let startupHistoryId: string | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    readline.close();
    await browser.close();
    process.exit(0);
  };
  const onSignal = () => { void shutdown(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  readline.on('SIGINT', onSignal);
  try {
    console.log('[Live BFMR E2E] Chromium stays open across tests. Press Ctrl+C to exit.');
    await runBrowserSession(browser, qualifyingEmails(gmail, () => startupHistoryId), async (email) => {
      const alertDeal = parseIncomingEmail({ ...email, messageId: email.id });
      await withReservationFailureAlert(`Email-triggered reservation processing stopped.\nDeal: ${alertDeal.dealUrl || 'identity unavailable'}`, () => processEmail(email, browser));
      console.log('[Live BFMR E2E] Ready for the next qualifying email in the same browser.');
    }, async (error) => {
      console.error(`[Live BFMR E2E] PAUSED: ${error instanceof Error ? error.message : String(error)}`);
      console.log('Browser retained for inspection. Processing is stopped; no automatic retry.');
      let answer = '';
      while (answer.trim() !== 'EXIT') {
        answer = await readline.question('Type EXIT to terminate the app, or press Ctrl+C: ');
      }
    }, async () => {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      startupHistoryId = profile.data.historyId || undefined;
      if (!startupHistoryId) throw new Error('Gmail did not provide a pre-startup history cursor.');
      await runLiveTestStartup(browser);
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    readline.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[Live BFMR E2E] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
