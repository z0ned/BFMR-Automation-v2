import type { Page } from 'playwright';
import type { AmazonOrderRecord, TrackedPackage } from './amazonOrderLedger';
import { requireAmazonAccountIdentity } from './amazonAccountIdentity';

const ORDERS_URL = 'https://www.amazon.com/gp/css/order-history';

function amazonUrl(value: string, base = ORDERS_URL): string {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || !['amazon.com', 'www.amazon.com'].includes(url.hostname) ||
    url.username || url.password || url.port) throw new Error('Amazon tracking navigation reached an unexpected destination.');
  return url.href;
}

function assertAmazonPage(page: Page) {
  const url = amazonUrl(page.url());
  if (/\/ap\/(?:signin|mfa|cvf)|captcha/i.test(new URL(url).pathname)) {
    throw new Error('Amazon sign-in or access challenge requires manual attention; tracking was not changed.');
  }
}

export function trackingNumbersFromText(text: string): string[] {
  const values = [...text.matchAll(/\b(?:tracking\s*(?:number|no\.?|id|#))\s*[:#-]?\s*([A-Z0-9-]{8,40})\b/gi)]
    .map((match) => match[1].toUpperCase())
    .filter((value) => /\d/.test(value) && !/^(?:AVAILABLE|DELIVERED|SHIPMENTS?)$/i.test(value));
  return [...new Set(values)];
}

interface OrderCard {
  totalCents: number | null;
  status: 'PENDING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'UNKNOWN';
  trackHrefs: string[];
  trackControlsWithoutHref: number;
}

/** Only a visible product link inside a card bearing the exact Amazon Order # qualifies. */
async function findExactOrderCard(page: Page, order: AmazonOrderRecord): Promise<OrderCard | null> {
  return page.evaluate(({ orderId, asin }) => {
    const results: OrderCard[] = [];
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (!link.getClientRects().length) continue;
      let productAsin: string | undefined;
      try { productAsin = new URL(link.href).pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase(); }
      catch { continue; }
      if (productAsin !== asin) continue;
      let section: HTMLElement | null = link.parentElement;
      for (let depth = 0; section && depth < 12; depth++, section = section.parentElement) {
        const visible = section.innerText;
        const ids = [...visible.matchAll(/\bOrder\s*#\s*(\d{3}-\d{7}-\d{7})\b/gi)].map((match) => match[1]);
        if (!ids.length) continue;
        if (new Set(ids).size !== 1 || ids[0] !== orderId) break;
        if (!/\border placed\b/i.test(visible)) continue;
        const total = visible.match(/\bTotal\s*(?:US\s*)?\$\s*([\d,]+\.\d{2})/i);
        const links = [...section.querySelectorAll<HTMLAnchorElement>('a')].filter((node) =>
          node.getClientRects().length > 0 && /\btrack\s+package\b/i.test(node.innerText));
        const buttons = [...section.querySelectorAll<HTMLButtonElement>('button')].filter((node) =>
          node.getClientRects().length > 0 && /\btrack\s+package\b/i.test(node.innerText));
        results.push({
          totalCents: total ? Math.round(Number(total[1].replace(/,/g, '')) * 100) : null,
          status: /\bcancelled\b|\bcanceled\b/i.test(visible) ? 'CANCELLED' :
            /\bnot (?:yet )?shipped\b/i.test(visible) ? 'PENDING' :
            /\bdelivered\b/i.test(visible) && !/\bnot (?:yet )?delivered\b/i.test(visible) ? 'DELIVERED' :
              /\bshipped\b|\btrack\s+package\b/i.test(visible) ? 'SHIPPED' :
                /\barriving\b|\border placed\b/i.test(visible) ? 'PENDING' : 'UNKNOWN',
          trackHrefs: links.map((node) => node.getAttribute('href') || '').filter(Boolean),
          trackControlsWithoutHref: links.filter((node) => !node.getAttribute('href')).length + buttons.length,
        });
        break;
      }
    }
    const unique = [...new Map(results.map((result) => [JSON.stringify(result), result])).values()];
    return unique.length === 1 ? unique[0] : null;
  }, { orderId: order.orderId, asin: order.asin });
}

/** Read-only Amazon website lookup. Unknown layouts never yield tracking data. */
export async function checkAmazonShipment(page: Page, order: AmazonOrderRecord, now = new Date()): Promise<AmazonOrderRecord> {
  page.setDefaultTimeout(10_000);
  const deadline = Date.now() + 90_000;
  await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  assertAmazonPage(page);
  await requireAmazonAccountIdentity(page);
  let card: OrderCard | null = null;
  const visited = new Set<string>();
  for (let index = 0; index < 10; index++) {
    if (Date.now() >= deadline) throw new Error('Amazon order-history lookup exceeded 90 seconds; returning browser priority to email intake.');
    assertAmazonPage(page);
    const current = amazonUrl(page.url());
    if (visited.has(current)) break;
    visited.add(current);
    for (let renderAttempt = 0; renderAttempt < 5 && !card; renderAttempt++) {
      card = await findExactOrderCard(page, order);
      if (!card && renderAttempt < 4) await page.waitForTimeout(500);
    }
    if (card) break;
    const next = page.getByRole('link', { name: /^next(?: page)?$/i }).and(page.locator(':visible'));
    if (await next.count() !== 1) break;
    const href = await next.getAttribute('href');
    if (!href) break;
    const destination = amazonUrl(href, current);
    if (!/\/gp\/css\/order-history|\/your-orders\/orders/i.test(new URL(destination).pathname)) break;
    await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(15_000, deadline - Date.now())) });
  }
  if (!card) throw new Error(`Amazon order ${order.orderId} was not uniquely found with the expected ASIN in Orders.`);
  if (card.totalCents !== order.totalCents) throw new Error(`Amazon order ${order.orderId} total does not match the recorded purchase.`);
  if (card.status === 'CANCELLED') throw new Error(`Amazon order ${order.orderId} is cancelled; review the BFMR reservation.`);
  if (card.trackControlsWithoutHref) throw new Error(`Amazon order ${order.orderId} has a tracking control that cannot be safely opened read-only.`);
  if (card.status === 'UNKNOWN') throw new Error(`Amazon order ${order.orderId} has an unrecognized shipment status.`);
  if (card.trackHrefs.length > 12) throw new Error(`Amazon order ${order.orderId} has more tracking links than this bounded lookup supports.`);

  const observed = new Map<string, TrackedPackage>();
  let allLinksHaveDeliveredTracking = card.trackHrefs.length > 0;
  const historyUrl = page.url();
  for (const href of [...new Set(card.trackHrefs)]) {
    if (Date.now() >= deadline) throw new Error('Amazon package lookup exceeded 90 seconds; returning browser priority to email intake.');
    const destination = amazonUrl(href, historyUrl);
    await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(15_000, deadline - Date.now())) });
    assertAmazonPage(page);
    let visible = '';
    for (let renderAttempt = 0; renderAttempt < 5; renderAttempt++) {
      visible = await page.locator('body').innerText();
      if (trackingNumbersFromText(visible).length || renderAttempt === 4) break;
      await page.waitForTimeout(500);
    }
    const otherIds = [...visible.matchAll(/\bOrder\s*#\s*(\d{3}-\d{7}-\d{7})\b/gi)].map((match) => match[1]);
    if (otherIds.some((id) => id !== order.orderId)) throw new Error('Tracking page shows a different Amazon order ID.');
    const delivered = /\bdelivered\b/i.test(visible) && !/\bnot (?:yet )?delivered\b/i.test(visible);
    const carrier = visible.match(/\b(?:shipped with|carrier)\s*[:]?\s*(Amazon(?: Logistics)?|UPS|USPS|FedEx|DHL)\b/i)?.[1] ?? null;
    const numbers = trackingNumbersFromText(visible);
    if (!delivered || !numbers.length) allLinksHaveDeliveredTracking = false;
    for (const trackingNumber of numbers) {
      const previous = order.packages.find((pkg) => pkg.trackingNumber === trackingNumber);
      observed.set(trackingNumber, {
        trackingNumber,
        carrier: carrier ?? previous?.carrier ?? null,
        status: delivered ? 'DELIVERED' : 'SHIPPED',
        firstSeenAt: previous?.firstSeenAt ?? now.toISOString(),
        lastSeenAt: now.toISOString(),
      });
    }
  }
  const packages = [...order.packages];
  for (const pkg of observed.values()) {
    const index = packages.findIndex((item) => item.trackingNumber === pkg.trackingNumber);
    if (index >= 0) packages[index] = pkg;
    else packages.push(pkg);
  }
  return {
    ...order,
    status: card.status === 'DELIVERED' && allLinksHaveDeliveredTracking ? 'DELIVERED' :
      card.status === 'SHIPPED' || card.status === 'DELIVERED' || packages.length ? 'SHIPPED' : 'PENDING',
    packages,
    lastError: undefined,
  };
}
