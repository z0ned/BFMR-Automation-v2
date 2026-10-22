import { randomUUID } from 'node:crypto';
import type { RelationalRuntime } from './relationalRuntime';
import type { ReservationReference } from './amazonEvaluation';
import { readAmazonPurchaseEvidence } from './amazonEvaluation';
import { readRecentReservedRows } from './bfmrTrackerApi';
import { normalizeTrackerReservation } from './relationalTrackerTerms';
import { readCanonicalDealTerms, fetchLiveBfmrDealPayout } from './relationalDealTerms';
import { readRelationalAmazonAccount } from './relationalOrderLedger';
import { assertEmailSinceCutover } from './relationalCutover';

interface TriggerEmail { id: string; subject: string; receivedAt: string; emailType: string }
export interface PreparedRelationalReservation {
  correlationId: string;
  dealId: string;
  deal: { slug: string; title: string; currentPayoutCents: number };
  email?: TriggerEmail;
}

/** Only for adapter results that prove the website action was never attempted. */
export async function recordReservationNotAttempted(runtime: RelationalRuntime, prepared: PreparedRelationalReservation): Promise<void> {
  await runtime.db.withTransaction(tx => tx.evidence.appendWorkflow({ correlationId: prepared.correlationId,
    actionType: 'RESERVATION_CREATION', phase: 'NO_ACTION', outcome: 'NOT_SUBMITTED',
    evidence: { bfmr_deal_id: prepared.dealId } }));
}

/** Persist intent before the provider form action. Deal and reservation rates
 * are independent facts; an email payout is never used as creation evidence.
 */
export async function prepareRelationalReservation(runtime: RelationalRuntime, input: {
  dealUrl: string; dealId: string; title: string; email?: TriggerEmail; correlationId?: string;
}): Promise<PreparedRelationalReservation> {
  if (input.email) assertEmailSinceCutover(runtime.baselineStartsAt, input.email.receivedAt);
  await runtime.verifyRetailerAccount();
  const deal = await readCanonicalDealTerms(input.dealUrl, input.dealId, input.title);
  const correlationId = input.correlationId ?? randomUUID();
  await runtime.db.withTransaction(async tx => {
    const email = input.email ? await tx.emails.upsert({ gmailMessageId: input.email.id,
      subject: input.email.subject, receivedAt: input.email.receivedAt, emailType: input.email.emailType }) : null;
    const saved = await tx.deals.upsert({ bfmrDealId: input.dealId, slug: deal.slug, title: deal.title,
      reimbursementAmountCents: deal.currentPayoutCents });
    if (email) await tx.emails.linkDeal(email.id, saved.id, 'TRIGGER');
    await tx.evidence.appendWorkflow({ emailId: email?.id, correlationId,
      actionType: 'RESERVATION_CREATION', phase: 'INTENT', outcome: null,
      evidence: { bfmr_deal_id: input.dealId, slug: deal.slug, requested_quantity: 1,
        observed_current_deal_rate_cents: deal.currentPayoutCents } });
  });
  return { correlationId, dealId: input.dealId, deal, email: input.email };
}

export async function captureRelationalReservation(runtime: RelationalRuntime, reference: ReservationReference,
  prepared: PreparedRelationalReservation): Promise<void> {
  if (reference.dealId !== prepared.dealId) throw new Error('Confirmed reservation differs from the submitted deal; review required.');
  try {
    const rows = await readRecentReservedRows();
    const matches = rows.filter(row => String(row.reserve_id ?? '').trim() === reference.reserveId);
    if (matches.length !== 1) throw new Error('New reservation creation terms are missing or ambiguous.');
    const terms = normalizeTrackerReservation(matches[0]);
    if (terms.dealId !== reference.dealId || terms.quantity !== 1 || terms.status !== 'reserved' || terms.payoutPerItemCents === null) {
      throw new Error('New reservation identity, status or creation quantity conflicts with confirmation.');
    }
    await runtime.sync.captureConfirmedReservation({ reference, correlationId: prepared.correlationId,
      email: prepared.email, deal: prepared.deal, observedAt: new Date().toISOString(),
      creationTerms: { quantity: terms.quantity, payoutPerItemCents: terms.payoutPerItemCents },
      evidence: { source: 'EXACT_NEW_RESERVATION_CONFIRMATION', contract_validated: true } });
  } catch (error) {
    await runtime.db.withTransaction(async tx => {
      const reservation = await tx.reservations.findByBfmrId(reference.reserveId);
      await tx.evidence.appendWorkflow({ reservationId: reservation?.id, correlationId: prepared.correlationId,
        actionType: 'RESERVATION_CREATION', phase: 'REVIEW', outcome: 'CREATION_CAPTURE_UNRESOLVED',
        evidence: { bfmr_reservation_id: reference.reserveId, bfmr_deal_id: reference.dealId,
          reason: 'AUTHORITATIVE_CREATION_TERMS_REQUIRED' } });
    });
    throw error;
  }
}

/** Failed collection is recorded as a newer incomplete attempt, so exposure
 * cannot fall back to an earlier successful observation after a failed read.
 */
export async function readTrackerWithFailureEvidence(runtime: RelationalRuntime) {
  try { return await readRecentReservedRows(); }
  catch {
    await runtime.sync.reconcile([], { complete: false, accountValidated: false, financialContractValidated: false });
    throw new Error('Complete BFMR collection failed; an incomplete reconciliation attempt was retained.');
  }
}

/** Only called after exact supplier evidence has returned PRESENT. */
export async function recordVerifiedAmazonSupplier(runtime: RelationalRuntime, reference: ReservationReference): Promise<void> {
  await runtime.db.withTransaction(async tx => {
    const reservation = await tx.reservations.findByBfmrId(reference.reserveId);
    const deal = await tx.deals.findByBfmrId(reference.dealId);
    if (!reservation || !deal || reservation.deal_id !== deal.id) throw new Error('Supplier result has no matching stored reservation.');
    const account = await readRelationalAmazonAccount(tx);
    if (account.id !== runtime.retailerAccount.id || account.retailer_id !== runtime.retailerAccount.retailer_id
        || account.email !== runtime.retailerAccount.email) {
      throw new Error('Amazon retailer/account identity changed during this run; review required.');
    }
    await tx.deals.ensureRetailer(deal.id, account.retailer_id);
    await tx.evidence.appendWorkflow({ reservationId: reservation.id, correlationId: randomUUID(),
      actionType: 'SUPPLIER_EVALUATION', phase: 'CONFIRMED', outcome: 'AMAZON_PRESENT',
      evidence: { bfmr_reservation_id: reference.reserveId, bfmr_deal_id: reference.dealId,
        retailer_id: account.retailer_id, exact_supplier_read: true } });
  });
}

/** The cancellation caller has already verified the exact causal release. */
export async function recordConfirmedCancellation(runtime: RelationalRuntime, reference: ReservationReference): Promise<void> {
  await runtime.db.withTransaction(async tx => {
    const reservation = await tx.reservations.findByBfmrId(reference.reserveId);
    const deal = await tx.deals.findByBfmrId(reference.dealId);
    if (!reservation || !deal || reservation.deal_id !== deal.id) throw new Error('Cancellation has no matching stored reservation.');
    await tx.reservations.updateStatus(reservation.id, '2');
    await tx.evidence.appendWorkflow({ reservationId: reservation.id, correlationId: randomUUID(),
      actionType: 'RESERVATION_CANCELLATION', phase: 'CONFIRMED', outcome: 'EXACT_RELEASE_VERIFIED',
      evidence: { bfmr_reservation_id: reference.reserveId, bfmr_deal_id: reference.dealId } });
  });
}

export async function readLockedPurchaseEvidence(
  runtime: RelationalRuntime,
  reference: ReservationReference,
  dependencies: {
    fetchLivePayout?: typeof fetchLiveBfmrDealPayout;
    readAmazonEvidence?: typeof readAmazonPurchaseEvidence;
  } = {},
) {
  const observed = await (dependencies.readAmazonEvidence ?? readAmazonPurchaseEvidence)(reference);
  if (!observed) throw new Error('Live Amazon purchase evidence could not be read.');
  let livePayoutCents: number | null = null;

  await runtime.db.withTransaction(async tx => {
    const reservation = await tx.reservations.findByBfmrId(reference.reserveId);
    if (!reservation) throw new Error('Checkout reservation is missing in database.');
    const deal = await tx.deals.findByBfmrId(reference.dealId);
    if (!deal) throw new Error('Checkout deal is missing in database.');

    try {
      const fetcher = dependencies.fetchLivePayout ?? fetchLiveBfmrDealPayout;
      livePayoutCents = await fetcher(deal.slug);
      await tx.reservations.updatePayout(reservation.id, livePayoutCents);
      await tx.evidence.appendWorkflow({
        reservationId: reservation.id,
        correlationId: randomUUID(),
        actionType: 'CHECKOUT_PAYOUT',
        phase: 'CONFIRMED',
        outcome: 'PAYOUT_REFRESHED',
        evidence: {
          bfmr_reservation_id: reference.reserveId,
          bfmr_deal_id: reference.dealId,
          slug: deal.slug,
          previous_payout_cents: Math.round(Number(reservation.payout_per_item) * 100),
          live_payout_cents: livePayoutCents,
        },
      });
    } catch {
      // Fall back to stored payout if live network call fails
      livePayoutCents = Math.round(Number(reservation.payout_per_item) * 100);
    }
  });

  return { ...observed, payoutCents: livePayoutCents ?? observed.payoutCents };
}
