import type { ReservationReference } from './amazonEvaluation';
import type { StartupDeal } from './startupReservation';
import type { RelationalRuntime } from './relationalRuntime';
import type { PostReservationTask } from './postReservation';
import { captureRelationalReservation, prepareRelationalReservation, recordConfirmedCancellation,
  recordVerifiedAmazonSupplier, type PreparedRelationalReservation } from './relationalReservations';
import { readTrackerWithFailureEvidence } from './relationalReservations';
import { recordReservationNotAttempted } from './relationalReservations';

/** The startup CAPTCHA workflow still cancels without supplier evaluation.
 * Recovery can use existing locked terms, but must never recreate them from
 * today's rate when a past submission has no captured creation evidence.
 */
export function relationalStartupHooks(runtime: RelationalRuntime) {
  let prepared: PreparedRelationalReservation | undefined;
  return {
    async beforeMutation() { await runtime.ownership.verifyOwnership(); await runtime.verifyRetailerAccount(); },
    async afterNotSubmitted(deal: StartupDeal) {
      if (!prepared || prepared.dealId !== deal.id) throw new Error('Startup non-submission intent is missing.');
      await recordReservationNotAttempted(runtime, prepared);
    },
    async beforeStartup() {
      const result = await runtime.sync.reconcile(await readTrackerWithFailureEvidence(runtime), {
        complete: true, accountValidated: true,
        financialContractValidated: process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED === 'YES',
      });
      if (!result.promoted) throw new Error('Startup account records require reconciliation before any provider mutation.');
    },
    async beforeRecovery(task: PostReservationTask) {
      // The private recovery journal is operational evidence, not permission to
      // create missing historical financial terms or bypass the cutover gate.
      await runtime.sync.readLockedPayoutCents(task.reference);
      await runtime.ownership.verifyOwnership();
    },
    async afterRecovery(task: PostReservationTask) {
      if (task.state === 'CANCELLED') await recordConfirmedCancellation(runtime, task.reference);
      else if (task.state === 'KEPT' && task.kind === 'EMAIL') await recordVerifiedAmazonSupplier(runtime, task.reference);
      else throw new Error('Recovered workflow outcome remains unresolved.');
    },
    async beforeSubmit(deal: StartupDeal) {
      prepared = await prepareRelationalReservation(runtime, { dealUrl: deal.url, dealId: deal.id, title: deal.title });
      await runtime.ownership.verifyOwnership();
      await runtime.verifyRetailerAccount();
    },
    async afterConfirmed(reference: ReservationReference | undefined) {
      if (!reference) throw new Error('Startup confirmation omitted exact reservation identity.');
      if (prepared && prepared.dealId === reference.dealId) await captureRelationalReservation(runtime, reference, prepared);
      else await runtime.sync.readLockedPayoutCents(reference);
    },
    async afterCancelled(reference: ReservationReference | undefined) {
      if (!reference) throw new Error('Startup cancellation omitted exact reservation identity.');
      await recordConfirmedCancellation(runtime, reference);
    },
  };
}
