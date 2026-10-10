import path from 'node:path';
import os from 'node:os';
import type { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { checkDealReservation } from '../src/services/bfmrTrackerApi';
import { runStartupReservation } from '../src/services/startupReservation';
import { startupJournal } from '../src/services/startupJournal';
import { sendReservationFailureAlert, withReservationFailureAlert } from '../src/services/reservationAlerts';
import { finishLiveReservation, recoverLivePostReservation } from './post_reservation';

export async function runLiveTestStartup(browser: PlaywrightBfmrBrowser) {
  await browser.init();
  const file = process.env.BFMR_STARTUP_STATE_PATH || path.join(os.homedir(), '.local/state/bfmr/startup-reservation.json');
  return withReservationFailureAlert('Startup reservation processing stopped. Inspect the browser, journal and terminal.', async () => {
    await recoverLivePostReservation();
    return runStartupReservation({
      afterConfirmed: (reference) => finishLiveReservation(reference, 'STARTUP'),
      onProvedFailure: async (deal) => sendReservationFailureAlert(`Startup submission definitively failed: ${deal.url}. The startup flow will follow its retry/next-deal rules.`),
      listDeals: () => browser.getStartupDealUrls(),
      inspectDeal: (url) => browser.inspectStartupDeal(url),
      submit: (deal) => browser.submitReservation(deal.url, deal.id),
      check: (deal) => checkDealReservation(deal.id, deal.title),
      waitForManualAccess: () => browser.waitForManualAccess(),
      journal: startupJournal(file),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (message) => console.log(`[Live BFMR startup] ${message}`),
    });
  });
}
