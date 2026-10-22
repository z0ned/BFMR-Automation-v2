import type { Page } from 'playwright';

/** No guessed selector or generic signed-in greeting establishes account identity.
 * The operator must verify that this visible field identifies the active buying
 * account on the actual checkout/order-history layout before enabling its gate.
 */
export async function requireAmazonAccountIdentity(page: Page, expectedAccountEmail?: string, config = process.env): Promise<void> {
  const expected = expectedAccountEmail?.trim().toLowerCase();
  const selector = config.AMAZON_ACCOUNT_IDENTITY_SELECTOR?.trim();
  if (!expected || !selector || config.AMAZON_ACCOUNT_IDENTITY_CONTRACT_VALIDATED !== 'YES') {
    throw new Error('Verified Amazon account identity configuration is required before retailer actions.');
  }
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || !['amazon.com', 'www.amazon.com'].includes(url.hostname) ||
      url.username || url.password || url.port || /\/ap\/|captcha/i.test(url.pathname)) {
    throw new Error('Amazon account identity cannot be verified on this page.');
  }
  try {
    const identity = page.locator(selector);
    if (await identity.count() !== 1 || !await identity.isVisible() ||
        (await identity.innerText()).trim().toLowerCase() !== expected) throw new Error();
  } catch {
    throw new Error('The active Amazon account does not uniquely match the configured retailer account.');
  }
}
