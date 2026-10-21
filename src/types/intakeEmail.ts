export type IntakeEmail = {
  id: string;
  historyId: number;
  messageId: string;
  sender: string;
  receivedAt: string;
  subject: string;
  rawBody: string;
  isSingleDeal: boolean;
  isAdditionalSlotNotice: boolean;
  isMultiDeal: boolean;
  isMultiDealAnnouncement: boolean;
  /** Trusted deal-detail links in the order they occur in the body. */
  deals: Array<{ canonicalDealId: string; dealUrl: string; dealTitle?: string }>;
  dealUrl?: string;
  canonicalDealId?: string;
  dealTitle?: string;
  retailer?: string;
  isBundle?: boolean;
  payoutPrice?: number;
  retailPrice?: number;
};
