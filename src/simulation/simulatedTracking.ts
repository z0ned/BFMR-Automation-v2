import type { ProviderBundle, ProviderTrackerRow } from '../providers/interfaces';
import type { AmazonOrderRecord, TrackedPackage } from '../services/amazonOrderLedger';
import { atlantaDayAndHour } from '../services/nightlyAmazonTracking';
import type { RelationalRuntime } from '../services/relationalRuntime';
import type { SimulatedStore } from './simulatedStore';

function exactReservationRow(rows: ProviderTrackerRow[], order: AmazonOrderRecord): ProviderTrackerRow {
  const matches = rows.filter(row => String(row.reserve_id ?? '').trim() === order.reserveId);
  if (matches.length !== 1) throw new Error('Exact simulated BFMR reservation is missing or ambiguous.');
  const row = matches[0];
  if (String(row.deal_id ?? '').trim() !== order.dealId || Number(row.qty ?? row.quantity) !== 1) {
    throw new Error('Simulated BFMR reservation identity or quantity conflicts with the order.');
  }
  return row;
}

function official(row: ProviderTrackerRow, observedAt: string): NonNullable<AmazonOrderRecord['bfmrOfficial']> {
  return {
    status: String(row.status ?? row.item_status ?? row.reservation_status ?? 'UNKNOWN'),
    quantity: Number(row.qty ?? row.quantity),
    purchaseId: row.purchase_id == null ? null : String(row.purchase_id),
    shipmentId: row.shipment_id == null ? null : String(row.shipment_id),
    orderNo: row.order_no == null ? null : String(row.order_no),
    trackingNumber: row.tracking_number == null ? null : String(row.tracking_number),
    observedAt,
  };
}

async function reconcileBfmrTracking(orderId: string, runtime: RelationalRuntime, bundle: ProviderBundle, store: SimulatedStore) {
  const api = bundle.bfmrApi;
  if (!api.submitPurchase || !api.submitPurchaseTracking || !api.readTrackingTrackerRows) {
    throw new Error('Simulated BFMR Purchase/Shipment operations are unavailable.');
  }
  let order = (await runtime.ledger.load()).find(item => item.orderId === orderId);
  if (!order?.reserveId || !order.dealId || order.packages.length !== 1) return;
  const pkg = order.packages[0];
  let rows = await api.readTrackingTrackerRows();
  let row = exactReservationRow(rows, order);
  const currentTime = bundle.clock.now().toISOString();

  const exactPurchase = (candidate: ProviderTrackerRow) => {
    const id = candidate.purchase_id == null ? '' : String(candidate.purchase_id).trim();
    return id && String(candidate.order_no ?? '').trim() === order!.orderId ? id : '';
  };
  let purchaseId = exactPurchase(row);
  if (purchaseId) {
    if (order.bfmrPurchaseId && order.bfmrPurchaseId !== purchaseId) throw new Error('Simulated BFMR Purchase ID changed.');
    if (order.bfmrPurchaseId !== purchaseId) {
      order = { ...order, bfmrPurchaseId: purchaseId, bfmrOfficial: official(row, currentTime) };
      await runtime.ledger.update(order, 'BFMR');
    }
  } else {
    if (row.purchase_id || row.order_no || row.shipment_id || row.tracking_number ||
        String(row.status ?? row.item_status ?? row.reservation_status).toLowerCase() !== 'reserved') {
      throw new Error('Simulated BFMR Purchase state conflicts with the exact Reserved order.');
    }
    if (order.bfmrPurchaseIntentAt) throw new Error('Unresolved BFMR Purchase intent; reconcile exact tracker evidence before retry.');
    order = { ...order, bfmrPurchaseIntentAt: currentTime };
    await runtime.ledger.update(order, 'OPERATIONAL');
    try { await api.submitPurchase({ orderId: order.orderId, reserveId: order.reserveId, dealId: order.dealId }); }
    catch { /* Exact readback below distinguishes committed from uncommitted outcomes. */ }
    rows = await api.readTrackingTrackerRows();
    row = exactReservationRow(rows, order);
    purchaseId = exactPurchase(row);
    if (!purchaseId) throw new Error('BFMR Purchase is not confirmed by exact simulated tracker readback; no repeat write is permitted.');
    order = { ...(await runtime.ledger.load()).find(item => item.orderId === orderId)!, bfmrPurchaseId: purchaseId,
      bfmrOfficial: official(row, bundle.clock.now().toISOString()) };
    await runtime.ledger.update(order, 'BFMR');
  }

  const trackerNumber = row.tracking_number == null ? '' : String(row.tracking_number).trim();
  const shipmentId = row.shipment_id == null ? '' : String(row.shipment_id).trim();
  if (shipmentId || trackerNumber) {
    if (!shipmentId || trackerNumber.toUpperCase() !== pkg.trackingNumber.toUpperCase() ||
        (order.bfmrShipmentId && order.bfmrShipmentId !== shipmentId)) {
      throw new Error('Simulated BFMR Shipment readback conflicts with Amazon tracking.');
    }
    if (!order.bfmrShipmentId || !order.bfmrTrackingSubmittedAt) {
      await runtime.ledger.update({ ...order, bfmrShipmentId: shipmentId,
        bfmrTrackingSubmittedAt: bundle.clock.now().toISOString(), bfmrOfficial: official(row, bundle.clock.now().toISOString()) }, 'BFMR');
    }
    return;
  }
  if (String(row.status ?? row.item_status ?? row.reservation_status).toLowerCase() !== 'purchased') {
    throw new Error('Simulated BFMR status is not Purchased before Shipment.');
  }
  if (order.bfmrShipmentIntent) throw new Error('Unresolved BFMR Shipment intent; reconcile exact tracker evidence before retry.');
  order = { ...order, bfmrShipmentIntent: { trackingNumber: pkg.trackingNumber, at: bundle.clock.now().toISOString() } };
  await runtime.ledger.update(order, 'OPERATIONAL');
  try {
    await api.submitPurchaseTracking(order.orderId, pkg.trackingNumber, pkg.carrier ?? '');
  } catch { /* Exact readback below distinguishes committed from uncommitted outcomes. */ }
  rows = await api.readTrackingTrackerRows();
  row = exactReservationRow(rows, order);
  const confirmedShipment = row.shipment_id == null ? '' : String(row.shipment_id).trim();
  const confirmedTracking = row.tracking_number == null ? '' : String(row.tracking_number).trim();
  if (!confirmedShipment || confirmedTracking.toUpperCase() !== pkg.trackingNumber.toUpperCase() ||
      String(row.purchase_id ?? '').trim() !== purchaseId || String(row.order_no ?? '').trim() !== order.orderId) {
    throw new Error('BFMR Shipment is not confirmed by exact simulated tracker readback; no repeat write is permitted.');
  }
  order = { ...(await runtime.ledger.load()).find(item => item.orderId === orderId)!, bfmrShipmentId: confirmedShipment,
    bfmrTrackingSubmittedAt: bundle.clock.now().toISOString(), bfmrOfficial: official(row, bundle.clock.now().toISOString()) };
  await runtime.ledger.update(order, 'BFMR');
  await store.logEvent(bundle.runId!, 'INFO', 'WORKFLOW', 'Simulated BFMR Shipment was confirmed by exact tracker readback.',
    { reserveId: order.reserveId, purchaseId, shipmentId: confirmedShipment, trackingNumber: pkg.trackingNumber });
}

function dueForTracking(order: AmazonOrderRecord, now: Date): { day: string; due: boolean } {
  const current = atlantaDayAndHour(now);
  const purchased = atlantaDayAndHour(new Date(order.purchasedAt));
  const due = current.hour >= 3 && order.lastCheckedAtlantaDay !== current.day && order.lastAttemptAtlantaDay !== current.day &&
    (order.status !== 'DELIVERED' || Boolean(order.reserveId && order.packages.length === 1 && !order.bfmrTrackingSubmittedAt)) &&
    (purchased.day < current.day || (purchased.day === current.day && purchased.hour < 3));
  return { day: current.day, due };
}

async function recordReview(order: AmazonOrderRecord, runtime: RelationalRuntime, bundle: ProviderBundle,
  store: SimulatedStore, reason: string, evidence: unknown): Promise<void> {
  await runtime.ledger.recordReview?.(order.orderId, reason, { provider: 'AMAZON', reserveId: order.reserveId,
    dealId: order.dealId, trackingNumber: order.packages[0]?.trackingNumber });
  await store.logEvent(bundle.runId!, 'WARN', 'WORKFLOW', `Tracking review required: ${reason}.`, evidence);
}

/** One manually advanced, virtual-time tracking pass; never opens a live browser or sends live provider writes. */
export async function runSimulatedAmazonTracking(runtime: RelationalRuntime, bundle: ProviderBundle,
  store: SimulatedStore): Promise<{ checked: number; skipped: number; reviews: string[] }> {
  if (bundle.mode !== 'simulation' || bundle.simulationScenario?.phase !== 3 || !bundle.runId) {
    throw new Error('Simulated tracking requires an active Phase 3 provider run.');
  }
  if (!bundle.amazon.readTracking) throw new Error('Simulated Amazon tracking reads are unavailable.');
  const now = bundle.clock.now();
  const orders = await runtime.ledger.load();
  let checked = 0;
  let skipped = 0;
  const reviews: string[] = [];
  for (const initial of orders) {
    const schedule = dueForTracking(initial, now);
    if (!schedule.due) { skipped++; continue; }
    try {
      const account = await bundle.amazon.verifyAccount(runtime.retailerAccount.email);
      if (account !== 'AUTHENTICATED') throw new Error(`Simulated Amazon tracking account is ${account}.`);
      const observation = await bundle.amazon.readTracking(initial.orderId);
      if (observation.status !== 'FOUND') {
        await recordReview(initial, runtime, bundle, store, 'AMAZON_TRACKING_INCOMPLETE', { orderId: initial.orderId, status: observation.status });
        await runtime.ledger.update({ ...initial, lastAttemptAtlantaDay: schedule.day, lastError: 'AMAZON_TRACKING_INCOMPLETE' }, 'OPERATIONAL');
        reviews.push(`${initial.orderId}: incomplete Amazon tracking read`);
        continue;
      }
      if (observation.orderId !== initial.orderId || observation.asin !== initial.asin || observation.totalCents !== initial.totalCents) {
        await recordReview(initial, runtime, bundle, store, 'AMAZON_TRACKING_IDENTITY_MISMATCH', {
          expectedOrderId: initial.orderId, observedOrderId: observation.orderId,
          expectedAsin: initial.asin, observedAsin: observation.asin,
          expectedTotalCents: initial.totalCents, observedTotalCents: observation.totalCents,
        });
        await runtime.ledger.update({ ...initial, lastAttemptAtlantaDay: schedule.day, lastError: 'AMAZON_TRACKING_IDENTITY_MISMATCH' }, 'OPERATIONAL');
        reviews.push(`${initial.orderId}: Amazon order identity mismatch`);
        continue;
      }
      if (observation.packages.length > 1 || observation.packages.some(pkg => !pkg.trackingNumber || !pkg.carrier?.trim())) {
        await recordReview(initial, runtime, bundle, store, observation.packages.length > 1 ? 'MULTIPLE_TRACKING_NUMBERS' : 'PARTIAL_TRACKING_EVIDENCE', {
          orderId: initial.orderId, packageCount: observation.packages.length,
        });
        await runtime.ledger.update({ ...initial, lastAttemptAtlantaDay: schedule.day, lastError: 'TRACKING_EVIDENCE_REQUIRES_REVIEW' }, 'OPERATIONAL');
        reviews.push(`${initial.orderId}: tracking evidence requires review`);
        continue;
      }
      const pkg = observation.packages[0];
      if ((observation.shipmentStatus === 'PENDING' && pkg) ||
          (observation.shipmentStatus !== 'PENDING' && !pkg) ||
          (pkg && pkg.status !== observation.shipmentStatus)) {
        await recordReview(initial, runtime, bundle, store, 'AMAZON_ORDER_SHIPMENT_STATE_MISMATCH', {
          orderId: initial.orderId, shipmentStatus: observation.shipmentStatus, packageCount: observation.packages.length,
        });
        await runtime.ledger.update({ ...initial, lastAttemptAtlantaDay: schedule.day, lastError: 'AMAZON_ORDER_SHIPMENT_STATE_MISMATCH' }, 'OPERATIONAL');
        reviews.push(`${initial.orderId}: Amazon order/shipment state mismatch`);
        continue;
      }
      const updated: AmazonOrderRecord = {
        ...initial,
        status: observation.shipmentStatus,
        packages: pkg ? [{ ...pkg, firstSeenAt: initial.packages[0]?.firstSeenAt ?? pkg.firstSeenAt, lastSeenAt: now.toISOString() }] : [],
        lastCheckedAtlantaDay: schedule.day,
        lastAttemptAtlantaDay: schedule.day,
        lastError: undefined,
      };
      await runtime.ledger.update(updated, 'AMAZON');
      if (updated.packages.length) await reconcileBfmrTracking(updated.orderId, runtime, bundle, store);
      await store.logEvent(bundle.runId, 'INFO', 'WORKFLOW', `Simulated Amazon tracking checked: ${updated.orderId} is ${updated.status}.`, {
        orderId: updated.orderId, asin: updated.asin, totalCents: updated.totalCents,
        shipmentStatus: updated.status, packageCount: updated.packages.length,
      });
      checked++;
    } catch (error) {
      const current = (await runtime.ledger.load()).find(item => item.orderId === initial.orderId) ?? initial;
      await runtime.ledger.update({ ...current, lastAttemptAtlantaDay: schedule.day,
        lastError: error instanceof Error ? error.message.slice(0, 160) : 'SIMULATED_TRACKING_FAILED' }, 'OPERATIONAL').catch(() => {});
      await recordReview(initial, runtime, bundle, store, 'TRACKING_WORKFLOW_REQUIRES_REVIEW', {
        orderId: initial.orderId, errorCode: error instanceof Error ? error.message.slice(0, 100) : 'SIMULATED_TRACKING_FAILED',
      });
      reviews.push(`${initial.orderId}: tracking workflow requires review`);
    }
  }
  await store.logEvent(bundle.runId, reviews.length ? 'WARN' : 'INFO', 'WORKFLOW',
    `Simulated tracking pass finished: ${checked} checked, ${skipped} not due, ${reviews.length} review item(s).`,
    { checked, skipped, reviews });
  return { checked, skipped, reviews };
}
