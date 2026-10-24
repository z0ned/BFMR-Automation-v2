import type { ReservationReference } from '../services/amazonEvaluation';
import type { ReservationSubmissionResult } from '../adapters/playwrightBrowser';
import type { IpadReservationCheck, TrackerReservationRow } from '../services/bfmrTrackerApi';
import type { TrackedPackage } from '../services/amazonOrderLedger';

export type { ReservationSubmissionResult, IpadReservationCheck };
export type ReservationCheckResult = IpadReservationCheck;
export type ProviderTrackerRow = TrackerReservationRow;

export interface BfmrDealDetail {
  dealId: string;
  slug: string;
  title: string;
  payoutPriceCents: number;
  retailers?: Array<{
    retailerName: string;
    productUrl: string;
  }>;
}

/**
 * BFMR API contract abstraction per Proposal Section 4.
 * Reads deal details, active reservations, complete tracker pages,
 * and submits/cancels reservations/purchases.
 */
export interface IBfmrApi {
  resolveDealId(dealUrl: string): Promise<string>;
  readRecentReservedRows(): Promise<ProviderTrackerRow[]>;
  readTrackingTrackerRows?(): Promise<ProviderTrackerRow[]>;
  inspectReservations(
    dealId: string,
    dealTitle: string,
    purpose?: 'DUPLICATE' | 'CONFIRMATION'
  ): Promise<ReservationCheckResult>;
  cancelReservation(reference: ReservationReference): Promise<boolean>;
  getDeal?(slug: string): Promise<BfmrDealDetail | null>;
  submitPurchase?(order: { orderId: string; reserveId: string; dealId: string }): Promise<boolean>;
  submitPurchaseTracking?(orderId: string, trackingNumber: string, carrier: string): Promise<boolean>;
}

/**
 * BFMR Browser operations contract per Proposal Section 4.
 * Inspects session/account/deal, observes availability, submits quantity 1 reservation.
 */
export interface IBfmrBrowser {
  verifySession(
    expectedAccount?: string,
    dealUrl?: string
  ): Promise<'AUTHENTICATED' | 'AUTH_REQUIRED' | 'UNTRUSTED_REDIRECT' | 'DEAL_PAGE_MISMATCH' | 'PAGE_ERROR' | 'CHALLENGE'>;
  getCurrentDealUnavailableReason(): Promise<string | null>;
  confirmCurrentDealPageAfterManualAccess(dealUrl: string): Promise<boolean>;
  getVisibleDealTitle(): Promise<string | null>;
  getCurrentUrl(): Promise<string>;
  submitReservation(dealUrl: string, dealId: string): Promise<ReservationSubmissionResult>;
  close(): Promise<void>;
}

/**
 * Amazon provider contract abstraction per Proposal Section 4.
 * Inspects account/product/cart, prepares checkout, and submits order once.
 */
export interface IAmazonProvider {
  verifyAccount(expectedAccount: string): Promise<'AUTHENTICATED' | 'AUTH_REQUIRED' | 'CHALLENGE'>;
  readSupplier(productUrl: string): Promise<{ asin: string; available: boolean; priceCents?: number }>;
  prepareCheckout?(options: { asin: string; quantity: number }): Promise<{
    preparedCheckoutId: string;
    accountEmail: string;
    asin: string;
    quantity: number;
    itemSubtotalCents: number;
    shippingCents: number;
    taxCents: number;
    discountCents: number;
    reviewAvailable: boolean;
    completeTotalCents: number;
    isGift: boolean;
    isFreeNonPrimeDelivery: boolean;
    addressMatches: boolean;
    paymentCardMatches: boolean;
    cartState: 'EMPTY' | 'EXPECTED_ITEM' | 'OTHER_ITEMS' | 'UNKNOWN';
    deliveryEstimate: {
      type: 'KNOWN' | 'ABSENT' | 'UNKNOWN';
      rawText: string;
      latestDate?: string;
    };
  }>;
  submitOrder?(preparedCheckoutId: string): Promise<{
    orderId?: string;
    asin: string;
    quantity: number;
    totalCents: number;
    status: 'REJECTED' | 'PENDING' | 'CONFIRMED' | 'UNCERTAIN';
  }>;
  readOrder?(preparedCheckoutId: string): Promise<
    | { status: 'FOUND'; orderId: string; asin: string; quantity: number; totalCents: number; purchasedAt: string }
    | { status: 'NOT_FOUND' | 'INCOMPLETE' }
  >;
  readTracking?(orderId: string): Promise<
    | { status: 'FOUND'; orderId: string; asin: string; totalCents: number;
        shipmentStatus: 'PENDING' | 'SHIPPED' | 'DELIVERED'; packages: TrackedPackage[] }
    | { status: 'NOT_FOUND' | 'INCOMPLETE'; evidence?: unknown }
  >;
  removePreparedCartItem?(preparedCheckoutId: string): Promise<boolean>;
}

/**
 * Virtual / Wall Clock interface for workflow timing and simulated time advancement.
 */
export interface IClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  isPast(date: Date): boolean;
}

/**
 * Structured notification provider (Telegram) with central test/run labelling.
 */
export interface ITelegramNotifier {
  sendReservationFailureAlert(context: string): Promise<void>;
  sendTrackingFailureAlert(orderId: string): Promise<void>;
  sendCustomAlert(subject: string, body: string): Promise<void>;
}

/**
 * Immutable Provider Bundle pinned to a worker run.
 * Selected once at startup based on BFMR_INTAKE_MODE and BFMR_PROVIDER_MODE.
 */
export interface ProviderBundle {
  readonly mode: 'live' | 'simulation';
  readonly intakeMode: 'production' | 'testing';
  readonly runId?: string;
  readonly simulationScenario?: {
    phase: 1 | 2 | 3 | 4 | 5 | 6;
    purchaseStart?: 'END_TO_END' | 'SEEDED_RESERVATION';
    trackingStart?: 'PHASE2_PURCHASE' | 'SEEDED_ORDER';
    seededReservation?: { reserveId: string; dealId: string; accountId: string; quantity: number; status: string; createdAt: string };
  };
  readonly simulationFaults?: {
    consume(targetOp: string): Promise<{ faultType: string; errorDetail?: string } | null>;
  };
  readonly bfmrApi: IBfmrApi;
  readonly bfmrBrowser: IBfmrBrowser;
  readonly amazon: IAmazonProvider;
  readonly clock: IClock;
  readonly notifier: ITelegramNotifier;
}
