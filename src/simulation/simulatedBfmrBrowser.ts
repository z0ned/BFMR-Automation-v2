import type {
  IBfmrBrowser,
  ReservationSubmissionResult,
} from '../providers/interfaces';
import type { SimulatedStore } from './simulatedStore';

export class SimulatedBfmrBrowser implements IBfmrBrowser {
  private currentUrl: string = 'https://www.bfmr.com/deals';
  private currentDealId: string | null = null;
  private currentDealTitle: string | null = null;

  constructor(
    private readonly store: SimulatedStore,
    private readonly runId: string,
    private readonly accountId: string = 'synthetic-operator-1'
  ) {}

  public async verifySession(
    _expectedAccount?: string,
    dealUrl?: string
  ): Promise<'AUTHENTICATED' | 'AUTH_REQUIRED' | 'UNTRUSTED_REDIRECT' | 'DEAL_PAGE_MISMATCH' | 'PAGE_ERROR' | 'CHALLENGE'> {
    const fault = await this.store.checkAndTriggerFault(this.runId, 'VERIFY_SESSION');
    if (fault) {
      if (fault.faultType === 'AUTH_CHALLENGE') return 'CHALLENGE';
      if (fault.faultType === 'FAIL_BEFORE_COMMIT') return 'PAGE_ERROR';
    }

    if (dealUrl) {
      this.currentUrl = dealUrl;
      const slug = new URL(dealUrl).pathname.split('/').filter(Boolean).at(-1)!;
      const deal = await this.store.getDealBySlug(this.runId, slug);
      if (!deal) {
        return 'PAGE_ERROR';
      }
      if (deal.isClosed) {
        return 'DEAL_PAGE_MISMATCH';
      }
      this.currentDealId = deal.dealId;
      this.currentDealTitle = deal.title;
    }

    return 'AUTHENTICATED';
  }

  public async getCurrentDealUnavailableReason(): Promise<string | null> {
    if (!this.currentDealId) return null;
    const deal = await this.store.getDealById(this.runId, this.currentDealId);
    if (!deal) return 'Deal not found in simulation';
    if (deal.isClosed) return 'Deal is closed';
    if (deal.availableSlots <= 0) return 'No reservation slots available';
    return null;
  }

  public async confirmCurrentDealPageAfterManualAccess(dealUrl: string): Promise<boolean> {
    this.currentUrl = dealUrl;
    return true;
  }

  public async getVisibleDealTitle(): Promise<string | null> {
    if (this.currentDealTitle) return this.currentDealTitle;
    if (this.currentDealId) {
      const deal = await this.store.getDealById(this.runId, this.currentDealId);
      return deal?.title ?? null;
    }
    return null;
  }

  public async getCurrentUrl(): Promise<string> {
    return this.currentUrl;
  }

  public async submitReservation(dealUrl: string, dealId: string): Promise<ReservationSubmissionResult> {
    const fault = await this.store.checkAndTriggerFault(this.runId, 'SUBMIT_RESERVATION');

    if (fault) {
      if (fault.faultType === 'FAIL_BEFORE_COMMIT') {
        return {
          status: 'FAILED_500',
          dealId,
          errorDetail: fault.errorDetail || 'Simulated 500 error from BFMR server before reservation commit',
          definitiveNonCreation: true,
        };
      }

      if (fault.faultType === 'DROP_CONFIRMATION_AFTER_COMMIT') {
        // Critical Section 9 condition: Reservation commits in provider truth,
        // but browser confirmation / response readback is lost!
        await this.store.createReservation(this.runId, dealId, this.accountId, 1);
        return {
          status: 'UNCERTAIN',
          dealId,
          errorDetail: fault.errorDetail || 'Browser confirmation timed out after commit; reservation outcome uncertain',
        };
      }
    }

    const deal = await this.store.getDealById(this.runId, dealId);
    if (!deal || deal.isClosed || deal.availableSlots <= 0) {
      return {
        status: 'CLOSED_NO_SLOTS',
        dealId,
        errorDetail: 'Deal reservation slots exhausted',
      };
    }

    // Normal happy-path commit
    const res = await this.store.createReservation(this.runId, dealId, this.accountId, 1);

    return {
      status: 'SUBMITTED',
      dealId,
      reservationId: res.reserveId,
      toastAcknowledgement: true,
    };
  }

  public async close(): Promise<void> {
    // No-op for simulated browser
  }
}
