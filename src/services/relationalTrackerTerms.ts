import { bfmrStatus, bfmrStatusClass } from './bfmrStatus';
import type { TrackerReservationRow } from './bfmrTrackerApi';

/** USD provider/SQL amounts are parsed exactly, never through floating point. */
export function usdToCents(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('USD amount is missing or invalid.');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('USD amount is not finite.');
  const raw = String(value).trim();
  if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error('USD amount must be nonnegative with at most two decimal places.');
  }
  const [dollars, fraction = ''] = raw.replace(/[$,]/g, '').split('.');
  const result = BigInt(dollars) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('USD amount exceeds the safe cents range.');
  return Number(result);
}

export function trackerIdentifier(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && value.trim() && value.length <= 256 && !value.includes('\0')) return value.trim();
  throw new Error('Provider identity is missing or invalid.');
}

function presentValues(row: TrackerReservationRow, fields: string[]): unknown[] {
  return fields.map(field => row[field]).filter(value => value !== undefined && value !== null);
}

function agreed<T>(values: T[], description: string): T {
  if (!values.length || values.some(value => value !== values[0])) throw new Error(`${description} is missing or conflicting.`);
  return values[0];
}

function quantity(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Reservation quantity is missing.');
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) throw new Error('Reservation quantity is not an integer.');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Reservation quantity must be a positive safe integer.');
  return result;
}

function optionalProviderId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return trackerIdentifier(value);
}

function optionalProviderText(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\0')) {
    throw new Error('Provider order or tracking identity is invalid.');
  }
  return value.trim();
}

export interface TrackerFinancialObservation {
  reserveId: string;
  dealId: string;
  quantity: number;
  status: string;
  classification: 'OPEN' | 'TERMINAL';
  expectedPayoutCents: number;
  payoutPerItemCents: number | null;
  amountPaidCents: number | null;
  purchaseId: string | null;
  shipmentId: string | null;
  orderNo: string | null;
  trackingNumber: string | null;
  /** Selected validated fields only; never the raw authenticated provider row. */
  evidence: Record<string, string | number | null>;
}

/** Field meanings still require BFMR contract verification before live use. */
export function normalizeTrackerReservation(row: TrackerReservationRow): TrackerFinancialObservation {
  const reserveId = trackerIdentifier(row.reserve_id);
  const dealId = trackerIdentifier(row.deal_id);
  const reserved = agreed(presentValues(row, ['qty', 'quantity']).map(quantity), 'Reservation quantity');
  const status = agreed(presentValues(row, ['status', 'item_status', 'reservation_status']).map(bfmrStatus), 'Reservation status');
  const classification = bfmrStatusClass(status);
  if (classification === 'UNKNOWN') throw new Error('Reservation lifecycle status is unknown.');
  const totals = presentValues(row, ['expected_payout', 'payout_total', 'total_payout', 'payout_amount']).map(usdToCents);
  const rates = presentValues(row, ['payout_price', 'payout']).map(usdToCents);
  const expandedRates = rates.map(rate => {
    const total = rate * reserved;
    if (!Number.isSafeInteger(total)) throw new Error('Reservation expected payout exceeds the safe cents range.');
    return total;
  });
  const expectedPayoutCents = agreed([...totals, ...expandedRates], 'Reservation expected payout');
  const payoutPerItemCents = rates.length ? agreed(rates, 'Reservation payout rate') :
    expectedPayoutCents % reserved === 0 ? expectedPayoutCents / reserved : null;
  const paid = presentValues(row, ['amount_paid']).map(usdToCents);
  const amountPaidCents = paid.length ? agreed(paid, 'Reservation amount paid') : null;
  const purchaseId = optionalProviderId(row.purchase_id);
  const shipmentId = optionalProviderId(row.shipment_id);
  const orderNo = optionalProviderText(row.order_no);
  const trackingNumber = optionalProviderText(row.tracking_number);
  return {
    reserveId, dealId, quantity: reserved, status, classification,
    expectedPayoutCents, payoutPerItemCents, amountPaidCents,
    purchaseId, shipmentId, orderNo, trackingNumber,
    evidence: {
      bfmr_reservation_id: reserveId, bfmr_deal_id: dealId,
      quantity: reserved, provider_status: status,
      expected_payout_cents: expectedPayoutCents, payout_per_item_cents: payoutPerItemCents,
      amount_paid_cents: amountPaidCents,
      bfmr_purchase_id: purchaseId, bfmr_shipment_id: shipmentId,
      retailer_order_number: orderNo, tracking_number: trackingNumber,
    },
  };
}
