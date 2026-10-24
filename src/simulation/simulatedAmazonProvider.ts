import type { IAmazonProvider } from '../providers/interfaces';
import type { SimulatedStore } from './simulatedStore';

export class SimulatedAmazonProvider implements IAmazonProvider {
  constructor(private readonly store: SimulatedStore, private readonly runId: string) {}

  public async verifyAccount(expectedAccount: string): Promise<'AUTHENTICATED' | 'AUTH_REQUIRED' | 'CHALLENGE'> {
    const fault = await this.store.checkAndTriggerFault(this.runId, 'AMAZON_ACCOUNT');
    if (fault?.faultType === 'AUTH_CHALLENGE') return 'CHALLENGE';
    const scenario = await this.store.getAmazonScenario(this.runId);
    if (scenario.accountEmail.toLowerCase() !== expectedAccount.toLowerCase()) return 'AUTH_REQUIRED';
    return scenario.accountState;
  }

  public async readSupplier(productUrl: string): Promise<{ asin: string; available: boolean; priceCents?: number }> {
    const fault = await this.store.checkAndTriggerFault(this.runId, 'AMAZON_SUPPLIER_READ');
    if (fault && fault.faultType !== 'AUTH_CHALLENGE') {
      throw new Error(`[Simulated Amazon supplier read: ${fault.faultType}] ${fault.errorDetail || 'Supplier read failed.'}`);
    }
    const scenario = await this.store.getAmazonScenario(this.runId);
    const match = productUrl.match(/\/dp\/([A-Z0-9]{10})(?:[/?#]|$)/i) ||
      productUrl.match(/\/gp\/product\/([A-Z0-9]{10})(?:[/?#]|$)/i);
    const asin = match?.[1]?.toUpperCase() ?? '';
    if (!asin || asin !== scenario.asin) return { asin, available: false };
    return { asin, available: scenario.available, priceCents: scenario.itemSubtotalCents };
  }

  public async prepareCheckout(options: { asin: string; quantity: number }) {
    const cartFault = await this.store.checkAndTriggerFault(this.runId, 'AMAZON_CART_READ');
    const prepareFault = await this.store.checkAndTriggerFault(this.runId, 'AMAZON_CHECKOUT_PREPARE');
    if (prepareFault?.faultType === 'FAIL_BEFORE_COMMIT') {
      throw new Error(`[Simulated Amazon checkout: ${prepareFault.faultType}] ${prepareFault.errorDetail || 'Checkout preparation failed before mutation.'}`);
    }
    const { preparedCheckoutId, scenario, completeTotalCents } = await this.store.createAmazonCheckout(this.runId, options);
    const cartState = cartFault?.faultType === 'CART_STATE_UNKNOWN' ? 'UNKNOWN' : scenario.cartState;
    return {
      preparedCheckoutId,
      accountEmail: scenario.accountEmail,
      asin: scenario.asin,
      quantity: scenario.quantity,
      itemSubtotalCents: scenario.itemSubtotalCents,
      shippingCents: scenario.shippingCents,
      taxCents: scenario.taxCents,
      discountCents: scenario.discountCents,
      reviewAvailable: scenario.available && !prepareFault,
      completeTotalCents,
      isGift: scenario.isGift,
      isFreeNonPrimeDelivery: scenario.isFreeNonPrimeDelivery,
      addressMatches: scenario.addressMatches,
      paymentCardMatches: scenario.paymentCardMatches,
      cartState,
      deliveryEstimate: scenario.deliveryEstimate,
    };
  }

  public async submitOrder(preparedCheckoutId: string) {
    const fault = await this.store.checkAndTriggerFault(this.runId, 'AMAZON_ORDER_SUBMIT');
    if (fault?.faultType === 'FAIL_BEFORE_COMMIT') {
      const scenario = await this.store.getAmazonScenario(this.runId);
      const totalCents = scenario.itemSubtotalCents + scenario.shippingCents + scenario.taxCents - scenario.discountCents;
      return { asin: scenario.asin, quantity: scenario.quantity, totalCents, status: 'REJECTED' as const };
    }
    const scenario = await this.store.getAmazonScenario(this.runId);
    const delay = fault?.faultType === 'DELAY_VISIBILITY' ?
      Math.max(1, scenario.orderVisibilityDelaySeconds ?? 60) : 0;
    const order = await this.store.submitAmazonOrder(this.runId, preparedCheckoutId, {
      duplicate: fault?.faultType === 'DUPLICATE_SUBMISSION',
      visibilityDelaySeconds: delay,
    });
    if (fault?.faultType === 'DROP_CONFIRMATION_AFTER_COMMIT') {
      return { asin: order.asin, quantity: order.quantity, totalCents: order.totalCents, status: 'UNCERTAIN' as const };
    }
    if (delay > 0) {
      return { asin: order.asin, quantity: order.quantity, totalCents: order.totalCents, status: 'PENDING' as const };
    }
    return { orderId: order.orderId, asin: order.asin, quantity: order.quantity,
      totalCents: order.totalCents, status: 'CONFIRMED' as const };
  }

  public async readOrder(preparedCheckoutId: string) {
    const fault = await this.store.checkAndTriggerFault(this.runId, 'AMAZON_ORDER_READ');
    if (fault) {
      if (fault.faultType === 'DELAY_VISIBILITY' || fault.faultType === 'INCOMPLETE_READ' || fault.faultType === 'FAIL_BEFORE_COMMIT') {
        return { status: 'INCOMPLETE' as const };
      }
      throw new Error(`[Simulated Amazon order read: ${fault.faultType}] ${fault.errorDetail || 'Order read failed.'}`);
    }
    return this.store.readAmazonOrder(this.runId, preparedCheckoutId);
  }

  public async readTracking(orderId: string) {
    const fault = await this.store.checkAndTriggerFault(this.runId, 'AMAZON_TRACKING_READ');
    if (fault) {
      if (['INCOMPLETE_READ','DELAY_VISIBILITY','FAIL_BEFORE_COMMIT'].includes(fault.faultType)) {
        return { status: 'INCOMPLETE' as const, evidence: { faultType: fault.faultType } };
      }
      throw new Error(`[Simulated Amazon tracking read: ${fault.faultType}] ${fault.errorDetail || 'Tracking read failed.'}`);
    }
    return this.store.readAmazonTracking(this.runId, orderId);
  }

  public async removePreparedCartItem(preparedCheckoutId: string): Promise<boolean> {
    const fault = await this.store.checkAndTriggerFault(this.runId, 'AMAZON_CART_READ');
    const scenario = await this.store.getAmazonScenario(this.runId);
    if (fault || scenario.cartState === 'UNKNOWN' || scenario.cartState === 'OTHER_ITEMS') return false;
    await this.store.logEvent(this.runId, 'INFO', 'PROVIDER', 'Removed the exact prepared simulated Amazon cart item.',
      { preparedCheckoutId, asin: scenario.asin });
    return true;
  }
}
