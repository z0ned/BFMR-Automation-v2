import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { retrieveAmazonOrderId, submitAmazonOrderOnce } from '../src/services/amazonCheckoutRehearsal';

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const asin = 'B09JQMJHXY';
const oldId = '114-1111111-1111111';
const newId = '114-2222222-2222222';

async function fixture(confirmation: string) {
  const context = await browser.newContext();
  let submissions = 0;
  let historyReads = 0;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    let body: string;
    if (url.pathname === '/checkout/review') {
      body = `<main><section><a href="/dp/${asin}">Test product</a><p>Qty: 1</p></section><p>Order total: $10.00</p>
        <p>Gift options selected</p><p>Shipping: $0.00</p><label><input type="radio" checked>FREE Shipping</label>
        <button onclick="location.href='/gp/buy/thankyou/handlers/display.html?purchaseId=114-3333333-3333333'">Place your order</button></main>`;
    } else if (url.pathname.startsWith('/gp/buy/thankyou/')) {
      submissions++;
      body = `<a id="nav-orders" href="/gp/css/order-history">Returns &amp; Orders</a>
        <main><h1>Thank you, your order has been placed</h1>${confirmation}</main>`;
    } else if (url.pathname === '/gp/css/order-history') {
      historyReads++;
      body = `<section>Order placed October 1 Total $10.00 Order # ${oldId}<a href="/dp/${asin}">Test product</a></section>`;
    } else throw new Error(`Unexpected fixture request: ${url.pathname}`);
    await route.fulfill({ contentType: 'text/html', body });
  });
  const page = await context.newPage();
  const submit = async () => {
    await page.goto('https://www.amazon.com/checkout/review');
    assert.equal(await submitAmazonOrderOnce(page, asin, 'Test product', undefined,
      { maxTotalCents: 1000, confirmedTotalCents: 1000, allowDuplicateWarning: false }), 'PLACED');
  };
  return { page, context, submit, counts: () => ({ submissions, historyReads }) };
}

test('captures this submission confirmation ID without consulting an older identical order', async () => {
  const f = await fixture(`<p>Order # ${newId}</p><p>Order number: ${newId}</p>`);
  try {
    await f.submit();
    assert.equal(await retrieveAmazonOrderId(f.page, asin, 'Test product', 1000), newId);
    assert.deepEqual(f.counts(), { submissions: 1, historyReads: 0 });
    await assert.rejects(retrieveAmazonOrderId(f.page, asin, 'Test product', 2000), /not bound/);
    await assert.rejects(retrieveAmazonOrderId(f.page, 'B000000001', 'Test product', 1000), /not bound/);
    await f.page.goto('https://www.amazon.com/gp/css/order-history');
    await assert.rejects(submitAmazonOrderOnce(f.page, asin, 'Test product'), /no longer on a checkout route/);
    await assert.rejects(retrieveAmazonOrderId(f.page, asin, 'Test product', 1000), /not bound/);
  } finally { await f.context.close(); }
});

test('waits for a delayed confirmation number', async () => {
  const f = await fixture(`<p id="number"></p><script>setTimeout(() => {
    document.querySelector('#number').textContent = 'Order ID: ${newId}'; }, 800);</script>`);
  try {
    await f.submit();
    assert.equal(await retrieveAmazonOrderId(f.page, asin, 'Test product', 1000), newId);
    assert.equal(f.counts().historyReads, 0);
  } finally { await f.context.close(); }
});

test('missing confirmation number rejects even when an older identical purchase exists in history', async () => {
  const f = await fixture('<p>Your delivery is being scheduled.</p>');
  try {
    await f.submit();
    await assert.rejects(retrieveAmazonOrderId(f.page, asin, 'Test product', 1000), /no unique Order #/);
    assert.deepEqual(f.counts(), { submissions: 1, historyReads: 0 });
  } finally { await f.context.close(); }
});

test('ambiguous confirmation numbers are rejected', async () => {
  const f = await fixture(`<p>Order # ${newId}</p><p>Order # ${oldId}</p>`);
  try {
    await f.submit();
    await assert.rejects(retrieveAmazonOrderId(f.page, asin, 'Test product', 1000), /multiple Order #/);
    assert.equal(f.counts().historyReads, 0);
  } finally { await f.context.close(); }
});

test('an order-history page alone cannot authorize an ID and leaving an incomplete confirmation stops lookup', async () => {
  const f = await fixture('');
  try {
    await f.page.goto('https://www.amazon.com/gp/css/order-history');
    await assert.rejects(retrieveAmazonOrderId(f.page, asin, 'Test product', 1000), /not bound/);
    await f.submit();
    await f.page.goto('https://www.amazon.com/gp/css/order-history');
    await assert.rejects(retrieveAmazonOrderId(f.page, asin, 'Test product', 1000), /no unique Order #/);
    assert.equal(f.counts().submissions, 1);
  } finally { await f.context.close(); }
});
