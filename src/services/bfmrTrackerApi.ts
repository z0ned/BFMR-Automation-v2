import type { ReservationReference } from './amazonEvaluation';

const TRACKER_PAGE_SIZE = 1000;
const MAX_TRACKER_PAGES = 100;
const MAX_TRANSIENT_FETCH_ATTEMPTS = 3;

const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export interface TrackerReservationRow {
  [key: string]: unknown;
}

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(\d+)\s+gb\b/g, '$1gb').trim();
}

function reservationQuantity(row: TrackerReservationRow): number {
  return Number(row.qty ?? row.quantity);
}

function reservationMatchesDeal(row: TrackerReservationRow, dealId: string, dealTitle: string): boolean {
  const status = ['status', 'item_status', 'reservation_status']
    .map((key) => row[key])
    .find((value): value is string => typeof value === 'string');
  const quantity = row.qty ?? row.quantity;
  const normalizedStatus = normalizedText(status || '');
  // Use the status returned on each unfiltered row. The live API has returned
  // a zero-result sentinel for status=reserved even while an unfiltered page
  // contains a matching reserved row.
  const reserved = normalizedStatus === 'reserved';
  if (!reserved || Number(quantity) <= 0) return false;

  const rowDealId = row.deal_id;
  if (typeof rowDealId === 'string' && rowDealId.trim().toLowerCase() === dealId.trim().toLowerCase()) {
    return true;
  }
  const expectedTitle = normalizedText(dealTitle);
  if (!expectedTitle) return false;
  const titles = ['title', 'deal_title', 'item_title', 'product_name', 'item_name', 'name', 'product']
    .map((key) => row[key])
    .filter((value): value is string => typeof value === 'string')
    .map(normalizedText);
  return titles.some((title) => title === expectedTitle);
}

function configuredTrackerEndpoint(): URL {
  const configuredUrl = process.env.BFMR_TRACKER_URL;
  if (!configuredUrl) throw new Error('BFMR_TRACKER_URL is not configured.');
  const endpoint = new URL(configuredUrl);
  if (endpoint.protocol !== 'https:' || endpoint.hostname.toLowerCase() !== 'api.bfmr.com') {
    throw new Error('BFMR_TRACKER_URL must use HTTPS on the documented BFMR API host api.bfmr.com.');
  }
  return endpoint;
}

function trackerPageUrl(pageNo: number, filters: { search?: string; status?: string } = { status: 'reserved' }): URL {
  const url = configuredTrackerEndpoint();
  if (filters.search) url.searchParams.set('search', filters.search);
  if (filters.status) url.searchParams.set('status', filters.status);
  url.searchParams.set('page_size', String(TRACKER_PAGE_SIZE));
  url.searchParams.set('page_no', String(pageNo));
  return url;
}

function networkFailureDetails(error: unknown): { code?: string; message: string } {
  if (!error || typeof error !== 'object') return { message: String(error) };
  const outer = error as { message?: unknown; cause?: unknown };
  const cause = outer.cause && typeof outer.cause === 'object'
    ? outer.cause as { code?: unknown; message?: unknown }
    : undefined;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  const causeMessage = typeof cause?.message === 'string' ? cause.message : undefined;
  const message = causeMessage || (typeof outer.message === 'string' ? outer.message : String(error));
  return { code, message };
}

async function fetchTrackerPage(url: URL, headers: Record<string, string>): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_TRANSIENT_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      const { code, message } = networkFailureDetails(error);
      const isTransient = Boolean(code && TRANSIENT_NETWORK_CODES.has(code));
      if (isTransient && attempt < MAX_TRANSIENT_FETCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        continue;
      }
      const reason = code ? `${code}: ${message}` : message;
      throw new Error(`My Tracker API network request failed (${reason}).`);
    }
  }
  throw new Error('My Tracker API network request failed after transient retries.');
}

function summarizePayloadShape(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (depth > 0) {
      try {
        const decoded: unknown = JSON.parse(value);
        return {
          type: 'string',
          length: value.length,
          parsedJSON: summarizePayloadShape(decoded, depth + 1),
        };
      } catch {
        // Keep string content private; its type and length are enough to diagnose shape.
      }
    }
    return { type: 'string', length: value.length };
  }
  if (Array.isArray(value)) {
    const first = value[0];
    return {
      type: 'array',
      length: value.length,
      ...(first && typeof first === 'object' && !Array.isArray(first)
        ? { firstItem: summarizePayloadShape(first, depth + 1) }
        : {}),
    };
  }
  if (value && typeof value === 'object') {
    if (depth >= 2) return { type: 'object', keys: Object.keys(value) };
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
      if (key === 'my_tracker' && typeof nested === 'string') {
        let parsedJSON: unknown;
        try {
          parsedJSON = summarizePayloadShape(JSON.parse(nested), depth + 1);
        } catch {
          parsedJSON = undefined;
        }
        return [key, {
          type: 'string',
          length: nested.length,
          recognizedNoResultsSentinel: isNoResultsSentinel(nested),
          ...(parsedJSON === undefined ? {} : { parsedJSON }),
        }];
      }
      if (key === 'paging' && nested && typeof nested === 'object' && !Array.isArray(nested)) {
        const paging = nested as Record<string, unknown>;
        const safeNumericFields = ['current_page', 'page', 'last_page', 'pages', 'perPage', 'total', 'first', 'last'];
        return [key, {
          ...Object.fromEntries(Object.entries(paging).map(([field, item]) => [field, item === null ? 'null' : typeof item])),
          ...Object.fromEntries(safeNumericFields
            .filter((field) => typeof paging[field] === 'number')
            .map((field) => [`${field}Value`, paging[field]])),
        }];
      }
      return [key, summarizePayloadShape(nested, depth + 1)];
    }));
  }
  return value === null ? 'null' : typeof value;
}

function decodeTrackerRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const decoded: unknown = JSON.parse(value);
      if (Array.isArray(decoded)) return decoded;
    } catch {
      // A non-JSON string is an unknown response shape, never an empty result.
    }
  }
  return null;
}

function isNoResultsSentinel(value: unknown): boolean {
  return typeof value === 'string' &&
    /^\s*(?:no\s+(?:records?|results?|data|items?)(?:\s+(?:were\s+)?(?:found|available|exist))?|(?:records?|results?|items?)\s+not\s+found)\s*[.!]?\s*$/i.test(value);
}

interface TrackerPage {
  rows: TrackerReservationRow[];
  page: number;
  pages: number;
  total: number;
}

function parseTrackerPage(payload: unknown, requestedPage: number): TrackerPage {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('My Tracker API response was not a JSON object; result is inconclusive.');
  }
  const envelope = payload as Record<string, unknown>;
  const data = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : envelope;
  const paging = data.paging && typeof data.paging === 'object' && !Array.isArray(data.paging)
    ? data.paging as Record<string, unknown>
    : envelope.paging && typeof envelope.paging === 'object' && !Array.isArray(envelope.paging)
      ? envelope.paging as Record<string, unknown>
      : null;
  if (!paging) throw new Error('My Tracker API response did not include pagination metadata; result is incomplete.');

  const page = Number(paging.page ?? paging.current_page);
  const reportedPages = Number(paging.pages ?? paging.last_page);
  const lastPage = paging.last_page === undefined ? undefined : Number(paging.last_page);
  const total = Number(paging.total);
  // BFMR's filtered zero-result response reports current_page=1,
  // last_page=1, pages=0, total=0. Normalize that exact empty-page convention.
  const emptyPageConvention = total === 0 && page === 1 && reportedPages === 0 && lastPage === 1;
  const pages = emptyPageConvention ? 1 : reportedPages;
  if (!Number.isInteger(page) || page < 1 || page !== requestedPage ||
      !Number.isInteger(pages) || pages < page ||
      !Number.isInteger(total) || total < 0) {
    throw new Error('My Tracker API returned invalid or inconsistent pagination metadata; result is incomplete.');
  }

  let pageRows = decodeTrackerRows(data.my_tracker);
  // BFMR's filtered empty result uses a short no-records message in this field,
  // while its documented schema and unfiltered result use an array. Treat this
  // only as an empty page when paging independently confirms a complete zero.
  if (!pageRows && isNoResultsSentinel(data.my_tracker) && page === 1 && pages === 1 && total === 0) {
    pageRows = [];
  }
  if (!pageRows) {
    const shape = summarizePayloadShape(payload);
    throw new Error(`My Tracker API response did not contain a usable my_tracker array (shape: ${JSON.stringify(shape)}); result is inconclusive.`);
  }
  if (!pageRows.every((row) => Boolean(row) && typeof row === 'object' && !Array.isArray(row))) {
    throw new Error('My Tracker API returned an unexpected row shape; result is inconclusive.');
  }
  return { rows: pageRows as TrackerReservationRow[], page, pages, total };
}

/** Safe, read-only schema probe. It never returns tracker row values or credentials. */
export async function inspectTrackerApiResponseShape(): Promise<Array<{
  label: string;
  requestEndpoint: string;
  queryParameters: Record<string, string>;
  httpStatus: number;
  contentType: string | null;
  payloadShape: unknown;
}>> {
  const apiKey = process.env.BFMR_API_KEY;
  const apiSecret = process.env.BFMR_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error('BFMR_API_KEY and BFMR_API_SECRET are required.');
  const probes = [
    { label: 'unfiltered', filters: {} },
    { label: 'search only', filters: { search: 'ipad air' } },
    { label: 'status only', filters: { status: 'reserved' } },
    { label: 'search plus status', filters: { search: 'ipad air', status: 'reserved' } },
  ];
  const results = [];
  for (const probe of probes) {
    const url = trackerPageUrl(1, probe.filters);
    const response = await fetchTrackerPage(url, {
      'API-KEY': apiKey,
      'API-SECRET': apiSecret,
      accept: 'application/json',
    });
    const contentType = response.headers.get('content-type');
    const payload = await response.json().catch(() => undefined);
    results.push({
      label: probe.label,
      requestEndpoint: `${url.origin}${url.pathname}`,
      queryParameters: Object.fromEntries(url.searchParams.entries()),
      httpStatus: response.status,
      contentType,
      payloadShape: summarizePayloadShape(payload),
    });
  }
  return results;
}

export async function readRecentReservedRows(): Promise<TrackerReservationRow[]> {
  const apiKey = process.env.BFMR_API_KEY;
  const apiSecret = process.env.BFMR_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error('BFMR_API_KEY and BFMR_API_SECRET are required for API confirmation.');

  const rows: TrackerReservationRow[] = [];
  let expectedTotalPages: number | null = null;
  let expectedTotalRows: number | null = null;

  for (let pageNo = 1; pageNo <= MAX_TRACKER_PAGES; pageNo += 1) {
    // Read the complete collection and apply the documented status locally.
    // The status filter has returned no-results while unfiltered rows contain
    // active reservations, so it cannot safely establish absence.
    const url = trackerPageUrl(pageNo, {});

    const response = await fetchTrackerPage(url, {
      'API-KEY': apiKey,
      'API-SECRET': apiSecret,
      accept: 'application/json',
    });
    if (!response.ok) throw new Error(`My Tracker API returned HTTP ${response.status}.`);

    const payload: unknown = await response.json();
    const parsedPage = parseTrackerPage(payload, pageNo);
    if (expectedTotalPages === null) expectedTotalPages = parsedPage.pages;
    if (expectedTotalRows === null) expectedTotalRows = parsedPage.total;
    if (parsedPage.pages !== expectedTotalPages || parsedPage.total !== expectedTotalRows) {
      throw new Error('My Tracker pagination changed while reading; result is incomplete.');
    }
    rows.push(...parsedPage.rows);
    if (parsedPage.page === parsedPage.pages) {
      if (rows.length !== parsedPage.total) {
        throw new Error(`My Tracker returned ${rows.length} rows but reported ${parsedPage.total}; result is incomplete.`);
      }
      return rows;
    }
    if (parsedPage.rows.length === 0) {
      throw new Error('My Tracker returned an empty page before the reported last page; result is incomplete.');
    }
  }

  throw new Error(`My Tracker pagination exceeded ${MAX_TRACKER_PAGES} pages; result is incomplete.`);
}

export type IpadReservationCheck =
  | { status: 'CONFIRMED'; quantity: 1; reference?: ReservationReference }
  | { status: 'EXISTING'; quantity: number }
  | { status: 'NOT_VISIBLE_YET' }
  | { status: 'UNKNOWN'; error: string };

/** Read-only duplicate and confirmation check for a specific deal email. */
export async function checkDealReservation(dealId: string, dealTitle: string): Promise<IpadReservationCheck> {
  try {
    const rows = await readRecentReservedRows();
    const matches = rows.filter((candidate) => reservationMatchesDeal(candidate, dealId, dealTitle));
    if (matches.length > 1) throw new Error('Multiple matching reserved rows; reservation identity is ambiguous.');
    const row = matches[0];
    if (!row) return { status: 'NOT_VISIBLE_YET' };
    const quantity = reservationQuantity(row);
    const reference = reservationReference(row);
    return quantity === 1 ? { status: 'CONFIRMED', quantity: 1, ...(reference ? { reference } : {}) } : { status: 'EXISTING', quantity };
  } catch (error) {
    return { status: 'UNKNOWN', error: error instanceof Error ? error.message : String(error) };
  }
}

export function reservationReference(row: TrackerReservationRow): ReservationReference | undefined {
  const id = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() :
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  const reserveId = id(row.reserve_id);
  const dealId = id(row.deal_id);
  return reserveId && dealId ? { reserveId, dealId } : undefined;
}

/** Compatibility wrapper retained for the dedicated iPad Air live test. */
export function checkIpadAirReservation(slug: string): Promise<IpadReservationCheck> {
  return checkDealReservation(slug, 'Apple iPad Air 11 inch M4 256GB Wi-Fi');
}

export const trackerApiTestHelpers = {
  reservationMatchesDeal,
  networkFailureDetails,
  summarizePayloadShape,
  decodeTrackerRows,
  parseTrackerPage,
  isNoResultsSentinel,
};
