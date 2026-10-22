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

export const BFMR_OPERATIONAL_TIMEZONE = 'America/New_York';

export type DeliveryEstimateType = 'KNOWN' | 'ABSENT' | 'UNKNOWN';

export interface DeliveryEstimate {
  type: DeliveryEstimateType;
  rawText: string;
  earliestDate?: Date;
  latestDate?: Date;
}

export interface DeliveryCutoffResult {
  eligible: boolean;
  status: 'PASS' | 'REJECT' | 'UNKNOWN';
  reason: string;
  calendarDays?: number;
  orderDateNY?: string;
  deliveryDateNY?: string;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const WEEKDAY_NAMES = /^(?:mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|sun|sunday)$/i;

export function getCalendarDateNY(date: Date, timeZone: string = BFMR_OPERATIONAL_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function calendarDaysBetween(
  startDate: Date,
  endDate: Date,
  timeZone: string = BFMR_OPERATIONAL_TIMEZONE
): number {
  const [sY, sM, sD] = getCalendarDateNY(startDate, timeZone).split('-').map(Number);
  const [eY, eM, eD] = getCalendarDateNY(endDate, timeZone).split('-').map(Number);
  const startUtc = Date.UTC(sY, sM - 1, sD);
  const endUtc = Date.UTC(eY, eM - 1, eD);
  return Math.round((endUtc - startUtc) / 86_400_000);
}

/**
 * Parses Amazon delivery estimates from option labels or review summaries.
 * Handles absent/pending, single dates, date ranges (same month or cross-month),
 * and relative dates (today/tomorrow).
 */
export function parseAmazonDeliveryEstimate(
  rawText: string,
  referenceDate: Date = new Date(),
  timeZone: string = BFMR_OPERATIONAL_TIMEZONE
): DeliveryEstimate {
  if (!rawText || typeof rawText !== 'string') {
    return { type: 'UNKNOWN', rawText: String(rawText ?? '') };
  }
  const text = rawText.trim();
  if (!text) {
    return { type: 'UNKNOWN', rawText: text };
  }

  // 1. Explicitly absent / pending delivery estimates
  if (/(?:we(?:\x27|\x22|’)?ll email you when available|delivery date pending|temporarily out of stock|order now and we(?:\x27|\x22|’)?ll deliver|delivery date to be determined|usually ships within)/i.test(text)) {
    return { type: 'ABSENT', rawText: text };
  }

  const [refY, refM] = getCalendarDateNY(referenceDate, timeZone).split('-').map(Number);
  const refYear = refY;
  const refMonth = refM - 1; // 0-indexed

  // 2. Relative: Today
  if (/\b(?:free\s+)?delivery(?:\s+by\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\s+today\b/i.test(text) || /\barriving\s+today\b/i.test(text)) {
    return { type: 'KNOWN', rawText: text, earliestDate: referenceDate, latestDate: referenceDate };
  }

  // 3. Relative: Tomorrow
  if (/\b(?:free\s+)?delivery(?:\s+by\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\s+tomorrow\b/i.test(text) || /\barriving\s+tomorrow\b/i.test(text)) {
    const tomorrow = new Date(referenceDate.getTime() + 86_400_000);
    return { type: 'KNOWN', rawText: text, earliestDate: tomorrow, latestDate: tomorrow };
  }

  // 4. Two different months range: e.g. "Oct 28 - Nov 2" or "Nov 2 - Nov 6"
  const rangeTwoMonths = text.match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|–|—|to|and)\s*([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/i);
  if (rangeTwoMonths && !WEEKDAY_NAMES.test(rangeTwoMonths[1]) && !WEEKDAY_NAMES.test(rangeTwoMonths[3])) {
    const m1 = MONTHS[rangeTwoMonths[1].toLowerCase()];
    const d1 = Number(rangeTwoMonths[2]);
    const m2 = MONTHS[rangeTwoMonths[3].toLowerCase()];
    const d2 = Number(rangeTwoMonths[4]);
    if (m1 !== undefined && m2 !== undefined && d1 >= 1 && d1 <= 31 && d2 >= 1 && d2 <= 31) {
      let y1 = rangeTwoMonths[5] ? Number(rangeTwoMonths[5]) : refYear;
      if (m1 < refMonth) y1++;
      let y2 = y1;
      if (m2 < m1) y2 = y1 + 1;
      return {
        type: 'KNOWN',
        rawText: text,
        earliestDate: new Date(Date.UTC(y1, m1, d1, 12, 0, 0)),
        latestDate: new Date(Date.UTC(y2, m2, d2, 12, 0, 0)),
      };
    }
  }

  // 5. Same month range: e.g. "Nov 12 - 18"
  const rangeSameMonth = text.match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|–|—|to|and)\s*(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/i);
  if (rangeSameMonth && !WEEKDAY_NAMES.test(rangeSameMonth[1])) {
    const m = MONTHS[rangeSameMonth[1].toLowerCase()];
    const d1 = Number(rangeSameMonth[2]);
    const d2 = Number(rangeSameMonth[3]);
    if (m !== undefined && d1 >= 1 && d1 <= 31 && d2 >= 1 && d2 <= 31) {
      let y = rangeSameMonth[4] ? Number(rangeSameMonth[4]) : refYear;
      if (m < refMonth) y++;
      return {
        type: 'KNOWN',
        rawText: text,
        earliestDate: new Date(Date.UTC(y, m, d1, 12, 0, 0)),
        latestDate: new Date(Date.UTC(y, m, d2, 12, 0, 0)),
      };
    }
  }

  // 6. Single date: e.g. "Tuesday, Nov 4" or "Nov 4, 2026"
  const matches = [...text.matchAll(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/gi)];
  for (const match of matches) {
    const word = match[1].toLowerCase();
    if (WEEKDAY_NAMES.test(word)) continue;
    const m = MONTHS[word];
    const d = Number(match[2]);
    if (m !== undefined && d >= 1 && d <= 31) {
      let y = match[3] ? Number(match[3]) : refYear;
      if (m < refMonth) y++;
      const date = new Date(Date.UTC(y, m, d, 12, 0, 0));
      return {
        type: 'KNOWN',
        rawText: text,
        earliestDate: date,
        latestDate: date,
      };
    }
  }

  return { type: 'UNKNOWN', rawText: text };
}

/**
 * Evaluates whether a delivery estimate satisfies the <= 14 calendar day cutoff policy
 * in the America/New_York timezone.
 */
export function evaluateDeliveryCutoff(
  estimate: DeliveryEstimate,
  orderDate: Date = new Date(),
  maxDays: number = 14,
  timeZone: string = BFMR_OPERATIONAL_TIMEZONE
): DeliveryCutoffResult {
  if (estimate.type === 'ABSENT') {
    return {
      eligible: true,
      status: 'PASS',
      reason: `Explicitly absent delivery estimate (${estimate.rawText}) permitted under standard guards.`,
    };
  }

  if (estimate.type === 'UNKNOWN' || !estimate.latestDate) {
    return {
      eligible: false,
      status: 'UNKNOWN',
      reason: `Delivery estimate could not be deterministically determined (${estimate.rawText}); manual review required.`,
    };
  }

  const days = calendarDaysBetween(orderDate, estimate.latestDate, timeZone);
  const orderDateNY = getCalendarDateNY(orderDate, timeZone);
  const deliveryDateNY = getCalendarDateNY(estimate.latestDate, timeZone);

  if (days < 0) {
    return {
      eligible: false,
      status: 'UNKNOWN',
      reason: `Calculated delivery date (${deliveryDateNY}) precedes order date (${orderDateNY}); ambiguous evidence.`,
      calendarDays: days,
      orderDateNY,
      deliveryDateNY,
    };
  }

  if (days <= maxDays) {
    return {
      eligible: true,
      status: 'PASS',
      reason: `Delivery within policy (${days} calendar days <= ${maxDays} limit, arriving by ${deliveryDateNY}).`,
      calendarDays: days,
      orderDateNY,
      deliveryDateNY,
    };
  }

  return {
    eligible: false,
    status: 'REJECT',
    reason: `Delivery exceeds policy window (${days} calendar days > ${maxDays} limit, arriving ${deliveryDateNY}). Refusing order and releasing reservation.`,
    calendarDays: days,
    orderDateNY,
    deliveryDateNY,
  };
}

