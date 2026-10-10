import os from 'node:os';
import path from 'node:path';
import { readAmazonSupplier, type ReservationReference } from '../src/services/amazonEvaluation';
import { cancelConfirmedReservation } from '../src/services/reservationCancellation';
import { completePostReservation, recoverPostReservation } from '../src/services/postReservation';
import { postReservationJournal } from '../src/services/postReservationJournal';

function dependencies() {
  return {
    journal: postReservationJournal(process.env.BFMR_POST_RESERVATION_STATE_PATH || path.join(os.homedir(), '.local/state/bfmr/post-reservation.json')),
    readAmazon: readAmazonSupplier,
    cancel: cancelConfirmedReservation,
    log: (message: string) => console.log(`[BFMR evaluation] ${message}`),
  };
}

export function finishLiveReservation(reference: ReservationReference | undefined, kind: 'STARTUP' | 'EMAIL') {
  return completePostReservation(reference, kind, dependencies());
}

export function recoverLivePostReservation() { return recoverPostReservation(dependencies()); }
