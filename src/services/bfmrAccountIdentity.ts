import type { Page } from 'playwright';
import { isTrustedBfmrHost } from './bfmrUrl';
import { readRecentReservedRows, type TrackerReservationRow } from './bfmrTrackerApi';

/** Positive, operator-configured account evidence. Missing/unverified site selectors block writes.
 * A known reservation ID must exist both in this authenticated browser's tracker and the API.
 * The selector must target the account identity field, never general page/product text.
 */
export async function verifyBfmrAccountIdentity(page: Page, expectedAccount: string | undefined,
  readRows: () => Promise<TrackerReservationRow[]> = readRecentReservedRows,
  config = process.env): Promise<boolean> {
  const identitySelector = config.BFMR_ACCOUNT_IDENTITY_SELECTOR;
  const trackerUrl = config.BFMR_TRACKER_BROWSER_URL;
  const reserveId = config.BFMR_ACCOUNT_PROOF_RESERVE_ID;
  const rowSelector = config.BFMR_ACCOUNT_RESERVATION_SELECTOR;
  if (!expectedAccount?.trim() || !identitySelector || !trackerUrl || !reserveId || !rowSelector) return false;
  let proofPage: Page | undefined;
  try {
    const target = new URL(trackerUrl);
    const current = new URL(page.url());
    if (target.protocol !== 'https:' || target.username || target.password || target.port ||
        !isTrustedBfmrHost(target.hostname) || target.origin !== current.origin) return false;
    proofPage = await page.context().newPage();
    await proofPage.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (new URL(proofPage.url()).origin !== target.origin) return false;
    const identity = proofPage.locator(identitySelector);
    if (await identity.count() !== 1 || !await identity.isVisible()) return false;
    const text = (await identity.innerText()).trim().toLowerCase();
    if (text !== expectedAccount.trim().toLowerCase()) return false;
    const apiRows = (await readRows()).filter(row => String(row.reserve_id) === reserveId);
    if (apiRows.length !== 1 || !String(apiRows[0].deal_id ?? '').trim()) return false;
    const rows = proofPage.locator(rowSelector);
    const matching = [];
    for (const row of await rows.all()) {
      if (await row.isVisible() && await row.getAttribute('data-reserve-id') === reserveId) matching.push(row);
    }
    return matching.length === 1 && await matching[0].getAttribute('data-deal-id') === String(apiRows[0].deal_id);
  } catch { return false; }
  finally { await proofPage?.close().catch(() => {}); }
}
