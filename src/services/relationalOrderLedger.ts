import { randomUUID } from 'node:crypto';
import type { RelationalDatabase } from '../db/relationalDatabase';
import { numericToCents, type BusinessRepositories } from '../db/relationalRepositories';
import type { BusinessQueryable, DbId, JsonObject, JsonValue, OrderRecord, WorkflowRecord } from '../db/relationalTypes';
import { AMAZON_ASIN, AMAZON_ORDER_ID, validateAmazonOrderRecord, type AmazonOrderLedger, type AmazonOrderRecord, type LedgerUpdateSource } from './amazonOrderLedger';

export const AMAZON_ORDER_STATE_ACTION = 'AMAZON_ORDER_STATE';
const ORDER_REVIEW_ACTION = 'AMAZON_ORDER_REVIEW';
export const AMAZON_AUTOMATION_SCOPE_ACTION = 'AMAZON_AUTOMATION_SCOPE';

export interface RelationalOrderLedgerOptions {
  retailerAccountId: DbId;
  expectedAccountEmail: string;
  retailerId?: DbId;
}

interface RetailerAccountIdentity {
  id: DbId; retailer_id: DbId; email: string; retailer_account_ranking: number; name: string; primary_url: string;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing; review required.`);
  return value;
}

function instant(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error(`${label} has no explicit valid timezone; review required.`);
  }
  return result;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** PostgreSQL JSONB canonicalizes object key order. Compare semantic JSON
 * values rather than insertion order while preserving array order.
 */
function canonicalJson(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (object(item)) return Object.fromEntries(Object.keys(item).sort()
      .filter(key => item[key] !== undefined).map(key => [key, ordered(item[key])]));
    return item;
  };
  return JSON.stringify(ordered(value)) ?? 'undefined';
}

function purchaseDay(value: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant(value, 'Purchase confirmation time')));
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Shared import/runtime scope. Unsupported historical business identities are
 * retained in SQL without being mistaken for quantity-one Amazon automation.
 */
export function supportsAmazonOrderAutomation(order: {
  orderId: string; productIdentifier: string; quantity: number;
  canceledQuantity: number; statusId: string; totalCostCents: number;
}): boolean {
  return order.quantity === 1 && order.canceledQuantity === 0 && ['1', '3', '5'].includes(order.statusId) &&
    AMAZON_ORDER_ID.test(order.orderId) && AMAZON_ASIN.test(order.productIdentifier) &&
    Number.isSafeInteger(order.totalCostCents) && order.totalCostCents > 0;
}

/** An import cannot be accepted if the resulting supported automation record
 * would immediately fail the same order/shipment consistency checks on load.
 */
export function amazonOrderCoherenceProblem(order: {
  statusId: string; purchasedAt: string; purchaseDate: string;
  shipment?: { quantity: number; statusId: string; shippingCompany: string } | null;
}): string | null {
  if (purchaseDay(order.purchasedAt) !== order.purchaseDate) return 'PURCHASE_DATE_CONFLICT';
  const shipment = order.shipment;
  if (shipment && (shipment.quantity !== 1 || !['1', '2', '3'].includes(shipment.statusId) || !shipment.shippingCompany.trim())) {
    return 'SHIPMENT_OUTSIDE_SUPPORTED_AUTOMATION_STATE';
  }
  if (shipment && order.statusId === '1') return 'PENDING_ORDER_HAS_SHIPMENT';
  if (order.statusId === '5' && (!shipment || shipment.statusId !== '3')) return 'DELIVERED_ORDER_WITHOUT_DELIVERED_SHIPMENT';
  return null;
}

/** Resolve the retailer independently: a join could hide a duplicate Amazon
 * retailer with no accounts. Accounts are 1:M; the unique, required ranking
 * selects the lowest one. Caller supplies a schema-validated transaction.
 * Identity/ranking columns only; the worker has no need or grant to read ccv.
 */
export async function readRelationalAmazonAccount(tx: BusinessQueryable): Promise<RetailerAccountIdentity> {
  const retailers = await tx.query<Pick<RetailerAccountIdentity, 'id' | 'name' | 'primary_url'>>(
    'SELECT id::text, name, primary_url FROM public.retailers WHERE name=$1', ['Amazon']);
  if (retailers.rows.length === 0) throw new Error('Amazon retailer is missing; provision it in the database before starting the worker.');
  if (retailers.rows.length !== 1) throw new Error('Amazon retailer is ambiguous; exactly one database row named Amazon is required.');
  const retailer = retailers.rows[0];
  if (!/^[1-9]\d*$/.test(retailer.id) || retailer.name !== 'Amazon') throw new Error('Amazon retailer identity is invalid.');
  let homepage: URL;
  try { homepage = new URL(retailer.primary_url); } catch { throw new Error('Amazon retailer URL is invalid.'); }
  if (homepage.protocol !== 'https:' ||
      !['amazon.com', 'www.amazon.com'].includes(homepage.hostname.toLowerCase()) ||
      homepage.username || homepage.password || homepage.port) {
    throw new Error('Amazon retailer URL does not match the approved HTTPS site.');
  }
  const accounts = await tx.query<Pick<RetailerAccountIdentity, 'id' | 'retailer_id' | 'email' | 'retailer_account_ranking'>>(
    `SELECT id::text, retailer_id::text, email, retailer_account_ranking
       FROM public.retailer_accounts WHERE retailer_id=$1::bigint
       ORDER BY retailer_account_ranking ASC LIMIT 1`, [retailer.id]);
  if (accounts.rows.length === 0) throw new Error('Amazon retailer account is missing; provision it in the database before starting the worker.');
  const account = accounts.rows[0];
  if (!/^[1-9]\d*$/.test(account.id) || account.retailer_id !== retailer.id || typeof account.email !== 'string'
      || account.email !== account.email.trim() || !/^[^\s@]+@[^\s@]+$/.test(account.email)
      || !Number.isInteger(account.retailer_account_ranking) || account.retailer_account_ranking < -2147483648
      || account.retailer_account_ranking > 2147483647) {
    throw new Error('Amazon retailer account identity is invalid.');
  }
  return { ...account, name: retailer.name, primary_url: retailer.primary_url };
}

async function accountIdentity(tx: BusinessRepositories, options?: RelationalOrderLedgerOptions): Promise<RetailerAccountIdentity> {
  const row = await readRelationalAmazonAccount(tx);
  // Pin the identity read from SQL at startup. Re-resolve on each operation so
  // a different top-ranked account stops work instead of switching a live run.
  if (options && (row.id !== options.retailerAccountId || row.email !== options.expectedAccountEmail
      || (options.retailerId !== undefined && row.retailer_id !== options.retailerId))) {
    throw new Error('Configured Amazon retailer/account identity does not match; no business data changed.');
  }
  return row;
}

/** Resolve the database mapping before opening any provider/browser workflow. */
export function validateRelationalRetailerAccount(db: RelationalDatabase, options?: RelationalOrderLedgerOptions) {
  return db.withTransaction(tx => accountIdentity(tx, options));
}

/** Only local scheduling, provider IDs and observation times belong in this snapshot. */
export function encodeAmazonOperationalState(record: AmazonOrderRecord): JsonObject {
  validateAmazonOrderRecord(record);
  const evidence: JsonObject = {
    schemaVersion: 1,
    purchasedAt: instant(record.purchasedAt, 'Purchase confirmation time'),
    packageSeen: record.packages.map(pkg => {
      const firstSeenAt = instant(pkg.firstSeenAt, 'Package first observation time');
      const lastSeenAt = instant(pkg.lastSeenAt, 'Package last observation time');
      if (Date.parse(firstSeenAt) > Date.parse(lastSeenAt)) throw new Error('Package observation times conflict.');
      return { trackingNumber: pkg.trackingNumber, firstSeenAt, lastSeenAt };
    }),
  };
  for (const key of ['lastCheckedAtlantaDay', 'lastAttemptAtlantaDay'] as const) {
    if (record[key] !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record[key]!)) throw new Error('Invalid tracking schedule date.');
      evidence[key] = record[key]!;
    }
  }
  // Provider/browser exception text can contain URLs or account content. Retain
  // the failure state without copying an arbitrary exception into the database.
  if (record.lastError !== undefined) evidence.lastError = 'RETAILER_CHECK_FAILED';
  for (const key of ['bfmrPurchaseIntentAt', 'bfmrTrackingSubmittedAt'] as const) {
    if (record[key] !== undefined) evidence[key] = instant(record[key], 'BFMR workflow time');
  }
  for (const key of ['bfmrPurchaseId', 'bfmrShipmentId'] as const) {
    if (record[key] !== undefined) evidence[key] = text(record[key], 'BFMR provider identity');
  }
  if (record.bfmrShipmentIntent !== undefined) evidence.bfmrShipmentIntent = {
    trackingNumber: text(record.bfmrShipmentIntent.trackingNumber, 'Shipment intent tracking identity'),
    at: instant(record.bfmrShipmentIntent.at, 'Shipment intent time'),
  };
  if (record.bfmrOfficial !== undefined) {
    const value = record.bfmrOfficial;
    for (const key of ['purchaseId', 'shipmentId', 'orderNo', 'trackingNumber'] as const) {
      if (value[key] !== null && (typeof value[key] !== 'string' || !value[key]?.trim())) {
        throw new Error('BFMR official observation has invalid identifiers.');
      }
    }
    evidence.bfmrOfficial = {
      status: text(value.status, 'BFMR observed status'), quantity: value.quantity,
      purchaseId: value.purchaseId, shipmentId: value.shipmentId,
      orderNo: value.orderNo, trackingNumber: value.trackingNumber,
      observedAt: instant(value.observedAt, 'BFMR observation time'),
    };
  }
  return evidence;
}

function sourceFacts(record: AmazonOrderRecord): JsonObject {
  const facts: JsonObject = {
    orderId: record.orderId, reserveId: record.reserveId, dealId: record.dealId,
    productIdentifier: record.asin, totalCents: record.totalCents, status: record.status,
    packages: record.packages.map(pkg => ({ trackingNumber: pkg.trackingNumber, carrier: pkg.carrier,
      status: pkg.status, firstSeenAt: pkg.firstSeenAt, lastSeenAt: pkg.lastSeenAt })),
  };
  if (record.bfmrOfficial) facts.bfmrOfficial = {
    status: record.bfmrOfficial.status, quantity: record.bfmrOfficial.quantity,
    purchaseId: record.bfmrOfficial.purchaseId, shipmentId: record.bfmrOfficial.shipmentId,
    orderNo: record.bfmrOfficial.orderNo, trackingNumber: record.bfmrOfficial.trackingNumber,
    observedAt: record.bfmrOfficial.observedAt,
  };
  if (record.bfmrPurchaseId) facts.bfmrPurchaseId = record.bfmrPurchaseId;
  if (record.bfmrShipmentId) facts.bfmrShipmentId = record.bfmrShipmentId;
  return facts;
}

/** Quantity-one automation is a projection of the full business history. An
 * unsupported historical row remains in the business tables and exposure/sync;
 * it is never transformed into a different order or used as a duplicate ban.
 */
function automationExclusion(row: OrderRecord): JsonObject | null {
  if (supportsAmazonOrderAutomation({ orderId: row.order_id, productIdentifier: row.product_identifier,
    quantity: row.quantity, canceledQuantity: row.canceled_quantity, statusId: row.status_id,
    totalCostCents: numericToCents(row.total_cost) })) return null;
  return { reason: 'ORDER_OUTSIDE_SUPPORTED_AUTOMATION_SCOPE', statusId: row.status_id,
    quantity: row.quantity, canceledQuantity: row.canceled_quantity, businessRecordsRetained: true };
}

async function retainLocalProjectionReview(tx: BusinessRepositories, row: OrderRecord,
  actionType: string, outcome: string, evidence: JsonObject): Promise<void> {
  const previous = await tx.evidence.latestWorkflow(actionType, row.id);
  if (previous?.outcome === outcome && canonicalJson(previous.evidence) === canonicalJson(evidence)) return;
  await tx.evidence.appendWorkflow({ orderId: row.id, reservationId: row.reservation_id,
    correlationId: previous?.correlation_id ?? randomUUID(), actionType,
    phase: 'REVIEW', outcome, evidence });
}

async function context(tx: BusinessRepositories, row: OrderRecord) {
  const reservation = await tx.reservations.findById(row.reservation_id);
  if (!reservation || reservation.deal_id !== row.deal_id) throw new Error('Stored order/reservation identity is inconsistent.');
  const deal = await tx.query<{ bfmr_deal_id: string }>('SELECT bfmr_deal_id FROM public.deals WHERE id=$1::bigint', [row.deal_id]);
  if (deal.rows.length !== 1) throw new Error('Stored order deal identity is missing.');
  return { reservation, dealId: deal.rows[0].bfmr_deal_id };
}

async function readRecord(tx: BusinessRepositories, row: OrderRecord): Promise<AmazonOrderRecord> {
  const { reservation, dealId } = await context(tx, row);
  if (row.quantity !== 1 || row.canceled_quantity !== 0) throw new Error('Non-unit or canceled retailer orders require explicit reconciliation.');
  const status = row.status_id === '1' ? 'PENDING' : row.status_id === '3' ? 'SHIPPED' : row.status_id === '5' ? 'DELIVERED' : null;
  if (!status) throw new Error('Stored retailer order status requires explicit reconciliation.');
  const snapshot = await tx.evidence.latestWorkflow(AMAZON_ORDER_STATE_ACTION, row.id);
  if (!snapshot || snapshot.evidence.schemaVersion !== 1 || !Array.isArray(snapshot.evidence.packageSeen)) {
    throw new Error('Order operational evidence is absent or unsupported; reconcile it before cutover.');
  }
  const state = snapshot.evidence;
  const packageSeen = state.packageSeen as JsonValue[];
  const record: AmazonOrderRecord = { orderId: row.order_id, reserveId: reservation.bfmr_reservation_id,
    dealId, asin: row.product_identifier, totalCents: numericToCents(row.total_cost),
    purchasedAt: instant(state.purchasedAt, 'Stored purchase confirmation time'), status, packages: [] };
  if (purchaseDay(record.purchasedAt) !== row.purchase_date) throw new Error('Stored order purchase date conflicts with its evidence.');
  const shipment = await tx.shipments.findByOrderId(row.id);
  if (amazonOrderCoherenceProblem({ statusId: row.status_id, purchasedAt: record.purchasedAt, purchaseDate: row.purchase_date,
    shipment: shipment ? { quantity: shipment.quantity, statusId: shipment.status_id, shippingCompany: shipment.shipping_company } : null })) {
    throw new Error('Stored order/shipment state is inconsistent; reconcile before provider actions.');
  }
  if (shipment) {
    if (shipment.quantity !== 1 || !['1', '2', '3'].includes(shipment.status_id)) throw new Error('Stored shipment requires explicit reconciliation.');
    if (!shipment.shipping_company.trim() || status === 'PENDING' || (status === 'DELIVERED' && shipment.status_id !== '3')) {
      throw new Error('Stored order/shipment status or carrier is inconsistent; reconcile before provider actions.');
    }
    const times = packageSeen.filter(item => object(item) && item.trackingNumber === shipment.tracking_number);
    if (times.length !== 1 || !object(times[0]) || packageSeen.length !== 1) {
      throw new Error('Shipment observation evidence is incomplete or conflicts with its tracking identity.');
    }
    record.packages.push({ trackingNumber: shipment.tracking_number, carrier: shipment.shipping_company,
      status: shipment.status_id === '3' ? 'DELIVERED' : 'SHIPPED',
      firstSeenAt: instant(times[0].firstSeenAt, 'Package first observation time'),
      lastSeenAt: instant(times[0].lastSeenAt, 'Package last observation time') });
  } else if (packageSeen.length || status === 'DELIVERED') throw new Error('Package observation or delivery status has no authoritative shipment row.');
  for (const key of ['lastCheckedAtlantaDay', 'lastAttemptAtlantaDay', 'lastError', 'bfmrPurchaseIntentAt',
    'bfmrPurchaseId', 'bfmrShipmentId', 'bfmrTrackingSubmittedAt'] as const) {
    if (state[key] !== undefined) {
      if (typeof state[key] !== 'string') throw new Error('Stored operational evidence has an invalid field.');
      record[key] = state[key];
    }
  }
  if (state.bfmrShipmentIntent !== undefined) {
    if (!object(state.bfmrShipmentIntent)) throw new Error('Stored shipment intent is invalid.');
    record.bfmrShipmentIntent = { trackingNumber: text(state.bfmrShipmentIntent.trackingNumber, 'Shipment intent identity'),
      at: instant(state.bfmrShipmentIntent.at, 'Shipment intent time') };
  }
  if (state.bfmrOfficial !== undefined) {
    if (!object(state.bfmrOfficial)) throw new Error('Stored BFMR observation is invalid.');
    record.bfmrOfficial = state.bfmrOfficial as unknown as NonNullable<AmazonOrderRecord['bfmrOfficial']>;
  }
  if ((record.bfmrShipmentId && !record.bfmrPurchaseId) ||
      (record.bfmrTrackingSubmittedAt && (!record.bfmrPurchaseId || !record.bfmrShipmentId || record.packages.length !== 1))) {
    throw new Error('Stored BFMR shipment confirmation is missing its exact purchase or tracking identity.');
  }
  encodeAmazonOperationalState(record); // Validate reconstructed evidence without inventing missing values.
  return record;
}

function immutableStateProblem(previous: AmazonOrderRecord, incoming: AmazonOrderRecord): string | null {
  if (previous.orderId !== incoming.orderId || previous.reserveId !== incoming.reserveId || previous.dealId !== incoming.dealId ||
      previous.asin !== incoming.asin || previous.totalCents !== incoming.totalCents || previous.purchasedAt !== incoming.purchasedAt) {
    return 'Retailer order identity, cost, or original purchase confirmation time changed.';
  }
  for (const key of ['bfmrPurchaseIntentAt', 'bfmrPurchaseId', 'bfmrShipmentId', 'bfmrTrackingSubmittedAt'] as const) {
    if (previous[key] !== undefined && previous[key] !== incoming[key]) return 'Established BFMR workflow identity or intent cannot be replaced.';
  }
  if (previous.bfmrShipmentIntent && canonicalJson(previous.bfmrShipmentIntent) !== canonicalJson(incoming.bfmrShipmentIntent)) {
    return 'Established BFMR shipment intent cannot be replaced.';
  }
  for (const key of ['lastCheckedAtlantaDay', 'lastAttemptAtlantaDay'] as const) {
    if (previous[key] && (!incoming[key] || incoming[key]! < previous[key]!)) return 'Retailer tracking schedule cannot regress.';
  }
  const rank = { PENDING: 0, SHIPPED: 1, DELIVERED: 2 };
  if (rank[incoming.status] < rank[previous.status]) return 'Retailer delivery status regressed; retain the conflicting observation for review.';
  if (previous.packages.length) {
    const old = previous.packages[0], next = incoming.packages[0];
    if (!next || old.trackingNumber !== next.trackingNumber || old.carrier !== next.carrier ||
        old.firstSeenAt !== next.firstSeenAt || Date.parse(next.lastSeenAt) < Date.parse(old.lastSeenAt) ||
        (old.status === 'DELIVERED' && next.status !== 'DELIVERED')) return 'Established shipment identity or observations changed.';
  }
  return null;
}

function bfmrState(record: AmazonOrderRecord): string {
  return canonicalJson({ purchaseIntent: record.bfmrPurchaseIntentAt, purchaseId: record.bfmrPurchaseId,
    shipmentIntent: record.bfmrShipmentIntent, shipmentId: record.bfmrShipmentId,
    submittedAt: record.bfmrTrackingSubmittedAt, official: record.bfmrOfficial });
}

async function appendReview(tx: BusinessRepositories, row: OrderRecord | null | undefined, reason: string,
  facts: JsonObject, snapshot?: WorkflowRecord | null, provider: 'AMAZON' | 'BFMR' | null = 'AMAZON') {
  await tx.evidence.appendWorkflow({ orderId: row?.id, reservationId: row?.reservation_id,
    correlationId: snapshot?.correlation_id ?? randomUUID(), actionType: ORDER_REVIEW_ACTION,
    phase: 'REVIEW', outcome: 'BLOCKED', evidence: { reason, ...facts } });
  if (provider) await tx.evidence.appendObservation({ orderId: row?.id, reservationId: row?.reservation_id, dealId: row?.deal_id,
    provider, resourceType: 'ORDER_CONFLICT', observedAt: new Date().toISOString(),
    isComplete: false, responseData: facts });
}

/** Typed business rows are authoritative; append-only snapshots retain operational state only. */
export function relationalOrderLedger(db: RelationalDatabase, options: RelationalOrderLedgerOptions): AmazonOrderLedger {
  async function write(record: AmazonOrderRecord, mode: 'ADD' | 'UPDATE', source: LedgerUpdateSource = 'OPERATIONAL'): Promise<void> {
    validateAmazonOrderRecord(record);
    const operational = encodeAmazonOperationalState(record);
    const problem = await db.withTransaction(async tx => {
      const account = await accountIdentity(tx, options);
      let row = await tx.orders.findByExternalId(record.orderId, account.retailer_id);
      const snapshot = row ? await tx.evidence.latestWorkflow(AMAZON_ORDER_STATE_ACTION, row.id) : undefined;
      const fail = async (reason: string) => {
        const provider = mode === 'ADD' || source === 'AMAZON' ? 'AMAZON' : source === 'BFMR' ? 'BFMR' : null;
        await appendReview(tx, row, reason, sourceFacts(record), snapshot, provider);
        return reason;
      };
      if (!record.reserveId || !record.dealId) return fail('Standalone orders require the standalone ledger; no relational reservation may be fabricated.');
      const reservation = await tx.reservations.findByBfmrId(record.reserveId);
      if (!reservation || reservation.quantity !== 1) return fail('Exact quantity-one reservation is absent; creation terms require reconciliation.');
      const deal = await tx.query<{ bfmr_deal_id: string }>('SELECT bfmr_deal_id FROM public.deals WHERE id=$1::bigint', [reservation.deal_id]);
      if (deal.rows.length !== 1 || deal.rows[0].bfmr_deal_id !== record.dealId) return fail('Retailer order deal differs from the reservation.');
      if (row && (row.retailer_account_id !== account.id || row.reservation_id !== reservation.id || row.deal_id !== reservation.deal_id)) {
        return fail('Retailer order is already associated with another account or reservation.');
      }
      if (mode === 'UPDATE' && !row) return fail('Order update has no existing authoritative order.');
      if (record.packages.length > 1) return fail('Multiple provider tracking numbers require review; no second shipment is promoted.');
      if (record.packages.some(pkg => !pkg.carrier?.trim())) return fail('Shipment carrier is unknown; the observed tracking is retained for review.');
      if ((record.bfmrShipmentId && !record.bfmrPurchaseId) ||
          (record.bfmrTrackingSubmittedAt && (!record.bfmrPurchaseId || !record.bfmrShipmentId || record.packages.length !== 1))) {
        return fail('BFMR shipment confirmation is missing its exact purchase or tracking identity.');
      }
      if (source === 'BFMR' && record.bfmrOfficial) {
        const official = record.bfmrOfficial;
        if (official.quantity !== 1 || official.orderNo !== record.orderId ||
            (record.bfmrPurchaseId && official.purchaseId !== record.bfmrPurchaseId) ||
            (record.bfmrShipmentId && official.shipmentId !== record.bfmrShipmentId) ||
            (record.packages.length === 1 && official.trackingNumber?.toUpperCase() !== record.packages[0].trackingNumber.toUpperCase()) ||
            (!record.packages.length && (official.shipmentId !== null || official.trackingNumber !== null))) {
          return fail('BFMR official observation conflicts with the exact retailer order or shipment.');
        }
      }
      if ((record.status === 'PENDING' && record.packages.length) ||
          (record.status === 'DELIVERED' && (record.packages.length !== 1 || record.packages[0].status !== 'DELIVERED'))) {
        return fail('Retailer order and shipment delivery states are inconsistent.');
      }
      if (row) {
        const previous = await readRecord(tx, row);
        const mismatch = immutableStateProblem(previous, record);
        if (mismatch) return fail(mismatch);
        if (mode === 'UPDATE' && source !== 'AMAZON' &&
            (previous.status !== record.status || canonicalJson(previous.packages) !== canonicalJson(record.packages))) {
          return fail('Order/shipment changes require explicit validated Amazon observation provenance.');
        }
        if (mode === 'UPDATE' && source === 'AMAZON' && bfmrState(previous) !== bfmrState(record)) {
          return fail('An Amazon observation cannot replace BFMR workflow evidence.');
        }
        if (mode === 'UPDATE' && source === 'OPERATIONAL' &&
            (previous.bfmrPurchaseId !== record.bfmrPurchaseId || previous.bfmrShipmentId !== record.bfmrShipmentId ||
              previous.bfmrTrackingSubmittedAt !== record.bfmrTrackingSubmittedAt ||
              canonicalJson(previous.bfmrOfficial) !== canonicalJson(record.bfmrOfficial))) {
          return fail('BFMR confirmation changes require explicit validated BFMR readback provenance.');
        }
      } else {
        const other = await tx.orders.findByReservationId(reservation.id);
        if (other) return fail('Reservation already has a different retailer order.');
        const eligible = await tx.query('SELECT 1 FROM public.deal_retailers WHERE deal_id=$1::bigint AND retailer_id=$2::bigint',
          [reservation.deal_id, account.retailer_id]);
        if (eligible.rows.length !== 1) return fail('Verified deal/retailer eligibility is absent; no order eligibility is inferred.');
        row = await tx.orders.create({ orderId: record.orderId, reservationId: reservation.id, dealId: reservation.deal_id,
          retailerId: account.retailer_id, retailerAccountId: account.id, quantity: 1, totalCostCents: record.totalCents,
          purchaseDate: purchaseDay(record.purchasedAt), productIdentifier: record.asin,
          statusId: record.status === 'PENDING' ? '1' : record.status === 'SHIPPED' ? '3' : '5' });
      }
      await tx.orders.updateStatus(row.id, record.status === 'PENDING' ? '1' : record.status === 'SHIPPED' ? '3' : '5');
      if (record.packages.length) {
        const pkg = record.packages[0];
        const previousShipment = await tx.shipments.findByOrderId(row.id);
        await tx.shipments.save({ orderId: row.id, trackingNumber: pkg.trackingNumber, shippingCompany: pkg.carrier!,
          quantity: 1, statusId: pkg.status === 'DELIVERED' ? '3' : previousShipment?.status_id === '2' ? '2' : '1' });
      }
      if (mode === 'ADD' || source === 'AMAZON') {
        await tx.evidence.appendObservation({ orderId: row.id, reservationId: reservation.id, dealId: reservation.deal_id,
          provider: 'AMAZON', resourceType: mode === 'ADD' ? 'ORDER_CONFIRMATION' : 'ORDER_TRACKING',
          observedAt: new Date().toISOString(), isComplete: true, responseData: sourceFacts(record) });
      } else if (source === 'BFMR') {
        const official = record.bfmrOfficial;
        await tx.evidence.appendObservation({ orderId: row.id, reservationId: reservation.id, dealId: reservation.deal_id,
          provider: 'BFMR', resourceType: 'ORDER_READBACK', observedAt: official?.observedAt ?? new Date().toISOString(),
          isComplete: !official || (official.quantity === 1 && official.orderNo === record.orderId &&
            (!record.bfmrPurchaseId || record.bfmrPurchaseId === official.purchaseId) &&
            (!record.bfmrShipmentId || record.bfmrShipmentId === official.shipmentId)),
          responseData: official ? { status: official.status, quantity: official.quantity,
            purchaseId: official.purchaseId, shipmentId: official.shipmentId, orderNo: official.orderNo,
            trackingNumber: official.trackingNumber } : { reserveId: record.reserveId, dealId: record.dealId,
            orderNo: record.orderId, purchaseId: record.bfmrPurchaseId ?? null, shipmentId: record.bfmrShipmentId ?? null,
            trackingNumber: record.packages[0]?.trackingNumber ?? null } });
      }
      await tx.evidence.appendWorkflow({ orderId: row.id, reservationId: reservation.id,
        correlationId: snapshot?.correlation_id ?? randomUUID(), actionType: AMAZON_ORDER_STATE_ACTION,
        phase: 'SNAPSHOT', outcome: 'RECORDED', evidence: operational });
      return null;
    });
    // Throw only after the transaction commits the conflicting observation.
    if (problem) throw new Error(`${problem} No authoritative change was made; review evidence was retained.`);
  }
  return {
    async load() {
      const result = await db.withTransaction(async tx => {
        const account = await accountIdentity(tx, options);
        const rows = (await tx.orders.list()).filter(row => row.retailer_account_id === account.id);
        const records: AmazonOrderRecord[] = [];
        let blocked = false;
        for (const row of rows) {
          const exclusion = automationExclusion(row);
          if (exclusion) {
            await retainLocalProjectionReview(tx, row, AMAZON_AUTOMATION_SCOPE_ACTION, 'EXCLUDED', exclusion);
            continue;
          }
          try { records.push(await readRecord(tx, row)); }
          catch {
            blocked = true;
            await retainLocalProjectionReview(tx, row, ORDER_REVIEW_ACTION, 'BLOCKED',
              { reason: 'ACTIVE_ORDER_PROJECTION_REQUIRES_RECONCILIATION', businessRecordsRetained: true });
          }
        }
        return { records, blocked };
      });
      // Keep local review evidence even when active order data cannot be used.
      if (result.blocked) throw new Error('An active order requires reconciliation before automation; review evidence was retained.');
      return result.records;
    },
    add: record => write(record, 'ADD'),
    update: (record, source) => write(record, 'UPDATE', source),
    async recordReview(orderId, reason, facts = {}) {
      // Callers supply only selected identity facts. Arbitrary payloads are not copied.
      const selected: JsonObject = { externalOrderId: orderId };
      for (const key of ['purchaseId', 'shipmentId', 'trackingNumber', 'reserveId', 'dealId'] as const) {
        if (facts[key] === null || typeof facts[key] === 'string') selected[key] = facts[key] as JsonValue;
      }
      if (Array.isArray(facts.trackerRows)) selected.trackerRows = facts.trackerRows.map(value => {
        const row: JsonObject = {};
        if (!object(value)) return row;
        for (const key of ['reserveId', 'dealId', 'purchaseId', 'shipmentId', 'trackingNumber', 'orderNo', 'status'] as const) {
          if (value[key] === null || typeof value[key] === 'string') row[key] = value[key] as JsonValue;
        }
        if (Number.isSafeInteger(value.quantity) && Number(value.quantity) >= 0) row.quantity = Number(value.quantity);
        return row;
      });
      await db.withTransaction(async tx => {
        const account = await accountIdentity(tx, options);
        const row = await tx.orders.findByExternalId(orderId, account.retailer_id);
        if (row && row.retailer_account_id !== account.id) throw new Error('Review subject belongs to another configured account.');
        const snapshot = row ? await tx.evidence.latestWorkflow(AMAZON_ORDER_STATE_ACTION, row.id) : undefined;
        // The reason argument may originate in an exception. Only a static code
        // and explicitly selected identity facts are durable evidence.
        await appendReview(tx, row, 'RECONCILIATION_REVIEW_REQUIRED', selected, snapshot, facts.provider === 'BFMR' ? 'BFMR' : 'AMAZON');
      });
    },
  };
}
