import type { Locator, Page } from 'playwright';

export const AMAZON_TEST_PRODUCT = 'https://www.amazon.com/dp/B09JQMJHXY';
const AMAZON_TEST_PRODUCT_TITLE = 'Apple AirPods Pro (1st Generation) with MagSafe Charging Case';
export const AMAZON_PURCHASE_TEST_PRODUCT = 'https://www.amazon.com/dp/B0GTMJF7PV';
const AMAZON_PURCHASE_TEST_PRODUCT_TITLE = 'Google Fitbit Air - Screenless Activity Tracker, Berry';
const CART = 'https://www.amazon.com/gp/cart/view.html';
const ASIN = /^[A-Z0-9]{10}$/;
const giftMarkedPages = new WeakSet<Page>();

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
  let row: Locator | null = null;
  let count = await rows.count();

  // Amazon Business sometimes omits #sc-active-cart and/or the
  // data-itemtype="active" marker. Fall back to a visible cart line carrying
  // an ASIN and quantity evidence. Count all such lines so another item can
  // never be silently treated as an empty cart.
  if (!count) {
    const candidateRows = await page.locator('[data-asin]:visible').evaluateAll(elements => elements.filter(element => {
      const node = element as HTMLElement;
      return !!node.querySelector('select[name="quantity"], input[name="quantity"], [data-quantity], [aria-label*="quantity" i]') ||
        /^sc-item-/i.test(node.id);
    }).map(element => (element as HTMLElement).getAttribute('data-asin')));
    count = candidateRows.length;
    if (count === 1 && candidateRows[0] === expectedAsin) {
      row = page.locator(`[data-asin="${expectedAsin}"]:visible`).filter({
        has: page.locator('select[name="quantity"], input[name="quantity"], [data-quantity], [aria-label*="quantity" i]'),
      }).first();
      if (!await row.count()) row = page.locator(`[data-asin="${expectedAsin}"][id^="sc-item-"]:visible`).first();
    }
  }

  if (!count) {
    // Amazon Business may render the empty-cart message as ordinary copy,
    // outside the active-cart container and without heading semantics.
    const visibleText = await page.locator('body').innerText();
    const normalized = visibleText.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const emptyCart = /(?:your\s+)?(?:(?:amazon\s+business|amazon|shopping)\s+)?cart\s+(?:is\s+)?(?:currently\s+)?empty\b/i.test(normalized);
    if (emptyCart) return 'EMPTY';
    throw new Error(`Amazon cart contents could not be verified (path=${new URL(page.url()).pathname}; active containers=${await active.count()}; active rows=${await rows.count()}; cart-line candidates=${count}; visible empty-cart text=${emptyCart}). No item was added.`);
  }

  row ??= rows.first();
  const rowAsin = await row.getAttribute('data-asin');
  if (count !== 1 || rowAsin !== expectedAsin) {
    throw new Error('Amazon cart contains other items or multiple lines. Leave them untouched and prepare an empty cart for this test.');
  }
  const quantities = await row.evaluate(row => {
    const values: string[] = [];
    const attribute = row.getAttribute('data-quantity');
    if (attribute !== null) values.push(attribute);
    for (const input of row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select[name="quantity"], input[name="quantity"]')) values.push(input.value);
    return values;
  });
  if (!quantities.length || quantities.some(value => value.trim() !== '1')) throw new Error('Amazon cart quantity is not unambiguously one; no automatic cart changes.');
  return 'TARGET_ONLY';
}

/** Check the Amazon Business cart's order-level gift flag before checkout. */
export async function ensureAmazonCartGiftSelected(page: Page, log: (message: string) => void = () => {}): Promise<void> {
  assertAmazon(page);
  const visible = page.locator(':visible');
  const semantic = page.getByRole('checkbox', { name: /^this order contains a gift$/i }).and(visible);
  const semanticCount = await semantic.count();
  if (semanticCount > 1) throw new Error('Amazon showed multiple “This order contains a gift” checkboxes.');

  let checkbox: Locator | null = semanticCount === 1 ? semantic : null;
  if (!checkbox) {
    const inputs = page.locator('input[type="checkbox"]:visible');
    const matches = await inputs.evaluateAll(elements => elements.map((element, index) => {
      const input = element as HTMLInputElement;
      const labelText = Array.from(input.labels ?? []).map(label => label.innerText || label.textContent || '').join(' ');
      const nearbyText = input.parentElement?.innerText || '';
      return { index, matches: /\bthis order contains a gift\b/i.test(`${labelText} ${nearbyText}`) };
    }).filter(item => item.matches));
    if (matches.length > 1) throw new Error('Amazon showed multiple “This order contains a gift” checkboxes.');
    if (matches.length === 1) checkbox = inputs.nth(matches[0].index);
  }
  if (!checkbox) throw new Error('Amazon cart did not expose the “This order contains a gift” checkbox.');
  if (!await checkbox.isChecked()) {
    if (!await checkbox.isEnabled()) throw new Error('Amazon cart gift checkbox is disabled.');
    // Amazon overlays a decorative icon over the native checkbox, so a
    // pointer-based check is intercepted. Clicking its associated label
    // toggles the native control through Amazon's normal change handler.
    const clickedLabel = await checkbox.evaluate(element => {
      const input = element as HTMLInputElement;
      const label = Array.from(input.labels ?? []).find(candidate => candidate.getClientRects().length > 0);
      if (!label) return false;
      label.click();
      return true;
    });
    if (!clickedLabel) await checkbox.evaluate(element => (element as HTMLInputElement).click());
  }
  if (!await checkbox.isChecked()) throw new Error('Amazon did not confirm the cart-level gift checkbox.');
  log('Cart-level “This order contains a gift” is checked; waiting 2 seconds before checkout.');
  await page.waitForTimeout(2000);
  assertAmazon(page);
  if (!await checkbox.isChecked()) throw new Error('Amazon cleared the cart-level gift checkbox before checkout.');
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

/** Decline Amazon's optional protection offer only when its prompt appears. */
async function declineProtectionOfferIfPresent(page: Page) {
  assertAmazon(page);
  const noThanks = page.getByRole('button', { name: /^no thanks$/i });
  // The offer is conditional and can render shortly after the add-to-cart
  // response. A short wait handles that case without requiring the prompt.
  await noThanks.first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
  assertAmazon(page);
  const count = await noThanks.count();
  if (count === 0) return;
  if (count !== 1 || !await noThanks.isVisible()) {
    throw new Error('Amazon protection prompt appeared, but its No thanks control is ambiguous. Inspect the browser.');
  }
  await noThanks.click({ timeout: 5000 });
  await settle(page);
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

async function readRequestedProductTitle(page: Page, asin: string): Promise<string | null> {
  const preferred = page.locator('#productTitle:visible, #title_feature_div h1:visible');
  if (await preferred.count() === 1) return (await preferred.first().innerText()).replace(/\s+/g, ' ').trim();
  const headings = await page.locator('h1:visible').evaluateAll(elements => elements
    .map(element => (element as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
  if (headings.length === 1) return headings[0];
  if (asin === amazonProductAsin(AMAZON_TEST_PRODUCT)) return AMAZON_TEST_PRODUCT_TITLE;
  if (asin === amazonProductAsin(AMAZON_PURCHASE_TEST_PRODUCT)) return AMAZON_PURCHASE_TEST_PRODUCT_TITLE;
  return null;
}

async function readVisibleQuantityEvidence(page: Page, expectedTitle: string): Promise<number[]> {
  const selector = '[data-quantity], [role="spinbutton"], select[name*="quantity" i], input[name*="quantity" i], input[aria-label*="quantity" i], [class*="quantity" i], [data-a-selector*="quantity" i], [data-testid*="quantity" i]';
  const explicit = await page.locator(selector).evaluateAll(elements => {
    const values: number[] = [];
    for (const element of elements) {
      const node = element as HTMLElement;
      if (!node.getClientRects().length) continue;
      const candidates = [node.getAttribute('data-quantity'), node.getAttribute('aria-valuenow'),
        node.getAttribute('value'), (node as HTMLInputElement | HTMLSelectElement).value,
        node.innerText?.trim()];
      for (const candidate of candidates) {
        if (candidate && /^\d+$/.test(candidate.trim())) values.push(Number(candidate.trim()));
      }
    }
    return values;
  });
  if (explicit.length) return explicit;

  return page.evaluate(expectedTitle => {
    // Amazon Business renders the quantity as a numeral between remove and
    // increment buttons in the order-review item card, without quantity IDs.
    const title = expectedTitle.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const titleNodes = document.querySelectorAll<HTMLElement>('h1, h2, h3, a, span, p, div');
    for (const titleNode of titleNodes) {
      const titleText = (titleNode.innerText || titleNode.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
      // Amazon Business appends descriptive copy to the concise known title
      // fallback, so accept the exact title or a title that starts with it.
      if (!titleNode.getClientRects().length || (titleText !== title && !titleText.startsWith(title))) continue;
      let container: HTMLElement | null = titleNode;
      for (let depth = 0; container && depth < 9; depth++, container = container.parentElement) {
        let hasOne = false;
        const values = container.querySelectorAll<HTMLElement>('span, div, p, input, button');
        for (const value of values) {
          if (!value.getClientRects().length) continue;
          const valueText = (value.innerText || value.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
          if (valueText === '1' || (value as HTMLInputElement).value === '1') hasOne = true;
        }
        let hasQuantityAction = false;
        const buttons = container.querySelectorAll<HTMLElement>('button, [role="button"]');
        for (const button of buttons) {
          if (!button.getClientRects().length) continue;
          const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''} ${button.innerText ?? ''}`;
          if (/increase|decrease|quantity|remove|delete/i.test(label) || button.innerText.trim() === '+') hasQuantityAction = true;
        }
        if (hasOne && hasQuantityAction) return [1];
      }
    }
    return [];
  }, expectedTitle);
}

export interface AmazonOrderReviewEvidence {
  totalUsd: number;
  totalCents: number;
  giftSelected: boolean;
  freeNonPrimeDeliverySelected: boolean;
}

interface FreeNonPrimeDeliveryOption {
  index: number;
  label: string;
  checked: boolean;
  disabled: boolean;
}

async function freeNonPrimeDeliveryOptions(page: Page): Promise<FreeNonPrimeDeliveryOption[]> {
  const radios = page.locator('input[type="radio"]:visible');
  return radios.evaluateAll(elements => elements.map((element, index) => {
    const radio = element as HTMLInputElement;
    let optionLabel = Array.from(radio.labels ?? []).map(label => label.innerText || label.textContent || '').join(' ')
      .replace(/\s+/g, ' ').trim();
    if (!/\bfree\s+(?:shipping|delivery)\b/i.test(optionLabel) || /\bprime\b/i.test(optionLabel)) {
      let parent: HTMLElement | null = radio.parentElement;
      for (let depth = 0; parent && depth < 7; depth++, parent = parent.parentElement) {
        if (parent.querySelectorAll('input[type="radio"]').length !== 1) continue;
        const text = (parent.innerText || parent.textContent || '').replace(/\s+/g, ' ').trim();
        if (/\bfree\s+(?:shipping|delivery)\b/i.test(text) && !/\bprime\b/i.test(text)) {
          optionLabel = text;
          break;
        }
      }
    }
    return { index, label: optionLabel, checked: radio.checked, disabled: radio.disabled };
  }).filter(option => /\bfree\s+(?:shipping|delivery)\b/i.test(option.label) && !/\bprime\b/i.test(option.label)));
}

async function hasSelectedFreeNonPrimeDelivery(page: Page): Promise<boolean> {
  const selected = (await freeNonPrimeDeliveryOptions(page)).some(option => option.checked);
  if (!selected) return false;
  const body = await page.locator('body').innerText();
  const shipping = body.match(/\bshipping(?:\s*&\s*handling|\s+and\s+handling)?\s*:?\s*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (shipping && Number(shipping[1].replace(/,/g, '')) === 0) return true;
  if (/\bshipping(?:\s*&\s*handling|\s+and\s+handling)?\s*:?\s*free\b/i.test(body)) return true;
  if (shipping) {
    const charge = Number(shipping[1].replace(/,/g, ''));
    const credits = [...body.matchAll(/\bfree\s+shipping\s*:?\s*-\s*\$\s*([\d,]+(?:\.\d{2})?)/gi)]
      .reduce((sum, match) => sum + Number(match[1].replace(/,/g, '')), 0);
    if (charge > 0 && Math.round(credits * 100) === Math.round(charge * 100)) return true;
  }
  return false;
}

/** Select a delivery option that is free and has no Prime requirement in its option label. */
export async function ensureAmazonFreeNonPrimeDeliverySelected(page: Page, log: (message: string) => void = () => {}): Promise<void> {
  assertAmazon(page);
  const options = await freeNonPrimeDeliveryOptions(page);
  if (!options.length) throw new Error('Amazon did not expose a free delivery option that does not mention Prime.');
  if (await hasSelectedFreeNonPrimeDelivery(page)) return;

  const choice = options.find(option => option.checked && !option.disabled) ?? options.find(option => !option.disabled);
  if (!choice) throw new Error('All free non-Prime delivery options are disabled.');
  const radio = page.locator('input[type="radio"]:visible').nth(choice.index);
  log(`Selecting the free non-Prime delivery option: ${choice.label}`);
  await radio.click({ timeout: 10000 });
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await freeNonPrimeDeliveryOptions(page);
    const selected = current.find(option => option.index === choice.index)?.checked ?? false;
    if (selected && await hasSelectedFreeNonPrimeDelivery(page)) {
      log('Free non-Prime shipping is selected and reflected in the order total.');
      return;
    }
    await page.waitForTimeout(500);
  }
  const current = await freeNonPrimeDeliveryOptions(page);
  const selected = current.find(option => option.index === choice.index)?.checked ?? false;
  const body = await page.locator('body').innerText();
  throw new Error(`Amazon did not confirm free non-Prime shipping in the order summary (option selected=${selected}; free non-Prime options=${current.map(option => `${option.label} [checked=${option.checked}]`).join(' | ')}; order total=${parseAmazonOrderTotalUsd(body) ?? 'unreadable'}). No order was submitted.`);
}

async function visibleGiftCheckbox(page: Page): Promise<Locator | null> {
  const giftLabel = /(?:this (?:item )?is a gift|add gift options)/i;
  const accessible = page.getByRole('checkbox', { name: giftLabel }).and(page.locator(':visible'));
  const accessibleCount = await accessible.count();
  if (accessibleCount > 1) throw new Error('Amazon showed multiple visible gift-option checkboxes.');
  if (accessibleCount === 1) return accessible;

  const inputs = page.locator('input[type="checkbox"]:visible');
  const matches = await inputs.evaluateAll(elements => elements.map((element, index) => {
    const input = element as HTMLInputElement;
    const labels = Array.from(input.labels ?? []).map(label => label.innerText || label.textContent || '').join(' ');
    const parentText = input.parentElement?.innerText || '';
    return { index, text: `${input.getAttribute('aria-label') ?? ''} ${labels} ${parentText}` };
  }).filter(value => /(?:this (?:item )?is a gift|add gift options)/i.test(value.text)));
  if (matches.length > 1) throw new Error('Amazon showed multiple visible gift-option checkboxes.');
  return matches.length === 1 ? inputs.nth(matches[0].index) : null;
}

async function visibleAddGiftOptionsControl(page: Page): Promise<Locator | null> {
  const visible = page.locator(':visible');
  const semantic = page.getByRole('button', { name: /add\s+gift\s+options/i })
    .or(page.getByRole('link', { name: /add\s+gift\s+options/i })).and(visible);
  const semanticCount = await semantic.count();
  if (semanticCount > 1) throw new Error('Amazon showed multiple visible Add gift options controls.');
  if (semanticCount === 1) return semantic;

  const text = page.getByText(/add\s+gift\s+options/i).and(visible);
  const textCount = await text.count();
  if (textCount > 1) throw new Error('Amazon showed multiple visible Add gift options controls.');
  return textCount === 1 ? text : null;
}

async function visibleSaveGiftOptionsControls(page: Page): Promise<Locator> {
  const visible = page.locator(':visible');
  const semantic = page.getByRole('button', { name: /save\s+gift\s+options/i })
    .or(page.getByRole('link', { name: /save\s+gift\s+options/i })).and(visible);
  const semanticCount = await semantic.count();
  if (semanticCount > 2) throw new Error('Amazon showed more than two visible Save gift options controls.');
  if (semanticCount) return semantic;

  const controls = page.getByText(/save\s+gift\s+options/i).and(visible);
  const count = await controls.count();
  if (count > 2) throw new Error('Amazon showed more than two visible Save gift options controls.');
  return controls;
}

function isAmazonGiftOptionsEditor(page: Page): boolean {
  return /\/gift(?:\/|$)/i.test(new URL(page.url()).pathname);
}

async function amazonGiftEditorIsVisible(page: Page): Promise<boolean> {
  if (isAmazonGiftOptionsEditor(page)) return true;
  const heading = page.getByText(/^choose gift options$/i).and(page.locator(':visible'));
  if (await heading.count()) return true;
  return await (await visibleSaveGiftOptionsControls(page)).count() > 0;
}

async function lowestEnabledControl(controls: Locator): Promise<Locator | null> {
  let selected: Locator | null = null;
  let lowestY = Number.NEGATIVE_INFINITY;
  for (const control of await controls.all()) {
    if (!await control.isEnabled()) continue;
    const box = await control.boundingBox();
    if (box && box.y >= lowestY) {
      selected = control;
      lowestY = box.y;
    } else if (!box && !selected) {
      selected = control;
    }
  }
  return selected;
}

async function amazonGiftSelected(page: Page): Promise<boolean> {
  if (giftMarkedPages.has(page)) return true;
  const checkbox = await visibleGiftCheckbox(page);
  if (checkbox) return checkbox.isChecked();
  const body = await page.locator('body').innerText();
  return /\b(?:this order is a gift|gift options (?:selected|saved|added|edited)|gift options have been applied|gift receipt selected)\b/i.test(body);
}

export async function ensureAmazonGiftSelected(page: Page, log: (message: string) => void = () => {}): Promise<void> {
  assertAmazon(page);
  let saveControls = await visibleSaveGiftOptionsControls(page);
  let inGiftOptionsEditor = await amazonGiftEditorIsVisible(page);
  if (!inGiftOptionsEditor && await amazonGiftSelected(page)) return;

  let checkbox = await visibleGiftCheckbox(page);
  let clickedAddGiftOptions = false;
  if (!checkbox && !await saveControls.count()) {
    const addGiftOptions = await visibleAddGiftOptionsControl(page);
    if (!addGiftOptions) throw new Error('Amazon did not expose an Add gift options control or gift checkbox.');
    await addGiftOptions.scrollIntoViewIfNeeded({ timeout: 10000 });
    await addGiftOptions.click({ timeout: 10000 });
    clickedAddGiftOptions = true;
    assertAmazon(page);
    await page.waitForTimeout(300);
    checkbox = await visibleGiftCheckbox(page);
    inGiftOptionsEditor = await amazonGiftEditorIsVisible(page);
  }

  if (!checkbox && inGiftOptionsEditor) {
    throw new Error('Amazon gift-options editor did not expose a gift checkbox.');
  }
  if (checkbox && !await checkbox.isChecked()) {
    if (!await checkbox.isEnabled()) throw new Error('Amazon’s gift checkbox is disabled.');
    await checkbox.check({ timeout: 10000 });
  }
  if (checkbox && !await checkbox.isChecked()) throw new Error('Amazon did not confirm that its gift checkbox is selected.');

  saveControls = await visibleSaveGiftOptionsControls(page);
  inGiftOptionsEditor = await amazonGiftEditorIsVisible(page);
  const dialog = page.getByRole('dialog');
  if (await saveControls.count()) {
    // Amazon Business shows a summary Save button and the form's own Save
    // button. Click the lower form action visible beside the gift message.
    const save = await lowestEnabledControl(saveControls);
    if (!save) throw new Error('Amazon’s Save gift options controls are disabled.');
    await save.scrollIntoViewIfNeeded({ timeout: 10000 });
    log('Clicking the lower Save gift options control in the gift form.');
    await save.click({ timeout: 10000 });
    const placeOrder = page.getByRole('button', { name: /^place (?:your )?order\b/i }).and(page.locator(':visible'));
    let checkoutReturned = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      assertAmazon(page);
      const remainingSaveControls = await visibleSaveGiftOptionsControls(page);
      const editorStillVisible = await amazonGiftEditorIsVisible(page);
      let enabledPlaceOrder = false;
      for (const control of await placeOrder.all()) {
        if (await control.isEnabled()) {
          enabledPlaceOrder = true;
          break;
        }
      }
      if (!editorStillVisible && !await remainingSaveControls.count() && enabledPlaceOrder) {
        checkoutReturned = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    if (!checkoutReturned) {
      throw new Error(`Save gift options did not return to secure checkout (path=${new URL(page.url()).pathname}; visible save controls=${await (await visibleSaveGiftOptionsControls(page)).count()}). The gift editor is still open; no order was submitted.`);
    }
    log('Save gift options completed; secure checkout returned.');
    giftMarkedPages.add(page);
    return;
  }
  if (inGiftOptionsEditor || await dialog.count() === 1 && await dialog.isVisible()) {
    throw new Error('Amazon gift-options editor did not show a Save gift options control.');
  }
  if (!checkbox && clickedAddGiftOptions) {
    // Amazon Business applies the gift flag when its Add gift options control is selected.
    giftMarkedPages.add(page);
    return;
  }
  if (!await amazonGiftSelected(page)) {
    throw new Error('Amazon did not retain a verifiable gift selection. The order was not submitted.');
  }
  giftMarkedPages.add(page);
}

async function enabledPlaceOrderControl(page: Page): Promise<Locator | null> {
  const matches = page.getByRole('button', { name: /^place (?:your )?order\b/i }).and(page.locator(':visible'));
  const count = await matches.count();
  if (!count) return null;
  if (count > 2) throw new Error('Amazon showed more than two visible final order controls.');
  for (const match of await matches.all()) {
    if (await match.isEnabled()) return match;
  }
  throw new Error('Amazon’s visible final order controls are all disabled.');
}

export function parseAmazonOrderTotalUsd(body: string): number | null {
  const totals = [...body.matchAll(/\border total\b[\s\S]{0,80}?(?<![a-z])(?:us\s*)?\$\s*([0-9,]+(?:\.\d{2})?)/gi)];
  if (!totals.length || totals.some(total =>
    /\b(?:CAD|AUD|NZD|GBP|EUR|MXN|JPY|INR)\b|\b(?:CA|AU|NZ|MX)\s*\$/i.test(total[0]))) return null;
  const amounts = totals.map(total => Number(total[1].replace(/,/g, '')));
  const cents = amounts.map(amount => Math.round(amount * 100));
  if (cents.some(amount => !Number.isFinite(amount) || amount <= 0) || new Set(cents).size !== 1) return null;
  return cents[0] / 100;
}

export async function readAmazonOrderReview(
  page: Page,
  expectedAsin: string,
  expectedTitle: string | null,
  options: { requireGift?: boolean; requireFreeNonPrimeDelivery?: boolean } = {},
): Promise<AmazonOrderReviewEvidence | null> {
  assertAmazon(page);
  const path = new URL(page.url()).pathname;
  if (!/(?:^|\/)(?:checkout|gp\/buy)(?:\/|$)/i.test(path) || await amazonGiftEditorIsVisible(page)) return null;
  const saveGiftOptions = await visibleSaveGiftOptionsControls(page);
  if (await saveGiftOptions.count()) return null;
  const placeOrder = await enabledPlaceOrderControl(page);
  if (!placeOrder) return null;
  const body = await page.locator('body').innerText();
  const productLinks = await page.locator('a[href*="/dp/"], a[href*="/gp/product/"]').evaluateAll(elements =>
    elements.filter(element => (element as HTMLElement).getClientRects().length > 0).map(element => (element as HTMLAnchorElement).href));
  const asins = productLinks.map(amazonProductAsin).filter((value): value is string => value !== null);
  const linkedProductMatches = asins.includes(expectedAsin);
  const visibleTitleMatches = !!expectedTitle && normalizeVisibleText(body).includes(normalizeVisibleText(expectedTitle));
  const explicitQuantities = [...body.matchAll(/\b(?:Qty|Quantity)\s*:?\s*(\d+)\b/gi)].map(match => Number(match[1]));
  const widgetQuantities = await readVisibleQuantityEvidence(page, expectedTitle ?? '');
  const quantities = explicitQuantities.length ? explicitQuantities : widgetQuantities;
  const totalUsd = parseAmazonOrderTotalUsd(body);
  const giftSelected = await amazonGiftSelected(page);
  const freeNonPrimeDeliverySelected = await hasSelectedFreeNonPrimeDelivery(page);
  if ((!linkedProductMatches && !visibleTitleMatches) || !quantities.length || quantities.some(qty => qty !== 1) || totalUsd === null ||
    (options.requireGift && !giftSelected) || (options.requireFreeNonPrimeDelivery && !freeNonPrimeDeliverySelected)) {
    throw new Error(`Order-review screen reached, but evidence was incomplete (target link=${linkedProductMatches}; product title=${visibleTitleMatches}; quantity values=${quantities.length}; USD order total=${totalUsd !== null}; gift selected=${giftSelected}; free non-Prime delivery selected=${freeNonPrimeDeliverySelected}). No order was placed.`);
  }
  return { totalUsd, totalCents: Math.round(totalUsd * 100), giftSelected, freeNonPrimeDeliverySelected };
}

export async function isAmazonOrderReview(page: Page, expectedAsin: string, expectedTitle: string | null): Promise<boolean> {
  return (await readAmazonOrderReview(page, expectedAsin, expectedTitle)) !== null;
}

/** Complete a post-submit card-security prompt only when it is visibly present. */
async function completeAmazonCvvChallenge(page: Page, cvv: string | undefined): Promise<'NONE' | 'COMPLETED' | 'UNCERTAIN'> {
  const visible = page.locator(':visible');
  const inputs = page.locator([
    'input[autocomplete="cc-csc"]',
    'input[name*="cvv" i]', 'input[id*="cvv" i]', 'input[aria-label*="cvv" i]', 'input[placeholder*="cvv" i]',
    'input[name*="cvc" i]', 'input[id*="cvc" i]', 'input[aria-label*="cvc" i]', 'input[placeholder*="cvc" i]',
    'input[name*="securityCode" i]', 'input[id*="securityCode" i]', 'input[aria-label*="security code" i]', 'input[placeholder*="security code" i]',
  ].join(', ')).and(visible);
  const count = await inputs.count();
  if (!count) return 'NONE';
  if (count !== 1 || !cvv || !/^\d{3,4}$/.test(cvv)) return 'UNCERTAIN';

  const input = inputs.first();
  const form = input.locator('xpath=ancestor::form[1]');
  if (await form.count() !== 1) return 'UNCERTAIN';
  try {
    await input.fill(cvv, { timeout: 10000 });
    if (await input.inputValue() !== cvv) return 'UNCERTAIN';
  } catch {
    // Playwright fill errors can include the supplied value. Never propagate them.
    return 'UNCERTAIN';
  }

  const submitNames = /^(?:place (?:your )?order|submit(?: order)?|continue|confirm(?: order)?)$/i;
  const actions = form.getByRole('button', { name: submitNames }).or(form.locator('input[type="submit"]')).and(visible);
  if (await actions.count() !== 1 || !await actions.isEnabled()) return 'UNCERTAIN';
  // This is the completion of the already-authorized order flow after Amazon
  // explicitly requested the card security code. Never retry this action.
  try {
    await actions.click({ timeout: 15000 });
  } catch {
    return 'UNCERTAIN';
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  assertAmazon(page);
  return 'COMPLETED';
}

/** Explicitly authorized duplicate-warning continuation, never a generic submission retry. */
async function completeAmazonDuplicateOrderWarning(
  page: Page,
  expectedAsin: string,
  expectedTitle: string | null,
  confirmedTotalCents: number,
): Promise<'NONE' | 'COMPLETED' | 'UNCERTAIN'> {
  assertAmazon(page);
  if (!/^\/checkout\/[^?#]*\/duplicateOrder\/?$/i.test(new URL(page.url()).pathname)) return 'NONE';
  const body = await page.locator('body').innerText();
  if (!/\bthis is a pending order\b/i.test(body) ||
    !/you placed an order for these items recently\.\s*do you want to place the same order again\?/i.test(body)) return 'NONE';
  const productLinks = await page.locator('a[href*="/dp/"], a[href*="/gp/product/"]').evaluateAll(elements =>
    elements.filter(element => (element as HTMLElement).getClientRects().length > 0).map(element => (element as HTMLAnchorElement).href));
  const asins = [...new Set(productLinks.map(amazonProductAsin).filter(value => value !== null))];
  if (asins.some(asin => asin !== expectedAsin) ||
    (!asins.includes(expectedAsin) && !(expectedTitle && normalizeVisibleText(body).includes(normalizeVisibleText(expectedTitle).split(/\s*\|\s*/)[0])))) return 'NONE';
  const prices = [...body.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map(match => Math.round(Number(match[1].replace(/,/g, '')) * 100));
  if (!prices.length || prices.some(price => price <= 0 || price > confirmedTotalCents)) return 'NONE';
  const button = page.getByRole('button', { name: /^place your order$/i })
    .or(page.getByRole('link', { name: /^place your order$/i })).and(page.locator(':visible'));
  if (await button.count() !== 1 || !await button.isEnabled()) return 'NONE';
  try {
    await button.click({ timeout: 15000 });
  } catch {
    return 'UNCERTAIN';
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  assertAmazon(page);
  return 'COMPLETED';
}

export async function submitAmazonOrderOnce(
  page: Page,
  expectedAsin: string,
  expectedTitle: string | null,
  amazonDefaultCardCvv?: string,
  limits?: { maxTotalCents: number; confirmedTotalCents: number; log?: (message: string) => void },
): Promise<'PLACED' | 'UNCERTAIN'> {
  assertAmazon(page);
  const path = new URL(page.url()).pathname;
  if (!/(?:^|\/)(?:checkout|gp\/buy)(?:\/|$)/i.test(path)) {
    throw new Error(`Final submission recheck failed: Amazon is no longer on a checkout route (path=${path}). No order was submitted.`);
  }
  if (isAmazonGiftOptionsEditor(page)) {
    throw new Error(`Final submission recheck failed: Amazon's gift editor is still open (path=${path}). Save gift options before continuing; no order was submitted.`);
  }
  const evidence = await readAmazonOrderReview(page, expectedAsin, expectedTitle, {
    requireGift: true,
    requireFreeNonPrimeDelivery: true,
  });
  if (!evidence) {
    throw new Error(`Final submission recheck failed: no enabled Place your order control was found on checkout (path=${path}). No order was submitted.`);
  }
  if (!limits || !Number.isSafeInteger(limits.maxTotalCents) || limits.maxTotalCents <= 0 ||
    limits.maxTotalCents > 10000 || evidence.totalCents > limits.maxTotalCents ||
    evidence.totalCents !== limits.confirmedTotalCents) {
    throw new Error('Final order total exceeds the permitted limit or differs from the confirmed total. No order was submitted.');
  }
  const primaryPlaceOrder = await enabledPlaceOrderControl(page);
  if (!primaryPlaceOrder) throw new Error('Amazon final order button is no longer visible; refusing to submit.');

  // A timed-out click may still have placed the order. Observe confirmation,
  // but never click again or complete another purchase action after uncertainty.
  let actionsUncertain = false;
  try {
    await primaryPlaceOrder.click({ timeout: 15000 });
  } catch {
    actionsUncertain = true;
  }
  let duplicateAttempted = false;
  let cvvAttempted = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assertAmazon(page);
    // Read the URL and confirmation from the same DOM snapshot; Amazon can
    // navigate or render the thank-you message after the click has returned.
    const state = await page.evaluate(({ asin, title }) => {
      const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const confirmation = /\b(?:thank you,? your order has been placed|your order(?: on behalf of .+?)? has been placed|order placed|order confirmed)\b/i.test(body);
      const targetPresent = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).some(link =>
        link.getClientRects().length > 0 &&
        new URL(link.href).pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1].toUpperCase() === asin) ||
        !!title && body.toLowerCase().includes(title.replace(/\s+/g, ' ').trim().toLowerCase());
      return { path: location.pathname, confirmation, targetPresent };
    }, { asin: expectedAsin, title: expectedTitle }).catch(error => {
      if (/Execution context was destroyed|Cannot find context/i.test(String(error))) return null;
      throw error;
    });
    if (state) {
      const thankYouPage = /\/gp\/buy\/thankyou\//i.test(state.path);
      if (state.confirmation && (state.targetPresent || thankYouPage)) return 'PLACED';
      if (!actionsUncertain) {
        if (/\/duplicateOrder\/?$/i.test(state.path)) {
          if (!duplicateAttempted) {
            const result = await completeAmazonDuplicateOrderWarning(page, expectedAsin, expectedTitle, limits.confirmedTotalCents);
            if (result !== 'NONE') duplicateAttempted = true;
            if (result === 'COMPLETED') limits.log?.('Duplicate-order warning confirmed; clicked Place your order once. Waiting for confirmation.');
            if (result === 'UNCERTAIN') {
              actionsUncertain = true;
              limits.log?.('Duplicate-order continuation click was uncertain; observing only, without retry.');
            }
          }
        } else if (!cvvAttempted) {
          const result = await completeAmazonCvvChallenge(page, amazonDefaultCardCvv);
          if (result !== 'NONE') cvvAttempted = true;
          if (result === 'UNCERTAIN') actionsUncertain = true;
        }
      }
    }
    await page.waitForTimeout(500);
  }
  limits.log?.(`Confirmation wait expired (duplicate continuation attempted=${duplicateAttempted}; CVV continuation attempted=${cvvAttempted}; uncertain action=${actionsUncertain}). No submission will be retried.`);
  return 'UNCERTAIN';
}

/** Read-only follow-up after a confirmed purchase; never use the thank-you purchaseId as an order number. */
export async function retrieveAmazonOrderId(
  page: Page,
  expectedAsin: string,
  expectedTitle: string | null,
  expectedTotalCents: number,
): Promise<string> {
  assertAmazon(page);
  const orders = page.getByRole('link', { name: /returns\s*(?:&|and)\s*orders/i }).and(page.locator(':visible'));
  const navOrders = page.locator('a#nav-orders:visible');
  const control = await orders.count() === 1 ? orders : navOrders;
  if (await control.count() !== 1) throw new Error('Order placed, but Returns and Orders could not be identified. Do not repeat the purchase.');
  const destination = await control.getAttribute('href');
  const url = new URL(destination ?? '', page.url());
  if (url.protocol !== 'https:' || !['amazon.com', 'www.amazon.com'].includes(url.hostname) ||
    url.username || url.password || url.port || !/\/(?:gp\/css\/order-history|your-orders\/orders)(?:\/|$)/i.test(url.pathname)) {
    throw new Error('Order placed, but the Orders navigation destination was unexpected. Do not repeat the purchase.');
  }
  await control.click({ timeout: 15000 });
  await settle(page);
  for (let attempt = 0; attempt < 20; attempt++) {
    assertAmazon(page);
    if (!/\/(?:gp\/css\/order-history|your-orders\/orders)(?:\/|$)/i.test(new URL(page.url()).pathname)) break;
    const candidate = await page.evaluate(({ asin, title }) => {
      // Keep browser-evaluated code free of named local functions: tsx/esbuild
      // can inject a __name helper that is unavailable in Playwright's page context.
      const normalizedTitle = title?.replace(/\s+/g, ' ').trim().toLowerCase();
      // Product links are traversed in displayed order (newest first). Ascend only
      // to the enclosing order section, never read an ID from a neighbouring order.
      for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        if (!link.getClientRects().length) continue;
        const productAsin = new URL(link.href).pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1].toUpperCase();
        if (productAsin !== asin && !(normalizedTitle && link.innerText.replace(/\s+/g, ' ').trim().toLowerCase() === normalizedTitle)) continue;
        let section: HTMLElement | null = link.parentElement;
        for (let depth = 0; section && depth < 12; depth++, section = section.parentElement) {
          const text = section.innerText;
          const ids = [...text.matchAll(/\bOrder\s*#\s*(\d{3}-\d{7}-\d{7})\b/gi)].map(match => match[1]);
          if (new Set(ids).size > 1) break;
          if (ids.length && /\border placed\b/i.test(text)) {
            const total = text.match(/\bTotal\s*(?:US\s*)?\$\s*([\d,]+\.\d{2})/i);
            return { orderId: ids[0], totalCents: total ? Math.round(Number(total[1].replace(/,/g, '')) * 100) : null };
          }
        }
      }
      return null;
    }, { asin: expectedAsin, title: expectedTitle });
    if (candidate) {
      if (candidate.totalCents !== expectedTotalCents) {
        throw new Error('Order placed, but the newest matching order total differs from the purchase. Inspect Orders; do not repeat the purchase.');
      }
      return candidate.orderId;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Order placed, but its Order # could not be verified in Orders. Inspect Orders; do not repeat the purchase.');
}

export async function runAmazonCheckoutRehearsal(page: Page, productUrl: string, options: AmazonRehearsalOptions): Promise<string | null> {
  const asin = amazonProductAsin(productUrl);
  if (!asin || !ASIN.test(asin)) throw new Error('A direct HTTPS amazon.com product URL is required.');
  const product = `https://www.amazon.com/dp/${asin}`;
  options.log('Opening Amazon cart first; an empty cart is required before preparing the product.');
  await openWithAccess(page, CART, options);
  if (await inspectAmazonCart(page, asin) !== 'EMPTY') {
    throw new Error('Amazon cart is not empty. Leave existing items untouched and empty the cart before running this test. No item was added.');
  }
  options.log(`Cart verified empty. Opening requested product: ${product}`);
  await openWithAccess(page, product, options);
  if (amazonProductAsin(page.url()) !== asin) throw new Error('Amazon product identity changed; no cart action taken.');
  const expectedTitle = await readRequestedProductTitle(page, asin);
  const add = page.locator('#add-to-cart-button:visible');
  if (await add.count() !== 1) {
    const availability = await page.locator('body').innerText().catch(() => '');
    if (/cannot be shipped to your selected delivery location|currently unavailable|out of stock/i.test(availability)) {
      throw new Error('The selected Amazon delivery location cannot receive this item or the offer is unavailable. No item was added.');
    }
    throw new Error('Amazon did not show one unambiguous Add to cart control. No item was added.');
  }
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
  await declineProtectionOfferIfPresent(page);
  // Never repeat an uncertain Add to cart action. Verify the resulting cart instead.
  await openWithAccess(page, CART, options);
  if (await inspectAmazonCart(page, asin) !== 'TARGET_ONLY') throw new Error('Amazon did not confirm the requested cart item; no automatic repeat Add to cart.');
  await ensureAmazonCartGiftSelected(page, options.log);
  const checkoutName = /^proceed to checkout(?:\s*\(\d+ items?\))?$/i;
  // Amazon's cart sidebar uses a named submit input inside this container;
  // Amazon Business may not expose it through the same role/name mapping.
  const sidebarSubmit = page.locator('input#sc-buy-box-ptc-button-announce:visible, #sc-buy-box-ptc-button input[name="proceedToRetailCheckout"]:visible');
  const sidebarCount = await sidebarSubmit.count();
  let checkout: Locator;
  if (sidebarCount === 1) {
    checkout = sidebarSubmit;
  } else if (sidebarCount > 1) {
    throw new Error('Amazon has multiple visible checkout submit controls in the cart sidebar. Inspect the browser.');
  } else {
    const roleCheckout = page.getByRole('button', { name: checkoutName })
      .or(page.getByRole('link', { name: checkoutName })).and(page.locator(':visible'));
    const roleCount = await roleCheckout.count();
    if (roleCount !== 1) {
      throw new Error(`Amazon checkout control could not be uniquely identified (path=${new URL(page.url()).pathname}; sidebar=${await page.locator('#sc-buy-box-ptc-button').count()}; named submit=${await page.locator('input[name="proceedToRetailCheckout"]:visible').count()}; visible role matches=${roleCount}).`);
    }
    checkout = roleCheckout;
  }
  await clickPreparationControl(page, checkout, 'CHECKOUT');
  for (let step = 0; step < 5; step++) {
    await requireAccess(page, options);
    if (await amazonGiftEditorIsVisible(page)) {
      options.log('Amazon opened the gift-options screen; saving the selected gift options before continuing.');
      await ensureAmazonGiftSelected(page, options.log);
      continue;
    }
    if (await isAmazonOrderReview(page, asin, expectedTitle)) {
      options.log('Amazon reached the final order-review screen; Place your order was NOT clicked.');
      return expectedTitle;
    }
    await options.manual('Amazon needs a checkout step. Select the intended saved delivery address and payment method, then advance to the final order-review screen. Do NOT click Place your order, Buy Now, or accept a trial/subscription.');
    await settle(page);
  }
  throw new Error('Amazon final order review was not verified. No order was placed by the test.');
}
