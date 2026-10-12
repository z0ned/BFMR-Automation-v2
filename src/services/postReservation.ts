import type { AmazonSupplierResult, ReservationReference } from './amazonEvaluation';

export interface PostReservationTask {
  reference: ReservationReference;
  kind: 'STARTUP' | 'EMAIL';
  state: 'EVALUATE' | 'CANCEL_PENDING' | 'KEPT' | 'CANCELLED';
}
export interface PostReservationDependencies {
  journal: { load(): Promise<PostReservationTask | null>; save(task: PostReservationTask): Promise<void> };
  readAmazon(reference: ReservationReference): Promise<AmazonSupplierResult>;
  cancel(reference: ReservationReference, recoveryOnly: boolean): Promise<void>;
  log(message: string): void;
}

export type PostReservationOutcome = 'KEPT' | 'CANCELLED';

async function processTask(task: PostReservationTask, dependencies: PostReservationDependencies): Promise<PostReservationOutcome> {
  if (task.state === 'KEPT' || task.state === 'CANCELLED') return task.state;
  if (task.state === 'CANCEL_PENDING') {
    // The previous process could have sent its POST. Recovery is read-only.
    await dependencies.cancel(task.reference, true);
  } else {
    if (task.kind === 'EMAIL') {
      const amazon = await dependencies.readAmazon(task.reference);
      if (amazon === 'UNKNOWN') throw new Error('Amazon supplier evaluation is inconclusive; reservation retained for review.');
      if (amazon === 'PRESENT') {
        await dependencies.journal.save({ ...task, state: 'KEPT' });
        dependencies.log('PASS: Amazon is listed as a supplier. Reservation retained.');
        return 'KEPT';
      }
      dependencies.log('Amazon is not listed as a supplier; canceling this reservation.');
    } else dependencies.log('Startup CAPTCHA reservation confirmed; canceling it before continuing.');
    await dependencies.journal.save({ ...task, state: 'CANCEL_PENDING' });
    await dependencies.cancel(task.reference, false);
  }
  await dependencies.journal.save({ ...task, state: 'CANCELLED' });
  dependencies.log('My Tracker confirmed that the reservation is no longer reserved.');
  return 'CANCELLED';
}

export async function recoverPostReservation(dependencies: PostReservationDependencies): Promise<void> {
  const task = await dependencies.journal.load();
  if (task) await processTask(task, dependencies);
}

export async function completePostReservation(reference: ReservationReference | undefined, kind: 'STARTUP' | 'EMAIL',
  dependencies: PostReservationDependencies): Promise<PostReservationOutcome> {
  if (!reference?.reserveId || !reference.dealId) throw new Error('My Tracker did not expose exact reservation/deal IDs; post-reservation action requires review.');
  const previous = await dependencies.journal.load();
  if (previous && previous.reference.reserveId === reference.reserveId) {
    if (previous.reference.dealId !== reference.dealId || previous.kind !== kind) throw new Error('Post-reservation journal identity conflict.');
    return processTask(previous, dependencies);
  }
  if (previous && !['KEPT', 'CANCELLED'].includes(previous.state)) {
    throw new Error('An earlier evaluation/cancellation is unresolved; refusing to replace its recovery evidence.');
  }
  const task: PostReservationTask = { reference, kind, state: 'EVALUATE' };
  await dependencies.journal.save(task);
  return processTask(task, dependencies);
}
