import {
  IGmailAdapter,
  IMyTrackerAdapter,
  IBrowserAdapter,
  ITelegramAdapter,
  GmailFetchMessage,
} from '../interfaces';

export class FakeGmailAdapter implements IGmailAdapter {
  public watchHistoryId = 10000;
  public messagesQueue: GmailFetchMessage[] = [];
  public shouldSimulateExpiredGap = false;

  async renewWatch(mailbox: string): Promise<{ historyId: number; expiration: string }> {
    return {
      historyId: this.watchHistoryId,
      expiration: new Date(Date.now() + 86400 * 1000 * 7).toISOString(),
    };
  }

  async fetchHistory(
    mailbox: string,
    startHistoryId: number
  ): Promise<{
    historyId: number;
    messages: GmailFetchMessage[];
    isExpiredHistoryGap?: boolean;
  }> {
    if (this.shouldSimulateExpiredGap) {
      return {
        historyId: startHistoryId,
        messages: [],
        isExpiredHistoryGap: true,
      };
    }
    const msgs = [...this.messagesQueue];
    this.messagesQueue = [];
    this.watchHistoryId += 10;
    return {
      historyId: this.watchHistoryId,
      messages: msgs,
    };
  }
}

export class FakeMyTrackerAdapter implements IMyTrackerAdapter {
  public reservations: Array<{
    rid: string;
    dealId: string;
    quantity: number;
    offerId: string;
    status: string;
  }> = [];

  public shouldFailRead = false;
  public shouldSimulateIncompleteRead = false;

  async inspectReservations(
    accountId: string,
    dealId: string
  ): Promise<{
    status: 'RESERVED' | 'CONFIRMED_NONE' | 'UNKNOWN';
    records: Array<{
      rid: string;
      dealId: string;
      quantity: number;
      offerId: string;
      status: string;
    }>;
    incompleteRead?: boolean;
    error?: string;
  }> {
    if (this.shouldFailRead) {
      return {
        status: 'UNKNOWN',
        records: [],
        error: 'Simulated 500 Network error from My Tracker endpoint',
      };
    }

    if (this.shouldSimulateIncompleteRead) {
      return {
        status: 'UNKNOWN',
        records: [],
        incompleteRead: true,
        error: 'Incomplete pagination: missing page 2',
      };
    }

    const matching = this.reservations.filter(
      (r) => r.dealId.toLowerCase() === dealId.toLowerCase() && r.status === 'RESERVED'
    );

    if (matching.length > 0) {
      return {
        status: 'RESERVED',
        records: matching,
      };
    }

    return {
      status: 'CONFIRMED_NONE',
      records: [],
    };
  }

  public addReservation(dealId: string, offerId = 'offer-default'): string {
    const rid = `RID-${Math.floor(100000 + Math.random() * 900000)}`;
    this.reservations.push({
      rid,
      dealId,
      quantity: 1,
      offerId,
      status: 'RESERVED',
    });
    return rid;
  }
}

export class FakeBrowserAdapter implements IBrowserAdapter {
  public sessionStatus: 'AUTHENTICATED' | 'AUTH_REQUIRED' | 'CHALLENGE' | 'UNKNOWN' = 'AUTHENTICATED';
  public submitOutcome: 'SUBMITTED' | 'UNCERTAIN' | 'FAILED_500' | 'CLOSED_NO_SLOTS' = 'SUBMITTED';
  public submitCallCount = 0;
  public offers = [{ id: 'offer-1', name: 'Standard Bundle (1 unit)' }];
  public isClosed = false;

  async verifySession(accountId: string) {
    return this.sessionStatus;
  }

  async readDeal(dealUrl: string) {
    // Extract deal ID
    const match = dealUrl.match(/\/(?:deals?|offer)\/([a-zA-Z0-9_-]+)/i);
    const dealId = match ? match[1] : 'unknown-deal';
    return {
      dealId,
      canonicalUrl: `https://www.buyformeretail.com/deals/${dealId}`,
      offers: this.offers,
      isClosed: this.isClosed,
    };
  }

  async submitOne(offerId: string): Promise<{
    status: 'SUBMITTED' | 'UNCERTAIN' | 'FAILED_500' | 'CLOSED_NO_SLOTS';
    toastAcknowledgement?: boolean;
    errorDetail?: string;
  }> {
    this.submitCallCount++;
    if (this.submitOutcome === 'SUBMITTED') {
      return { status: 'SUBMITTED', toastAcknowledgement: true };
    }
    if (this.submitOutcome === 'UNCERTAIN') {
      return { status: 'UNCERTAIN', errorDetail: 'Page navigation timeout waiting for response modal' };
    }
    if (this.submitOutcome === 'FAILED_500') {
      return { status: 'FAILED_500', errorDetail: 'HTTP 500 internal server error from BFMR website' };
    }
    return { status: 'CLOSED_NO_SLOTS', errorDetail: 'Button disabled: No slots available' };
  }
}

export class FakeTelegramAdapter implements ITelegramAdapter {
  public shouldFail = false;
  public sentMessages: Array<{ chatId: string; text: string; messageId: number }> = [];
  private messageSeq = 5000;

  async sendMessage(chatId: string, text: string) {
    if (this.shouldFail) {
      return {
        ok: false,
        errorDetail: 'Simulated network outage to api.telegram.org',
        retryAfterSeconds: 5,
      };
    }
    const messageId = ++this.messageSeq;
    this.sentMessages.push({ chatId, text, messageId });
    return { ok: true, messageId };
  }
}
