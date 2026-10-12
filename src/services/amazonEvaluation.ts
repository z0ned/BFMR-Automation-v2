/** First post-reservation evaluation. Supplier evidence belongs to an exact reservation. */
import { amazonProductAsin } from './amazonCheckoutRehearsal';
export interface ReservationReference {
  reserveId: string;
  dealId: string;
}

export type AmazonSupplierResult = 'PRESENT' | 'ABSENT' | 'UNKNOWN';

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function amazonSupplierFromReservations(payload: unknown, reference: ReservationReference): AmazonSupplierResult {
  if (!reference.reserveId || !reference.dealId || !record(payload)) return 'UNKNOWN';
  if (payload.success !== undefined && payload.success !== true) return 'UNKNOWN';
  const data = record(payload.data) ? payload.data : payload;
  if (!Array.isArray(data.reservation_list) || !data.reservation_list.every(record)) return 'UNKNOWN';
  const matches = data.reservation_list.filter(row => String(row.reserve_id ?? '') === reference.reserveId);
  if (matches.length !== 1) return 'UNKNOWN';
  const reservation = matches[0];
  if (String(reservation.deal_id ?? '') !== reference.dealId || Number(reservation.reserved_quantity) !== 1 ||
      !Array.isArray(reservation.item) || reservation.item.length === 0) return 'UNKNOWN';
  let amazon = false;
  for (const item of reservation.item) {
    if (!record(item) || !Array.isArray(item.retailer_links) || item.retailer_links.length === 0) return 'UNKNOWN';
    for (const link of item.retailer_links) {
      if (!record(link) || typeof link.retailer !== 'string' || !link.retailer.trim()) return 'UNKNOWN';
      if (/^amazon(?:\.com)?$/i.test(link.retailer.trim())) amazon = true;
    }
  }
  return amazon ? 'PRESENT' : 'ABSENT';
}

/** Read only; never infer supplier eligibility from the email parser's default retailer. */
export async function readAmazonSupplier(reference: ReservationReference, request: typeof fetch = fetch): Promise<AmazonSupplierResult> {
  const key = process.env.BFMR_API_KEY;
  const secret = process.env.BFMR_API_SECRET;
  if (!key || !secret) throw new Error('BFMR API credentials are required for supplier evaluation.');
  try {
    const response = await request('https://api.bfmr.com/api/v2/deal/reservations/active', {
      method: 'GET', headers: { 'API-KEY': key, 'API-SECRET': secret, accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return 'UNKNOWN';
    return amazonSupplierFromReservations(await response.json(), reference);
  } catch { return 'UNKNOWN'; }
}

/** A purchase target must belong to the exact confirmed reservation and one BFMR item. */
export function amazonProductFromReservation(payload: unknown, reference: ReservationReference): string | null {
  if (amazonSupplierFromReservations(payload, reference) !== 'PRESENT' || !record(payload)) return null;
  const data = record(payload.data) ? payload.data : payload;
  const rows = data.reservation_list as Record<string, unknown>[];
  const row = rows.find(candidate => String(candidate.reserve_id ?? '') === reference.reserveId);
  if (!row || !Array.isArray(row.item) || row.item.length !== 1 || !record(row.item[0])) return null;
  const links = row.item[0].retailer_links;
  if (!Array.isArray(links)) return null;
  const amazonLinks = links.filter(link => record(link) && typeof link.retailer === 'string' &&
    /^amazon(?:\.com)?$/i.test(link.retailer.trim()));
  if (amazonLinks.length !== 1) return null;
  const link = amazonLinks[0] as Record<string, unknown>;
  const candidates = [link.url, link.link, link.retailer_url].filter((value): value is string => typeof value === 'string');
  if (candidates.length !== 1) return null;
  const asin = amazonProductAsin(candidates[0]);
  return asin ? `https://www.amazon.com/dp/${asin}` : null;
}

function usdCents(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const raw = String(value).trim();
  if (!/^\$?\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const cents = Math.round(Number(raw.replace('$', '')) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** Payout must be reported for the exact reservation; email prices are not authoritative at checkout. */
export function amazonPurchaseEvidenceFromReservation(payload: unknown, reference: ReservationReference):
  { productUrl: string; payoutCents: number } | null {
  const productUrl = amazonProductFromReservation(payload, reference);
  if (!productUrl || !record(payload)) return null;
  const data = record(payload.data) ? payload.data : payload;
  const row = (data.reservation_list as Record<string, unknown>[]).find(candidate => String(candidate.reserve_id ?? '') === reference.reserveId);
  if (!row || !Array.isArray(row.item) || row.item.length !== 1 || !record(row.item[0])) return null;
  const item = row.item[0];
  const amounts = [row.payout_price, row.payout, row.expected_payout, item.payout_price, item.payout]
    .filter(value => value !== undefined && value !== null).map(usdCents);
  if (!amounts.length || amounts.some(amount => amount === null) || new Set(amounts).size !== 1) return null;
  return { productUrl, payoutCents: amounts[0] as number };
}

export async function readAmazonPurchaseEvidence(reference: ReservationReference, request: typeof fetch = fetch):
  Promise<{ productUrl: string; payoutCents: number } | null> {
  const key = process.env.BFMR_API_KEY;
  const secret = process.env.BFMR_API_SECRET;
  if (!key || !secret) throw new Error('BFMR API credentials are required for checkout payout evidence.');
  const response = await request('https://api.bfmr.com/api/v2/deal/reservations/active', {
    method: 'GET', headers: { 'API-KEY': key, 'API-SECRET': secret, accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return null;
  return amazonPurchaseEvidenceFromReservation(await response.json(), reference);
}

