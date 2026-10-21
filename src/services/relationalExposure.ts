import type { RelationalDatabase } from '../db/relationalDatabase';
import type { JsonObject, ReservationRecord, SyncRunRecord } from '../db/relationalTypes';
import type { ReservationReference } from './amazonEvaluation';
import { BFMR_FULL_SYNC_SCOPE, BFMR_RESERVATION_RESOURCE, ReservationReviewRequiredError } from './bfmrRelationalSync';
import { usdToCents } from './relationalTrackerTerms';

interface ExposureRow extends ReservationRecord { bfmr_deal_id: string; paid_amount: string | null; order_count: string }
interface CoverageRow { reservation_id: string | null; is_complete: boolean; observed_at: string | Date; response_data: JsonObject }

function instant(value: string | Date | null): number {
  return value instanceof Date ? value.getTime() : value === null ? NaN : Date.parse(value);
}

/** Current locked business records are usable only with fresh, complete provider/payment coverage. */
export async function readRelationalExposureCents(db: RelationalDatabase, current: ReservationReference, options: {
  now?: Date;
  maxAgeMs?: number;
  contractValidated?: boolean;
} = {}): Promise<number> {
  const contractValidated = options.contractValidated ?? process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED === 'YES';
  if (!contractValidated) throw new ReservationReviewRequiredError(['PROVIDER_FINANCIAL_CONTRACT_UNVALIDATED']);
  const now = options.now?.getTime() ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
  if (!Number.isFinite(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error('Exposure freshness policy is invalid.');
  return db.withTransaction(async tx => {
    // Do not fall back to an older successful run after a newer failed/incomplete attempt.
    const result = await tx.query<SyncRunRecord>(`SELECT * FROM public.sync_runs
      WHERE provider = $1 AND scope = $2 ORDER BY started_at DESC, id DESC LIMIT 1`, ['BFMR', BFMR_FULL_SYNC_SCOPE]);
    const run = result.rows[0];
    if (!run || run.status !== 'COMPLETED' || !run.is_complete || !Number.isFinite(instant(run.completed_at)) ||
      instant(run.completed_at) > now || now - instant(run.completed_at) > maxAgeMs) {
      throw new ReservationReviewRequiredError(['FRESH_COMPLETE_RECONCILIATION_REQUIRED']);
    }
    const coverage = (await tx.query<CoverageRow>(`SELECT reservation_id, is_complete, observed_at, response_data
      FROM public.provider_observations WHERE sync_run_id = $1 AND provider = $2 AND resource_type = $3`,
    [run.id, 'BFMR', BFMR_RESERVATION_RESOURCE])).rows;
    const reservations = (await tx.query<ExposureRow>(`SELECT r.*, d.bfmr_deal_id, p.amount AS paid_amount,
      (SELECT COUNT(*) FROM public.orders o WHERE o.reservation_id = r.id)::text AS order_count
      FROM public.reservations r JOIN public.deals d ON d.id = r.deal_id
      LEFT JOIN public.reimbursements p ON p.reservation_id = r.id ORDER BY r.id`)).rows;
    if (coverage.length !== reservations.length || coverage.length !== run.records_received ||
      new Set(coverage.map(row => row.reservation_id)).size !== coverage.length ||
      coverage.some(row => !row.reservation_id || !row.is_complete || !Number.isFinite(instant(row.observed_at)) ||
        instant(row.observed_at) > now || now - instant(row.observed_at) > maxAgeMs)) {
      throw new ReservationReviewRequiredError(['RESERVATION_COVERAGE_INCOMPLETE'], run.id);
    }
    const byId = new Map(coverage.map(row => [row.reservation_id, row.response_data]));
    let foundCurrent = false;
    let total = 0;
    for (const reservation of reservations) {
      const evidence = byId.get(reservation.id);
      const payout = usdToCents(reservation.expected_payout);
      const actualPaid = reservation.paid_amount === null ? 0 : usdToCents(reservation.paid_amount);
      if (!evidence || evidence.bfmr_reservation_id !== reservation.bfmr_reservation_id ||
        evidence.bfmr_deal_id !== reservation.bfmr_deal_id || evidence.quantity !== reservation.quantity ||
        evidence.expected_payout_cents !== payout || evidence.amount_paid_cents !== actualPaid) {
        throw new ReservationReviewRequiredError(['RESERVATION_OR_PAYMENT_COVERAGE_CHANGED'], run.id);
      }
      if (reservation.bfmr_reservation_id === current.reserveId) {
        if (foundCurrent || reservation.bfmr_deal_id !== current.dealId || reservation.quantity !== 1 ||
          evidence.provider_status !== 'reserved' || reservation.order_count !== '0') {
          throw new ReservationReviewRequiredError(['CURRENT_RESERVATION_NOT_PURCHASABLE'], run.id);
        }
        foundCurrent = true;
        continue;
      }
      const canceled = ['cancelled', 'canceled', 'released', 'expired'].includes(String(evidence.provider_status));
      if (canceled && reservation.order_count === '0') continue;
      total += Math.max(0, payout - actualPaid);
      if (!Number.isSafeInteger(total)) throw new Error('Outstanding exposure exceeds the safe cents range.');
    }
    if (!foundCurrent) throw new ReservationReviewRequiredError(['CURRENT_RESERVATION_MISSING'], run.id);
    return total;
  });
}
