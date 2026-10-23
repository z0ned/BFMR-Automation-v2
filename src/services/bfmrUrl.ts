export const TRUSTED_BFMR_HOSTS = [
  'bfmr.com',
  'www.bfmr.com',
  'buyformeretail.com',
  'www.buyformeretail.com',
  'app.buyformeretail.com',
] as const;

const trustedHosts = new Set<string>(TRUSTED_BFMR_HOSTS);

export function isTrustedBfmrHost(hostname: string): boolean {
  return trustedHosts.has(hostname.toLowerCase());
}

/** BFMR may return an unavailable deal link to the generic listing. */
export function isTrustedBfmrDealsListingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const validPort = !url.port || url.port === '443';
    return url.protocol === 'https:' && isTrustedBfmrHost(url.hostname) &&
      !url.username && !url.password && validPort && /^\/deals\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function isTrustedBfmrDealUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const validPort = !url.port || url.port === '443';
    return url.protocol === 'https:' &&
      isTrustedBfmrHost(url.hostname) &&
      !url.username &&
      !url.password &&
      validPort &&
      /^\/(?:deals?|offers?|item)\/[a-zA-Z0-9_-]+(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

