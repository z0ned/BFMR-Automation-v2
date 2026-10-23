import { environmentPaths } from '../config/environment';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { recordPaymentByTrackingNumber } from './relationalPayments';
import { multiDealJournal } from './multiDealJournal';
import { postReservationJournal } from './postReservationJournal';
import { WorkerActionControl } from './workerActionControl';
import type { PlaywrightBfmrBrowser } from '../adapters/playwrightBrowser';
import type { RelationalRuntime } from './relationalRuntime';
import { assertEmailSinceCutover } from './relationalCutover';
import { authenticateGmailSender, intakeMode } from './emailProvenance';
import { parseBfmrEmail } from './bfmrEmailLinks';
import { reserveEmailDeal } from './emailReservation';
import { readAmazonSupplier } from './amazonEvaluation';
import { readTrackerWithFailureEvidence, readLockedPurchaseEvidence, recordVerifiedAmazonSupplier, recordConfirmedCancellation } from './relationalReservations';
import { readRelationalExposureCents } from './relationalExposure';
import { readRecentReservedRows } from './bfmrTrackerApi';
import { cancelConfirmedReservation } from './reservationCancellation';
import { amazonProductAsin } from './amazonCheckoutRehearsal';
import { purchaseReservedDeal } from './reservedDealPurchase';
import { ensureBfmrPurchase } from './bfmrTrackingSubmission';
import { DealEmailWorkflowStore, terminalDeal, type WorkflowEmail, type DealStep, type DealProgress } from './dealEmailWorkflowStore';

export type ReceivedEmail = WorkflowEmail;
export class WorkflowReviewRequiredError extends Error {
  constructor(readonly workflowId: string) {
    super('Email workflow paused. Reconcile its persisted external-action boundaries before reviewed repair; never replay the message.');
  }
}

/** The same ordered phases serve single- and multi-deal mail. Only the number
 * of announced offers differs. Every external mutation has a durable prior step.
 */
export async function processEmail(email: ReceivedEmail, browser: PlaywrightBfmrBrowser, runtime: RelationalRuntime,
  assertIntakeReady?: () => void | Promise<void>): Promise<void> {
  const actionControl = new WorkerActionControl(runtime.db, runtime.account);
  const guard = async () => {
    if (assertIntakeReady) await assertIntakeReady();
    else await actionControl.assertReady();
    await runtime.ownership.verifyOwnership();
    await runtime.verifyRetailerAccount();
  };
  await guard();
  const localPdf = email.source === 'LOCAL_PDF_TEST';
  if (localPdf ? !/^pdf-[a-f0-9]{64}$/.test(email.id) :
    (!email.inboxAtFetch || !authenticateGmailSender(email.sender, email.headers ?? [], intakeMode(process.env.BFMR_INTAKE_MODE)))) {
    throw new Error('Workflow requires authenticated Gmail provenance or the explicitly invoked local PDF test.');
  }
  if (!localPdf) assertEmailSinceCutover(runtime.baselineStartsAt, email.receivedAt);
  const batch = await multiDealJournal(process.env.BFMR_MULTI_DEAL_STATE_PATH || path.join(environmentPaths().state, 'multi-deal.json')).load();
  const post = await postReservationJournal(process.env.BFMR_POST_RESERVATION_STATE_PATH || path.join(environmentPaths().state, 'post-reservation.json')).load();
  if (batch && batch.stage !== 'COMPLETE' || post && !['KEPT', 'CANCELLED'].includes(post.state)) {
    throw new Error('Legacy batch or post-reservation work is unfinished; preserve/reconcile it before new workflow enrollment.');
  }
  const parsed = parseBfmrEmail({ ...email, messageId: email.id });

  if (parsed.isPaymentNotice && parsed.paymentNotice) {
    const trackingNumbers = parsed.paymentNotice.trackingNumbers;
    const sha256 = createHash('sha256').update(email.body || email.id).digest('hex');

    if (trackingNumbers.length === 0) {
      await runtime.db.withTransaction(async tx => {
        const savedEmail = await tx.emails.upsert({
          gmailMessageId: email.id,
          subject: email.subject,
          emailType: 'PAYMENT_SENT',
          receivedAt: email.receivedAt,
        });
        await tx.evidence.appendWorkflow({
          emailId: savedEmail.id,
          correlationId: randomUUID(),
          actionType: 'REIMBURSEMENT_RECORDING',
          phase: 'REVIEW',
          outcome: 'PAYMENT_WITHOUT_TRACKING',
          evidence: {
            schemaVersion: 1,
            amountCents: parsed.paymentNotice!.amountCents,
            sourceSha256: sha256,
            reasonCode: 'NO_TRACKING_NUMBERS_EXTRACTED',
          },
        });
      });
      return;
    }

    for (const trackingNumber of trackingNumbers) {
      await runtime.db.withTransaction(async tx => {
        await recordPaymentByTrackingNumber(tx, {
          trackingNumber,
          amountCents: parsed.paymentNotice!.amountCents,
          paidAt: parsed.paymentNotice!.paidAt,
          paymentReference: parsed.paymentNotice!.paymentReference,
          email: {
            gmailMessageId: email.id,
            subject: email.subject,
            emailType: 'PAYMENT_SENT',
            receivedAt: email.receivedAt,
          },
          sourceSha256: sha256,
        });
      });
    }
    return;
  }

  if (parsed.isInformationalUpdate) {
    await runtime.db.withTransaction(async tx => {
      const emailRecord = await tx.emails.upsert({
        gmailMessageId: email.id,
        subject: email.subject,
        emailType: parsed.informationalType || 'DEAL_UPDATE',
        receivedAt: email.receivedAt,
      });
      for (const d of parsed.deals) {
        const dealRecord = await tx.deals.findByBfmrId(d.canonicalDealId);
        if (dealRecord) {
          await tx.emails.linkDeal(emailRecord.id, dealRecord.id, parsed.informationalType || 'DEAL_UPDATE');
        }
      }
      await tx.evidence.appendWorkflow({
        emailId: emailRecord.id,
        correlationId: randomUUID(),
        actionType: 'INFORMATIONAL_EMAIL_INGESTION',
        phase: 'CONFIRMED',
        outcome: parsed.informationalType || 'DEAL_UPDATE',
        evidence: {
          schemaVersion: 1,
          subject: email.subject,
          dealsCount: parsed.deals.length,
        },
      });
    });
    return;
  }

  if (!parsed.isSingleDeal && !parsed.isMultiDealAnnouncement) throw new Error('Unsupported new-deal announcement.');
  const store = new DealEmailWorkflowStore(runtime.db, runtime.account);
  let checkpoint = await store.claim(email, parsed.isMultiDealAnnouncement ? 'MULTI_DEAL' : 'SINGLE_DEAL',
    parsed.deals.map(d => d.dealUrl), runtime.retailerAccount.id);
  if (checkpoint.state.status === 'COMPLETE') return; // Confirmation/ACK gap; never backfill purchases.
  const persist = async () => { checkpoint = await store.save(checkpoint, checkpoint.state); };
  const step = async (index: number, next: DealStep, fields: Partial<DealProgress> = {}) => {
    checkpoint.state.deals[index] = { ...checkpoint.state.deals[index], ...fields, step: next };
    await persist();
  };
  const cancel = async (index: number, reason: DealProgress['cancelReason']) => {
    const reference = checkpoint.state.deals[index].reference!;
    await step(index, 'CANCEL_INTENT', { cancelReason: reason });
    await cancelConfirmedReservation(reference, false, { readRows: readRecentReservedRows, request: fetch,
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)), beforeMutation: guard });
    await recordConfirmedCancellation(runtime, reference);
    await step(index, 'CANCELLED');
  };
  try {
    const reconciliation = await runtime.sync.reconcile(await readTrackerWithFailureEvidence(runtime), {
      complete: true, accountValidated: true,
      financialContractValidated: process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED === 'YES',
    });
    if (!reconciliation.promoted) throw new Error('Complete account reconciliation is required.');

    // Reservation barrier: an uncertain member stops before ANY evaluation or
    // checkout. A reviewed continuation skips confirmed/terminal members.
    for (let i = 0; i < parsed.deals.length; i++) {
      if (checkpoint.state.deals[i].step !== 'PENDING') continue;
      await guard();
      await step(i, 'RESERVING');
      const reference = await reserveEmailDeal(browser, parsed.deals[i], runtime,
        localPdf ? undefined : { ...email, emailType: checkpoint.state.messageType }, checkpoint.state.workflowId, guard,
        async dealId => {
          if (checkpoint.state.deals.some((d, n) => n !== i && d.dealId === dealId)) throw new Error('Announced deals resolve to duplicate canonical identity.');
          await step(i, 'RESERVING', { dealId });
        });
      await step(i, reference ? 'RESERVED' : 'SKIPPED', reference ? { dealId: reference.dealId, reference } : {});
    }
    if (checkpoint.state.deals.some(d => ['PENDING', 'RESERVING'].includes(d.step))) throw new Error('Reservation barrier is unresolved.');

    for (let i = 0; i < checkpoint.state.deals.length; i++) {
      const deal = checkpoint.state.deals[i];
      if (deal.step !== 'RESERVED') continue;
      await guard();
      await step(i, 'EVALUATING');
      const supplier = await readAmazonSupplier(deal.reference!);
      if (supplier === 'UNKNOWN') throw new Error('Supplier evidence is unknown.');
      if (supplier === 'ABSENT') await cancel(i, 'SUPPLIER_ABSENT');
      else {
        await recordVerifiedAmazonSupplier(runtime, deal.reference!);
        await step(i, 'ELIGIBLE');
      }
    }
    if (checkpoint.state.deals.some(d => ['RESERVED', 'EVALUATING', 'CANCEL_INTENT'].includes(d.step))) {
      throw new Error('Supplier/cancellation barrier is unresolved.');
    }
    for (let i = 0; i < checkpoint.state.deals.length; i++) {
      let deal = checkpoint.state.deals[i];
      if (terminalDeal(deal)) continue;
      if (deal.step === 'ELIGIBLE') {
        await guard();
        const evidence = await readLockedPurchaseEvidence(runtime, deal.reference!);
        const targetAsin = amazonProductAsin(evidence.productUrl);
        if (!targetAsin) throw new Error('Exact retailer product is missing.');
        await step(i, 'CHECKOUT_PREPARING', { targetAsin });
        const purchase = await purchaseReservedDeal(browser, deal.reference!, evidence.productUrl, evidence.payoutCents,
          async () => {
            const latest = await runtime.sync.reconcile(await readTrackerWithFailureEvidence(runtime), {
              complete: true, accountValidated: true,
              financialContractValidated: process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED === 'YES',
            });
            if (!latest.promoted) throw new Error('Latest full-account payment/exposure evidence is not accepted.');
            return readRelationalExposureCents(runtime.db, deal.reference!);
          }, { expectedAccountEmail: runtime.retailerAccount.email, readPurchaseEvidence: ref => readLockedPurchaseEvidence(runtime, ref),
            beforeMutation: guard,
            beforeSubmit: async checkout => {
              await guard();
              await step(i, 'CHECKOUT_INTENT', { checkout });
              await runtime.db.withTransaction(async tx => {
                const reservation = await tx.reservations.findByBfmrId(deal.reference!.reserveId);
                if (!reservation) throw new Error('Checkout reservation is missing.');
                await tx.evidence.appendWorkflow({ reservationId: reservation.id, correlationId: checkpoint.state.workflowId,
                  actionType: 'AMAZON_CHECKOUT', phase: 'INTENT', evidence: {
                    bfmr_reservation_id: deal.reference!.reserveId, bfmr_deal_id: deal.reference!.dealId } });
              });
              await guard();
            },
          });
        if (purchase.status === 'INELIGIBLE') {
          // Keep cart uncertainty even if BFMR cancellation succeeds.
          checkpoint.state.deals[i].cartNeedsReview = !purchase.cartCleared;
          await cancel(i, 'CHECKOUT_RULE');
          if (!purchase.cartCleared) throw new Error('Rejected retailer cart requires review.');
          continue;
        }
        await step(i, 'ORDER_CONFIRMED', { order: {
          orderId: purchase.orderId, reserveId: deal.reference!.reserveId, dealId: deal.reference!.dealId,
          asin: purchase.asin, totalCents: purchase.totalCents, purchasedAt: new Date().toISOString(), status: 'PENDING', packages: [],
        } });
        deal = checkpoint.state.deals[i];
      }
      if (deal.step === 'ORDER_CONFIRMED') {
        // Only local SQL persistence; authoritative causal order identity is
        // already captured. Reviewed repair may return to this exact boundary.
        await runtime.ledger.add(deal.order!);
        await step(i, 'ORDER_RECORDED');
        deal = checkpoint.state.deals[i];
      }
      if (deal.step === 'ORDER_RECORDED') {
        await guard();
        await step(i, 'PURCHASE_UPDATE_INTENT');
        await ensureBfmrPurchase(deal.order!.orderId, runtime.ledger, { beforeMutation: guard });
        await step(i, 'COMPLETE');
      }
      if (!terminalDeal(checkpoint.state.deals[i])) throw new Error('External action requires reconciliation, not another invocation.');
    }
    checkpoint.state.status = 'COMPLETE';
    await persist();
  } catch {
    // A failing final snapshot must not erase the last successful durable
    // intent. The review error still scopes the incident to this workflow.
    try { checkpoint.state.status = 'PAUSED'; await persist(); } catch { /* Durable prior snapshot remains authoritative. */ }
    throw new WorkflowReviewRequiredError(checkpoint.state.workflowId);
  }
}
