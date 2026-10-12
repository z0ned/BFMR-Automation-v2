import { bfmrStatus, bfmrStatusClass } from './bfmrStatus';
import { readRecentReservedRows, type TrackerReservationRow } from './bfmrTrackerApi';
import type { ReservationReference } from './amazonEvaluation';

function cents(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const raw = String(value).trim();
  if (!/^\$?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^\$?\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const amount = Math.round(Number(raw.replace(/[$,]/g, '')) * 100);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function payoutForRow(row: TrackerReservationRow): number | null {
  const quantity = Number(row.qty ?? row.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
  const totalFields = [row.expected_payout, row.payout_total, row.total_payout, row.payout_amount]
    .filter(value => value !== undefined && value !== null).map(cents);
  const unitFields = [row.payout_price, row.payout].filter(value => value !== undefined && value !== null).map(cents);
  if (totalFields.some(value => value === null) || unitFields.some(value => value === null)) return null;
  const totals = [...totalFields, ...unitFields.map(value => value! * quantity)];
  if (!totals.length || new Set(totals).size !== 1 || !Number.isSafeInteger(totals[0])) return null;
  const paid = row.amount_paid === undefined || row.amount_paid === null ? 0 : cents(row.amount_paid);
  if (paid === null || paid > totals[0]!) return null;
  return totals[0]! - paid;
}

/** Existing unpaid BFMR payouts plus the proposed Amazon cost; exclude this reservation's payout. */
export function openBfmrExposureCents(rows: TrackerReservationRow[], current: ReservationReference): number {
  if (!current.reserveId || !current.dealId) throw new Error('Current reservation identity is missing; exposure cannot be checked.');
  let currentCount = 0;
  let exposure = 0;
  for (const row of rows) {
    const statusValue = row.status ?? row.item_status ?? row.reservation_status;
    const status = bfmrStatus(statusValue);
    const classification = bfmrStatusClass(statusValue);
    if (classification === 'UNKNOWN') throw new Error('My Tracker has an unrecognized status; exposure is unknown.');
    if (String(row.reserve_id ?? '') === current.reserveId) {
      currentCount += 1;
      if (String(row.deal_id ?? '') !== current.dealId || status !== 'reserved' || Number(row.qty ?? row.quantity) !== 1) {
        throw new Error('Current reservation changed before the exposure check.');
      }
      continue;
    }
    if (classification === 'TERMINAL') continue;
    const payout = payoutForRow(row);
    if (payout === null) throw new Error('An unpaid BFMR row has no unambiguous unpaid payout; exposure is unknown.');
    exposure += payout;
    if (!Number.isSafeInteger(exposure)) throw new Error('Open BFMR exposure exceeds a safe numeric range.');
  }
  if (currentCount !== 1) throw new Error('Current reservation is missing or duplicated in My Tracker; exposure is unknown.');
  return exposure;
}

export async function readOpenBfmrExposureCents(current: ReservationReference): Promise<number> {
  if (process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED !== 'YES') {
    throw new Error('My Tracker open-order payout/status contract has not been validated; no Amazon order was submitted.');
  }
  return openBfmrExposureCents(await readRecentReservedRows(), current);
}
