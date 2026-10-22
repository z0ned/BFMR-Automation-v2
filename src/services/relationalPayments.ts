import { createHash, randomUUID } from 'node:crypto';
import type { RelationalDatabase } from '../db/relationalDatabase';
import type { BusinessRepositories } from '../db/relationalRepositories';
import { numericToCents } from '../db/relationalRepositories';
import type { EmailInput, ReimbursementRecord } from '../db/relationalTypes';

/** Supplied only after an authenticated payment-sent notice has been reviewed.
 * A subject, cumulative tracker balance or caller-supplied amount alone is insufficient.
 */
export interface VerifiedPaymentNotice {
  bfmrReservationId: string;
  bfmrDealId: string;
  email: EmailInput;
  amountCents: number;
  paidAt: string;
  paymentReference?: string | null;
  verification: {
    authenticatedGmailApi: true;
    paymentContractValidated: true;
    sourceSha256: string;
    verifiedAt: string;
  };
}

export function validateVerifiedPaymentNotice(value: unknown): VerifiedPaymentNotice {
  const item = value as VerifiedPaymentNotice;
  const time = (x: unknown) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(x) && Number.isFinite(Date.parse(x));
  if (!item || typeof item !== 'object' ||
      typeof item.bfmrReservationId !== 'string' || !item.bfmrReservationId.trim() ||
      typeof item.bfmrDealId !== 'string' || !item.bfmrDealId.trim() ||
      !Number.isSafeInteger(item.amountCents) || item.amountCents < 0 ||
      !time(item.paidAt) || !item.email || typeof item.email.gmailMessageId !== 'string' || !item.email.gmailMessageId ||
      typeof item.email.subject !== 'string' || item.email.emailType !== 'PAYMENT_SENT' || !time(item.email.receivedAt) ||
      (item.paymentReference != null && (typeof item.paymentReference !== 'string' || !item.paymentReference.trim())) ||
      item.verification?.authenticatedGmailApi !== true || item.verification?.paymentContractValidated !== true ||
      !/^[a-f0-9]{64}$/i.test(item.verification.sourceSha256) || !time(item.verification.verifiedAt)) {
    throw new Error('Verified payment notice is incomplete or unsupported; no reimbursement was recorded.');
  }
  return item;
}

/** Inserts an actual payment in the caller's transaction. No cumulative-payment inference. */
export async function recordVerifiedPaymentInTransaction(
  tx: BusinessRepositories, input: VerifiedPaymentNotice,
): Promise<ReimbursementRecord> {
  const notice = validateVerifiedPaymentNotice(input);
  const reservation = await tx.reservations.findByBfmrId(notice.bfmrReservationId);
  const deal = await tx.deals.findByBfmrId(notice.bfmrDealId);
  if (!reservation || !deal || reservation.deal_id !== deal.id) {
    throw new Error('Payment reservation/deal identity does not match the authoritative records.');
  }
  const email = await tx.emails.upsert(notice.email);
  const previous = await tx.reimbursements.findByReservationId(reservation.id);
  const payment = await tx.reimbursements.create({
    reservationId: reservation.id, paymentEmailId: email.id, amountCents: notice.amountCents,
    paidAt: notice.paidAt, paymentReference: notice.paymentReference,
  });
  if (notice.amountCents >= numericToCents(reservation.expected_payout) && reservation.reservation_status_id !== '3') {
    await tx.reservations.updateStatus(reservation.id, '3');
  }
  // Repository equality checks make exact repeats harmless; do not duplicate evidence.
  if (previous) return payment;
  const eventHash = createHash('sha256').update(JSON.stringify({
    reservation: notice.bfmrReservationId, gmailMessageId: notice.email.gmailMessageId,
    amountCents: notice.amountCents, paidAt: new Date(notice.paidAt).toISOString(),
    reference: notice.paymentReference ?? null,
  })).digest('hex');
  await tx.evidence.appendObservation({
    emailId: email.id, dealId: deal.id, reservationId: reservation.id, reimbursementId: payment.id,
    provider: 'BFMR', resourceType: 'PAYMENT_SENT', observedAt: notice.verification.verifiedAt,
    isComplete: true, responseData: {
      amountCents: notice.amountCents, paidAt: notice.paidAt,
      sourceSha256: notice.verification.sourceSha256, authenticatedGmailApi: true,
      paymentContractValidated: true,
    },
  });
  await tx.evidence.appendWorkflow({
    emailId: email.id, reservationId: reservation.id, correlationId: randomUUID(),
    actionType: 'REIMBURSEMENT_RECORDED', phase: 'CONFIRMED', outcome: 'RECORDED',
    evidence: { schemaVersion: 1, paymentEventSha256: eventHash, sourceSha256: notice.verification.sourceSha256 },
  });
  return payment;
}

export async function recordVerifiedPayment(
  db: RelationalDatabase, notice: VerifiedPaymentNotice, account: string,
): Promise<ReimbursementRecord> {
  if (!account.trim()) throw new Error('A verified BFMR account is required.');
  const checked = validateVerifiedPaymentNotice(notice);
  let acceptedAccount = false;
  try { return await db.withTransaction(async tx => {
    const markers = await tx.query<{ evidence: { account?: string } }>(
      `SELECT evidence FROM public.workflow_evidence
       WHERE action_type='RELATIONAL_CUTOVER' AND phase='CONFIRMED' AND outcome='ACCEPTED'`,
    );
    if (markers.rows.length !== 1 || markers.rows[0].evidence.account !== account.trim().toLowerCase()) {
      throw new Error('Relational cutover is not accepted for this account; no reimbursement was recorded.');
    }
    acceptedAccount = true;
    return recordVerifiedPaymentInTransaction(tx, checked);
  }); } catch {
    if (acceptedAccount) {
      try {
        await db.withTransaction(async tx => {
          const reservation = await tx.reservations.findByBfmrId(checked.bfmrReservationId);
          await tx.evidence.appendWorkflow({
            reservationId: reservation?.id, correlationId: randomUUID(), actionType: 'REIMBURSEMENT_RECORDING',
            phase: 'REVIEW', outcome: 'REJECTED', evidence: { schemaVersion: 1,
              sourceSha256: checked.verification.sourceSha256, amountCents: checked.amountCents,
              reasonCode: 'PAYMENT_IDENTITY_OR_RECORDING_CONFLICT' },
          });
        });
      } catch { throw new Error('Payment recording failed and review evidence could not be retained; stop for reconciliation.'); }
    }
    throw new Error('Payment recording was not committed; reconcile the authenticated notice and existing payment before any retry.');
  }
}

export interface TrackingPaymentNoticeInput {
  trackingNumber: string;
  amountCents: number;
  paidAt: string;
  paymentReference?: string | null;
  email: EmailInput;
  sourceSha256: string;
}

export type RecordTrackingPaymentResult =
  | { status: 'RECORDED'; reimbursement: ReimbursementRecord; reservationId: string; orderId: string }
  | { status: 'UNRESOLVED_TRACKING'; trackingNumber: string; emailId: string }
  | { status: 'CONFLICT'; reason: string };

/**
 * Resolves a payment notice through its carrier tracking ID:
 * tracking_number -> shipments -> orders -> reservations -> reimbursements
 */
export async function recordPaymentByTrackingNumber(
  tx: BusinessRepositories,
  input: TrackingPaymentNoticeInput,
): Promise<RecordTrackingPaymentResult> {
  if (!input.trackingNumber || !input.trackingNumber.trim()) {
    return { status: 'CONFLICT', reason: 'Tracking number is required to resolve reservation.' };
  }
  const cleanTracking = input.trackingNumber.trim();
  const shipment = await tx.shipments.findByTrackingNumber(cleanTracking);
  if (!shipment) {
    const email = await tx.emails.upsert(input.email);
    await tx.evidence.appendWorkflow({
      emailId: email.id,
      correlationId: randomUUID(),
      actionType: 'REIMBURSEMENT_RECORDING',
      phase: 'REVIEW',
      outcome: 'UNRESOLVED_PAYMENT_TRACKING',
      evidence: {
        schemaVersion: 1,
        trackingNumber: cleanTracking,
        amountCents: input.amountCents,
        sourceSha256: input.sourceSha256,
        reasonCode: 'TRACKING_NUMBER_NOT_FOUND',
      },
    });
    return { status: 'UNRESOLVED_TRACKING', trackingNumber: cleanTracking, emailId: email.id };
  }

  const order = await tx.orders.findById(shipment.order_id);
  if (!order || !order.reservation_id) {
    return { status: 'CONFLICT', reason: `Shipment ${shipment.id} is not linked to an order with a valid reservation.` };
  }

  const reservation = await tx.reservations.findById(order.reservation_id);
  if (!reservation || !reservation.deal_id) {
    return { status: 'CONFLICT', reason: `Order ${order.id} is not linked to an existing reservation.` };
  }

  const deal = await tx.deals.findById(reservation.deal_id);
  if (!deal) {
    return { status: 'CONFLICT', reason: `Reservation ${reservation.id} is not linked to an existing deal.` };
  }

  const notice: VerifiedPaymentNotice = {
    bfmrReservationId: reservation.bfmr_reservation_id,
    bfmrDealId: deal.bfmr_deal_id,
    email: input.email,
    amountCents: input.amountCents,
    paidAt: input.paidAt,
    paymentReference: input.paymentReference ?? null,
    verification: {
      authenticatedGmailApi: true,
      paymentContractValidated: true,
      sourceSha256: input.sourceSha256,
      verifiedAt: new Date().toISOString(),
    },
  };

  const reimbursement = await recordVerifiedPaymentInTransaction(tx, notice);
  return {
    status: 'RECORDED',
    reimbursement,
    reservationId: reservation.id,
    orderId: order.id,
  };
}
