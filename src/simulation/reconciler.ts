import type { SimulatedStore } from './simulatedStore';
import type { StateComparisonDiff, SimulatedReservation } from './types';
import type { RelationalDatabase } from '../db/relationalDatabase';

export class StateReconciler {
  constructor(private readonly store: SimulatedStore) {}

  public async evaluateDiff(
    runId: string,
    appDb: RelationalDatabase
  ): Promise<StateComparisonDiff> {
    const providerReservations = await this.store.getReservations(runId);

    // Read application state through read-only SQL query
    const appRowsRes = await appDb.withTransaction(async (tx) =>
      tx.query<{
        id: string | number;
        bfmr_reservation_id: string;
        bfmr_deal_id: string;
        status_name: string;
        quantity: number;
        payout_per_item: number | string;
      }>(`
        SELECT
          r.id,
          r.bfmr_reservation_id,
          d.bfmr_deal_id,
          rs.description as status_name,
          r.quantity,
          r.payout_per_item
        FROM reservations r
        JOIN deals d ON d.id = r.deal_id
        JOIN reservation_status rs ON rs.id = r.reservation_status_id
      `)
    ).catch(() => ({ rows: [] }));

    const applicationReservations = appRowsRes.rows.map((row) => ({
      id: String(row.id),
      bfmrReservationId: row.bfmr_reservation_id,
      dealId: row.bfmr_deal_id,
      status: row.status_name,
      quantity: Number(row.quantity),
      payoutCents: Math.round(Number(row.payout_per_item) * 100),
    }));

    const appMap = new Map(applicationReservations.map((a) => [a.bfmrReservationId, a]));
    const providerMap = new Map(providerReservations.map((p) => [p.reserveId, p]));

    const matches: StateComparisonDiff['matches'] = [];
    const discrepancies: StateComparisonDiff['discrepancies'] = [];
    const missingInApp: SimulatedReservation[] = [];
    const missingInProvider: StateComparisonDiff['missingInProvider'] = [];

    for (const p of providerReservations) {
      const app = appMap.get(p.reserveId);
      if (!app) {
        missingInApp.push(p);
      } else {
        const statusMatches =
          p.status.toLowerCase() === app.status.toLowerCase() ||
          (p.status.toLowerCase() === 'reserved' && app.status.toLowerCase() === 'active') ||
          (['purchased','delivered'].includes(p.status.toLowerCase()) && app.status.toLowerCase() === 'active') ||
          (p.status.toLowerCase() === 'cancelled' && app.status.toLowerCase() === 'canceled') ||
          (p.status.toLowerCase() === 'canceled' && app.status.toLowerCase() === 'canceled');
        const quantityMatches = p.quantity === app.quantity;

        if (statusMatches && quantityMatches) {
          matches.push({
            reserveId: p.reserveId,
            dealId: p.dealId,
            quantity: p.quantity,
            providerStatus: p.status,
            appStatus: app.status,
          });
        } else {
          discrepancies.push({
            reserveId: p.reserveId,
            dealId: p.dealId,
            reason: !statusMatches
              ? `Status mismatch: provider has ${p.status}, application recorded ${app.status}`
              : `Quantity mismatch: provider has ${p.quantity}, application recorded ${app.quantity}`,
            providerStatus: p.status,
            appStatus: app.status,
          });
        }
      }
    }

    for (const app of applicationReservations) {
      if (!providerMap.has(app.bfmrReservationId)) {
        missingInProvider.push({
          id: app.id,
          bfmrReservationId: app.bfmrReservationId,
          dealId: app.dealId,
        });
      }
    }

    const isSynchronized =
      missingInApp.length === 0 &&
      missingInProvider.length === 0 &&
      discrepancies.length === 0;

    return {
      runId,
      evaluatedAt: new Date().toISOString(),
      isSynchronized,
      providerReservations,
      applicationReservations,
      matches,
      discrepancies,
      missingInApp,
      missingInProvider,
    };
  }
}
