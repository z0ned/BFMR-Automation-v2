import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { amazonOrderLedger, type AmazonOrderRecord } from '../src/services/amazonOrderLedger';
import { bfmrStatusStore, runDueBfmrStatusCheck } from '../src/services/bfmrDailyStatus';

const order: AmazonOrderRecord = {
  orderId: '114-1234567-1234567', reserveId: 'R-1', dealId: 'D-1', asin: 'B0GTMJF7PV',
  totalCents: 4500, purchasedAt: '2026-10-11T14:00:00Z', status: 'SHIPPED',
  packages: [{ trackingNumber: '1Z999AA10123456784', carrier: 'UPS', status: 'SHIPPED',
    firstSeenAt: '2026-10-12T06:00:00Z', lastSeenAt: '2026-10-12T06:00:00Z' }],
};

test('daily BFMR check persists all open rows, updates local official status and alerts discrepancies once', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bfmr-daily-'));
  try {
    const ledger = amazonOrderLedger(path.join(directory, 'orders.json'));
    const store = bfmrStatusStore(path.join(directory, 'status.json'));
    await ledger.add(order);
    const alerts: string[] = [];
    let reads = 0;
    const options = {
      ledger, store, now: () => new Date('2026-10-12T08:00:00Z'), hasIncomingMail: async () => false,
      notify: async (message: string) => { alerts.push(message); },
      readRows: async () => { reads++; return [
        { reserve_id: 'R-1', deal_id: 'D-1', status: 'Shipped', qty: 1, purchase_id: 'P-1',
          shipment_id: 'S-1', order_no: order.orderId, tracking_number: 'DIFFERENT123' },
        { reserve_id: 'R-2', deal_id: 'D-2', status: 'Reserved', qty: 1 },
      ]; },
    };
    await runDueBfmrStatusCheck({ ...options, hasIncomingMail: async () => true });
    assert.equal(reads, 0);
    await runDueBfmrStatusCheck(options);
    assert.equal(reads, 1);
    assert.equal((await store.load())?.openRows.length, 2);
    assert.equal((await ledger.load())[0].bfmrOfficial?.status, 'shipped');
    assert.match(alerts.join('\n'), /tracking.*differs/i);
    assert.match(alerts.join('\n'), /R-2.*absent/i);
    await runDueBfmrStatusCheck(options);
    assert.equal(reads, 1);
    assert.equal(alerts.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Telegram outage preserves alerts while the next daily BFMR snapshot still advances', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bfmr-daily-retry-'));
  try {
    const ledger = amazonOrderLedger(path.join(directory, 'orders.json'));
    const store = bfmrStatusStore(path.join(directory, 'status.json'));
    await ledger.add(order);
    let reads = 0;
    let sends = 0;
    const options = {
      ledger, store, now: () => new Date('2026-10-12T08:00:00Z'), hasIncomingMail: async () => false,
      readRows: async () => { reads++; return [{ reserve_id: 'R-1', deal_id: 'D-1', status: 'Reserved', qty: 1 }]; },
      notify: async () => { sends++; if (sends === 1) throw new Error('Telegram unavailable'); },
    };
    await assert.rejects(() => runDueBfmrStatusCheck(options), /Telegram unavailable/);
    assert.equal((await store.load())?.nextAlert, 0);
    const nextDay = { ...options, now: () => new Date('2026-10-13T08:00:00Z') };
    await assert.rejects(() => runDueBfmrStatusCheck({ ...nextDay, notify: async () => { throw new Error('still unavailable'); } }), /still unavailable/);
    assert.equal(reads, 2);
    assert.equal((await store.load())?.atlantaDay, '2026-10-13');
    assert.equal((await store.load())?.pendingAlerts.length, 2);
    await runDueBfmrStatusCheck(nextDay);
    assert.equal(reads, 2);
    assert.equal(sends, 3);
    assert.equal((await store.load())?.nextAlert, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
