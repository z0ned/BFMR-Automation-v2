import type {
  IBfmrApi,
  ProviderTrackerRow,
  ReservationCheckResult,
} from '../providers/interfaces';
import type { ReservationReference } from '../services/amazonEvaluation';
import type { SimulatedStore } from './simulatedStore';

export class SimulatedBfmrApi implements IBfmrApi {
  constructor(
    private readonly store: SimulatedStore,
    private readonly runId: string,
    private readonly accountId: string = 'synthetic-operator-1'
  ) {}

  public async resolveDealId(dealUrl: string): Promise<string> {
    const fault = await this.store.checkAndTriggerFault(this.runId, 'RESOLVE_DEAL');
    if (fault) {
      throw new Error(`[Simulated BFMR API Fault: ${fault.faultType}] ${fault.errorDetail || 'Simulated API deal resolution failure'}`);
    }

    const slug = new URL(dealUrl).pathname.split('/').filter(Boolean).at(-1)!;
    const deal = await this.store.getDealBySlug(this.runId, slug);
    if (!deal) {
      throw new Error(`[Simulated BFMR API] Deal slug "${slug}" not found in simulated deal catalog for run ${this.runId}.`);
    }
    return deal.dealId;
  }

  public async readRecentReservedRows(): Promise<ProviderTrackerRow[]> {
    const fault = await this.store.checkAndTriggerFault(this.runId, 'TRACKER_READ');
    if (fault) {
      if (fault.faultType === 'INCOMPLETE_READ') {
        throw new Error('My Tracker pagination failed: simulated incomplete read (HTTP 500)');
      }
      if (fault.faultType === 'FAIL_BEFORE_COMMIT') {
        throw new Error('Simulated network failure on My Tracker endpoint');
      }
    }

    const reservations = await this.store.getReservations(this.runId);
    const deals = await this.store.getDeals(this.runId);
    const dealMap = new Map(deals.map((d) => [d.dealId, d]));

    return reservations.map((r) => {
      const deal = dealMap.get(r.dealId);
      return {
        reserve_id: r.reserveId,
        deal_id: r.dealId,
        deal_title: deal?.title || 'Simulated Deal Title',
        title: deal?.title || 'Simulated Deal Title',
        qty: r.quantity,
        quantity: r.quantity,
        status: r.status,
        item_status: r.status,
        reservation_status: r.status,
        payout_price: deal ? (deal.payoutCents / 100).toFixed(2) : '0.00',
        retail_price: deal ? (deal.retailCents / 100).toFixed(2) : '0.00',
        created_at: r.createdAt,
      };
    });
  }

  public async inspectReservations(
    dealId: string,
    _dealTitle: string,
    purpose: 'DUPLICATE' | 'CONFIRMATION' = 'DUPLICATE'
  ): Promise<ReservationCheckResult> {
    const rows = await this.readRecentReservedRows();
    const matching = rows.filter(
      (r) => String(r.deal_id) === String(dealId) && String(r.status).toLowerCase() === 'reserved'
    );

    if (matching.length > 1) {
      return {
        status: 'UNKNOWN',
        error: 'Multiple matching reserved rows in simulated tracker',
      };
    }

    const row = matching[0];
    if (!row) {
      return { status: 'NOT_VISIBLE_YET' };
    }

    const quantity = Number(row.qty ?? row.quantity ?? 1);
    const reserveId = String(row.reserve_id);

    if (purpose === 'DUPLICATE') {
      return { status: 'EXISTING', quantity };
    }

    if (quantity === 1) {
      return {
        status: 'CONFIRMED',
        quantity: 1,
        reference: { reserveId, dealId },
      };
    }

    return { status: 'EXISTING', quantity };
  }

  public async cancelReservation(reference: ReservationReference): Promise<boolean> {
    const fault = await this.store.checkAndTriggerFault(this.runId, 'CANCEL_RESERVATION');
    if (fault) {
      throw new Error(`[Simulated BFMR API Fault: ${fault.faultType}] Cancellation failed in simulation.`);
    }

    return this.store.cancelReservation(this.runId, reference.reserveId);
  }

  public async getDeal(slug: string): Promise<import('../providers/interfaces').BfmrDealDetail | null> {
    const deal = await this.store.getDealBySlug(this.runId, slug);
    if (!deal) return null;
    return {
      dealId: deal.dealId,
      slug: deal.slug,
      title: deal.title,
      payoutPriceCents: deal.payoutCents,
      retailers: [{ retailerName: deal.retailer, productUrl: `https://www.amazon.com/dp/${deal.asin}` }],
    };
  }
}
