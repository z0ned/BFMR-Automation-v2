import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { requireAmazonAccountIdentity } from '../src/services/amazonAccountIdentity';
import { readAmazonPurchaseEvidence, type ReservationReference } from '../src/services/amazonEvaluation';
import {
  amazonProductAsin,
  ensureAmazonFreeNonPrimeDeliverySelected,
  ensureAmazonGiftSelected,
  removePreparedAmazonCartItem,
  readAmazonOrderReview,
  retrieveAmazonOrderId,
  runAmazonCheckoutRehearsal,
  submitAmazonOrderOnce,
  verifyAmazonCheckoutSelections,
} from '../src/services/amazonCheckoutRehearsal';

/** A missing policy or unknown account selection stops before any Amazon cart action. */
export async function purchaseReservedDeal(
  browser: PlaywrightBfmrBrowser,
  reference: ReservationReference,
  productUrl: string,
  payoutCents: number,
  readOpenOrdersTotalCents: () => Promise<number>,
  dependencies: {
    expectedAccountEmail?: string;
    readPurchaseEvidence?: typeof readAmazonPurchaseEvidence;
    beforeSubmit?: () => Promise<void>;
    beforeMutation?: () => Promise<void>;
  } = {},
): Promise<{ status: 'INELIGIBLE'; cartCleared: boolean } | { status: 'PLACED'; orderId: string; asin: string; totalCents: number }> {
  const asin = amazonProductAsin(productUrl);
  if (!asin || !Number.isSafeInteger(payoutCents) || payoutCents <= 0) {
    throw new Error('Exact Amazon product and BFMR payout evidence are required; reservation retained for review.');
  }
  if (process.env.BFMR_AMAZON_POLICY_APPROVED !== 'YES') {
    throw new Error('Unattended financial policy is not approved/configured; no Amazon cart action was attempted.');
  }
  const maxTotalCents = 10000;
  const maxCumulativeCents = 20000;
  const addressFragment = process.env.AMAZON_EXPECTED_DELIVERY_FRAGMENT?.trim();
  const cardLast4 = process.env.AMAZON_EXPECTED_CARD_LAST4?.trim();
  if (!addressFragment || !cardLast4 || !/^\d{4}$/.test(cardLast4) ||
      !dependencies.expectedAccountEmail?.trim() ||
      !process.env.AMAZON_ACCOUNT_IDENTITY_SELECTOR?.trim() ||
      process.env.AMAZON_ACCOUNT_IDENTITY_CONTRACT_VALIDATED !== 'YES') {
    throw new Error('Exact Amazon account, delivery address and payment-card expectations are required before cart actions.');
  }

  const page = await browser.createRetailerTab();
  await page.bringToFront();
  const log = (message: string) => console.log(`[Amazon reserved deal ${asin}] ${message}`);
  const rejectCheckout = async (): Promise<{ status: 'INELIGIBLE'; cartCleared: boolean }> => {
    await dependencies.beforeMutation?.();
    await requireAmazonAccountIdentity(page, dependencies.expectedAccountEmail);
    try {
      await removePreparedAmazonCartItem(page, asin);
      return { status: 'INELIGIBLE', cartCleared: true };
    } catch {
      log('Checkout rule failed, but the prepared cart item could not be confirmed removed. BFMR cancellation will proceed; inspect the cart before another order.');
      return { status: 'INELIGIBLE', cartCleared: false };
    }
  };
  const title = await runAmazonCheckoutRehearsal(page, productUrl, {
    log,
    accessTimeoutMs: 30_000,
    beforeCartMutation: async () => { await dependencies.beforeMutation?.(); await requireAmazonAccountIdentity(page, dependencies.expectedAccountEmail); },
    manual: async () => { throw new Error('Amazon requires a manual checkout choice; unattended order stopped before submission.'); },
  });
  await ensureAmazonGiftSelected(page, log);
  await ensureAmazonFreeNonPrimeDeliverySelected(page, log);
  const review = await readAmazonOrderReview(page, asin, title, { requireGift: true, requireFreeNonPrimeDelivery: true });
  if (!review) throw new Error('Amazon final review is missing; no order was submitted.');
  if (review.totalCents > maxTotalCents || review.totalCents > payoutCents) {
    return rejectCheckout();
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readAmazonOrderReview(page, asin, title, { requireGift: true, requireFreeNonPrimeDelivery: true });
    if (!current || current.totalCents !== review.totalCents) throw new Error('Amazon final review changed; no order was submitted.');
    if (attempt < 2) await page.waitForTimeout(500);
  }
  if (!await verifyAmazonCheckoutSelections(page, addressFragment, cardLast4)) {
    throw new Error('Expected delivery address or payment card was not uniquely visible at checkout; no order was submitted.');
  }
  const refreshed = await (dependencies.readPurchaseEvidence ?? readAmazonPurchaseEvidence)(reference);
  if (!refreshed || refreshed.productUrl !== productUrl || refreshed.payoutCents !== payoutCents) {
    throw new Error('BFMR product or payout evidence changed before submission; no order was submitted.');
  }
  if (!await verifyAmazonCheckoutSelections(page, addressFragment, cardLast4)) {
    throw new Error('Expected delivery address or payment card changed before submission; no order was submitted.');
  }
  const openTotalCents = await readOpenOrdersTotalCents();
  if (!Number.isSafeInteger(openTotalCents) || openTotalCents < 0) {
    throw new Error('Cumulative open-order total is unavailable; no order was submitted.');
  }
  if (openTotalCents + review.totalCents > maxCumulativeCents) {
    return rejectCheckout();
  }
  log(`Submitting one ${title || asin}; BFMR payout $${(payoutCents / 100).toFixed(2)}, Amazon total $${review.totalUsd.toFixed(2)}, open orders after submission $${((openTotalCents + review.totalCents) / 100).toFixed(2)}.`);
  const result = await submitAmazonOrderOnce(page, asin, title, process.env.AMAZON_DEFAULT_CARD, {
    maxTotalCents, confirmedTotalCents: review.totalCents, allowDuplicateWarning: false, log,
    beforeContinuation: async () => { await dependencies.beforeMutation?.(); await requireAmazonAccountIdentity(page, dependencies.expectedAccountEmail); },
    beforeClick: async () => {
      await dependencies.beforeSubmit?.();
      await requireAmazonAccountIdentity(page, dependencies.expectedAccountEmail);
      if (!await verifyAmazonCheckoutSelections(page, addressFragment, cardLast4)) {
        throw new Error('Exact delivery address or payment card changed before submission.');
      }
    },
  });
  if (result !== 'PLACED') throw new Error('Amazon order outcome is UNCERTAIN. Inspect Amazon Orders; never rerun this item automatically.');
  log('Amazon confirmed placement. Reading the Order # from this purchase confirmation.');
  const orderId = await retrieveAmazonOrderId(page, asin, title, review.totalCents);
  log(`Order #: ${orderId}`);
  return { status: 'PLACED', orderId, asin, totalCents: review.totalCents };
}
