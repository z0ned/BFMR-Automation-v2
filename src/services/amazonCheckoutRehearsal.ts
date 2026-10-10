import type { Locator, Page } from 'playwright';

export const AMAZON_TEST_PRODUCT = 'https://www.amazon.com/dp/B09JQMJHXY';
const CART = 'https://www.amazon.com/gp/cart/view.html';
const ASIN = /^[A-Z0-9]{10}$/;

export function amazonProductAsin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['amazon.com', 'www.amazon.com'].includes(url.hostname) ||
      url.username || url.password || url.port) return null;
    const match = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i);
    return match?.[1].toUpperCase() ?? null;
  } catch { return null; }
}

function assertAmazon(page: Page) {
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || !['amazon.com', 'www.amazon.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error('Amazon test reached an unexpected destination; inspect the browser.');
  }
}

export interface AmazonRehearsalOptions {
  manual(message: string): Promise<void>;
  log(message: string): void;
  accessTimeoutMs?: number;
}

async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  assertAmazon(page);
}

async function requireAccess(page: Page, options: AmazonRehearsalOptions): Promise<boolean> {
  const deadline = Date.now() + (options.accessTimeoutMs ?? 10 * 60_000);
  let waiting = false;
  while (Date.now() < deadline) {
    assertAmazon(page);
    // Read one DOM snapshot so navigation during manual login cannot mix pages.
    const state = await page.evaluate(() => {
      const challengeControl = Array.from(document.querySelectorAll<HTMLElement>(
        'input[type="password"], input[autocomplete="one-time-code"], #captchacharacters, iframe[src*="captcha" i]'))
        .some(element => element.getClientRects().length > 0);
      const body = document.body?.innerText ?? '';
      const account = document.querySelector<HTMLElement>('#nav-link-accountList-nav-line-1')?.innerText.trim() ?? '';
      return {
        blocked: /\/ap\/(?:signin|mfa|cvf)/i.test(location.pathname) ||
          challengeControl ||
          /enter the characters you see|verify (?:that )?you are human|click the button below to continue shopping/i.test(body) || /sign in/i.test(account),
        signedIn: !!account && !/sign in/i.test(account),
      };
    }).catch(error => {
      if (/Execution context was destroyed|Cannot find context/i.test(String(error))) return null;
      throw error;
    });
    assertAmazon(page);
    if (state && !state.blocked && (!waiting || state.signedIn)) {
      if (waiting) options.log('Amazon sign-in completed; resuming automatically.');
      return waiting;
    }
    if (state?.blocked && !waiting) {
      waiting = true;
      options.log('Complete Amazon sign-in and any MFA/access challenge in Chromium. Waiting up to 10 minutes; no terminal Enter is needed. Do not place an order.');
    }
    await page.waitForTimeout(250);
  }
  throw new Error('Amazon sign-in or access challenge was not confirmed complete before timeout.');
}

/** Restore only after a human login detour; never repeat a cart mutation. */
async function openWithAccess(page: Page, url: string, options: AmazonRehearsalOptions) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const resumed = await requireAccess(page, options);
    if (!resumed || new URL(page.url()).pathname === new URL(url).pathname) return;
    options.log('Returning to the requested Amazon page after sign-in.');
  }
  throw new Error('Amazon repeatedly redirected the requested page through sign-in.');
}

/** Refuse to involve or modify other existing cart items. */
export async function inspectAmazonCart(page: Page, expectedAsin: string): Promise<'EMPTY' | 'TARGET_ONLY'> {
  assertAmazon(page);
  const active = page.locator('#sc-active-cart');
  const rows = active.locator('[data-asin][data-itemtype="active"]:visible');
  const count = await rows.count();
  if (!count) {
    const empty = page.getByText(/^(?:Your (?:Amazon |Shopping )?Cart is empty|Your Amazon Cart is currently empty)[.!]?$/i).and(page.locator(':visible'));
    if (await empty.count()) return 'EMPTY';
    throw new Error(`Amazon cart contents could not be verified (path=${new URL(page.url()).pathname}; active containers=${await active.count()}; active rows=${count}; empty-cart message=false). No item was added.`);
  }
  if (count !== 1 || await rows.first().getAttribute('data-asin') !== expectedAsin) {
    throw new Error('Amazon cart contains other items or multiple lines. Leave them untouched and prepare an empty cart for this test.');
  }
  const quantities = await rows.first().evaluate(row => {
    const values: string[] = [];
    const attribute = row.getAttribute('data-quantity');
    if (attribute !== null) values.push(attribute);
    for (const input of row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select[name="quantity"], input[name="quantity"]')) values.push(input.value);
    return values;
  });
  if (!quantities.length || quantities.some(value => value.trim() !== '1')) throw new Error('Amazon cart quantity is not unambiguously one; no automatic cart changes.');
  return 'TARGET_ONLY';
}

/** Narrow action whitelist. There is intentionally no final-order action. */
async function clickPreparationControl(page: Page, locator: Locator, action: 'ADD' | 'CHECKOUT') {
  assertAmazon(page);
  if (await locator.count() !== 1) throw new Error(`Amazon ${action.toLowerCase()} control is missing or ambiguous.`);
  const label = await locator.evaluate(element => [element.getAttribute('value'), element.getAttribute('aria-label'),
    element.getAttribute('title'), element.textContent].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim());
  if (/place.*order|buy\s*now|pay\s*now|subscribe|start.*trial/i.test(label)) throw new Error('Refusing a purchase/subscription control in checkout rehearsal.');
  if (!(action === 'ADD' ? /add to (?:shopping )?cart/i : /proceed to checkout/i).test(label)) throw new Error('Unexpected Amazon control label; inspect the browser.');
  await locator.click({ timeout: 15000 });
  await settle(page);
}

export async function isAmazonOrderReview(page: Page, expectedAsin: string): Promise<boolean> {
  assertAmazon(page);
  if (!/\/(?:checkout|gp\/buy)(?:\/|$)/i.test(new URL(page.url()).pathname)) return false;
  const placeOrder = page.getByRole('button', { name: /^place (?:your )?order(?: in [A-Z]{3})?$/i }).and(page.locator(':visible'));
  if (!await placeOrder.count()) return false;
  const body = await page.locator('body').innerText();
  const productLinks = await page.locator('a[href*="/dp/"], a[href*="/gp/product/"]').evaluateAll(elements =>
    elements.filter(element => (element as HTMLElement).getClientRects().length > 0).map(element => (element as HTMLAnchorElement).href));
  const asins = productLinks.map(amazonProductAsin).filter((value): value is string => value !== null);
  const quantities = [...body.matchAll(/\b(?:Qty|Quantity)\s*:?\s*(\d+)\b/gi)].map(match => Number(match[1]));
  if (!asins.length || asins.some(asin => asin !== expectedAsin) || !quantities.length || quantities.some(qty => qty !== 1) || !/order total/i.test(body)) {
    throw new Error('Order-review screen reached, but the product, quantity or order total could not be verified. No order was placed.');
  }
  return true;
}

export async function runAmazonCheckoutRehearsal(page: Page, productUrl: string, options: AmazonRehearsalOptions): Promise<void> {
  const asin = amazonProductAsin(productUrl);
  if (!asin || !ASIN.test(asin)) throw new Error('A direct HTTPS amazon.com product URL is required.');
  const product = `https://www.amazon.com/dp/${asin}`;
  options.log(`Opening requested product: ${product}`);
  await openWithAccess(page, product, options);
  if (amazonProductAsin(page.url()) !== asin) throw new Error('Amazon product identity changed; no cart action taken.');
  await openWithAccess(page, CART, options);
  let initialCart: 'EMPTY' | 'TARGET_ONLY';
  try {
    initialCart = await inspectAmazonCart(page, asin);
  } catch (error) {
    // Keep the requested product available for inspection when cart markup is unknown.
    options.log(error instanceof Error ? error.message : 'Amazon cart inspection failed.');
    await openWithAccess(page, product, options);
    throw error;
  }
  if (initialCart === 'EMPTY') {
    await openWithAccess(page, product, options);
    if (amazonProductAsin(page.url()) !== asin) throw new Error('Amazon product identity changed; no cart action taken.');
    const add = page.locator('#add-to-cart-button:visible');
    await add.waitFor({ state: 'visible', timeout: 15000 });
    if (await add.count() !== 1) throw new Error('Amazon primary offer is ambiguous.');
    const evidence = await add.evaluate(element => {
      const form = element.closest('form');
      return {
        asin: form?.querySelector<HTMLInputElement>('input[name="ASIN"]')?.value,
        quantities: Array.from(form?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name="quantity"]') ?? []).map(input => input.value),
      };
    });
    if (evidence.asin !== asin || !evidence.quantities.length || evidence.quantities.some(value => value !== '1')) {
      throw new Error('Amazon offer ASIN/quantity is not unambiguously the requested product and one unit.');
    }
    options.log(`Adding one unit of ${asin} to the otherwise empty cart.`);
    await clickPreparationControl(page, add, 'ADD');
    // Never repeat an uncertain Add to cart action. Verify the resulting cart instead.
    await openWithAccess(page, CART, options);
  }
  if (await inspectAmazonCart(page, asin) !== 'TARGET_ONLY') throw new Error('Amazon did not confirm the requested cart item; no automatic repeat Add to cart.');
  const checkoutName = /^proceed to checkout(?:\s*\(\d+ items?\))?$/i;
  const checkout = page.getByRole('button', { name: checkoutName }).or(page.getByRole('link', { name: checkoutName })).and(page.locator(':visible'));
  await clickPreparationControl(page, checkout, 'CHECKOUT');
  for (let step = 0; step < 5; step++) {
    await requireAccess(page, options);
    if (await isAmazonOrderReview(page, asin)) {
      options.log('PASS: final order review shows the requested product, quantity one and an order total. Place your order was NOT clicked.');
      return;
    }
    await options.manual('Amazon needs a checkout step. Use your saved default delivery address and an existing payment method, then advance to the final order-review screen. Do NOT click Place your order, Buy Now, or accept a trial/subscription.');
    await settle(page);
  }
  throw new Error('Amazon final order review was not verified. No order was placed by the test.');
}
