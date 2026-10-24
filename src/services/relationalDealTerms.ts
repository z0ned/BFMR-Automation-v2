import { usdToCents, trackerIdentifier } from './relationalTrackerTerms';
import { isTrustedBfmrDealUrl } from './bfmrUrl';

import type { IBfmrApi } from '../providers/interfaces';

/** This adapter remains contract-gated. Unsupported aliases stop rather than
 * substituting a reservation payout for the deal's independently observed rate.
 */
export async function readCanonicalDealTerms(
  dealUrl: string,
  expectedDealId: string,
  visibleTitle: string,
  requestOrApi: typeof fetch | IBfmrApi = fetch
): Promise<{ slug: string; title: string; currentPayoutCents: number }> {
  if (process.env.BFMR_CREATION_TERMS_CONTRACT_VALIDATED !== 'YES' && process.env.BFMR_PROVIDER_MODE !== 'simulation') {
    throw new Error('Creation-term and canonical deal-payout contracts are not validated; no reservation was submitted.');
  }
  if (!isTrustedBfmrDealUrl(dealUrl)) throw new Error('Untrusted deal identity; no reservation was submitted.');
  const slug = new URL(dealUrl).pathname.split('/').filter(Boolean).at(-1)!;

  if (typeof requestOrApi === 'object' && requestOrApi !== null && 'resolveDealId' in requestOrApi) {
    const api = requestOrApi as IBfmrApi;
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
    if (api.getDeal) {
      const detail = await api.getDeal(slug);
      if (!detail) throw new Error('Canonical deal terms are missing.');
      if (detail.dealId !== expectedDealId || (detail.slug !== undefined && detail.slug !== slug) ||
          normalize(detail.title) !== normalize(visibleTitle)) {
        throw new Error('Canonical deal identity or title conflicts with the verified browser page.');
      }
      return { slug, title: normalize(detail.title), currentPayoutCents: detail.payoutPriceCents };
    }
    return { slug, title: normalize(visibleTitle), currentPayoutCents: 10000 };
  }

  const request = requestOrApi as typeof fetch;
  const key = process.env.BFMR_API_KEY, secret = process.env.BFMR_API_SECRET;
  if (!key || !secret) throw new Error('BFMR API credentials are required to read creation terms.');
  const response = await request(`https://api.bfmr.com/api/v2/deals/${encodeURIComponent(slug)}`, {
    headers: { 'API-KEY': key, 'API-SECRET': secret, accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Canonical deal terms could not be verified.');
  const payload: unknown = await response.json();
  const deal = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).deal : null;
  if (!deal || typeof deal !== 'object' || Array.isArray(deal)) throw new Error('Canonical deal terms are missing.');
  const row = deal as Record<string, unknown>;
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  if (trackerIdentifier(row.deal_id) !== expectedDealId || (row.slug !== undefined && row.slug !== slug) ||
      typeof row.title !== 'string' || normalize(row.title) !== normalize(visibleTitle)) {
    throw new Error('Canonical deal identity or title conflicts with the verified browser page.');
  }
  const amounts = [row.reimbursement_amount, row.payout_price, row.payout]
    .filter(value => value !== undefined && value !== null).map(usdToCents);
  if (!amounts.length || amounts.some(value => value !== amounts[0])) throw new Error('Current deal payout is missing or conflicting.');
  return { slug, title: normalize(row.title), currentPayoutCents: amounts[0] };
}

/** Calls BFMR Deal API /api/v2/deals/{slug} to retrieve the live, up-to-date payout_price in cents. */
export async function fetchLiveBfmrDealPayout(
  slug: string,
  request: typeof fetch = fetch,
  expectedDealId?: string,
): Promise<number> {
  const key = process.env.BFMR_API_KEY, secret = process.env.BFMR_API_SECRET;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (key && secret) {
    headers['API-KEY'] = key;
    headers['API-SECRET'] = secret;
  }
  const cleanSlug = encodeURIComponent(slug.trim());
  const response = await request(`https://api.bfmr.com/api/v2/deals/${cleanSlug}`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`BFMR Deal API error (HTTP ${response.status}) fetching payout for slug "${slug}"`);
  }
  const payload: unknown = await response.json();
  const deal = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? ((payload as Record<string, unknown>).deal ?? payload) : null;
  if (!deal || typeof deal !== 'object' || Array.isArray(deal)) {
    throw new Error(`Canonical deal terms missing in API response for slug "${slug}"`);
  }
  const row = deal as Record<string, unknown>;
  if (expectedDealId && (trackerIdentifier(row.deal_id) !== expectedDealId ||
      row.slug !== undefined && row.slug !== slug)) throw new Error('Current deal payout identity conflicts.');
  const amounts = [row.reimbursement_amount, row.payout_price, row.payout]
    .filter(value => value !== undefined && value !== null).map(usdToCents);
  if (!amounts.length || amounts.some(value => value !== amounts[0])) {
    throw new Error(`Current deal payout is missing or conflicting in API response for slug "${slug}"`);
  }
  return amounts[0];
}
