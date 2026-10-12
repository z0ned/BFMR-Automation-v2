import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { amazonOrderLedger, type AmazonOrderRecord } from '../src/services/amazonOrderLedger';
import { ensureBfmrPurchase, ensureBfmrTracking } from '../src/services/bfmrTrackingSubmission';
import type { TrackerReservationRow } from '../src/services/bfmrTrackerApi';

const amazon: AmazonOrderRecord = {
  orderId: '114-1234567-1234567', reserveId: 'RID-1', dealId: 'd-example', asin: 'B0GTMJF7PV',
  totalCents: 7999, purchasedAt: '2026-10-12T12:01:00Z', status: 'SHIPPED',
  packages: [{ trackingNumber: '1Z999AA10123456784', carrier: 'UPS', status: 'SHIPPED',
    firstSeenAt: '2026-10-13T07:00:00Z', lastSeenAt: '2026-10-13T07:00:00Z' }],
};

test('documented BFMR purchase and shipment writes use exact IDs and reconcile before completion', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bfmr-tracking-api-'));
  const oldKey = process.env.BFMR_API_KEY;
  const oldSecret = process.env.BFMR_API_SECRET;
  process.env.BFMR_API_KEY = 'fixture-key';
  process.env.BFMR_API_SECRET = 'fixture-secret';
  try {
    const ledger = amazonOrderLedger(path.join(directory, 'orders.json'));
    await ledger.add(amazon);
    let row: TrackerReservationRow = { reserve_id: 'RID-1', deal_id: 'd-example', qty: 1,
      status: 'Reserved', purchase_id: null, shipment_id: null, order_no: null, tracking_number: null };
    const calls: Record<string, unknown>[] = [];
    const dependencies = {
      readRows: async () => [row],
      request: async (_url: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(init?.method, 'POST');
        assert.equal(init?.headers && (init.headers as Record<string, string>)['content-type'], 'application/json');
        const item = JSON.parse(String(init?.body)).tracker_data[0] as Record<string, unknown>;
        calls.push(item);
        if (item.tracking_number === null) row = { ...row, status: 'Purchased', purchase_id: 'PID-1', order_no: item.order_no };
        else row = { ...row, status: 'Shipped', shipment_id: 'SID-1', tracking_number: item.tracking_number };
        return new Response('{}', { status: 200 });
      },
    };
    await ensureBfmrPurchase(amazon.orderId, ledger, dependencies);
    await ensureBfmrTracking(amazon.orderId, ledger, dependencies);
    await ensureBfmrPurchase(amazon.orderId, ledger, dependencies);
    await ensureBfmrTracking(amazon.orderId, ledger, dependencies);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { reserve_id: 'RID-1', purchase_id: null, shipment_id: null,
      qty: 1, order_no: amazon.orderId, tracking_number: null });
    assert.deepEqual(calls[1], { reserve_id: 'RID-1', purchase_id: 'PID-1', shipment_id: null,
      qty: 1, order_no: amazon.orderId, tracking_number: '1Z999AA10123456784' });
    const saved = (await ledger.load())[0];
    assert.equal(saved.bfmrPurchaseId, 'PID-1');
    assert.equal(saved.bfmrShipmentId, 'SID-1');
    assert.ok(saved.bfmrTrackingSubmittedAt);
  } finally {
    if (oldKey === undefined) delete process.env.BFMR_API_KEY; else process.env.BFMR_API_KEY = oldKey;
    if (oldSecret === undefined) delete process.env.BFMR_API_SECRET; else process.env.BFMR_API_SECRET = oldSecret;
    await rm(directory, { recursive: true, force: true });
  }
});

test('uncertain BFMR purchase POST is never repeated without matching My Tracker evidence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bfmr-tracking-uncertain-'));
  const oldKey = process.env.BFMR_API_KEY;
  const oldSecret = process.env.BFMR_API_SECRET;
  process.env.BFMR_API_KEY = 'fixture-key';
  process.env.BFMR_API_SECRET = 'fixture-secret';
  try {
    const ledger = amazonOrderLedger(path.join(directory, 'orders.json'));
    await ledger.add(amazon);
    let posts = 0;
    const dependencies = {
      readRows: async () => [{ reserve_id: 'RID-1', deal_id: 'd-example', qty: 1, status: 'Reserved' }],
      request: async () => { posts++; throw new Error('response lost'); },
    };
    await assert.rejects(() => ensureBfmrPurchase(amazon.orderId, ledger, dependencies), /not confirmed/);
    await assert.rejects(() => ensureBfmrPurchase(amazon.orderId, ledger, dependencies), /No repeat POST/);
    assert.equal(posts, 1);
    assert.ok((await ledger.load())[0].bfmrPurchaseIntentAt);
  } finally {
    if (oldKey === undefined) delete process.env.BFMR_API_KEY; else process.env.BFMR_API_KEY = oldKey;
    if (oldSecret === undefined) delete process.env.BFMR_API_SECRET; else process.env.BFMR_API_SECRET = oldSecret;
    await rm(directory, { recursive: true, force: true });
  }
});
