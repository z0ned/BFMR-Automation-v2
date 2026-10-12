import type { PlaywrightBfmrBrowser } from '../adapters/playwrightBrowser';
import type { Page } from 'playwright';
import type { AmazonOrderRecord } from './amazonOrderLedger';
import { amazonOrderLedger } from './amazonOrderLedger';
import { checkAmazonShipment } from './amazonShipmentCheck';

/** Atlanta observes EST and EDT; use its IANA zone rather than a fixed UTC offset. */
export function atlantaDayAndHour(instant: Date): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const hour = Number(value('hour'));
  if (!year || !month || !day || !Number.isInteger(hour)) throw new Error('Cannot calculate Atlanta tracking time.');
  return { day: `${year}-${month}-${day}`, hour };
}

export async function runDueAmazonTracking(options: {
  browser: PlaywrightBfmrBrowser;
  ledger: ReturnType<typeof amazonOrderLedger>;
  hasIncomingMail: () => Promise<boolean>;
  onOrderFailure: (order: AmazonOrderRecord, error: unknown) => Promise<void>;
  now?: () => Date;
  checkShipment?: (page: Page, order: AmazonOrderRecord, now: Date) => Promise<AmazonOrderRecord>;
  afterCheck?: (order: AmazonOrderRecord) => Promise<void>;
}): Promise<void> {
  const { day, hour } = atlantaDayAndHour(options.now?.() ?? new Date());
  if (hour < 3) return;
  const due = (await options.ledger.load()).filter((order) => {
    const purchased = atlantaDayAndHour(new Date(order.purchasedAt));
    const needsBfmrSubmission = Boolean(order.reserveId && order.packages.length === 1 && !order.bfmrTrackingSubmittedAt);
    return (order.status !== 'DELIVERED' || needsBfmrSubmission) && order.lastCheckedAtlantaDay !== day &&
      order.lastAttemptAtlantaDay !== day && (purchased.day < day || (purchased.day === day && purchased.hour < 3));
  });
  for (const order of due) {
    // Gmail intake owns the browser's priority. Finish at most the current
    // read-only order lookup when an email arrives during a tracking check.
    if (await options.hasIncomingMail()) return;
    const page = await options.browser.createRetailerTab();
    try {
      const checked = await (options.checkShipment ?? checkAmazonShipment)(page, order, options.now?.() ?? new Date());
      checked.lastCheckedAtlantaDay = day;
      checked.lastAttemptAtlantaDay = day;
      await options.ledger.update(checked);
      await options.afterCheck?.(checked);
      console.log(`[Amazon tracking] ${order.orderId}: ${checked.status}; ${checked.packages.length} tracking number(s) recorded.`);
    } catch (error) {
      const current = (await options.ledger.load()).find((item) => item.orderId === order.orderId) ?? order;
      const failed = { ...current, lastAttemptAtlantaDay: day,
        lastError: error instanceof Error ? error.message.slice(0, 240) : 'Unknown Amazon tracking error' };
      await options.ledger.update(failed);
      await options.onOrderFailure(order, error);
    } finally {
      await page.close().catch(() => {});
    }
  }
}
