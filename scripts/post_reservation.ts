import { environmentPaths } from '../src/config/environment';
import os from 'node:os';
import path from 'node:path';
import { readAmazonSupplier, type ReservationReference } from '../src/services/amazonEvaluation';
import { cancelConfirmedReservation } from '../src/services/reservationCancellation';
import { readRecentReservedRows } from '../src/services/bfmrTrackerApi';
import { completePostReservation, recoverPostReservation, type PostReservationTask } from '../src/services/postReservation';
import { postReservationJournal } from '../src/services/postReservationJournal';

function dependencies(beforeMutation?: () => Promise<void>) {
  return {
    journal: postReservationJournal(process.env.BFMR_POST_RESERVATION_STATE_PATH || path.join(environmentPaths().state, 'post-reservation.json')),
    readAmazon: readAmazonSupplier,
    cancel: (reference: ReservationReference, recoveryOnly: boolean) => cancelConfirmedReservation(reference, recoveryOnly,
      beforeMutation ? { readRows: readRecentReservedRows, request: fetch,
        wait: ms => new Promise(resolve => setTimeout(resolve, ms)), beforeMutation } : undefined),
    log: (message: string) => console.log(`[BFMR evaluation] ${message}`),
  };
}

export function finishLiveReservation(reference: ReservationReference | undefined, kind: 'STARTUP' | 'EMAIL', beforeMutation?: () => Promise<void>) {
  return completePostReservation(reference, kind, dependencies(beforeMutation));
}

export async function recoverLivePostReservation(hooks: {
  beforeMutation?(): Promise<void>;
  beforeRecovery?(task: PostReservationTask): Promise<void>;
  afterRecovery?(task: PostReservationTask): Promise<void>;
} = {}) {
  const deps = dependencies(hooks.beforeMutation);
  const pending = await deps.journal.load();
  const unfinished = pending && !['KEPT', 'CANCELLED'].includes(pending.state);
  if (unfinished) await hooks.beforeRecovery?.(pending);
  await recoverPostReservation(deps);
  if (unfinished) {
    const completed = await deps.journal.load();
    if (!completed || completed.reference.reserveId !== pending.reference.reserveId ||
        completed.reference.dealId !== pending.reference.dealId) throw new Error('Recovery journal identity changed.');
    await hooks.afterRecovery?.(completed);
  }
}
