import { inflateSync } from 'node:zlib';
import { isTrustedBfmrDealUrl } from './bfmrUrl';
import { parseIncomingEmail } from './emailParser';

/** Recover the observed BFMR email destination locally; never visit tracking links. */
export function decodeBfmrEmailDealLink(value: string): string | null {
  if (isTrustedBfmrDealUrl(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'email.mail.buyformeretail.com' ||
      url.username || url.password || url.port || url.search || url.hash) return null;
    const token = url.pathname.match(/^\/c\/([A-Za-z0-9_-]+={0,2})$/)?.[1];
    if (!token || token.length > 8192) return null;
    const payload = inflateSync(Buffer.from(token, 'base64url'), { maxOutputLength: 16384 }).toString('utf8');
    const destinations = new URLSearchParams(payload).getAll('l');
    if (destinations.length !== 1 || !isTrustedBfmrDealUrl(destinations[0])) return null;
    return destinations[0];
  } catch {
    // Malformed, oversized or unsupported tokens cannot identify a trusted deal.
    return null;
  }
}

/** Node intake entry point; keep zlib and email tokens out of the browser bundle. */
export function parseBfmrEmail(raw: Parameters<typeof parseIncomingEmail>[0]) {
  return parseIncomingEmail(raw, decodeBfmrEmailDealLink);
}
