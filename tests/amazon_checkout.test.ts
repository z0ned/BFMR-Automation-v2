import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { AMAZON_TEST_PRODUCT, amazonProductAsin, runAmazonCheckoutRehearsal } from '../src/services/amazonCheckoutRehearsal';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const asin = 'B09JQMJHXY';
const review = (id = asin, quantity = 1) => `<main><a href="/dp/${id}">Test product</a><p>Qty: ${quantity}</p><p>Order total: $10.00</p><button onclick="fetch('/order-submit', {method:'POST'})">Place your order</button></main>`;

async function fixture(options: { initial?: 'EMPTY' | 'TARGET' | 'OTHER'; quantity?: number; productAsin?: string; reviewAsin?: string; reviewQuantity?: number; manualStep?: boolean } = {}) {
  const context = await browser.newContext();
  let cart = options.initial ?? 'EMPTY';
  let added = 0; let placed = 0; let humanReady = !options.manualStep;
  await context.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    let body = '';
    if (path === '/order-submit') { placed++; body = 'Order complete'; }
    else if (path === '/cart/add-to-cart') { added++; cart = 'TARGET'; body = '<p>Added to cart</p>'; }
    else if (path === '/gp/cart/view.html') {
      body = cart === 'EMPTY' ? '<h1>Your Amazon Cart is empty.</h1>' :
        `<div id="sc-active-cart"><div data-asin="${cart === 'OTHER' ? 'B000000001' : asin}" data-itemtype="active" data-quantity="${options.quantity ?? 1}">Product</div></div><a href="/checkout/review">Proceed to checkout</a>`;
    } else if (path.startsWith('/dp/')) {
      body = `<form action="/cart/add-to-cart" method="post"><input name="ASIN" type="hidden" value="${options.productAsin ?? asin}"><select name="quantity"><option value="1">1</option></select><input type="submit" id="add-to-cart-button" value="Add to cart"></form><button>Buy Now</button>`;
    } else if (path.startsWith('/checkout/')) {
      body = humanReady ? review(options.reviewAsin, options.reviewQuantity) : '<h1>Select a payment method</h1><button>Use this payment method</button>';
    } else body = '<h1>BFMR fixture</h1>';
    await route.fulfill({ contentType: 'text/html', body });
  });
  const page = await context.newPage();
  const messages: string[] = []; let manualCalls = 0;
  return {
    context, page, messages,
    counters: () => ({ added, placed, manualCalls }),
    callbacks: {
      log: (message: string) => messages.push(message),
      manual: async (message: string) => {
        manualCalls++; messages.push(message); humanReady = true;
        await page.reload();
      },
    },
  };
}

test('only direct HTTPS Amazon product URLs identify the rehearsal product', () => {
  assert.equal(amazonProductAsin(AMAZON_TEST_PRODUCT), asin);
  for (const url of ['https://amazon.com.evil.test/dp/B09JQMJHXY', 'http://amazon.com/dp/B09JQMJHXY',
    'https://user:pass@amazon.com/dp/B09JQMJHXY', 'https://amazon.com:444/dp/B09JQMJHXY', 'https://amazon.com/gp/cart/view.html']) {
    assert.equal(amazonProductAsin(url), null);
  }
});

test('empty cart adds exactly one requested product and stops without placing an order', async () => {
  const f = await fixture();
  try {
    await runAmazonCheckoutRehearsal(f.page, AMAZON_TEST_PRODUCT, f.callbacks);
    assert.deepEqual(f.counters(), { added: 1, placed: 0, manualCalls: 0 });
    assert.match(f.messages.at(-1)!, /Place your order was NOT clicked/);
    assert.equal(await f.page.getByRole('button', { name: 'Place your order', exact: true }).isVisible(), true);
  } finally { await f.context.close(); }
});

test('rerunning with the existing single target item never adds it again', async () => {
  const f = await fixture({ initial: 'TARGET' });
  try {
    await runAmazonCheckoutRehearsal(f.page, AMAZON_TEST_PRODUCT, f.callbacks);
    assert.deepEqual(f.counters(), { added: 0, placed: 0, manualCalls: 0 });
  } finally { await f.context.close(); }
});

test('other cart items and wrong quantity stop without cart changes or checkout', async () => {
  for (const options of [{ initial: 'OTHER' as const }, { initial: 'TARGET' as const, quantity: 2 }]) {
    const f = await fixture(options);
    try {
      await assert.rejects(runAmazonCheckoutRehearsal(f.page, AMAZON_TEST_PRODUCT, f.callbacks), /cart/);
      assert.deepEqual(f.counters(), { added: 0, placed: 0, manualCalls: 0 });
    } finally { await f.context.close(); }
  }
});

test('product variant mismatch prevents Add to cart', async () => {
  const f = await fixture({ productAsin: 'B000000001' });
  try {
    await assert.rejects(runAmazonCheckoutRehearsal(f.page, AMAZON_TEST_PRODUCT, f.callbacks), /offer ASIN/);
    assert.equal(f.counters().added, 0);
  } finally { await f.context.close(); }
});

test('review must show the requested product and quantity one without final submission', async () => {
  for (const options of [{ reviewAsin: 'B000000001' }, { reviewQuantity: 2 }]) {
    const f = await fixture({ initial: 'TARGET', ...options });
    try {
      await assert.rejects(runAmazonCheckoutRehearsal(f.page, AMAZON_TEST_PRODUCT, f.callbacks), /could not be verified/);
      assert.equal(f.counters().placed, 0);
    } finally { await f.context.close(); }
  }
});

test('unconfigured checkout asks for manual account choices and then verifies review', async () => {
  const f = await fixture({ initial: 'TARGET', manualStep: true });
  try {
    await runAmazonCheckoutRehearsal(f.page, AMAZON_TEST_PRODUCT, f.callbacks);
    assert.equal(f.counters().manualCalls, 1);
    assert.equal(f.counters().placed, 0);
    assert.ok(f.messages.some(message => /saved default delivery address/.test(message)));
  } finally { await f.context.close(); }
});

test('retailer tab belongs to the original BFMR browser context and preserves the BFMR page', async () => {
  const f = await fixture();
  try {
    await f.page.goto('https://www.bfmr.com/deals');
    const adapter = Object.create(PlaywrightBfmrBrowser.prototype) as PlaywrightBfmrBrowser;
    adapter.init = async () => f.page;
    const amazon = await adapter.createRetailerTab();
    assert.equal(amazon.context(), f.page.context());
    await amazon.goto(AMAZON_TEST_PRODUCT);
    assert.equal(f.page.url(), 'https://www.bfmr.com/deals');
    assert.equal(f.context.pages().length, 2);
  } finally { await f.context.close(); }
});

test('manual login and MFA resume from Amazon home without terminal input', async () => {
  for (const destination of ['/gp/cart/view.html', `/dp/${asin}`]) {
    const f = await fixture();
    let authenticated = false;
    try {
      await f.context.route(`https://www.amazon.com${destination}`, async route => {
        if (authenticated) return route.fallback();
        await route.fulfill({ status: 302, headers: { location: '/ap/signin' } });
      });
      await f.context.route('https://www.amazon.com/ap/**', route => route.fulfill({
        contentType: 'text/html', body: '<input type="password"><input autocomplete="one-time-code">',
      }));
      await f.context.route('https://www.amazon.com/', route => route.fulfill({
        contentType: 'text/html', body: '<span id="nav-link-accountList-nav-line-1">Hello, Test</span>',
      }));
      const human = async () => {
        await f.page.waitForURL('**/ap/signin');
        await f.page.waitForTimeout(800);
        await f.page.goto('https://www.amazon.com/ap/mfa');
        await f.page.waitForTimeout(300);
        authenticated = true;
        await f.page.goto('https://www.amazon.com/');
      };
      await Promise.all([human(), runAmazonCheckoutRehearsal(f.page, AMAZON_TEST_PRODUCT, f.callbacks)]);
      assert.deepEqual(f.counters(), { added: 1, placed: 0, manualCalls: 0 });
      assert.ok(f.messages.some(message => /resuming automatically/.test(message)));
    } finally { await f.context.close(); }
  }
});

test('unresolved authentication times out without adding or ordering', async () => {
  const f = await fixture();
  try {
    await f.context.route('**/gp/cart/view.html', route => route.fulfill({
      contentType: 'text/html', body: '<input type="password">',
    }));
    await assert.rejects(runAmazonCheckoutRehearsal(f.page, AMAZON_TEST_PRODUCT, {
      ...f.callbacks, accessTimeoutMs: 300,
    }), /before timeout/);
    assert.deepEqual(f.counters(), { added: 0, placed: 0, manualCalls: 0 });
  } finally { await f.context.close(); }
});

test('opens requested product before cart preflight and retains it if cart is unknown', async () => {
  const f = await fixture();
  const visited: string[] = [];
  f.page.on('framenavigated', frame => { if (frame === f.page.mainFrame()) visited.push(new URL(frame.url()).pathname); });
  try {
    await f.context.route('**/gp/cart/view.html', route => route.fulfill({
      contentType: 'text/html', body: '<h1>Shopping Cart</h1><p>Unrecognized fixture layout</p>',
    }));
    await assert.rejects(runAmazonCheckoutRehearsal(f.page, AMAZON_TEST_PRODUCT, f.callbacks), /active rows=0/);
    assert.equal(visited[0], `/dp/${asin}`);
    assert.equal(f.page.url(), AMAZON_TEST_PRODUCT);
    assert.deepEqual(f.counters(), { added: 0, placed: 0, manualCalls: 0 });
  } finally { await f.context.close(); }
});

test('recognizes the shorter empty-cart heading before adding one item', async () => {
  const f = await fixture();
  try {
    await f.context.route('**/gp/cart/view.html', async route => {
      if (f.counters().added) return route.fallback();
      await route.fulfill({ contentType: 'text/html', body: '<h1>Your cart is empty</h1>' });
    });
    await runAmazonCheckoutRehearsal(f.page, AMAZON_TEST_PRODUCT, f.callbacks);
    assert.deepEqual(f.counters(), { added: 1, placed: 0, manualCalls: 0 });
  } finally { await f.context.close(); }
});
