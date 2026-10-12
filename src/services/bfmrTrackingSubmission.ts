import { amazonOrderLedger, type AmazonOrderRecord } from './amazonOrderLedger';
import { readRecentReservedRows, type TrackerReservationRow } from './bfmrTrackerApi';

const TRACKER_UPDATE_URL = 'https://api.bfmr.com/api/v2/my-tracker';
type Ledger = ReturnType<typeof amazonOrderLedger>;

function id(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function field(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function exactTrackerRow(rows: TrackerReservationRow[], order: AmazonOrderRecord): TrackerReservationRow {
  if (!order.reserveId || !order.dealId) throw new Error('BFMR update requires the exact reservation and deal IDs.');
  const matches = rows.filter((row) => id(row.reserve_id) === order.reserveId);
  if (matches.length !== 1) throw new Error(`BFMR reservation ${order.reserveId} is missing or split into multiple My Tracker rows; review required.`);
  const row = matches[0];
  if (id(row.deal_id) !== order.dealId || Number(row.qty ?? row.quantity) !== 1) {
    throw new Error(`BFMR reservation ${order.reserveId} deal or quantity changed; no update sent.`);
  }
  return row;
}

async function postTrackerUpdate(payload: Record<string, unknown>, request: typeof fetch): Promise<void> {
  const key = process.env.BFMR_API_KEY;
  const secret = process.env.BFMR_API_SECRET;
  if (!key || !secret) throw new Error('BFMR API credentials are required for My Tracker updates.');
  // Never retry this POST: a lost response may follow a successful mutation.
  const response = await request(TRACKER_UPDATE_URL, {
    method: 'POST',
    headers: { 'API-KEY': key, 'API-SECRET': secret, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ tracker_data: [payload] }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  // A status or response body alone cannot prove which reservation was changed.
  await response.body?.cancel();
  if (!response.ok) throw new Error(`BFMR My Tracker update returned HTTP ${response.status}; reconcile before any retry.`);
}

async function latest(ledger: Ledger, orderId: string): Promise<AmazonOrderRecord> {
  const record = (await ledger.load()).find((item) => item.orderId === orderId);
  if (!record) throw new Error(`Amazon order ${orderId} is absent from the durable ledger.`);
  return record;
}

function confirmedPurchase(row: TrackerReservationRow, order: AmazonOrderRecord): string | null {
  const purchaseId = id(row.purchase_id);
  if (!purchaseId || field(row.order_no) !== order.orderId) return null;
  return purchaseId;
}

/** Submit Amazon Order # as a BFMR purchase before the reservation timer expires. */
export async function ensureBfmrPurchase(orderId: string, ledger: Ledger, dependencies: {
  readRows?: () => Promise<TrackerReservationRow[]>;
  request?: typeof fetch;
} = {}): Promise<void> {
  const readRows = dependencies.readRows ?? readRecentReservedRows;
  const request = dependencies.request ?? fetch;
  const order = await latest(ledger, orderId);
  if (!order.reserveId || !order.dealId) return; // Standalone Amazon purchase test.
  const row = exactTrackerRow(await readRows(), order);
  const existingPurchase = confirmedPurchase(row, order);
  if (existingPurchase) {
    if (order.bfmrPurchaseId && order.bfmrPurchaseId !== existingPurchase) throw new Error('BFMR purchase ID changed; review required.');
    if (order.bfmrPurchaseId !== existingPurchase) await ledger.update({ ...order, bfmrPurchaseId: existingPurchase });
    return;
  }
  if (id(row.purchase_id) || field(row.order_no) || id(row.shipment_id) || field(row.tracking_number)) {
    throw new Error(`BFMR reservation ${order.reserveId} has conflicting purchase/shipment evidence; no update sent.`);
  }
  if (String(row.status ?? row.item_status ?? row.reservation_status).trim().toLowerCase() !== 'reserved') {
    throw new Error(`BFMR reservation ${order.reserveId} is no longer Reserved; no purchase update sent.`);
  }
  if (order.bfmrPurchaseIntentAt) throw new Error('Previous BFMR purchase update is unresolved. No repeat POST; inspect My Tracker.');
  await ledger.update({ ...order, bfmrPurchaseIntentAt: new Date().toISOString() });
  let postError: unknown;
  try {
    await postTrackerUpdate({ reserve_id: order.reserveId, purchase_id: null, shipment_id: null,
      qty: 1, order_no: order.orderId, tracking_number: null }, request);
  } catch (error) { postError = error; }
  const after = exactTrackerRow(await readRows(), order);
  const purchaseId = confirmedPurchase(after, order);
  if (!purchaseId) {
    throw new Error(`BFMR purchase update for ${order.reserveId} was not confirmed in My Tracker${postError ? ' after an uncertain response' : ''}. No repeat POST.`);
  }
  await ledger.update({ ...(await latest(ledger, orderId)), bfmrPurchaseId: purchaseId });
  console.log(`[BFMR My Tracker] Amazon order ${orderId} confirmed as purchase ${purchaseId} for reservation ${order.reserveId}.`);
}

/** Submit one shipped quantity-one Amazon package to the exact BFMR purchase. */
export async function ensureBfmrTracking(orderId: string, ledger: Ledger, dependencies: {
  readRows?: () => Promise<TrackerReservationRow[]>;
  request?: typeof fetch;
} = {}): Promise<void> {
  const readRows = dependencies.readRows ?? readRecentReservedRows;
  const request = dependencies.request ?? fetch;
  let order = await latest(ledger, orderId);
  if (!order.reserveId || !order.dealId || !order.packages.length) return;
  if (order.bfmrTrackingSubmittedAt) return;
  if (order.packages.length !== 1) throw new Error('Amazon order has multiple tracking numbers for one BFMR unit; choose the matching package manually.');
  const trackingNumber = order.packages[0].trackingNumber;
  await ensureBfmrPurchase(orderId, ledger, dependencies);
  order = await latest(ledger, orderId);
  const row = exactTrackerRow(await readRows(), order);
  const purchaseId = confirmedPurchase(row, order);
  if (!purchaseId || purchaseId !== order.bfmrPurchaseId) throw new Error('BFMR purchase ID or Amazon Order # no longer matches; no tracking update sent.');
  const existingShipment = id(row.shipment_id);
  const existingTracking = field(row.tracking_number);
  if (existingShipment || existingTracking) {
    if (!existingShipment || existingTracking?.toUpperCase() !== trackingNumber.toUpperCase() ||
      (order.bfmrShipmentId && order.bfmrShipmentId !== existingShipment)) {
      throw new Error('BFMR shipment/tracking evidence conflicts with Amazon; no update sent.');
    }
    if (!order.bfmrTrackingSubmittedAt) await ledger.update({ ...order, bfmrShipmentId: existingShipment, bfmrTrackingSubmittedAt: new Date().toISOString() });
    return;
  }
  if (String(row.status ?? row.item_status ?? row.reservation_status).trim().toLowerCase() !== 'purchased') {
    throw new Error('BFMR purchase is not in Purchased status; no tracking update sent.');
  }
  if (order.bfmrShipmentIntent) throw new Error('Previous BFMR shipment update is unresolved. No repeat POST; inspect My Tracker.');
  await ledger.update({ ...order, bfmrShipmentIntent: { trackingNumber, at: new Date().toISOString() } });
  let postError: unknown;
  try {
    await postTrackerUpdate({ reserve_id: order.reserveId, purchase_id: purchaseId, shipment_id: null,
      qty: 1, order_no: order.orderId, tracking_number: trackingNumber }, request);
  } catch (error) { postError = error; }
  const after = exactTrackerRow(await readRows(), order);
  const shipmentId = id(after.shipment_id);
  if (confirmedPurchase(after, order) !== purchaseId || !shipmentId ||
    field(after.tracking_number)?.toUpperCase() !== trackingNumber.toUpperCase()) {
    throw new Error(`BFMR tracking update for ${order.reserveId} was not confirmed in My Tracker${postError ? ' after an uncertain response' : ''}. No repeat POST.`);
  }
  await ledger.update({ ...(await latest(ledger, orderId)), bfmrShipmentId: shipmentId, bfmrTrackingSubmittedAt: new Date().toISOString() });
  console.log(`[BFMR My Tracker] Tracking confirmed as shipment ${shipmentId} for reservation ${order.reserveId}.`);
}
