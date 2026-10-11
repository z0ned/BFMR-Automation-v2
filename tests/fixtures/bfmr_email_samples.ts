/** Sanitized synthetic cases modeled on the local BFMR sample-email PDFs. */
export interface BfmrEmailSampleFixture {
  name: string;
  sourceCategory: string;
  subject: string;
  body: string;
  expected: {
    isSingleDeal: boolean;
    isMultiDeal: boolean;
    isAdditionalSlotNotice: boolean;
  };
}

const firstDeal = '<a href="https://bfmr.com/deals/sample-product-a">View deal</a>';
const secondDeal = '<a href="https://bfmr.com/deals/sample-product-b">View deal</a>';

export const bfmrEmailSampleFixtures: BfmrEmailSampleFixture[] = [
  {
    name: 'standard promotional new-deal announcement',
    sourceCategory: 'new_deal',
    subject: 'PRIME DAY - NEW DEAL | FULL RETAIL | RETAILER DIRECT',
    body: `<h2>NEW DEAL</h2><p>We posted a new deal!</p>${firstDeal}`,
    expected: { isSingleDeal: true, isMultiDeal: false, isAdditionalSlotNotice: false },
  },
  {
    name: 'new-deal announcement with promo-only subject',
    sourceCategory: 'new_deal',
    subject: 'DEAL DAYS - ABOVE RETAIL | RETAILER DIRECT',
    body: `<h2>NEW DEAL</h2><p>We posted a new deal!</p>${firstDeal}`,
    expected: { isSingleDeal: true, isMultiDeal: false, isAdditionalSlotNotice: false },
  },
  {
    name: 'new-deal announcement whose subject says update',
    sourceCategory: 'new_deal',
    subject: 'NEW DEAL UPDATE - SAMPLE PRODUCT',
    body: `<h2>NEW DEAL</h2><p>We posted a new deal!</p>${firstDeal}`,
    expected: { isSingleDeal: true, isMultiDeal: false, isAdditionalSlotNotice: false },
  },
  {
    name: 'two new deals announcement',
    sourceCategory: 'multiple_new_deals',
    subject: 'PRIME DAY - TWO NEW DEALS',
    body: `<h2>NEW DEALS</h2><p>We posted two new deals!</p>${firstDeal}${secondDeal}`,
    expected: { isSingleDeal: false, isMultiDeal: true, isAdditionalSlotNotice: false },
  },
  {
    name: 'all-deals in-stock roundup',
    sourceCategory: 'all_open_deals',
    subject: 'ALL DEALS | IN STOCK',
    body: `<p>The following deals are In Stock, do not miss out!</p>${firstDeal}${secondDeal}`,
    expected: { isSingleDeal: false, isMultiDeal: true, isAdditionalSlotNotice: false },
  },
  {
    name: 'reservation update with a new-deal-update subject',
    sourceCategory: 'deal_update',
    subject: 'NEW DEAL UPDATE - SAMPLE PRODUCT',
    body: `<h2>NEW DEAL UPDATE</h2><p>We have added more reservations to the following deal!</p>${firstDeal}`,
    expected: { isSingleDeal: false, isMultiDeal: false, isAdditionalSlotNotice: true },
  },
  {
    name: 'payout increase update',
    sourceCategory: 'deal_update',
    subject: 'PAYOUT INCREASE - ABOVE RETAIL',
    body: `<h2>PAYOUT INCREASE</h2><p>We increased our payout for the following deal!</p>${firstDeal}`,
    expected: { isSingleDeal: false, isMultiDeal: false, isAdditionalSlotNotice: false },
  },
  {
    name: 'payment sent notification',
    sourceCategory: 'pay_out',
    subject: 'PAYMENT SENT',
    body: '<p>We have sent your payment. Your bank will process it shortly.</p>',
    expected: { isSingleDeal: false, isMultiDeal: false, isAdditionalSlotNotice: false },
  },
  {
    name: 'more reservations added notice',
    sourceCategory: 'reservations_added',
    subject: 'MORE RESERVATIONS ADDED - SAMPLE PRODUCT',
    body: `<h2>MORE RESERVATIONS ADDED</h2><p>As requested, we added more reservations to this deal!</p>${firstDeal}`,
    expected: { isSingleDeal: false, isMultiDeal: false, isAdditionalSlotNotice: true },
  },
  {
    name: 'unrelated account notification',
    sourceCategory: 'other',
    subject: 'TRACKING SUBMITTED',
    body: '<p>Tracking submitted. We will notify you when the shipment is processed.</p><a href="https://bfmr.com/my-tracker">My Tracker</a>',
    expected: { isSingleDeal: false, isMultiDeal: false, isAdditionalSlotNotice: false },
  },
];
