import test from 'node:test';
import assert from 'node:assert/strict';
import { amazonSupplierFromReservations, readAmazonSupplier } from '../src/services/amazonEvaluation';
import { cancelConfirmedReservation, cancellationTargetState, type CancellationDependencies } from '../src/services/reservationCancellation';
import { completePostReservation, recoverPostReservation, type PostReservationDependencies, type PostReservationTask } from '../src/services/postReservation';

const reference = { reserveId: 'reservation-1', dealId: 'deal-1' };
const row = { reserve_id: reference.reserveId, deal_id: reference.dealId, qty: 1, status: 'Reserved' };
const supplierPayload = (retailers: string[]) => ({ reservation_list: [{ reserve_id: reference.reserveId,
  deal_id: reference.dealId, reserved_quantity: 1, item: [{ retailer_links: retailers.map(retailer => ({ retailer })) }] }] });

test('supplier evaluation uses exact reservation/deal identity and actual supplier entries', () => {
  assert.equal(amazonSupplierFromReservations(supplierPayload(['Best Buy', 'Amazon']), reference), 'PRESENT');
  assert.equal(amazonSupplierFromReservations({ data: supplierPayload([' amazon ']) }, reference), 'PRESENT');
  assert.equal(amazonSupplierFromReservations(supplierPayload(['Apple', 'Walmart']), reference), 'ABSENT');
  assert.equal(amazonSupplierFromReservations(supplierPayload(['Amazon-like shop']), reference), 'ABSENT');
  assert.equal(amazonSupplierFromReservations(supplierPayload(['Amazon']), { ...reference, dealId: 'other' }), 'UNKNOWN');
  assert.equal(amazonSupplierFromReservations({ reservation_list: [] }, reference), 'UNKNOWN');
  assert.equal(amazonSupplierFromReservations({ reservation_list: [{ ...supplierPayload(['Amazon']).reservation_list[0], item: [] }] }, reference), 'UNKNOWN');
  assert.equal(amazonSupplierFromReservations({ reservation_list: [supplierPayload(['Amazon']).reservation_list[0], supplierPayload(['Apple']).reservation_list[0]] }, reference), 'UNKNOWN');
  assert.equal(amazonSupplierFromReservations(supplierPayload(['']), reference), 'UNKNOWN');
});

test('unknown supplier network response never becomes absence', async () => {
  process.env.BFMR_API_KEY = 'synthetic-key'; process.env.BFMR_API_SECRET = 'synthetic-secret';
  assert.equal(await readAmazonSupplier(reference, async () => new Response('{}', { status: 500 })), 'UNKNOWN');
  assert.equal(await readAmazonSupplier(reference, async () => { throw new Error('network'); }), 'UNKNOWN');
});

function cancellationFixture() {
  let calls = 0; let reads = 0; let released = false;
  const dependencies: CancellationDependencies = {
    readRows: async () => { reads++; return released ? [] : [row]; },
    wait: async () => {},
    request: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.bfmr.com/api/v2/my-tracker/reservation/cancel');
      assert.equal(options?.method, 'POST');
      assert.equal(options?.redirect, 'error');
      assert.equal((options?.headers as Record<string, string>)['content-type'], 'application/x-www-form-urlencoded');
      assert.deepEqual([...new URLSearchParams(String(options?.body))], [['reserve_id[]', reference.reserveId]]);
      released = true;
      return new Response('{"message":"Reservation cancelled successfully!"}');
    },
  };
  return { dependencies, calls: () => calls, reads: () => reads, release: () => { released = true; } };
}

test('cancellation encodes exactly one ID, then proves release through My Tracker', async () => {
  process.env.BFMR_API_KEY = 'synthetic-key'; process.env.BFMR_API_SECRET = 'synthetic-secret';
  const f = cancellationFixture();
  await cancelConfirmedReservation(reference, false, f.dependencies);
  assert.equal(f.calls(), 1); assert.equal(f.reads(), 2);
});

test('HTTP success without release and timeout with active row do not retry the POST', async () => {
  for (const timeout of [false, true]) {
    const f = cancellationFixture(); let posts = 0;
    f.dependencies.request = async () => { posts++; if (timeout) throw new Error('timeout'); return new Response('{}'); };
    await assert.rejects(cancelConfirmedReservation(reference, false, f.dependencies), /not confirmed/);
    assert.equal(posts, 1);
  }
});

test('lost cancellation response can reconcile release; restart remains read-only', async () => {
  const f = cancellationFixture();
  f.dependencies.request = async () => { f.release(); throw new Error('lost response'); };
  await cancelConfirmedReservation(reference, false, f.dependencies);
  const active = cancellationFixture();
  await assert.rejects(cancelConfirmedReservation(reference, true, active.dependencies), /Previous cancellation/);
  assert.equal(active.calls(), 0);
  active.release();
  await cancelConfirmedReservation(reference, true, active.dependencies);
  assert.equal(active.calls(), 0);
});

test('changed quantity, purchased status, ambiguous rows, and failed reads prevent cancellation', async () => {
  for (const rows of [[{ ...row, qty: 2 }], [{ ...row, status: 'Purchased' }], [row, row], [{ ...row, deal_id: 'other' }]]) {
    assert.throws(() => cancellationTargetState(rows, reference));
    const f = cancellationFixture(); f.dependencies.readRows = async () => rows;
    await assert.rejects(cancelConfirmedReservation(reference, false, f.dependencies));
    assert.equal(f.calls(), 0);
  }
  const f = cancellationFixture(); f.dependencies.readRows = async () => { throw new Error('incomplete paging'); };
  await assert.rejects(cancelConfirmedReservation(reference, false, f.dependencies));
  assert.equal(f.calls(), 0);
});

function postFixture(amazon: 'PRESENT' | 'ABSENT' | 'UNKNOWN') {
  let saved: PostReservationTask | null = null;
  const events: string[] = [];
  const dependencies: PostReservationDependencies = {
    journal: { load: async () => saved, save: async task => { saved = { ...task }; events.push(task.state); } },
    readAmazon: async () => { events.push('suppliers'); return amazon; },
    cancel: async (target, recovery) => { assert.deepEqual(target, reference); assert.equal(saved?.state, 'CANCEL_PENDING'); events.push(recovery ? 'reconcile' : 'cancel'); },
    log: () => {},
  };
  return { dependencies, events };
}

test('email Amazon presence retains; absence persists intent then cancels; unknown stops', async () => {
  for (const result of ['PRESENT', 'ABSENT', 'UNKNOWN'] as const) {
    const f = postFixture(result);
    if (result === 'UNKNOWN') await assert.rejects(completePostReservation(reference, 'EMAIL', f.dependencies), /inconclusive/);
    else await completePostReservation(reference, 'EMAIL', f.dependencies);
    assert.deepEqual(f.events, result === 'PRESENT' ? ['EVALUATE', 'suppliers', 'KEPT'] :
      result === 'ABSENT' ? ['EVALUATE', 'suppliers', 'CANCEL_PENDING', 'cancel', 'CANCELLED'] : ['EVALUATE', 'suppliers']);
  }
});

test('startup cleanup bypasses the Amazon evaluation and cannot repeat after completion', async () => {
  const f = postFixture('PRESENT');
  await completePostReservation(reference, 'STARTUP', f.dependencies);
  await completePostReservation(reference, 'STARTUP', f.dependencies);
  assert.deepEqual(f.events, ['EVALUATE', 'CANCEL_PENDING', 'cancel', 'CANCELLED']);
});

test('uncertain cancellation retains intent and recovery never repeats the mutation', async () => {
  const f = postFixture('ABSENT');
  f.dependencies.cancel = async (_, recovery) => { f.events.push(recovery ? 'reconcile' : 'cancel'); throw new Error('uncertain'); };
  await assert.rejects(completePostReservation(reference, 'EMAIL', f.dependencies), /uncertain/);
  await assert.rejects(recoverPostReservation(f.dependencies), /uncertain/);
  await assert.rejects(completePostReservation({ ...reference, reserveId: 'other' }, 'EMAIL', f.dependencies), /earlier evaluation/);
  assert.equal(f.events.filter(e => e === 'cancel').length, 1);
  assert.equal(f.events.filter(e => e === 'reconcile').length, 1);
});

test('missing reservation identity cannot evaluate or cancel', async () => {
  const f = postFixture('ABSENT');
  await assert.rejects(completePostReservation(undefined, 'EMAIL', f.dependencies), /exact reservation/);
  assert.deepEqual(f.events, []);
});
