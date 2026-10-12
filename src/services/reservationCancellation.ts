import { readRecentReservedRows, reservationReference, type TrackerReservationRow } from './bfmrTrackerApi';
import type { ReservationReference } from './amazonEvaluation';

/** Complete My Tracker reads are required; title matching is never used to cancel. */
export function cancellationTargetState(rows: TrackerReservationRow[], reference: ReservationReference): 'RESERVED' | 'RELEASED' {
  if (!reference.reserveId || !reference.dealId) throw new Error('Cancellation requires exact reservation and deal IDs.');
  const matches = rows.filter(row => String(row.reserve_id ?? '') === reference.reserveId);
  if (matches.length === 0) return 'RELEASED';
  if (matches.length !== 1) throw new Error('Cancellation target has multiple tracker rows; manual review required.');
  const row = matches[0];
  if (reservationReference(row)?.dealId !== reference.dealId) throw new Error('Cancellation target deal identity changed.');
  const status = row.status ?? row.item_status ?? row.reservation_status;
  if (typeof status !== 'string') throw new Error('Cancellation target status is unknown.');
  if (/^cancelled$|^canceled$/i.test(status.trim())) return 'RELEASED';
  if (!/^reserved$/i.test(status.trim()) || Number(row.qty ?? row.quantity) !== 1) {
    throw new Error('Cancellation target is no longer a quantity-one Reserved row; manual review required.');
  }
  return 'RESERVED';
}

export interface CancellationDependencies {
  readRows(): Promise<TrackerReservationRow[]>;
  request: typeof fetch;
  wait(ms: number): Promise<void>;
}

const defaults: CancellationDependencies = {
  readRows: readRecentReservedRows,
  request: (input, init) => fetch(input, init),
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** One form-encoded POST at most. Always reconcile by exact ID, even on a timeout. */
export async function cancelConfirmedReservation(reference: ReservationReference, recoveryOnly = false,
  dependencies: CancellationDependencies = defaults): Promise<void> {
  const state = cancellationTargetState(await dependencies.readRows(), reference);
  if (state === 'RELEASED') return;
  if (recoveryOnly) throw new Error('Previous cancellation is unresolved; no automatic repeat POST. Review My Tracker.');
  const key = process.env.BFMR_API_KEY;
  const secret = process.env.BFMR_API_SECRET;
  if (!key || !secret) throw new Error('BFMR API credentials are required for cancellation.');
  let responseStatus: number | undefined;
  try {
    const response = await dependencies.request('https://api.bfmr.com/api/v2/my-tracker/reservation/cancel', {
      method: 'POST',
      headers: { 'API-KEY': key, 'API-SECRET': secret, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams([['reserve_id[]', reference.reserveId]]).toString(),
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    responseStatus = response.status;
    // HTTP success alone does not prove release; response bodies may contain account data.
    await response.body?.cancel();
  } catch { /* A lost response can follow a completed cancellation. Read before deciding. */ }
  for (const delay of [0, 2000, 5000, 10000]) {
    if (delay) await dependencies.wait(delay);
    if (cancellationTargetState(await dependencies.readRows(), reference) === 'RELEASED') return;
  }
  const detail = responseStatus === undefined ? 'response unavailable' : `HTTP ${responseStatus}`;
  throw new Error(`Reservation cancellation was not confirmed (${detail}). No repeat POST; manual review required.`);
}
