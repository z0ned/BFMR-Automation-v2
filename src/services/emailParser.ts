import { IntakeEmail } from '../types/bfmr';
import { isTrustedBfmrDealUrl } from './bfmrUrl';

function cleanQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '') // remove soft line breaks
    .replace(/=3D/gi, '=')   // decode =3D to =
    .replace(/=20/g, ' ');   // decode =20 to space
}

function bodyText(body: string): string {
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, value: string) => {
      const codePoint = Number(value);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function bodyDealTitle(text: string): string | undefined {
  const match = /[•◦]\s*([^•◦]{3,180}?)\s*(?:-\s*)?This retails for\b/i.exec(text);
  const title = match?.[1].replace(/[-|]\s*$/, '').trim();
  return title || undefined;
}

export function parseIncomingEmail(raw: {
  id?: string;
  historyId?: number;
  messageId: string;
  sender: string;
  subject: string;
  body: string;
  receivedAt?: string;
}, resolveDealLink: (value: string) => string | null = (value) => value): IntakeEmail {
  const subject = raw.subject.trim();
  const cleanedBody = cleanQuotedPrintable(raw.body);
  const body = cleanedBody;
  const readableBody = bodyText(body);

  // Classify only from the message body. Subjects are preserved as header
  // metadata, but are not evidence about message type or offer contents.
  let isMultiDeal =
    /multiple deals/i.test(readableBody) ||
    /\b\d+\s+deals?\s+available/i.test(readableBody) ||
    /daily deal roundup/i.test(readableBody) ||
    /deals digest/i.test(readableBody) ||
    /\b(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+new deals?\b/i.test(readableBody) ||
    /\ball deals\b[\s\S]{0,80}\bin stock\b/i.test(readableBody) ||
    /\bthe following deals are in stock\b/i.test(readableBody);

  // Additional reservations are a separate BFMR message type, not a new deal.
  const isAdditionalSlotNotice = 
    /additional slots?/i.test(readableBody) ||
    /more slots?/i.test(readableBody) ||
    /slots? added/i.test(readableBody) ||
    /capacity increased/i.test(readableBody) ||
    /more reservations added/i.test(readableBody) ||
    /added more reservations/i.test(readableBody);

  const bodyAnnouncesNewDeal = /\bwe posted (?:a|an|two|three|four|five|six|seven|eight|nine|ten|\d+) new deals?\b/i.test(readableBody);
  const bodyIsUpdate = /\b(?:we increased our payout|we have added more reservations|we added more reservations|added more reservations|payout increase|new deal update)\b/i.test(readableBody);
  const isNewDealAnnouncement = bodyAnnouncesNewDeal && !bodyIsUpdate;
  const announcedCountWord = /\bwe posted (two|three|four|five|six|seven|eight|nine|ten|\d+) new deals\b/i.exec(readableBody)?.[1]?.toLowerCase();
  const wordCounts: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const announcedCount = announcedCountWord ? (wordCounts[announcedCountWord] ?? Number(announcedCountWord)) : undefined;

  // Extract link: from HTML href attributes and plain text URLs
  const candidateUrls: string[] = [];
  const candidateUrlTitles = new Map<string, string>();

  // 1. HTML href matches (preserves HTML hyperlink targets when plain text omits them)
  const hrefRegex = /href=["'](https?:\/\/[^"'>\s]+)["']/gi;
  let hrefMatch;
  while ((hrefMatch = hrefRegex.exec(body)) !== null) {
    candidateUrls.push(hrefMatch[1]);
  }
  const anchorRegex = /<a\b[^>]*href=["'](https?:\/\/[^"'>\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let anchorMatch;
  while ((anchorMatch = anchorRegex.exec(body)) !== null) {
    const title = bodyText(anchorMatch[2]);
    if (title && !/^(?:click here|view deal|deal link|here)$/i.test(title)) {
      candidateUrlTitles.set(anchorMatch[1], title);
    }
  }

  // 2. Plain text URLs
  const urlRegex = /https?:\/\/[^\s<>"'()[\]]+/gi;
  const plainMatches = body.match(urlRegex) || [];
  candidateUrls.push(...plainMatches);
  
  let dealUrl: string | undefined;
  let canonicalDealId: string | undefined;
  const deals = new Map<string, { url: string; id: string; title?: string }>();

  for (const rawUrl of candidateUrls) {
    try {
      // Clean trailing punctuation
      const cleanUrl = resolveDealLink(rawUrl.replace(/&amp;/gi, '&').replace(/[.,;>)]+$/, ''));
      if (!cleanUrl) continue;
      const parsed = new URL(cleanUrl);
      if (isTrustedBfmrDealUrl(cleanUrl)) {
        const match = parsed.pathname.match(/\/(?:deals?|offers?|item)\/([a-zA-Z0-9_-]+)/i);
        if (!match?.[1]) continue;

        // Collapse plain/HTML repeats and www aliases; distinct deal paths stay distinct.
        const key = parsed.pathname.replace(/\/+$/, '').toLowerCase();
        const existing = deals.get(key);
        deals.set(key, { url: cleanUrl, id: match[1], title: candidateUrlTitles.get(rawUrl) || existing?.title });
      }
    } catch {
      // invalid URL skipped
    }
  }

  if (deals.size > 1) isMultiDeal = true;
  if (deals.size === 1) {
    const deal = [...deals.values()][0];
    dealUrl = deal.url;
    canonicalDealId = deal.id;
  }
  const isSingleDeal = isNewDealAnnouncement && deals.size === 1 && !isMultiDeal && !isAdditionalSlotNotice;
  const isMultiDealAnnouncement = isNewDealAnnouncement && isMultiDeal && !isAdditionalSlotNotice &&
    deals.size >= 2 && announcedCount === deals.size;

  // Only an explicit body field is enough to identify the retailer. Retailer
  // names in subjects or product names (for example, an Apple product) are not.
  const retailer = readableBody.match(/\bretailer\s*:\s*(Amazon|Best Buy|Target|Walmart|B&H Photo|Costco)\b/i)?.[1];

  const isBundle = /\bbundle\b/i.test(readableBody) || /\+\s*[a-zA-Z0-9]/i.test(readableBody);

  // Detect prices
  const payoutMatch = body.match(/Payout:?\s*\$([0-9,.]+)/i) || body.match(/Payout\s+Price:?\s*\$([0-9,.]+)/i);
  const retailMatch = body.match(/Retail:?\s*\$([0-9,.]+)/i) || body.match(/Retail\s+Price:?\s*\$([0-9,.]+)/i);

  const payoutPrice = payoutMatch ? parseFloat(payoutMatch[1].replace(/,/g, '')) : undefined;
  const retailPrice = retailMatch ? parseFloat(retailMatch[1].replace(/,/g, '')) : undefined;

  const singleDeal = deals.size === 1 ? [...deals.values()][0] : undefined;
  const dealTitle = singleDeal?.title || bodyDealTitle(readableBody);

  return {
    id: raw.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    historyId: raw.historyId ?? 1000 + Math.floor(Math.random() * 500),
    messageId: raw.messageId,
    sender: raw.sender,
    receivedAt: raw.receivedAt || new Date().toISOString(),
    subject,
    rawBody: body,
    isSingleDeal,
    isAdditionalSlotNotice,
    isMultiDeal,
    isMultiDealAnnouncement,
    deals: [...deals.values()].map(deal => ({ canonicalDealId: deal.id, dealUrl: deal.url, ...(deal.title ? { dealTitle: deal.title } : {}) })),
    dealUrl,
    canonicalDealId,
    dealTitle,
    retailer,
    isBundle,
    payoutPrice,
    retailPrice,
  };
}
