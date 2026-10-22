import type { ReservationSubmissionResult } from '../adapters/playwrightBrowser';
import type { IpadReservationCheck } from './bfmrTrackerApi';
import { isTrustedBfmrDealUrl } from './bfmrUrl';
import type { ReservationReference } from './amazonEvaluation';

export interface StartupDeal { url: string; id: string; title: string }
export interface StartupAttempt extends StartupDeal {
  ordinal: 1 | 2;
  state: 'SUBMITTING' | 'CONFIRMED' | 'RETRY_PENDING' | 'REVIEW' | 'EXHAUSTED' | 'SKIPPED' | 'CLEANUP_PENDING' | 'CLEANED';
  reference?: ReservationReference;
}
export interface StartupReservationDependencies {
  onProvedFailure?(deal: StartupDeal): Promise<void>;
  afterConfirmed?(reference: ReservationReference | undefined): Promise<void>;
  afterNotSubmitted?(deal: StartupDeal): Promise<void>;
  listDeals(): Promise<string[]>;
  inspectDeal(url: string): Promise<StartupDeal | null>;
  submit(deal: StartupDeal): Promise<ReservationSubmissionResult>;
  check(deal: StartupDeal, purpose?: 'DUPLICATE' | 'CONFIRMATION'): Promise<IpadReservationCheck>;
  waitForManualAccess(): Promise<void>;
  journal: { load(): Promise<StartupAttempt | null>; save(attempt: StartupAttempt): Promise<void> };
  wait(ms: number): Promise<void>;
  log(message: string): void;
}

/** Serial startup reservation: no console approval, at most two submit ordinals. */
export async function runStartupReservation(deps: StartupReservationDependencies): Promise<'CONFIRMED' | 'NO_CANDIDATE'> {
  async function confirmed(attempt: StartupAttempt, reference: ReservationReference | undefined) {
    if (deps.afterConfirmed) {
      await deps.journal.save({ ...attempt, reference, state: 'CLEANUP_PENDING' });
      await deps.afterConfirmed(reference);
      await deps.journal.save({ ...attempt, reference, state: 'CLEANED' });
    } else await deps.journal.save({ ...attempt, state: 'CONFIRMED' });
  }
  const previous = await deps.journal.load();
  if (previous?.state === 'CLEANUP_PENDING') {
    if (!deps.afterConfirmed) throw new Error('Startup cleanup handler is required to recover this reservation.');
    await confirmed(previous, previous.reference);
  }
  if (previous && ['SUBMITTING', 'REVIEW'].includes(previous.state)) {
    const recovery = await deps.check(previous, 'CONFIRMATION');
    if (recovery.status !== 'CONFIRMED') {
      throw new Error('A previous startup reservation is unresolved. Check My Tracker before any new startup submission.');
    }
    await confirmed(previous, recovery.reference);
    deps.log('My Tracker confirmed the previous startup attempt; preparing this startup.');
  }

  const resume = previous?.state === 'RETRY_PENDING' ? previous : null;
  const listed = await deps.listDeals();
  const urls = resume ? [resume.url, ...listed] : listed;
  for (const url of [...new Set(urls)]) {
    if (!isTrustedBfmrDealUrl(url)) throw new Error('Startup listing contained an untrusted deal URL.');
    const resumingThisDeal = resume?.url === url ? resume : null;
    for (let ordinal = resumingThisDeal ? resumingThisDeal.ordinal + 1 : 1; ordinal <= 2; ordinal += 1) {
      const deal = await deps.inspectDeal(url);
      if (!deal) {
        if (resumingThisDeal) await deps.journal.save({ ...resumingThisDeal, state: 'SKIPPED' });
        deps.log('SKIPPED: startup deal is full, closed or not found; trying the next deal.');
        break;
      }
      if (!isTrustedBfmrDealUrl(deal.url) || !deal.id || !deal.title.trim()) throw new Error('Startup deal identity is incomplete.');
      const before = await deps.check(deal);
      if (before.status === 'UNKNOWN') throw new Error(`Startup My Tracker preflight failed: ${before.error}`);
      if (before.status === 'CONFIRMED' || before.status === 'EXISTING') {
        deps.log('SKIPPED: startup deal is already reserved; trying the next deal.');
        if (resumingThisDeal) await deps.journal.save({ ...resumingThisDeal, state: 'SKIPPED' });
        break;
      }
      const attempt: StartupAttempt = { ...deal, ordinal: ordinal as 1 | 2, state: 'SUBMITTING' };
      // This write must finish before calling anything that could click Reserve.
      await deps.journal.save(attempt);
      let submission: ReservationSubmissionResult;
      try { submission = await deps.submit(deal); }
      catch (error) {
        await deps.journal.save({ ...attempt, state: 'REVIEW' });
        throw error;
      }
      if (submission.status === 'CLOSED_NO_SLOTS') {
        await deps.afterNotSubmitted?.(deal);
        await deps.journal.save({ ...attempt, state: 'SKIPPED' });
        deps.log('SKIPPED: startup deal became unavailable before submission; trying the next deal.');
        break;
      }
      if (submission.status === 'AUTH_REQUIRED') {
        await deps.afterNotSubmitted?.(deal);
        await deps.journal.save({ ...attempt, state: 'SKIPPED' });
        throw new Error('Startup authentication is required; the reservation was not submitted.');
      }

      // Manual CAPTCHA completion happens in the browser; no CHECK-API prompt.
      // Neither a toast nor an empty tracker response proves creation/non-creation.
      let check: IpadReservationCheck = await deps.check(deal, 'CONFIRMATION');
      for (const delay of [10000, 20000]) {
        if (check.status === 'CONFIRMED' || check.status === 'EXISTING') break;
        await deps.waitForManualAccess();
        await deps.wait(delay);
        check = await deps.check(deal, 'CONFIRMATION');
      }
      if (check.status === 'CONFIRMED') {
        await confirmed(attempt, check.reference);
        deps.log('PASS: My Tracker confirmed the startup quantity-one reservation.');
        return 'CONFIRMED';
      }
      // FAILED_500 is retryable only when the adapter proves non-creation.
      // The live adapter currently returns uncertainty for unproved failures.
      if (submission.status === 'FAILED_500' && submission.definitiveNonCreation === true && check.status === 'NOT_VISIBLE_YET') {
        await deps.journal.save({ ...attempt, state: ordinal === 1 ? 'RETRY_PENDING' : 'EXHAUSTED' });
        await deps.onProvedFailure?.(deal);
        if (ordinal === 1) { deps.log('Startup submission definitively failed; rechecking before ordinal two.'); continue; }
        deps.log('SKIPPED: startup deal exhausted its two submission ordinals with proved non-creation; trying the next deal.');
        break;
      }
      await deps.journal.save({ ...attempt, state: 'REVIEW' });
      throw new Error(check.status === 'EXISTING'
        ? `Startup reservation quantity conflict (${check.quantity}); manual review required.`
        : 'My Tracker did not confirm startup creation; outcome remains uncertain. No automatic resubmission.');
    }
  }
  deps.log('No unreserved available deal was found in the displayed deals list; continuing the test.');
  return 'NO_CANDIDATE';
}
