import type { IpadReservationCheck } from './bfmrTrackerApi';

/** Read-only confirmation: no operator prompt or form resubmission. */
export async function automaticConfirmation(
  check: () => Promise<IpadReservationCheck>,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<IpadReservationCheck> {
  let result = await check();
  for (let attempt = 0; attempt < 12 && result.status === 'NOT_VISIBLE_YET'; attempt += 1) {
    await wait(5000);
    result = await check();
  }
  return result;
}
