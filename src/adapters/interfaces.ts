// External adapter interfaces per Solution Design Specification v1.5 Pages 8, 11, 13

export interface GmailFetchMessage {
  id: string;
  internalDate: number;
  sender: string;
  subject: string;
  body: string;
  inboxAtFetch: boolean;
  /** Unmodified headers from an authenticated Gmail API response. */
  headers?: Array<{ name?: string | null; value?: string | null }>;
}

export interface IGmailAdapter {
  renewWatch(mailbox: string): Promise<{ historyId: number; expiration: string }>;
  fetchHistory(
    mailbox: string,
    startHistoryId: number
  ): Promise<{
    historyId: number;
    messages: GmailFetchMessage[];
    isExpiredHistoryGap?: boolean;
  }>;
}

export interface IMyTrackerAdapter {
  inspectReservations(
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
  }>;
}

export interface IBrowserAdapter {
  close?(): Promise<void>;
  verifySession(accountId: string): Promise<'AUTHENTICATED' | 'AUTH_REQUIRED' | 'CHALLENGE' | 'UNKNOWN'>;
  readDeal(dealUrl: string): Promise<{
    dealId: string;
    canonicalUrl: string;
    offers: Array<{ id: string; name: string }>;
    isClosed?: boolean;
  }>;
  submitOne(offerId: string): Promise<{
    status: 'SUBMITTED' | 'UNCERTAIN' | 'FAILED_500' | 'CLOSED_NO_SLOTS';
    toastAcknowledgement?: boolean;
    errorDetail?: string;
  }>;
}

export interface ITelegramAdapter {
  sendMessage(
    chatId: string,
    text: string
  ): Promise<{
    ok: boolean;
    messageId?: number;
    retryAfterSeconds?: number;
    errorDetail?: string;
  }>;
}
