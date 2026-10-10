import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { describeDealTitleFailure, readVisibleDealTitle } from '../src/services/visibleDealTitle';
import { hasVisibleDealUnavailableMessage } from '../src/services/dealAvailability';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const prices = '<p>Payout Price: $96.90</p><p>Retail Price: $96.90</p>';
const title = 'Google - Fitbit Air - Obsidian';

test('startup reads deals in displayed order without requiring or clicking a filter', async () => {
  const page = await browser.newPage();
  const adapter = Object.create(PlaywrightBfmrBrowser.prototype) as PlaywrightBfmrBrowser;
  adapter.init = async () => page;
  adapter.verifySession = async () => 'AUTHENTICATED';
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body:
    `<button onclick="document.body.dataset.clicked = 'yes'">In Stock</button>
    <a hidden href="/deals/hidden">Hidden</a>
    <a href="/deals/second">First shown</a><a href="/deals/first">Second shown</a><a href="/deals/second">Duplicate</a>` }));
  try {
    await page.goto('https://www.bfmr.com/deals');
    assert.deepEqual(await adapter.getStartupDealUrls(), ['https://www.bfmr.com/deals/second', 'https://www.bfmr.com/deals/first']);
    assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
    await page.locator('button').evaluate(element => element.remove());
    assert.deepEqual(await adapter.getStartupDealUrls(), ['https://www.bfmr.com/deals/second', 'https://www.bfmr.com/deals/first']);
  } finally { await page.close(); }
});

test('listing redirects, challenges, login and unknown pages are not proved full-deal skips', async () => {
  const page = await browser.newPage();
  // Bind the adapter to a synthetic page; never launch the account profile.
  const adapter = Object.create(PlaywrightBfmrBrowser.prototype) as PlaywrightBfmrBrowser;
  adapter.init = async () => page;
  let markup = '<main><h1>Deals</h1><p>Available deals</p></main>';
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: markup }));
  try {
    await page.goto('https://www.bfmr.com/deals?tag=all');
    assert.equal(await adapter.getCurrentDealUnavailableReason(), null);
    await assert.rejects(adapter.getVisibleDealTitle(), /deals listing.*does not prove the deal is full/);
    markup = '<main>Verify you\'re human</main>';
    await page.reload();
    assert.equal(await adapter.getCurrentDealUnavailableReason(), null);
    markup = '<main><input type="password">Sign in</main>';
    await page.reload();
    assert.equal(await adapter.getCurrentDealUnavailableReason(), null);
    markup = '<main>Account settings</main>';
    await page.goto('https://www.bfmr.com/account');
    assert.equal(await adapter.getCurrentDealUnavailableReason(), null);
    await page.goto('https://untrusted.example/deals?tag=all');
    assert.equal(await adapter.getCurrentDealUnavailableReason(), null);
    markup = `<main><h2>${title}</h2>${prices}</main>`;
    await page.goto('https://www.bfmr.com/deals/synthetic-product');
    assert.equal(await adapter.getCurrentDealUnavailableReason(), null);
    assert.equal(await adapter.getVisibleDealTitle(), title);
  } finally { await page.close(); }
});

test('failed-read diagnostics identify unsupported markup without logging account or product text', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<header><h1>PRIVATE ACCOUNT NAME</h1></header><main><h2>PRIVATE PRODUCT TITLE</h2><p>Payout: $10</p><p>Retail: $10</p></main>');
    const diagnostics = await describeDealTitleFailure(page);
    assert.match(diagnostics, /visible candidate headings=1 \(h2\)/);
    assert.match(diagnostics, /Payout Price label=false; Retail Price label=false/);
    assert.equal(diagnostics.includes('PRIVATE'), false);
  } finally { await page.close(); }
});

test('the observed Deal not found page is an unavailable skip, without requiring a title or clicking back', async () => {
  const page = await browser.newPage();
  const adapter = Object.create(PlaywrightBfmrBrowser.prototype) as PlaywrightBfmrBrowser;
  adapter.init = async () => page;
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body:
    '<header>Deal Details</header><main><h2>Deal not found</h2><p>We are sorry for the inconvenience.</p><button>Go Back To Deals Page</button></main>' }));
  try {
    await page.goto('https://bfmr.com/deals/synthetic-missing-deal');
    assert.equal(await adapter.getCurrentDealUnavailableReason(), 'BFMR reports "Deal not found"');
    assert.equal(await adapter.isCurrentDealUnavailable(), true);
    assert.equal(page.url(), 'https://bfmr.com/deals/synthetic-missing-deal');
    await page.setContent('<main><h2 hidden>Deal not found</h2><p>Loading...</p></main>');
    assert.equal(await adapter.getCurrentDealUnavailableReason(), null);
  } finally { await page.close(); }
});

test('recognizes the full-deal page without requiring a product title or pricing', async () => {
  const page = await browser.newPage();
  try {
    for (const message of ['Deal Full - Looks like you missed this one', 'No slots available', 'Deal closed', 'Sold out']) {
      await page.setContent(`<main><h2>${message}</h2><p>Check out our other deals that are active and ready to be purchased!</p></main>`);
      assert.equal(await hasVisibleDealUnavailableMessage(page), true);
    }
    await page.setContent(`<main><h2>${title}</h2>${prices}<div hidden>Deal Full - Looks like you missed this one</div><p>Retailer is sold out</p></main>`);
    assert.equal(await hasVisibleDealUnavailableMessage(page), false);
    assert.equal(await readVisibleDealTitle(page, 1000), title);
    await page.setContent('<main>Loading deal...</main>');
    assert.equal(await hasVisibleDealUnavailableMessage(page), false);
  } finally { await page.close(); }
});

for (const tag of ['h1', 'h2', 'h3', 'div role="heading" aria-level="2"']) {
  test(`reads the visible catalog title from ${tag}`, async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<header><h1>Deal Details</h1></header><aside><h2>My Tracker</h2></aside>
        <h1 hidden>Hidden product</h1><main><h2>Deal Details</h2>
        <${tag}> Google - Fitbit Air -\n Obsidian </${tag.split(' ')[0]}>${prices}</main>`);
      assert.equal(await readVisibleDealTitle(page, 1000), title);
    } finally { await page.close(); }
  });
}

test('reads the principal pricing heading despite subtitle and Additional Details headings', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<main>
      <section><div>Product image</div><div><h2>${title}</h2>
        <h5>drop off only | up to $21 above retail</h5>${prices}</div></section>
      <section><h2>Additional Details</h2><p>Delivery instructions</p></section>
    </main>`);
    assert.equal(await readVisibleDealTitle(page, 1000), title);
    // DOM order does not choose between equally plausible catalog headings.
    await page.setContent(`<main><section><h2>${title}</h2><h2>Another catalog title</h2>
      <h5>Subtitle</h5>${prices}</section><h2>Additional Details</h2></main>`);
    assert.equal(await readVisibleDealTitle(page, 200), null);
  } finally { await page.close(); }
});

test('separate pricing sections remain ambiguous', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<main><section><h2>${title}</h2>${prices}</section>
      <section><h2>Another product</h2>${prices}</section></main>`);
    assert.equal(await readVisibleDealTitle(page, 200), null);
  } finally { await page.close(); }
});

test('waits for the client-rendered title after the page shell is ready', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<main><h2>Deal Details</h2>${prices}</main>`);
    const pendingTitle = readVisibleDealTitle(page, 2000);
    await page.evaluate((text) => {
      setTimeout(() => {
        const heading = document.createElement('h2');
        heading.textContent = text;
        document.querySelector('main')!.prepend(heading);
      }, 150);
    }, title);
    assert.equal(await pendingTitle, title);
  } finally { await page.close(); }
});

test('missing, hidden, unrelated and ambiguous headings do not identify a deal', async () => {
  const page = await browser.newPage();
  try {
    for (const markup of [
      `<h1>Deal Details</h1>${prices}`,
      `<h2 style="display:none">${title}</h2>${prices}`,
      `<h2 style="visibility:hidden">${title}</h2>${prices}`,
      `<h2>${title}</h2>`,
      `<h2>${title}</h2><h2>Different product</h2>${prices}`,
    ]) {
      await page.setContent(markup);
      assert.equal(await readVisibleDealTitle(page, 200), null);
    }
  } finally { await page.close(); }
});
