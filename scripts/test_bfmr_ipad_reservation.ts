import './loadEnv';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { checkIpadAirReservation } from '../src/services/bfmrTrackerApi';
import { runLiveTestStartup } from './live_test_startup';
import { automaticConfirmation } from '../src/services/automaticConfirmation';
import { requireReservationAlerts, withReservationFailureAlert } from '../src/services/reservationAlerts';

const dealUrl = 'https://www.bfmr.com/deals/apple-ipad-air-8-11-2026-m4-256gb-wifi-3';
const dealId = new URL(dealUrl).pathname.split('/').filter(Boolean).at(-1)!;

async function main() {
  if (!process.stdin.isTTY) throw new Error('This live reservation test requires an interactive terminal.');
  requireReservationAlerts();
  const browser = new PlaywrightBfmrBrowser();

  try {
    await runLiveTestStartup(browser);
    await withReservationFailureAlert(`iPad live test: ${dealUrl}`, async () => {
      console.log('[Live BFMR test] Opening the browser and navigating to the specified iPad Air deal.');
      const session = await browser.verifySession(process.env.BFMR_EXPECTED_ACCOUNT, dealUrl);
      if (session !== 'AUTHENTICATED' && session !== 'CHALLENGE') {
        throw new Error(`BFMR session/deal verification failed: ${session}. No reservation was attempted.`);
      }
      if (!process.stdin.isTTY) {
        throw new Error('This live reservation test requires an interactive terminal so you can complete CAPTCHA/login before processing can continue.');
      }

      if (session === 'CHALLENGE') throw new Error('Unexpected access challenge after startup; inspect the browser.');

      if (!(await browser.confirmCurrentDealPageAfterManualAccess(dealUrl))) {
        throw new Error('The BFMR page still shows a CAPTCHA/login challenge or is not a usable deal page. No reservation was attempted.');
      }

      const existing = await checkIpadAirReservation(dealId);
      if (existing.status === 'CONFIRMED' || existing.status === 'EXISTING') {
        console.log(`[Live BFMR test] SKIPPED: My Tracker already shows a reserved iPad Air (quantity ${existing.quantity}). No duplicate reservation was attempted.`);
        return;
      }
      if (existing.status === 'UNKNOWN') {
        throw new Error(`Could not complete the My Tracker duplicate check: ${existing.error}. No reservation was attempted.`);
      }

      console.log('[Live BFMR test] Submitting exactly one reservation through the BFMR website form.');
      const result = await browser.submitReservation(dealUrl, dealId);
      if (result.status === 'AUTH_REQUIRED' || result.status === 'CLOSED_NO_SLOTS') {
        throw new Error(`Reservation was not submitted: ${result.errorDetail || result.status}.`);
      }

      console.log('[Live BFMR test] Checking My Tracker automatically.');
      const lastCheck = await automaticConfirmation(() => checkIpadAirReservation(dealId));
      if (lastCheck.status === 'EXISTING') {
        throw new Error(`My Tracker shows the deal reserved with quantity ${lastCheck.quantity}, not quantity 1. Check My Tracker before any retry.`);
      }
      if (lastCheck.status !== 'CONFIRMED') {
        const detail = lastCheck.status === 'UNKNOWN' ? lastCheck.error : 'No matching reserved quantity-one row became visible';
        throw new Error(`My Tracker API did not confirm this reservation: ${detail}. Check My Tracker manually before any retry.`);
      }

      console.log(`[Live BFMR test] PASS: My Tracker API confirmed a quantity-one reservation for ${dealId}.`);
    });
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[Live BFMR test] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
