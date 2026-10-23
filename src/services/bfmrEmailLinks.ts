import { inflateSync } from 'node:zlib';
import { isTrustedBfmrDealUrl } from './bfmrUrl';
import { parseIncomingEmail } from './emailParser';

/** Recover the observed BFMR email destination locally, including Safelinks and SendGrid tokens. */
export function decodeBfmrEmailDealLink(value: string): string | null {
  if (isTrustedBfmrDealUrl(value)) return value;
  try {
    const url = new URL(value);

    // 1. Unwrap Microsoft Outlook / Live Safelinks (when forwarding from live.com / outlook.com)
    if (url.hostname.includes('safelinks.protection.outlook.com')) {
      const target = url.searchParams.get('url');
      if (target) return decodeBfmrEmailDealLink(decodeURIComponent(target));
    }

    // 2. Decode SendGrid email click-tracking links
    if (url.protocol === 'https:' && (url.hostname === 'email.mail.buyformeretail.com' || url.hostname.endsWith('.buyformeretail.com'))) {
      const token = url.pathname.match(/^\/c\/([A-Za-z0-9_-]+={0,2})$/)?.[1];
      if (token && token.length <= 8192) {
        const payload = inflateSync(Buffer.from(token, 'base64url'), { maxOutputLength: 16384 }).toString('utf8');
        const destinations = new URLSearchParams(payload).getAll('l');
        if (destinations.length === 1 && isTrustedBfmrDealUrl(destinations[0])) return destinations[0];
      }
    }
    return null;
  } catch {
    // Malformed, oversized or unsupported tokens cannot identify a trusted deal.
    return null;
  }
}

/** Node intake entry point; keep zlib and email tokens out of the browser bundle. */
export function parseBfmrEmail(raw: Parameters<typeof parseIncomingEmail>[0]) {
  return parseIncomingEmail(raw, decodeBfmrEmailDealLink);
}
