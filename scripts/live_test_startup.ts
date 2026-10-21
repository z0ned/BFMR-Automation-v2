import path from 'node:path';
import os from 'node:os';
import type { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { checkDealReservation, resolveBfmrDealId } from '../src/services/bfmrTrackerApi';
import { runStartupReservation } from '../src/services/startupReservation';
import { startupJournal } from '../src/services/startupJournal';
import { sendReservationFailureAlert, withReservationFailureAlert } from '../src/services/reservationAlerts';
import { finishLiveReservation, recoverLivePostReservation } from './post_reservation';
import type { StartupDeal } from '../src/services/startupReservation';
import type { ReservationReference } from '../src/services/amazonEvaluation';
import type { PostReservationTask } from '../src/services/postReservation';

export async function runLiveTestStartup(browser: PlaywrightBfmrBrowser, hooks: {
  beforeStartup?(): Promise<void>;
  beforeSubmit?(deal: StartupDeal): Promise<void>;
  afterConfirmed?(reference: ReservationReference | undefined): Promise<void>;
  afterCancelled?(reference: ReservationReference | undefined): Promise<void>;
  beforeRecovery?(task: PostReservationTask): Promise<void>;
  afterRecovery?(task: PostReservationTask): Promise<void>;
} = {}) {
  await browser.init();
  const file = process.env.BFMR_STARTUP_STATE_PATH || path.join(os.homedir(), '.local/state/bfmr/startup-reservation.json');
  return withReservationFailureAlert('Startup reservation processing stopped. Inspect the browser, journal and terminal.', async () => {
    if (hooks.beforeStartup) {
      let session = await browser.verifySession(process.env.BFMR_EXPECTED_ACCOUNT);
      if (session === 'CHALLENGE') {
        await browser.waitForManualAccess();
        session = await browser.verifySession(process.env.BFMR_EXPECTED_ACCOUNT);
      }
      if (session !== 'AUTHENTICATED') throw new Error('Startup requires verified BFMR account alignment before relational reconciliation.');
      await hooks.beforeStartup();
    }
    await recoverLivePostReservation(hooks);
    return runStartupReservation({
      afterConfirmed: async (reference) => {
        await hooks.afterConfirmed?.(reference);
        await finishLiveReservation(reference, 'STARTUP');
        await hooks.afterCancelled?.(reference);
      },
      onProvedFailure: async (deal) => sendReservationFailureAlert(`Startup submission definitively failed: ${deal.url}. The startup flow will follow its retry/next-deal rules.`),
      listDeals: () => browser.getStartupDealUrls(),
      inspectDeal: async (url) => { const deal = await browser.inspectStartupDeal(url); return deal ? { ...deal, id: await resolveBfmrDealId(deal.url) } : null; },
      submit: async (deal) => {
        await hooks.beforeSubmit?.(deal);
        return browser.submitReservation(deal.url, deal.id);
      },
      check: (deal, purpose) => checkDealReservation(deal.id, deal.title, purpose),
      waitForManualAccess: () => browser.waitForManualAccess(),
      journal: startupJournal(file),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (message) => console.log(`[Live BFMR startup] ${message}`),
    });
  });
}
