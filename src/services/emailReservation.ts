import type { PlaywrightBfmrBrowser } from '../adapters/playwrightBrowser';
import type { RelationalRuntime } from './relationalRuntime';
import type { ReceivedEmail } from './dealEmailWorkflow';
import type { ReservationReference } from './amazonEvaluation';
import { prepareRelationalReservation, captureRelationalReservation, recordReservationNotAttempted } from './relationalReservations';
import { checkDealReservation, resolveBfmrDealId } from './bfmrTrackerApi';
import { automaticConfirmation } from './automaticConfirmation';

export async function reserveEmailDeal(
  browser: PlaywrightBfmrBrowser,
  deal: { canonicalDealId: string; dealUrl: string; dealTitle?: string },
  runtime: RelationalRuntime,
  email: (ReceivedEmail & { emailType: string }) | undefined,
  correlationId: string,
  assertIntakeReady: () => void | Promise<void>,
  onIntent?: (dealId: string) => Promise<void>,
): Promise<ReservationReference | null> {
  const dealUrl = deal.dealUrl;
  console.log(`\n[BFMR workflow] Reserving one BFMR offer: ${dealUrl}`);

  const session = await browser.verifySession(process.env.BFMR_EXPECTED_ACCOUNT, dealUrl);
  if (session !== 'AUTHENTICATED' && session !== 'CHALLENGE') {
    throw new Error(`BFMR session/deal verification failed: ${session}. No reservation was attempted.`);
  }
  if (session === 'CHALLENGE') {
    throw new Error('Unexpected access challenge after startup. No reservation was attempted; inspect the browser.');
  }
  console.log('[BFMR workflow] Quantity-one reservation is authorized; running preflight checks.');

  const unavailableReason = await browser.getCurrentDealUnavailableReason();
  if (unavailableReason) {
    console.log(`[BFMR workflow] SKIPPED: ${unavailableReason}. No reservation was attempted.`);
    return null;
  }

  if (!(await browser.confirmCurrentDealPageAfterManualAccess(dealUrl))) {
    const reason = await browser.getCurrentDealUnavailableReason();
    if (reason) {
      console.log(`[BFMR workflow] SKIPPED: ${reason}. No reservation was attempted.`);
      return null;
    }
    throw new Error('The BFMR page still shows a challenge or is not a usable deal page. No reservation was attempted.');
  }

  const visibleDealTitle = await browser.getVisibleDealTitle();
  // BFMR can replace the detail page with a full message during rendering.
  const updatedUnavailableReason = await browser.getCurrentDealUnavailableReason();
  if (updatedUnavailableReason) {
    console.log(`[BFMR workflow] SKIPPED: ${updatedUnavailableReason}. No reservation was attempted.`);
    return null;
  }
  if (!visibleDealTitle) throw new Error('BFMR did not expose a visible deal title for the My Tracker check. No reservation was attempted.');
  console.log(`[BFMR workflow] BFMR deal title: ${visibleDealTitle}`);

  const dealId = await resolveBfmrDealId((await browser.init()).url());
  const before = await checkDealReservation(dealId, visibleDealTitle);
  if (before.status === 'UNKNOWN') throw new Error(`My Tracker preflight failed: ${before.error}. No reservation was attempted.`);
  if (before.status === 'CONFIRMED' || before.status === 'EXISTING') {
    console.log(`[BFMR workflow] SKIPPED: My Tracker already has a reserved row for this deal (quantity ${before.quantity}). No reservation was attempted.`);
    return null;
  }

  const prepared = await prepareRelationalReservation(runtime, {
    dealUrl: (await browser.init()).url(), dealId, title: visibleDealTitle, email, correlationId,
  });
  await runtime.ownership.verifyOwnership();
  await runtime.verifyRetailerAccount();
  await assertIntakeReady();
  await onIntent?.(dealId);
  console.log('[BFMR workflow] Submitting one unit through the deal page.');
  const submission = await browser.submitReservation(dealUrl, dealId);
  if (submission.status === 'CLOSED_NO_SLOTS') {
    await recordReservationNotAttempted(runtime, prepared);
    console.log(`[BFMR workflow] SKIPPED: ${submission.errorDetail || 'Deal reservation page is unavailable'}. No reservation was attempted.`);
    return null;
  }
  if (submission.status === 'AUTH_REQUIRED') {
    await recordReservationNotAttempted(runtime, prepared);
    throw new Error(`The reservation form was not submitted: ${submission.errorDetail || submission.status}.`);
  }

  console.log('[BFMR workflow] Checking My Tracker automatically; no further form submission.');
  const result = await automaticConfirmation(() => checkDealReservation(dealId, visibleDealTitle, 'CONFIRMATION'));
  if (result.status !== 'CONFIRMED') {
    const detail = result.status === 'UNKNOWN'
      ? result.error
      : result.status === 'EXISTING'
        ? `My Tracker shows quantity ${result.quantity}`
        : 'no matching quantity-one reserved row became visible';
    throw new Error(`My Tracker did not confirm this reservation (${detail}). Check My Tracker before any retry.`);
  }

  console.log(`[BFMR workflow] PASS: My Tracker API confirmed quantity one for ${dealId}.`);
  if (!result.reference) throw new Error('My Tracker confirmed quantity one but omitted the exact reservation ID; review before evaluating or ordering.');
  await captureRelationalReservation(runtime, result.reference, prepared);
  return result.reference;
}
