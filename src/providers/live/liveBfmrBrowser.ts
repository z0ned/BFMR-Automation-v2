import { PlaywrightBfmrBrowser, type ReservationSubmissionResult } from '../../adapters/playwrightBrowser';
import type { IBfmrBrowser } from '../interfaces';

/**
 * Concrete IBfmrBrowser implementation delegating to the live Playwright browser session.
 */
export class LiveBfmrBrowser implements IBfmrBrowser {
  constructor(private readonly browser: PlaywrightBfmrBrowser) {}

  public async verifySession(
    expectedAccount?: string,
    dealUrl?: string
  ): Promise<'AUTHENTICATED' | 'AUTH_REQUIRED' | 'UNTRUSTED_REDIRECT' | 'DEAL_PAGE_MISMATCH' | 'PAGE_ERROR' | 'CHALLENGE'> {
    return this.browser.verifySession(expectedAccount, dealUrl);
  }

  public async getCurrentDealUnavailableReason(): Promise<string | null> {
    return this.browser.getCurrentDealUnavailableReason();
  }

  public async confirmCurrentDealPageAfterManualAccess(dealUrl: string): Promise<boolean> {
    return this.browser.confirmCurrentDealPageAfterManualAccess(dealUrl);
  }

  public async getVisibleDealTitle(): Promise<string | null> {
    return this.browser.getVisibleDealTitle();
  }

  public async getCurrentUrl(): Promise<string> {
    const page = await this.browser.init();
    return page.url();
  }

  public async submitReservation(dealUrl: string, dealId: string): Promise<ReservationSubmissionResult> {
    return this.browser.submitReservation(dealUrl, dealId);
  }

  public async close(): Promise<void> {
    return this.browser.close();
  }

  public getUnderlyingBrowser(): PlaywrightBfmrBrowser {
    return this.browser;
  }
}
