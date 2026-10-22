import type { Page } from 'playwright';
import type { RelationalRuntime } from './relationalRuntime';
import type { TrackerReservationRow } from './bfmrTrackerApi';
import type { JsonObject } from '../db/relationalTypes';
import { normalizeTrackerReservation } from './relationalTrackerTerms';
import { cancellationTargetState } from './reservationCancellation';
import { checkAmazonShipment } from './amazonShipmentCheck';
import { requireAmazonAccountIdentity } from './amazonAccountIdentity';
import { inspectAmazonCart } from './amazonCheckoutRehearsal';
import { assertEmailSinceCutover } from './relationalCutover';
import { providerOrderIssues } from './bfmrRelationalSync';
import { encodeAmazonOperationalState, readRelationalAmazonAccount, readRelationalOrderRecord } from './relationalOrderLedger';
import { atlantaDayAndHour } from './nightlyAmazonTracking';
import type { AmazonOrderRecord } from './amazonOrderLedger';
import { numericToCents } from '../db/relationalRepositories';
import { DealEmailWorkflowStore, emailSourceSha256, validateDealEmailState, terminalDeal, type WorkflowEmail, type WorkflowCheckpoint, type DealEmailState } from './dealEmailWorkflowStore';

export interface EmailReconciliationReport {
  schemaVersion: 1;
  generatedAt: string;
  account: string;
  workflowRevision: string;
  ready: boolean;
  issues: string[];
  next: DealEmailState;
  cancelledReservationIds: string[];
  purchaseReadbacks: Array<{ reserveId: string; orderId: string; purchaseId: string }>;
  creationNoActionDealIds: string[];
  orderCaptures: AmazonOrderRecord[];
}

/** Read-only provider/SQL assessment. Unknown outcomes are reported, never
 * turned into permission to repeat a mutation or choose a matching order.
 */
export async function reconcileDealEmail(runtime: RelationalRuntime, checkpoint: WorkflowCheckpoint, options: {
  readTracker(): Promise<TrackerReservationRow[]>;
  createRetailerPage(): Promise<Page>;
}): Promise<EmailReconciliationReport> {
  await runtime.ownership.verifyOwnership();
  await runtime.verifyRetailerAccount();
  const next = structuredClone(validateDealEmailState(checkpoint.state));
  if (next.account !== runtime.account || next.source !== 'GMAIL' || next.retailerAccountId !== runtime.retailerAccount.id) {
    throw new Error('Reconciliation account/source differs from the pinned workflow.');
  }
  if (process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED !== 'YES' || process.env.BFMR_CREATION_TERMS_CONTRACT_VALIDATED !== 'YES') {
    throw new Error('Verified BFMR financial and creation contracts are required for action reconciliation.');
  }
  const issues: string[] = [];
  const cancelledReservationIds: string[] = [];
  const purchaseReadbacks: EmailReconciliationReport['purchaseReadbacks'] = [];
  const creationNoActionDealIds: string[] = [];
  const orderCaptures: AmazonOrderRecord[] = [];
  const rows = await options.readTracker();
  // Reject malformed, ambiguous or financially conflicting full reads before
  // drawing an action-driving conclusion about any member of the message.
  const normalized = rows.map(normalizeTrackerReservation);
  if (new Set(normalized.map(row => row.reserveId)).size !== normalized.length) throw new Error('Duplicate provider reservation identity.');
  const local = await runtime.db.withTransaction(async tx => {
    const queue = await tx.query<{ state: string; payload: WorkflowEmail | null }>(`SELECT state,payload FROM public.gmail_intake_work
      WHERE account_namespace=$1 AND gmail_message_id=$2`, [runtime.account, next.messageId]);
    if (queue.rows.length !== 1 || queue.rows[0].state !== 'PROCESSING' || !queue.rows[0].payload?.receivedAt ||
        emailSourceSha256(queue.rows[0].payload) !== next.sourceSha256) {
      throw new Error('Only interrupted PROCESSING work can be repaired; completed or missing mail cannot be replayed.');
    }
    assertEmailSinceCutover(runtime.baselineStartsAt, queue.rows[0].payload.receivedAt);
    const captures = await tx.query<{ id: string; reservation_id: string | null; evidence: JsonObject }>(`SELECT id::text,reservation_id,evidence FROM public.workflow_evidence
      WHERE action_type='RESERVATION_CREATION' AND phase='CONFIRMED' AND correlation_id=$1`, [next.workflowId]);
    const intents = await tx.query<{ id: string; evidence: JsonObject }>(`SELECT id::text,evidence FROM public.workflow_evidence
      WHERE action_type='RESERVATION_CREATION' AND phase='INTENT' AND correlation_id=$1`, [next.workflowId]);
    const noAction = await tx.query<{ id: string; evidence: JsonObject }>(`SELECT id::text,evidence FROM public.workflow_evidence
      WHERE action_type='RESERVATION_CREATION' AND phase='NO_ACTION' AND correlation_id=$1`, [next.workflowId]);
    const reservations = await tx.reservations.list();
    const orders = await tx.orders.list();
    const payments = await tx.reimbursements.list();
    const deals = await tx.query<{ id: string; bfmr_deal_id: string }>('SELECT id::text,bfmr_deal_id FROM public.deals');
    const associations: string[] = [];
    for (const reservation of reservations) {
      const row = normalized.find(r => r.reserveId === reservation.bfmr_reservation_id);
      if (row) associations.push(...await providerOrderIssues(tx, reservation, row));
    }
    return { associations, deals: deals.rows, captures: captures.rows, intents: intents.rows, noAction: noAction.rows, reservations, orders, payments };
  });
  // Require current full-account coverage and actual payment agreement, without
  // promoting provider state or inventing creation/payment records in report mode.
  issues.push(...local.associations);
  if (normalized.length !== local.reservations.length) issues.push('FULL_ACCOUNT_COVERAGE_CONFLICT');
  for (const reservation of local.reservations) {
    const row = normalized.find(r => r.reserveId === reservation.bfmr_reservation_id);
    const payment = local.payments.find(p => p.reservation_id === reservation.id);
    const cents = numericToCents;
    const paid = payment ? cents(payment.amount) : 0;
    const localOrder = local.orders.find(o => o.reservation_id === reservation.id);
    if (!row || row.quantity !== reservation.quantity || row.expectedPayoutCents !== cents(reservation.expected_payout) ||
        row.amountPaidCents !== paid || row.dealId !== local.deals.find(d => d.id === reservation.deal_id)?.bfmr_deal_id ||
        row.payoutPerItemCents !== cents(reservation.payout_per_item) || row.status === 'paid' && paid < cents(reservation.expected_payout) ||
        ['cancelled', 'canceled', 'released', 'expired'].includes(row.status) && localOrder && paid < cents(reservation.expected_payout)) issues.push('LOCKED_FINANCIAL_OR_PAYMENT_COVERAGE_CONFLICT');
  }
  const emptyCart = async (asin: string | undefined) => {
    if (!asin) throw new Error('Known cart product identity is missing.');
    const page = await options.createRetailerPage();
    try {
      await page.goto('https://www.amazon.com/gp/cart/view.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await requireAmazonAccountIdentity(page, runtime.retailerAccount.email);
      if (await inspectAmazonCart(page, asin) !== 'EMPTY') throw new Error('Cart is not verified empty.');
    } finally { await page.close().catch(() => {}); }
  };
  for (let index = 0; index < next.deals.length; index++) {
    const deal = next.deals[index];
    try {
      if (deal.step === 'SKIPPED' || deal.step === 'PENDING') continue;
      if (deal.step === 'RESERVING') {
        if (!deal.dealId) {
          // The canonical-ID checkpoint is committed before submitReservation
          // is called. Without it, this version cannot have clicked the form.
          const known = new Set(next.deals.map(d => d.dealId).filter(Boolean));
          const unresolved = local.intents.filter(i => ![...local.captures, ...local.noAction].some(c =>
            BigInt(c.id) > BigInt(i.id) && c.evidence.bfmr_deal_id === i.evidence.bfmr_deal_id));
          const orphanIds = unresolved.map(i => i.evidence.bfmr_deal_id);
          if (orphanIds.some(id => typeof id !== 'string') || new Set(orphanIds).size > 1 ||
              local.captures.some(c => !known.has(String(c.evidence.bfmr_deal_id)))) throw new Error('Ambiguous pre-submission creation evidence.');
          creationNoActionDealIds.push(...orphanIds as string[]);
          deal.step = orphanIds.some(id => known.has(String(id))) ? 'SKIPPED' : 'PENDING';
          continue;
        }
        const latestIntent = local.intents.filter(i => i.evidence.bfmr_deal_id === deal.dealId).reduce((id, i) => BigInt(i.id) > id ? BigInt(i.id) : id, 0n);
        const captures = local.captures.filter(c => c.evidence.bfmr_deal_id === deal.dealId && BigInt(c.id) > latestIntent);
        const ids = [...new Set(captures.map(c => c.evidence.bfmr_reservation_id))];
        if (!ids.length && local.noAction.some(c => c.evidence.bfmr_deal_id === deal.dealId && BigInt(c.id) > latestIntent)) { deal.step = 'SKIPPED'; continue; }
        if (ids.length !== 1 || typeof ids[0] !== 'string') throw new Error('No exact causal creation capture; provider title/deal matches are insufficient.');
        deal.reference = { reserveId: ids[0], dealId: deal.dealId };
        deal.step = 'RESERVED';
      }
      const reference = deal.reference;
      if (!reference) throw new Error('Exact reservation identity is missing.');
      const reservation = local.reservations.find(r => r.bfmr_reservation_id === reference.reserveId);
      const row = normalized.find(r => r.reserveId === reference.reserveId);
      if (!reservation || !row || row.dealId !== reference.dealId || row.quantity !== 1) throw new Error('Exact stored/provider reservation identity conflicts.');
      const order = local.orders.find(o => o.reservation_id === reservation.id);
      if (deal.step === 'CANCEL_INTENT' || deal.step === 'CANCELLED') {
        if (order || cancellationTargetState(rows, reference) !== 'RELEASED') throw new Error('Cancellation is not explicitly confirmed.');
        if (deal.cartNeedsReview) { await emptyCart(deal.targetAsin); deal.cartNeedsReview = false; }
        cancelledReservationIds.push(reference.reserveId);
        deal.step = 'CANCELLED';
        continue;
      }
      if (['RESERVED', 'EVALUATING', 'ELIGIBLE', 'CHECKOUT_PREPARING'].includes(deal.step)) {
        if (order || row.status !== 'reserved' || row.purchaseId || row.orderNo || row.shipmentId || row.trackingNumber) {
          throw new Error('Pre-order workflow has unexpected provider/order effects.');
        }
        if (deal.step === 'CHECKOUT_PREPARING') { await emptyCart(deal.targetAsin); deal.step = 'ELIGIBLE'; }
        if (deal.step === 'EVALUATING') deal.step = 'RESERVED'; // Repeat only a read, never cancellation.
        continue;
      }
      if (deal.step === 'CHECKOUT_INTENT') throw new Error('Checkout may have succeeded without causal confirmation capture; no automatic order search or retry.');
      const captured = deal.order;
      if (!captured || !deal.checkout) throw new Error('Causal order confirmation is missing.');
      if (order && (order.order_id !== captured.orderId || order.retailer_account_id !== runtime.retailerAccount.id ||
          order.product_identifier !== captured.asin || numericToCents(order.total_cost) !== captured.totalCents ||
          order.quantity !== 1 || order.canceled_quantity !== 0)) throw new Error('Stored order differs from the causal confirmation.');
      const storedOrder = order ? await runtime.db.withTransaction(tx => readRelationalOrderRecord(tx, order)) : null;
      if (storedOrder && storedOrder.purchasedAt !== captured.purchasedAt) throw new Error('Causal order time conflicts with stored confirmation.');
      if (!order && deal.step !== 'ORDER_CONFIRMED') throw new Error('Recorded order is missing from SQL.');
      const page = await options.createRetailerPage();
      try {
        const observed = await checkAmazonShipment(page, captured, new Date(), runtime.retailerAccount.email);
        if (observed.packages.length > 1) throw new Error('Unsupported multiple-shipment outcome.');
      } finally { await page.close().catch(() => {}); }
      if (row.orderNo || row.purchaseId) {
        if (!order || row.orderNo !== captured.orderId || !row.purchaseId) throw new Error('BFMR purchase is crossed or incomplete.');
        purchaseReadbacks.push({ reserveId: reference.reserveId, orderId: captured.orderId, purchaseId: row.purchaseId });
        deal.step = 'COMPLETE';
      } else {
        if (row.status !== 'reserved' || row.shipmentId || row.trackingNumber || storedOrder?.bfmrPurchaseIntentAt ||
            ['PURCHASE_UPDATE_INTENT', 'COMPLETE'].includes(deal.step)) throw new Error('BFMR write outcome is unresolved; do not repeat it.');
        if (!order) orderCaptures.push(captured);
        deal.step = 'ORDER_RECORDED';
      }
    } catch { issues.push(`DEAL_${index + 1}_OUTCOME_REQUIRES_REVIEW`); }
  }
  next.status = next.deals.every(terminalDeal) ? 'COMPLETE' : 'READY';
  validateDealEmailState(next);
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), account: runtime.account, workflowRevision: checkpoint.revision,
    ready: issues.length === 0, issues: [...new Set(issues)], next, cancelledReservationIds, purchaseReadbacks,
    creationNoActionDealIds: [...new Set(creationNoActionDealIds)], orderCaptures };
}

/** Apply only local repairs already substantiated by a fresh provider report.
 * Queue transition, scoped incident resolution and workflow snapshot are atomic.
 */
export async function applyDealEmailReconciliation(runtime: RelationalRuntime, checkpoint: WorkflowCheckpoint,
  report: EmailReconciliationReport, reportSha256: string): Promise<void> {
  const age = Date.now() - Date.parse(report.generatedAt);
  if (!Number.isFinite(age) || !report.ready || report.account !== runtime.account || report.workflowRevision !== checkpoint.revision ||
      age < 0 || age > 5 * 60_000) {
    throw new Error('A fresh, ready report for the exact interrupted workflow is required.');
  }
  await new DealEmailWorkflowStore(runtime.db, runtime.account).applyReviewedRepair(checkpoint, report.next, reportSha256, async tx => {
    const account = await readRelationalAmazonAccount(tx);
    if (account.id !== runtime.retailerAccount.id || account.email !== runtime.retailerAccount.email) throw new Error('Ranked account changed during repair.');
    for (const captured of report.orderCaptures) {
      const reservation = captured.reserveId ? await tx.reservations.findByBfmrId(captured.reserveId) : null;
      const planned = report.next.deals.find(d => d.order?.orderId === captured.orderId);
      if (!reservation || !planned || reservation.quantity !== 1 || planned.reference?.reserveId !== captured.reserveId ||
          numericToCents(reservation.expected_payout) < captured.totalCents) throw new Error('Captured order reservation is not substantiated.');
      const eligibility = await tx.query('SELECT 1 FROM public.deal_retailers WHERE deal_id=$1 AND retailer_id=$2', [reservation.deal_id, account.retailer_id]);
      if (eligibility.rows.length !== 1) throw new Error('Recorded supplier eligibility is missing.');
      const saved = await tx.orders.create({ orderId: captured.orderId, reservationId: reservation.id, dealId: reservation.deal_id,
        retailerId: account.retailer_id, retailerAccountId: account.id, quantity: 1, totalCostCents: captured.totalCents,
        purchaseDate: atlantaDayAndHour(new Date(captured.purchasedAt)).day, productIdentifier: captured.asin, statusId: '1' });
      await tx.evidence.appendObservation({ reservationId: reservation.id, orderId: saved.id, dealId: reservation.deal_id,
        provider: 'AMAZON', resourceType: 'ORDER_CONFIRMATION', observedAt: report.generatedAt, isComplete: true,
        responseData: { orderId: captured.orderId, reserveId: captured.reserveId, dealId: captured.dealId,
          productIdentifier: captured.asin, totalCents: captured.totalCents, report_sha256: reportSha256 } });
      await tx.evidence.appendWorkflow({ reservationId: reservation.id, orderId: saved.id, correlationId: report.next.workflowId,
        actionType: 'AMAZON_ORDER_STATE', phase: 'SNAPSHOT', outcome: 'RECORDED', evidence: encodeAmazonOperationalState(captured) });
    }
    for (const reserveId of report.cancelledReservationIds) {
      const reservation = await tx.reservations.findByBfmrId(reserveId);
      if (!reservation) throw new Error('Cancellation subject disappeared.');
      await tx.reservations.updateStatus(reservation.id, '2');
      await tx.evidence.appendWorkflow({ reservationId: reservation.id, correlationId: report.next.workflowId,
        actionType: 'RESERVATION_CANCELLATION', phase: 'CONFIRMED', outcome: 'EXACT_RELEASE_VERIFIED',
        evidence: { report_sha256: reportSha256, bfmr_reservation_id: reserveId } });
    }
    for (const readback of report.purchaseReadbacks) {
      const reservation = await tx.reservations.findByBfmrId(readback.reserveId);
      const order = reservation ? await tx.orders.findByReservationId(reservation.id) : null;
      const state = order ? await tx.evidence.latestWorkflow('AMAZON_ORDER_STATE', order.id) : null;
      if (!order || order.order_id !== readback.orderId || !state) throw new Error('Purchase local evidence is missing.');
      if (state.evidence.bfmrPurchaseId && state.evidence.bfmrPurchaseId !== readback.purchaseId) throw new Error('Established BFMR purchase identity changed.');
      await tx.evidence.appendWorkflow({ orderId: order.id, reservationId: reservation!.id, correlationId: state.correlation_id,
        actionType: 'AMAZON_ORDER_STATE', phase: 'SNAPSHOT', outcome: 'RECORDED',
        evidence: { ...state.evidence, bfmrPurchaseId: readback.purchaseId } });
    }
    for (const dealId of report.creationNoActionDealIds) await tx.evidence.appendWorkflow({ correlationId: report.next.workflowId,
      actionType: 'RESERVATION_CREATION', phase: 'NO_ACTION', outcome: 'NOT_SUBMITTED',
      evidence: { bfmr_deal_id: dealId, report_sha256: reportSha256 } });
  });
}
