import { PlaywrightBfmrBrowser } from '../adapters/playwrightBrowser';
import { requireAmazonAccountIdentity } from './amazonAccountIdentity';
import { readAmazonPurchaseEvidence, type ReservationReference, evaluateDeliveryCutoff } from './amazonEvaluation';
import type { IAmazonProvider } from '../providers/interfaces';
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
} from './amazonCheckoutRehearsal';

/** A missing policy or unknown account selection stops before any Amazon cart action. */
export async function purchaseReservedDeal(
  browser: PlaywrightBfmrBrowser | undefined,
  reference: ReservationReference,
  productUrl: string,
  payoutCents: number,
  readOpenOrdersTotalCents: () => Promise<number>,
  dependencies: {
    expectedAccountEmail?: string;
    amazonProvider?: IAmazonProvider;
    clock?: { now(): Date };
    readPurchaseEvidence?: typeof readAmazonPurchaseEvidence;
    beforeSubmit?: (checkout: { asin: string; totalCents: number; payoutCents: number; productUrl: string; preparedCheckoutId?: string }) => Promise<void>;
    beforeMutation?: () => Promise<void>;
  } = {},
): Promise<{ status: 'INELIGIBLE'; cartCleared: boolean } | { status: 'PLACED'; orderId: string; asin: string; totalCents: number }> {
  const asin = amazonProductAsin(productUrl);
  if (!asin || !Number.isSafeInteger(payoutCents) || payoutCents <= 0) {
    throw new Error('Exact Amazon product and BFMR payout evidence are required; reservation retained for review.');
  }
  if (dependencies.amazonProvider) {
    return purchaseReservedDealSimulated(dependencies.amazonProvider, reference, productUrl, payoutCents,
      readOpenOrdersTotalCents, dependencies);
  }
  if (!browser) throw new Error('The live purchase workflow requires its configured Playwright browser.');
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
  if (review.deliveryEstimate) {
    const deliveryEvaluation = evaluateDeliveryCutoff(review.deliveryEstimate);
    if (deliveryEvaluation.status === 'REJECT') {
      log(`Delivery date policy violation: ${deliveryEvaluation.reason}`);
      return rejectCheckout();
    }
    if (deliveryEvaluation.status === 'UNKNOWN') {
      throw new Error(`Unreadable or conflicting delivery estimate (${review.deliveryEstimate.rawText}); manual review required.`);
    }
    log(`Delivery estimate validated: ${deliveryEvaluation.reason}`);
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
      await dependencies.beforeSubmit?.({ asin, totalCents: review.totalCents, payoutCents, productUrl });
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

/** The simulator supplies provider observations; these same fixed business
 * limits remain in the purchase service and are not scenario-controlled.
 */
async function purchaseReservedDealSimulated(
  amazon: IAmazonProvider,
  reference: ReservationReference,
  productUrl: string,
  payoutCents: number,
  readOpenOrdersTotalCents: () => Promise<number>,
  dependencies: {
    expectedAccountEmail?: string;
    clock?: { now(): Date };
    beforeSubmit?: (checkout: { asin: string; totalCents: number; payoutCents: number; productUrl: string; preparedCheckoutId?: string }) => Promise<void>;
    beforeMutation?: () => Promise<void>;
  },
): Promise<{ status: 'INELIGIBLE'; cartCleared: boolean } | { status: 'PLACED'; orderId: string; asin: string; totalCents: number }> {
  const asin = amazonProductAsin(productUrl);
  if (!asin || !amazon.prepareCheckout || !amazon.submitOrder || !amazon.removePreparedCartItem) {
    throw new Error('The selected simulated Amazon provider does not implement the required purchase contract.');
  }
  const expectedAccount = dependencies.expectedAccountEmail?.trim().toLowerCase();
  if (!expectedAccount) throw new Error('Synthetic Amazon account identity is missing.');
  const accountState = await amazon.verifyAccount(expectedAccount);
  if (accountState !== 'AUTHENTICATED') throw new Error(`Simulated Amazon account requires access (${accountState}).`);
  const supplier = await amazon.readSupplier(productUrl);
  if (!supplier.available || supplier.asin !== asin) throw new Error('Exact simulated Amazon product is unavailable or mismatched.');

  await dependencies.beforeMutation?.();
  const review = await amazon.prepareCheckout({ asin, quantity: 1 });
  if (!review.reviewAvailable || review.asin !== asin || review.accountEmail.toLowerCase() !== expectedAccount) {
    throw new Error('Simulated checkout review is unavailable or bound to a different product/account.');
  }
  if (!Number.isSafeInteger(review.quantity) || review.quantity !== 1) {
    return { status: 'INELIGIBLE', cartCleared: await amazon.removePreparedCartItem(review.preparedCheckoutId) };
  }
  const components = [review.itemSubtotalCents, review.shippingCents, review.taxCents, review.discountCents];
  if (!components.every(value => Number.isSafeInteger(value) && value >= 0) ||
      review.discountCents > review.itemSubtotalCents + review.shippingCents + review.taxCents ||
      review.completeTotalCents !== review.itemSubtotalCents + review.shippingCents + review.taxCents - review.discountCents ||
      !Number.isSafeInteger(review.completeTotalCents) || review.completeTotalCents <= 0) {
    throw new Error('Simulated complete-total evidence is missing, invalid, or conflicting.');
  }
  if (review.cartState === 'UNKNOWN') throw new Error('Simulated Amazon cart state is uncertain; stop for reconciliation.');
  if (review.cartState === 'OTHER_ITEMS') {
    return { status: 'INELIGIBLE', cartCleared: await amazon.removePreparedCartItem(review.preparedCheckoutId) };
  }
  if (!review.addressMatches || !review.paymentCardMatches) {
    throw new Error('Synthetic address or payment-card identity does not match the configured account evidence.');
  }

  const maxTotalCents = 10000;
  const maxCumulativeCents = 20000;
  if (review.completeTotalCents > maxTotalCents || review.completeTotalCents > payoutCents ||
      !review.isGift || !review.isFreeNonPrimeDelivery) {
    return { status: 'INELIGIBLE', cartCleared: await amazon.removePreparedCartItem(review.preparedCheckoutId) };
  }
  const estimate = review.deliveryEstimate;
  const latestDate = estimate.latestDate ? new Date(estimate.latestDate) : undefined;
  if (latestDate && !Number.isFinite(latestDate.getTime())) throw new Error('Simulated delivery date is invalid.');
  const delivery = evaluateDeliveryCutoff({ type: estimate.type, rawText: estimate.rawText, latestDate },
    dependencies.clock?.now() ?? new Date());
  if (delivery.status === 'REJECT') {
    return { status: 'INELIGIBLE', cartCleared: await amazon.removePreparedCartItem(review.preparedCheckoutId) };
  }
  if (delivery.status === 'UNKNOWN') throw new Error('Simulated delivery evidence is ambiguous; manual review is required.');

  const openTotalCents = await readOpenOrdersTotalCents();
  if (!Number.isSafeInteger(openTotalCents) || openTotalCents < 0) throw new Error('Simulated open-order exposure is invalid.');
  if (openTotalCents + review.completeTotalCents > maxCumulativeCents) {
    return { status: 'INELIGIBLE', cartCleared: await amazon.removePreparedCartItem(review.preparedCheckoutId) };
  }

  await dependencies.beforeSubmit?.({ asin, totalCents: review.completeTotalCents, payoutCents, productUrl,
    preparedCheckoutId: review.preparedCheckoutId });
  await dependencies.beforeMutation?.();
  const result = await amazon.submitOrder(review.preparedCheckoutId);
  if (result.status !== 'CONFIRMED' || !result.orderId) {
    throw new Error(`Simulated Amazon order outcome is ${result.status}; reconcile exact provider state before another submission.`);
  }
  if (result.asin !== asin || result.quantity !== 1 || result.totalCents !== review.completeTotalCents) {
    throw new Error('Simulated order confirmation does not match the submitted ASIN, quantity, and total.');
  }
  // Bind the response to a separate exact read. This rejects a provider reply
  // that supplies an ID but cannot independently expose the committed order.
  const observed = await amazon.readOrder?.(review.preparedCheckoutId);
  if (!observed || observed.status !== 'FOUND' || observed.orderId !== result.orderId || observed.asin !== asin ||
      observed.quantity !== 1 || observed.totalCents !== review.completeTotalCents) {
    throw new Error('Simulated Amazon order readback is missing or conflicts; reconcile before retrying.');
  }
  return { status: 'PLACED', orderId: observed.orderId, asin, totalCents: observed.totalCents };
}
