/** First post-reservation evaluation. Supplier evidence belongs to an exact reservation. */
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

