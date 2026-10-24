import type { IBfmrApi, ProviderTrackerRow, ReservationCheckResult } from '../interfaces';
import type { ReservationReference } from '../../services/amazonEvaluation';
import { resolveBfmrDealId, readRecentReservedRows, checkDealReservation } from '../../services/bfmrTrackerApi';
import { cancelConfirmedReservation } from '../../services/reservationCancellation';

/**
 * Concrete IBfmrApi implementation communicating with the live BFMR API.
 */
export class LiveBfmrApi implements IBfmrApi {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  public async resolveDealId(dealUrl: string): Promise<string> {
    return resolveBfmrDealId(dealUrl, this.fetchFn);
  }

  public async readRecentReservedRows(): Promise<ProviderTrackerRow[]> {
    return readRecentReservedRows();
  }

  public async inspectReservations(
    dealId: string,
    dealTitle: string,
    purpose: 'DUPLICATE' | 'CONFIRMATION' = 'DUPLICATE'
  ): Promise<ReservationCheckResult> {
    return checkDealReservation(dealId, dealTitle, purpose);
  }

  public async cancelReservation(reference: ReservationReference): Promise<boolean> {
    await cancelConfirmedReservation(reference, false, {
      readRows: readRecentReservedRows,
      request: this.fetchFn,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    return true;
  }

  public async getDeal(slug: string): Promise<import('../interfaces').BfmrDealDetail | null> {
    const key = process.env.BFMR_API_KEY;
    const secret = process.env.BFMR_API_SECRET;
    if (!key || !secret) throw new Error('BFMR API credentials are required.');
    const response = await this.fetchFn(`https://api.bfmr.com/api/v2/deals/${encodeURIComponent(slug)}`, {
      headers: { 'API-KEY': key, 'API-SECRET': secret, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as any;
    const deal = payload?.deal;
    if (!deal) return null;
    const payout = Number(deal.payout_price ?? deal.reimbursement_amount ?? 0) * 100;
    return {
      dealId: String(deal.deal_id),
      slug: String(deal.slug ?? slug),
      title: String(deal.title),
      payoutPriceCents: Math.round(payout),
    };
  }
}
