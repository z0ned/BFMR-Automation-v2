import { randomUUID } from 'node:crypto';
import type { RelationalDatabase } from '../db/relationalDatabase';
import { BusinessConflictError, type BusinessRepositories } from '../db/relationalRepositories';
import type { JsonObject, ReservationRecord } from '../db/relationalTypes';
import type { ReservationReference } from './amazonEvaluation';
import type { TrackerReservationRow } from './bfmrTrackerApi';
import { normalizeTrackerReservation, trackerIdentifier, usdToCents, type TrackerFinancialObservation } from './relationalTrackerTerms';

export const BFMR_FULL_SYNC_SCOPE = 'BFMR_MY_TRACKER_FULL';
export const BFMR_RESERVATION_RESOURCE = 'RESERVATION_FINANCIAL_STATUS';

export interface ConfirmedReservationCapture {
  correlationId?: string;
  reference: ReservationReference;
  email?: { id: string; subject: string; receivedAt: string; emailType?: string } | null;
  deal: { slug: string; title: string; currentPayoutCents: number };
  creationTerms: { quantity: number; payoutPerItemCents: number };
  observedAt: string;
  /** Selected validated provenance only; never raw provider pages or email bodies. */
  evidence?: JsonObject;
}

export interface ReconciliationMetadata {
  observedAt?: string;
  complete: boolean;
  accountValidated: boolean;
  financialContractValidated: boolean;
}

export interface ReconciliationResult { runId: string; promoted: boolean; issues: string[] }

export class ReservationReviewRequiredError extends Error {
  constructor(public readonly issues: string[], public readonly runId?: string) {
    super('Reservation data requires reconciliation review; no automatic retry is permitted.');
    this.name = 'ReservationReviewRequiredError';
  }
}

function timestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Observation timestamp is invalid.');
  return new Date(value).toISOString();
}

function safeCents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Money must be nonnegative integer cents.');
  return value;
}

function isFinancialConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; name?: unknown };
  return value.code === '23514' || value.name === 'BusinessConflictError';
}

/** Preserve useful conflicting amounts without retaining arbitrary raw API content. */
function reviewObservation(row: TrackerReservationRow): JsonObject {
  const selected: JsonObject = {};
  for (const field of ['reserve_id', 'deal_id']) {
    try { selected[field] = trackerIdentifier(row[field]); } catch { selected[field] = null; }
  }
  for (const field of ['qty', 'quantity']) if (row[field] !== undefined && row[field] !== null) {
    const amount = typeof row[field] === 'number' || typeof row[field] === 'string' ? Number(row[field]) : NaN;
    selected[field] = Number.isSafeInteger(amount) && amount > 0 ? amount : 'INVALID';
  }
  for (const field of ['expected_payout', 'payout_total', 'total_payout', 'payout_amount', 'payout_price', 'payout', 'amount_paid']) {
    if (row[field] === undefined || row[field] === null) continue;
    try { selected[`${field}_cents`] = usdToCents(row[field]); } catch { selected[`${field}_cents`] = 'INVALID'; }
  }
  for (const field of ['status', 'item_status', 'reservation_status']) if (row[field] !== undefined && row[field] !== null) {
    const value = row[field];
    selected[field] = typeof value === 'string' && /^[A-Za-z _-]{1,80}$/.test(value) ? value.trim().toLowerCase() : 'INVALID';
  }
  for (const field of ['purchase_id', 'shipment_id', 'order_no', 'tracking_number']) {
    const value = row[field];
    if (value === undefined || value === null || value === '') continue;
    selected[field] = typeof value === 'string' && value.length <= 256 && !value.includes('\0') ? value.trim() :
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : 'INVALID';
  }
  return selected;
}

const purchaseStages = new Set(['purchased', 'ordered']);
const shipmentStages = new Set(['shipped', 'delivered', 'pkg received', 'processed', 'tracking submitted', 'payout pending', 'paid']);

function optionalStoredIdentity(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\0')) {
    throw new Error('Stored provider identity evidence is invalid.');
  }
  return value.trim();
}

/** Provider associations are checked before any row is promoted. A retailer
 * shipment may exist before its BFMR submission, so missing BFMR shipment IDs
 * at Reserved/Purchased are allowed until shipment confirmation is established.
 */
async function providerOrderIssues(tx: BusinessRepositories, reservation: ReservationRecord,
  observed: TrackerFinancialObservation): Promise<string[]> {
  const issues: string[] = [];
  const order = await tx.orders.findByReservationId(reservation.id);
  const hasAssociation = Boolean(observed.orderNo || observed.purchaseId || observed.shipmentId || observed.trackingNumber);
  const isShipmentStage = shipmentStages.has(observed.status);
  const isPurchaseStage = purchaseStages.has(observed.status) || isShipmentStage;
  if (!order) {
    // A substantiated payment may belong directly to a reservation with no
    // retailer order. The caller separately requires verified payment coverage
    // for Paid; absent order references must not invent a missing order.
    if (hasAssociation || (isPurchaseStage && observed.status !== 'paid')) issues.push('PROVIDER_ORDER_REQUIRES_LOCAL_RECONCILIATION');
    return issues;
  }
  const shipment = await tx.shipments.findByOrderId(order.id);
  if (observed.orderNo !== null && observed.orderNo !== order.order_id) issues.push('RETAILER_ORDER_IDENTITY_CONFLICT');
  if (isPurchaseStage && (observed.orderNo !== order.order_id || !observed.purchaseId)) {
    issues.push('PROVIDER_PURCHASE_IDENTITY_INCOMPLETE');
  }
  if (observed.purchaseId && observed.orderNo !== order.order_id) issues.push('PROVIDER_PURCHASE_ORDER_MISMATCH');
  if (isShipmentStage || observed.shipmentId || observed.trackingNumber) {
    if (!observed.purchaseId || observed.orderNo !== order.order_id || !observed.shipmentId || !observed.trackingNumber) {
      issues.push('PROVIDER_SHIPMENT_IDENTITY_INCOMPLETE');
    }
    if (!shipment || !observed.trackingNumber ||
        observed.trackingNumber.toUpperCase() !== shipment.tracking_number.toUpperCase()) {
      issues.push('PROVIDER_TRACKING_IDENTITY_CONFLICT');
    }
  }
  // Once accepted, provider IDs cannot disappear/change in a later full read.
  // Only successfully promoted observations bind identity; rejected evidence
  // must never become the expected value for the next attempt.
  const snapshot = await tx.evidence.latestWorkflow('AMAZON_ORDER_STATE', order.id);
  const previous = await tx.query<{ response_data: JsonObject }>(`SELECT response_data FROM public.provider_observations
    WHERE reservation_id=$1 AND provider='BFMR' AND resource_type=$2 AND is_complete
    ORDER BY observed_at DESC,id DESC LIMIT 1`, [reservation.id, BFMR_RESERVATION_RESOURCE]);
  try {
    const state = snapshot?.evidence;
    const official = state?.bfmrOfficial && typeof state.bfmrOfficial === 'object' && !Array.isArray(state.bfmrOfficial)
      ? state.bfmrOfficial : null;
    const prior = previous.rows[0]?.response_data;
    const purchases = [state?.bfmrPurchaseId, official?.purchaseId, prior?.bfmr_purchase_id].map(optionalStoredIdentity).filter(Boolean);
    const shipments = [state?.bfmrShipmentId, official?.shipmentId, prior?.bfmr_shipment_id].map(optionalStoredIdentity).filter(Boolean);
    if (new Set(purchases).size > 1 || new Set(shipments).size > 1) issues.push('STORED_PROVIDER_IDENTITY_CONFLICT');
    if (purchases.length && purchases[0] !== observed.purchaseId) issues.push('BFMR_PURCHASE_IDENTITY_CONFLICT');
    if (shipments.length && shipments[0] !== observed.shipmentId) issues.push('BFMR_SHIPMENT_IDENTITY_CONFLICT');
    const priorOrderNo = optionalStoredIdentity(prior?.retailer_order_number);
    const priorTracking = optionalStoredIdentity(prior?.tracking_number);
    if (priorOrderNo && observed.orderNo !== priorOrderNo) issues.push('RETAILER_ORDER_IDENTITY_CONFLICT');
    if (priorTracking && (!observed.trackingNumber || priorTracking.toUpperCase() !== observed.trackingNumber.toUpperCase())) {
      issues.push('PROVIDER_TRACKING_IDENTITY_CONFLICT');
    }
  } catch { issues.push('STORED_PROVIDER_IDENTITY_EVIDENCE_INVALID'); }
  return issues;
}

/** No network or provider effects occur inside these transactions. */
export class BfmrRelationalSync {
  constructor(private readonly db: RelationalDatabase) {}

  async captureConfirmedReservation(input: ConfirmedReservationCapture): Promise<ReservationRecord> {
    const reserveId = trackerIdentifier(input.reference.reserveId);
    const dealId = trackerIdentifier(input.reference.dealId);
    const observedAt = timestamp(input.observedAt);
    const { quantity, payoutPerItemCents } = input.creationTerms;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Creation quantity is invalid.');
    safeCents(payoutPerItemCents);
    safeCents(input.deal.currentPayoutCents);
    if (!Number.isSafeInteger(quantity * payoutPerItemCents)) throw new Error('Creation payout exceeds the safe cents range.');
    const correlationId = input.correlationId ?? randomUUID();
    try {
      return await this.db.withTransaction(async tx => {
        const existing = await tx.reservations.findByBfmrId(reserveId);
        const email = input.email ? await tx.emails.upsert({ gmailMessageId: input.email.id, subject: input.email.subject,
          receivedAt: timestamp(input.email.receivedAt), emailType: input.email.emailType ?? 'NEW_DEAL' }) : null;
        // A repeated creation confirmation is historical evidence. It must not
        // revert a deal's newer current terms to the earlier observed snapshot.
        const deal = existing ? await tx.deals.findByBfmrId(dealId) : await tx.deals.upsert({
          bfmrDealId: dealId, slug: input.deal.slug, title: input.deal.title,
          reimbursementAmountCents: input.deal.currentPayoutCents });
        if (!deal) throw new BusinessConflictError('Creation confirmation conflicts with the stored deal identity.');
        if (email) await tx.emails.linkDeal(email.id, deal.id, 'TRIGGER');
        const reservation = await tx.reservations.create({ bfmrReservationId: reserveId, dealId: deal.id,
          sourceEmailId: email?.id ?? null, quantity, payoutPerItemCents, reservationStatusId: '1' });
        const evidence: JsonObject = { ...input.evidence,
          bfmr_reservation_id: reserveId, bfmr_deal_id: dealId, quantity,
          payout_per_item_cents: payoutPerItemCents, expected_payout_cents: quantity * payoutPerItemCents,
          creation_terms_observed: true };
        await tx.evidence.appendObservation({ emailId: email?.id, dealId: deal.id, reservationId: reservation.id,
          provider: 'BFMR', resourceType: 'RESERVATION_CREATION_TERMS', observedAt, isComplete: true,
          responseData: evidence });
        await tx.evidence.appendWorkflow({ emailId: email?.id, reservationId: reservation.id, correlationId,
          actionType: 'RESERVATION_CREATION', phase: 'CONFIRMED', outcome: 'CAPTURED', evidence,
          recordedAt: observedAt });
        return reservation;
      });
    } catch (error) {
      if (!isFinancialConflict(error)) throw error;
      // This is a new evidence transaction, not a retry of the rejected upsert.
      await this.db.withTransaction(async tx => {
        const reservation = await tx.reservations.findByBfmrId(reserveId);
        const evidence: JsonObject = { bfmr_reservation_id: reserveId, bfmr_deal_id: dealId,
          observed_quantity: quantity, observed_payout_per_item_cents: payoutPerItemCents,
          reason: 'CREATION_TERMS_CONFLICT' };
        await tx.evidence.appendObservation({ reservationId: reservation?.id, provider: 'BFMR',
          resourceType: 'RESERVATION_CREATION_CONFLICT', observedAt, isComplete: false, responseData: evidence });
        await tx.evidence.appendWorkflow({ reservationId: reservation?.id, correlationId,
          actionType: 'RESERVATION_CREATION', phase: 'REVIEW', outcome: 'IMMUTABLE_TERMS_CONFLICT', evidence });
      });
      throw new ReservationReviewRequiredError(['CREATION_TERMS_CONFLICT']);
    }
  }

  async readLockedPayoutCents(reference: ReservationReference): Promise<number> {
    return this.db.withTransaction(async tx => {
      const reservation = await tx.reservations.findByBfmrId(reference.reserveId);
      const deal = await tx.deals.findByBfmrId(reference.dealId);
      if (!reservation || !deal || reservation.deal_id !== deal.id) {
        throw new ReservationReviewRequiredError(['RESERVATION_DEAL_IDENTITY_MISMATCH']);
      }
      return usdToCents(reservation.expected_payout);
    });
  }

  async reconcile(rows: TrackerReservationRow[], metadata: ReconciliationMetadata): Promise<ReconciliationResult> {
    const observedAt = timestamp(metadata.observedAt ?? new Date().toISOString());
    const issues: string[] = [];
    if (!metadata.complete) issues.push('PROVIDER_READ_INCOMPLETE');
    if (!metadata.accountValidated) issues.push('PROVIDER_ACCOUNT_UNVALIDATED');
    if (!metadata.financialContractValidated) issues.push('PROVIDER_FINANCIAL_CONTRACT_UNVALIDATED');
    const normalized: Array<TrackerFinancialObservation | null> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      try {
        const value = normalizeTrackerReservation(row);
        if (seen.has(value.reserveId)) issues.push('DUPLICATE_PROVIDER_RESERVATION');
        seen.add(value.reserveId);
        normalized.push(value);
      } catch { normalized.push(null); issues.push('INVALID_PROVIDER_RESERVATION'); }
    }
    const correlationId = randomUUID();
    try {
      return await this.db.withTransaction(async tx => {
        const run = await tx.syncRuns.start({ provider: 'BFMR', scope: BFMR_FULL_SYNC_SCOPE, startedAt: observedAt });
        const known = await tx.reservations.list();
        const knownByProviderId = new Map(known.map(value => [value.bfmr_reservation_id, value]));
        const statusChanges: Array<{ reservation: ReservationRecord; statusId: string }> = [];
        for (const value of known) if (!seen.has(value.bfmr_reservation_id)) issues.push('KNOWN_RESERVATION_MISSING_FROM_PROVIDER');
        for (const observation of normalized) {
          if (!observation) continue;
          const current = knownByProviderId.get(observation.reserveId);
          if (!current) { issues.push('LEGACY_RESERVATION_REQUIRES_CREATION_EVIDENCE'); continue; }
          const deal = await tx.deals.findByBfmrId(observation.dealId);
          if (!deal || current.deal_id !== deal.id) issues.push('RESERVATION_DEAL_IDENTITY_MISMATCH');
          if (current.quantity !== observation.quantity || usdToCents(current.expected_payout) !== observation.expectedPayoutCents ||
            (observation.payoutPerItemCents !== null && usdToCents(current.payout_per_item) !== observation.payoutPerItemCents)) {
            issues.push('LOCKED_RESERVATION_PAYOUT_CONFLICT');
          }
          const payment = await tx.reimbursements.findByReservationId(current.id);
          const paidCents = payment ? usdToCents(payment.amount) : 0;
          if (observation.amountPaidCents === null) issues.push('PAYMENT_COVERAGE_UNKNOWN');
          else if (observation.amountPaidCents !== paidCents) issues.push('PAYMENT_EVIDENCE_MISMATCH');
          const fullyReimbursed = Boolean(payment) && paidCents >= usdToCents(current.expected_payout);
          if (observation.status === 'paid' && !fullyReimbursed) issues.push('PAID_STATUS_WITHOUT_VERIFIED_PAYMENT');
          issues.push(...await providerOrderIssues(tx, current, observation));
          const canceled = ['cancelled', 'canceled', 'released', 'expired'].includes(observation.status);
          if (canceled) {
            const orders = await tx.query('SELECT id FROM public.orders WHERE reservation_id = $1', [current.id]);
            if (orders.rows.length && !fullyReimbursed) issues.push('CANCELED_RESERVATION_HAS_UNREIMBURSED_ORDER');
          }
          statusChanges.push({ reservation: current, statusId: fullyReimbursed ? '3' : canceled ? '2' : '1' });
        }
        const uniqueIssues = [...new Set(issues)];
        const promoted = uniqueIssues.length === 0;
        // Observations and review evidence are committed even when promotion is blocked.
        for (let index = 0; index < rows.length; index++) {
          const observation = normalized[index];
          const current = observation ? knownByProviderId.get(observation.reserveId) : undefined;
          const order = current ? await tx.orders.findByReservationId(current.id) : null;
          const shipment = order ? await tx.shipments.findByOrderId(order.id) : null;
          await tx.evidence.appendObservation({ reservationId: current?.id, dealId: current?.deal_id,
            orderId: order?.id, shipmentId: shipment?.id,
            syncRunId: run.id, provider: 'BFMR', resourceType: BFMR_RESERVATION_RESOURCE,
            observedAt, isComplete: promoted,
            responseData: observation ? observation.evidence : reviewObservation(rows[index]) });
        }
        if (promoted) for (const change of statusChanges) await tx.reservations.updateStatus(change.reservation.id, change.statusId);
        await tx.evidence.appendWorkflow({ correlationId, actionType: BFMR_FULL_SYNC_SCOPE,
          phase: promoted ? 'RECONCILED' : 'REVIEW', outcome: promoted ? 'COMPLETED' : 'BLOCKED',
          evidence: { sync_run_id: run.id, issues: uniqueIssues, records_received: rows.length }, recordedAt: observedAt });
        await tx.syncRuns.finish(run.id, { status: promoted ? 'COMPLETED' : metadata.complete ? 'FAILED' : 'INCOMPLETE',
          recordsReceived: rows.length, errorMessage: promoted ? null : uniqueIssues.join(', ') });
        return { runId: run.id, promoted, issues: uniqueIssues };
      });
    } catch (error) {
      if (!isFinancialConflict(error)) throw error;
      const result = await this.recordRejectedWrite(rows, normalized, observedAt, correlationId);
      throw new ReservationReviewRequiredError(result.issues, result.runId);
    }
  }

  private async recordRejectedWrite(rows: TrackerReservationRow[], normalized: Array<TrackerFinancialObservation | null>,
    observedAt: string, correlationId: string): Promise<ReconciliationResult> {
    return this.db.withTransaction(async (tx: BusinessRepositories) => {
      const run = await tx.syncRuns.start({ provider: 'BFMR', scope: BFMR_FULL_SYNC_SCOPE, startedAt: observedAt });
      for (let index = 0; index < rows.length; index++) {
        const observation = normalized[index];
        const reservation = observation ? await tx.reservations.findByBfmrId(observation.reserveId) : null;
        const order = reservation ? await tx.orders.findByReservationId(reservation.id) : null;
        const shipment = order ? await tx.shipments.findByOrderId(order.id) : null;
        await tx.evidence.appendObservation({ reservationId: reservation?.id, dealId: reservation?.deal_id,
          orderId: order?.id, shipmentId: shipment?.id,
          syncRunId: run.id, provider: 'BFMR', resourceType: BFMR_RESERVATION_RESOURCE, observedAt,
          isComplete: false, responseData: observation ? observation.evidence : reviewObservation(rows[index]) });
      }
      const issues = ['DATABASE_REJECTED_AUTHORITATIVE_WRITE'];
      await tx.evidence.appendWorkflow({ correlationId, actionType: BFMR_FULL_SYNC_SCOPE, phase: 'REVIEW',
        outcome: 'DATABASE_REJECTED', evidence: { sync_run_id: run.id, issues } });
      await tx.syncRuns.finish(run.id, { status: 'FAILED', recordsReceived: rows.length, errorMessage: issues[0] });
      return { runId: run.id, promoted: false, issues };
    });
  }
}
