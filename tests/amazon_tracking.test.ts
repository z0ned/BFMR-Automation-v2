import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { amazonOrderLedger, type AmazonOrderRecord } from '../src/services/amazonOrderLedger';
import { checkAmazonShipment, trackingNumbersFromText } from '../src/services/amazonShipmentCheck';
import { atlantaDayAndHour, runDueAmazonTracking } from '../src/services/nightlyAmazonTracking';
import type { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';

const order: AmazonOrderRecord = {
  orderId: '114-1234567-1234567', reserveId: 'RID-1', dealId: 'd-example', asin: 'B0GTMJF7PV',
  totalCents: 7999, purchasedAt: '2026-10-12T12:01:00Z', status: 'PENDING', packages: [],
};

test('Atlanta 3am follows EST and EDT, and tracking labels yield unique numbers', () => {
  assert.deepEqual(atlantaDayAndHour(new Date('2026-01-10T08:00:00Z')), { day: '2026-01-10', hour: 3 });
  assert.deepEqual(atlantaDayAndHour(new Date('2026-07-10T07:00:00Z')), { day: '2026-07-10', hour: 3 });
  assert.deepEqual(trackingNumbersFromText('Tracking number: TBA123456789012\nTracking ID TBA123456789012'), ['TBA123456789012']);
});

test('ledger persists exact order mapping and rejects a conflicting reservation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bfmr-amazon-ledger-'));
  try {
    const ledger = amazonOrderLedger(path.join(directory, 'orders.json'));
    await ledger.add(order);
    await ledger.add(order);
    assert.equal((await ledger.load()).length, 1);
    await assert.rejects(() => ledger.add({ ...order, orderId: '114-7654321-7654321' }), /already has a different/);
    await ledger.add({ ...order, orderId: '114-7654321-7654321', reserveId: null, dealId: null });
    assert.equal((await ledger.load()).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('nightly worker waits until next Atlanta 3am and yields before a new deal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bfmr-nightly-'));
  try {
    const ledger = amazonOrderLedger(path.join(directory, 'orders.json'));
    await ledger.add(order);
    let opened = 0;
    const browser = { createRetailerTab: async () => {
      opened++;
      return { close: async () => {} } as unknown as Page;
    } } as PlaywrightBfmrBrowser;
    const run = (now: string, incoming: boolean) => runDueAmazonTracking({
      browser, ledger, now: () => new Date(now), hasIncomingMail: async () => incoming,
      onOrderFailure: async () => assert.fail('unexpected lookup failure'),
      checkShipment: async (_page, record) => ({ ...record, status: 'SHIPPED' }),
    });
    await run('2026-10-12T16:00:00Z', false);
    assert.equal(opened, 0);
    await run('2026-10-13T07:00:00Z', true);
    assert.equal(opened, 0);
    await run('2026-10-13T07:00:00Z', false);
    assert.equal(opened, 1);
    assert.equal((await ledger.load())[0].lastCheckedAtlantaDay, '2026-10-13');
    await run('2026-10-13T08:00:00Z', false);
    assert.equal(opened, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('website lookup binds tracking to exact Amazon order, ASIN and total', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const body = url.pathname === '/gp/css/order-history' ? `<main>
        <section>Order placed October 12 Total $79.99 Order # 114-9999999-9999999
          <a href="/dp/B0GTMJF7PV">Same product on another order</a>
          <a href="/gp/track/other">Track package</a></section>
        <section>Order placed October 12 Total $79.99 Order # ${order.orderId} Shipped
          <a href="/dp/${order.asin}">Expected product</a>
          <a href="/gp/track/target">Track package</a></section>
      </main>` : url.pathname === '/gp/track/target' ?
        `<main>Order # ${order.orderId}<p>Shipped with UPS</p><p>Tracking number: 1Z999AA10123456784</p></main>` :
        '<main>Wrong package</main>';
      await route.fulfill({ contentType: 'text/html', body });
    });
    const page = await context.newPage();
    const checked = await checkAmazonShipment(page, order, new Date('2026-10-13T07:00:00Z'));
    assert.equal(checked.status, 'SHIPPED');
    assert.deepEqual(checked.packages.map((pkg) => pkg.trackingNumber), ['1Z999AA10123456784']);
    assert.equal(checked.packages[0].carrier, 'UPS');
    assert.match(page.url(), /\/gp\/track\/target$/);
    await assert.rejects(() => checkAmazonShipment(page, { ...order, totalCents: 7000 }), /total does not match/);
  } finally { await context.close(); await browser.close(); }
});
