import { environmentPaths } from '../config/environment';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { recordPaymentByTrackingNumber } from './relationalPayments';
import { multiDealJournal } from './multiDealJournal';
import { postReservationJournal } from './postReservationJournal';
import { WorkerActionControl } from './workerActionControl';
import type { PlaywrightBfmrBrowser } from '../adapters/playwrightBrowser';
import type { ProviderBundle, IBfmrBrowser, IBfmrApi } from '../providers/interfaces';
import { LiveBfmrBrowser } from '../providers/live/liveBfmrBrowser';
import { LiveBfmrApi } from '../providers/live/liveBfmrApi';
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

async function readSimulationAmazonSupplier(bundle: ProviderBundle, dealUrl: string,
  reference: { reserveId: string; dealId: string }): Promise<'PRESENT' | 'ABSENT' | 'UNKNOWN'> {
  try {
    const reservation = await bundle.bfmrApi.inspectReservations(reference.dealId, '', 'CONFIRMATION');
    if (reservation.status !== 'CONFIRMED' || reservation.reference?.reserveId !== reference.reserveId ||
        reservation.reference.dealId !== reference.dealId) return 'UNKNOWN';
    const slug = new URL(dealUrl).pathname.split('/').filter(Boolean).at(-1);
    if (!slug || !bundle.bfmrApi.getDeal) return 'UNKNOWN';
    const deal = await bundle.bfmrApi.getDeal(slug);
    if (!deal || deal.dealId !== reference.dealId) return 'UNKNOWN';
    const amazonLinks = (deal.retailers ?? []).filter(link => /^amazon(?:\.com)?$/i.test(link.retailerName.trim()));
    if (amazonLinks.length === 0) return 'ABSENT';
    if (amazonLinks.length !== 1) return 'UNKNOWN';
    const product = await bundle.amazon.readSupplier(amazonLinks[0].productUrl);
    const urlAsin = amazonProductAsin(amazonLinks[0].productUrl);
    if (!product.asin || product.asin !== urlAsin) return 'UNKNOWN';
    return product.available ? 'PRESENT' : 'ABSENT';
  } catch {
    return 'UNKNOWN';
  }
}

async function readSimulationPurchaseEvidence(bundle: ProviderBundle, runtime: RelationalRuntime,
  reference: { reserveId: string; dealId: string }) {
  if (!bundle.bfmrApi.getDeal) throw new Error('Simulated BFMR deal details are unsupported.');
  const identity = await runtime.db.withTransaction(async tx => {
    const reservation = await tx.reservations.findByBfmrId(reference.reserveId);
    const deal = await tx.deals.findByBfmrId(reference.dealId);
    if (!reservation || !deal || reservation.deal_id !== deal.id) throw new Error('Simulation purchase lacks exact reservation/deal state.');
    return { reservation, deal };
  });
  const detail = await bundle.bfmrApi.getDeal(identity.deal.slug);
  if (!detail || detail.dealId !== reference.dealId) throw new Error('Simulated BFMR deal identity is missing or mismatched.');
  const amazonLinks = (detail.retailers ?? []).filter(link => /^amazon(?:\.com)?$/i.test(link.retailerName.trim()));
  if (amazonLinks.length !== 1) throw new Error('Simulated BFMR Amazon product evidence is missing or ambiguous.');
  const productUrl = amazonLinks[0].productUrl;
  const product = await bundle.amazon.readSupplier(productUrl);
  if (!product.available || product.asin !== amazonProductAsin(productUrl)) {
    throw new Error('Simulated Amazon product is unavailable or mismatched.');
  }
  return { productUrl, payoutCents: detail.payoutPriceCents };
}

export class WorkflowReviewRequiredError extends Error {
  constructor(readonly workflowId: string, readonly causeError?: unknown) {
    super('Email workflow paused. Reconcile its persisted external-action boundaries before reviewed repair; never replay the message.');
  }
}

/** The same ordered phases serve single- and multi-deal mail. Only the number
 * of announced offers differs. Every external mutation has a durable prior step.
 */
export async function processEmail(
  email: ReceivedEmail,
  browserOrBundle: PlaywrightBfmrBrowser | ProviderBundle,
  runtime: RelationalRuntime,
  assertIntakeReady?: () => void | Promise<void>
): Promise<void> {
  const isBundle = typeof browserOrBundle === 'object' && browserOrBundle !== null && 'bfmrBrowser' in browserOrBundle;
  const bundle = isBundle ? (browserOrBundle as ProviderBundle) : undefined;
  const bfmrBrowser: IBfmrBrowser = bundle ? bundle.bfmrBrowser : new LiveBfmrBrowser(browserOrBundle as PlaywrightBfmrBrowser);
  const bfmrApi: IBfmrApi = bundle ? bundle.bfmrApi : new LiveBfmrApi();
  const playwrightBrowser: PlaywrightBfmrBrowser = bundle
    ? ('getUnderlyingBrowser' in (bundle.bfmrBrowser as any) && typeof (bundle.bfmrBrowser as any).getUnderlyingBrowser === 'function'
      ? (bundle.bfmrBrowser as any).getUnderlyingBrowser()
      : (bundle.bfmrBrowser as any))
    : (browserOrBundle as PlaywrightBfmrBrowser);

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
  const batch = bundle?.mode === 'simulation' ? null :
    await multiDealJournal(process.env.BFMR_MULTI_DEAL_STATE_PATH || path.join(environmentPaths().state, 'multi-deal.json')).load();
  const post = bundle?.mode === 'simulation' ? null :
    await postReservationJournal(process.env.BFMR_POST_RESERVATION_STATE_PATH || path.join(environmentPaths().state, 'post-reservation.json')).load();
  if (batch && batch.stage !== 'COMPLETE' || post && !['KEPT', 'CANCELLED'].includes(post.state)) {
    throw new Error('Legacy batch or post-reservation work is unfinished; preserve/reconcile it before new workflow enrollment.');
  }
  const parsed = parseBfmrEmail({ ...email, messageId: email.id });

  if (bundle?.mode === 'simulation' && ![1, 2].includes(bundle.simulationScenario?.phase ?? 1)) {
    throw new Error(`Simulation phase ${bundle.simulationScenario?.phase} is unsupported; no provider action was attempted.`);
  }

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
    parsed.deals.map(d => d.dealUrl), runtime.retailerAccount.id, bundle?.mode === 'simulation');
  if (checkpoint.state.status === 'COMPLETE') return; // Confirmation/ACK gap; never backfill purchases.
  const persist = async () => { checkpoint = await store.save(checkpoint, checkpoint.state); };
  const step = async (index: number, next: DealStep, fields: Partial<DealProgress> = {}) => {
    checkpoint.state.deals[index] = { ...checkpoint.state.deals[index], ...fields, step: next };
    await persist();
  };
  const cancel = async (index: number, reason: DealProgress['cancelReason']) => {
    const reference = checkpoint.state.deals[index].reference!;
    if (bundle?.mode === 'simulation' && bundle.simulationScenario?.phase === 2) {
      await step(index, 'CANCELLATION_REQUIRED', { cancelReason: reason });
      throw new Error('Phase 2 requires cancellation, which is not implemented yet. No BFMR cancellation was attempted.');
    }
    await step(index, 'CANCEL_INTENT', { cancelReason: reason });
    await cancelConfirmedReservation(reference, false, { readRows: readRecentReservedRows, request: fetch,
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)), beforeMutation: guard });
    await recordConfirmedCancellation(runtime, reference);
    await step(index, 'CANCELLED');
  };
  try {
    const trackerRows = await readTrackerWithFailureEvidence(runtime, bfmrApi);
    const reconciliation = await runtime.sync.reconcile(trackerRows as any, {
      complete: true, accountValidated: true,
      financialContractValidated: process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED === 'YES' || process.env.BFMR_PROVIDER_MODE === 'simulation',
    });
    if (!reconciliation.promoted) throw new Error('Complete account reconciliation is required.');

    // Reservation barrier: an uncertain member stops before ANY evaluation or
    // checkout. A reviewed continuation skips confirmed/terminal members.
    for (let i = 0; i < parsed.deals.length; i++) {
      if (checkpoint.state.deals[i].step !== 'PENDING') continue;
      if (bundle?.mode === 'simulation' && bundle.simulationScenario?.phase === 2 &&
          bundle.simulationScenario.purchaseStart === 'SEEDED_RESERVATION') {
        const seeded = bundle.simulationScenario.seededReservation;
        if (!seeded || parsed.deals.length !== 1) throw new Error('Seeded purchase run is missing its exact reservation or has multiple offers.');
        const resolvedDealId = await bfmrApi.resolveDealId(parsed.deals[i].dealUrl);
        if (resolvedDealId !== seeded.dealId) throw new Error('Seeded reservation does not match the synthetic email deal identity.');
        const exact = await bfmrApi.inspectReservations(seeded.dealId, '', 'CONFIRMATION');
        if (exact.status !== 'CONFIRMED' || exact.reference?.reserveId !== seeded.reserveId ||
            exact.reference.dealId !== seeded.dealId) throw new Error('Seeded reservation lacks exact simulated provider confirmation.');
        await step(i, 'RESERVED', { dealId: seeded.dealId, reference: exact.reference });
        continue;
      }
      await guard();
      await step(i, 'RESERVING');
      const reference = await reserveEmailDeal(bfmrBrowser, parsed.deals[i], runtime,
        localPdf ? undefined : { ...email, emailType: checkpoint.state.messageType }, checkpoint.state.workflowId, guard,
        async dealId => {
          if (checkpoint.state.deals.some((d, n) => n !== i && d.dealId === dealId)) throw new Error('Announced deals resolve to duplicate canonical identity.');
          await step(i, 'RESERVING', { dealId });
        }, bfmrApi);
      await step(i, reference ? 'RESERVED' : 'SKIPPED', reference ? { dealId: reference.dealId, reference } : {});
    }
    if (checkpoint.state.deals.some(d => ['PENDING', 'RESERVING'].includes(d.step))) throw new Error('Reservation barrier is unresolved.');

    if (bundle?.mode === 'simulation' && bundle.simulationScenario?.phase === 1) {
      // Phase 1 scope: Reservation barrier established and captured.
      // Subsequent checkout and tracking phases are gated to Phase 2/3.
      checkpoint.state.status = 'COMPLETE';
      await persist();
      return;
    }

    for (let i = 0; i < checkpoint.state.deals.length; i++) {
      const deal = checkpoint.state.deals[i];
      if (deal.step !== 'RESERVED') continue;
      await guard();
      await step(i, 'EVALUATING');
      const supplier = bundle?.mode === 'simulation'
        ? await readSimulationAmazonSupplier(bundle, deal.dealUrl, deal.reference!)
        : await readAmazonSupplier(deal.reference!);
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
        const evidence = bundle?.mode === 'simulation'
          ? await readLockedPurchaseEvidence(runtime, deal.reference!, {
            readAmazonEvidence: ref => readSimulationPurchaseEvidence(bundle, runtime, ref),
            fetchLivePayout: async slug => {
              const detail = await bundle.bfmrApi.getDeal?.(slug);
              if (!detail || detail.dealId !== deal.reference!.dealId) throw new Error('Simulated BFMR deal payout evidence is unavailable.');
              return detail.payoutPriceCents;
            },
          })
          : await readLockedPurchaseEvidence(runtime, deal.reference!);
        const targetAsin = amazonProductAsin(evidence.productUrl);
        if (!targetAsin) throw new Error('Exact retailer product is missing.');
        await step(i, 'CHECKOUT_PREPARING', { targetAsin });
        const purchase = await purchaseReservedDeal(bundle?.mode === 'simulation' ? undefined : playwrightBrowser,
          deal.reference!, evidence.productUrl, evidence.payoutCents,
          async () => {
            const latest = await runtime.sync.reconcile(await readTrackerWithFailureEvidence(runtime, bfmrApi), {
              complete: true, accountValidated: true,
              financialContractValidated: process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED === 'YES',
            });
            if (!latest.promoted) throw new Error('Latest full-account payment/exposure evidence is not accepted.');
            return readRelationalExposureCents(runtime.db, deal.reference!);
          }, { expectedAccountEmail: runtime.retailerAccount.email,
            amazonProvider: bundle?.mode === 'simulation' ? bundle.amazon : undefined,
            clock: bundle?.mode === 'simulation' ? bundle.clock : undefined,
            readPurchaseEvidence: ref => bundle?.mode === 'simulation'
              ? readLockedPurchaseEvidence(runtime, ref, {
                readAmazonEvidence: evidenceRef => readSimulationPurchaseEvidence(bundle, runtime, evidenceRef),
                fetchLivePayout: async slug => {
                  const detail = await bundle.bfmrApi.getDeal?.(slug);
                  if (!detail || detail.dealId !== ref.dealId) throw new Error('Simulated BFMR deal payout evidence is unavailable.');
                  return detail.payoutPriceCents;
                },
              })
              : readLockedPurchaseEvidence(runtime, ref),
            beforeMutation: guard,
            beforeSubmit: async checkout => {
              await guard();
              await step(i, 'CHECKOUT_INTENT', { checkout: {
                ...checkout,
                preparedCheckoutId: checkout.preparedCheckoutId,
              } });
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
          asin: purchase.asin, totalCents: purchase.totalCents,
          purchasedAt: bundle?.mode === 'simulation' ? bundle.clock.now().toISOString() : new Date().toISOString(),
          status: 'PENDING', packages: [],
        } });
        deal = checkpoint.state.deals[i];
      }
      if (deal.step === 'CHECKOUT_INTENT' && bundle?.mode === 'simulation') {
        const checkoutId = deal.checkout?.preparedCheckoutId;
        if (!checkoutId || !bundle.amazon.readOrder) throw new Error('Uncertain simulated checkout cannot be reconciled by exact prepared-checkout identity.');
        const observed = await bundle.amazon.readOrder(checkoutId);
        if (observed.status !== 'FOUND') {
          throw new Error(`Simulated order readback is ${observed.status}; preserve the checkout intent and do not submit again.`);
        }
        if (observed.asin !== deal.checkout?.asin || observed.quantity !== 1 ||
            observed.totalCents !== deal.checkout?.totalCents || !observed.orderId) {
          throw new Error('Simulated order readback conflicts with the durable checkout intent.');
        }
        await step(i, 'ORDER_CONFIRMED', { order: {
          orderId: observed.orderId, reserveId: deal.reference!.reserveId, dealId: deal.reference!.dealId,
          asin: observed.asin, totalCents: observed.totalCents, purchasedAt: observed.purchasedAt,
          status: 'PENDING', packages: [],
        } });
        deal = checkpoint.state.deals[i];
      }
      if (deal.step === 'ORDER_CONFIRMED') {
        // Only local SQL persistence; authoritative causal order identity is
        // already captured. Reviewed repair may return to this exact boundary.
        if (bundle?.mode === 'simulation') {
          const fault = await bundle.simulationFaults?.consume('APPLICATION_ORDER_PERSIST');
          if (fault) throw new Error(`[Simulated application persistence failure] ${fault.errorDetail || fault.faultType}`);
        }
        await runtime.ledger.add(deal.order!);
        await step(i, 'ORDER_RECORDED');
        deal = checkpoint.state.deals[i];
      }
      if (deal.step === 'ORDER_RECORDED') {
        if (bundle?.mode === 'simulation' && bundle.simulationScenario?.phase === 2) {
          await step(i, 'COMPLETE');
          continue;
        }
        await guard();
        await step(i, 'PURCHASE_UPDATE_INTENT');
        await ensureBfmrPurchase(deal.order!.orderId, runtime.ledger, { beforeMutation: guard });
        await step(i, 'COMPLETE');
      }
      if (!terminalDeal(checkpoint.state.deals[i])) throw new Error('External action requires reconciliation, not another invocation.');
    }
    checkpoint.state.status = 'COMPLETE';
    await persist();
  } catch (workflowErr: any) {
    console.error('[dealEmailWorkflow error details]:', workflowErr?.stack || workflowErr);
    // A failing final snapshot must not erase the last successful durable
    // intent. The review error still scopes the incident to this workflow.
    try { checkpoint.state.status = 'PAUSED'; await persist(); } catch { /* Durable prior snapshot remains authoritative. */ }
    throw new WorkflowReviewRequiredError(checkpoint.state.workflowId, workflowErr);
  }
}
