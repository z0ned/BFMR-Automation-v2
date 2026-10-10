import './loadEnv';
import { createInterface } from 'node:readline/promises';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { checkDealReservation } from '../src/services/bfmrTrackerApi';
import { automaticConfirmation } from '../src/services/automaticConfirmation';
import { requireReservationAlerts, withReservationFailureAlert } from '../src/services/reservationAlerts';

const dealUrl = 'https://bfmr.com/deals/d-bbsqg';
const dealId = 'd-bbsqg';

async function promptFor(readline: ReturnType<typeof createInterface>, prompt: string, expected: string) {
  const answer = await readline.question(prompt);
  if (answer.trim() !== expected) throw new Error(`Expected ${expected}; no further reservation action was taken.`);
}

async function main() {
  if (!process.stdin.isTTY) throw new Error('This live test requires an interactive terminal.');
  requireReservationAlerts();
  const browser = new PlaywrightBfmrBrowser();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await withReservationFailureAlert(`Watch recovery test: ${dealUrl}`, async () => {
      console.log('[Live BFMR resume] Opening the Watch Series 11 deal from the received email.');
      const session = await browser.verifySession(process.env.BFMR_EXPECTED_ACCOUNT, dealUrl);
      if (session !== 'AUTHENTICATED' && session !== 'CHALLENGE') {
        throw new Error(`BFMR session/deal verification failed: ${session}. No reservation was attempted.`);
      }
      console.log(session === 'CHALLENGE'
        ? 'Resolve any CAPTCHA or sign-in challenge, then confirm the correct account and deal are visible.'
        : 'Confirm the correct BFMR account and this exact deal are visible in the browser.');
      await promptFor(readline, 'Type PAGE-READY after checking the account and deal: ', 'PAGE-READY');

      if (!(await browser.confirmCurrentDealPageAfterManualAccess(dealUrl))) {
        throw new Error('The BFMR page still shows a challenge or is not a usable deal page. No reservation was attempted.');
      }

      const visibleDealTitle = await browser.getVisibleDealTitle();
      if (!visibleDealTitle) throw new Error('BFMR did not expose a visible deal title for the My Tracker check. No reservation was attempted.');
      console.log(`[Live BFMR resume] BFMR deal title: ${visibleDealTitle}`);

      const before = await checkDealReservation(dealId, visibleDealTitle);
      if (before.status === 'UNKNOWN') throw new Error(`My Tracker preflight failed: ${before.error}. No reservation was attempted.`);
      if (before.status === 'CONFIRMED' || before.status === 'EXISTING') {
        throw new Error(`My Tracker already has a reserved row for this deal (quantity ${before.quantity}). No reservation was attempted.`);
      }

      console.log('[Live BFMR resume] Submitting one unit through the BFMR form.');
      const submission = await browser.submitReservation(dealUrl, dealId);
      if (submission.status === 'AUTH_REQUIRED' || submission.status === 'CLOSED_NO_SLOTS') {
        throw new Error(`The reservation form was not submitted: ${submission.errorDetail || submission.status}.`);
      }
      const result = await automaticConfirmation(() => checkDealReservation(dealId, visibleDealTitle));
      if (result.status !== 'CONFIRMED') {
        const detail = result.status === 'UNKNOWN'
          ? result.error
          : result.status === 'EXISTING'
            ? `My Tracker shows quantity ${result.quantity}`
            : 'no matching quantity-one reserved row became visible';
        throw new Error(`My Tracker did not confirm this reservation (${detail}). Check My Tracker before any retry.`);
      }
      console.log(`[Live BFMR resume] PASS: My Tracker API confirmed quantity one for ${dealId}.`);
    });
  } finally {
    readline.close();
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[Live BFMR resume] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
