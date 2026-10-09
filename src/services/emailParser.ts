import { IntakeEmail } from '../types/bfmr';

// Trusted BFMR domains per Solution Design v1.5 Page 7:
// "initial known hosts: bfmr.com and www.bfmr.com; /deals/ path. Preserve HTML hyperlink targets when plain text omits them."
const TRUSTED_DOMAINS = [
  'bfmr.com',
  'www.bfmr.com',
  'buyformeretail.com',
  'www.buyformeretail.com',
  'app.buyformeretail.com',
];

function cleanQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '') // remove soft line breaks
    .replace(/=3D/gi, '=')   // decode =3D to =
    .replace(/=20/g, ' ');   // decode =20 to space
}

export function parseIncomingEmail(raw: {
  id?: string;
  historyId?: number;
  messageId: string;
  sender: string;
  subject: string;
  body: string;
  receivedAt?: string;
}): IntakeEmail {
  const subject = raw.subject.trim();
  const cleanedBody = cleanQuotedPrintable(raw.body);
  const body = cleanedBody;

  // Rule: Ignore multiple-deal mail
  const isMultiDeal = 
    /multiple deals/i.test(subject) ||
    /\b\d+\s+deals?\s+available/i.test(subject) ||
    /daily deal roundup/i.test(subject) ||
    /deals digest/i.test(subject);

  // Rule: Ignore additional-slot notifications
  const isAdditionalSlotNotice = 
    /additional slots?/i.test(subject) ||
    /more slots?/i.test(subject) ||
    /slots? added/i.test(subject) ||
    /capacity increased/i.test(subject);

  // Rule: Detect single deal email
  // Valid subject patterns per Decision register:
  // "New Deal: [Title]" or "[Retailer] New Deal: [Title]" (retailer not strictly required)
  const isNewDealKeyword = /new deal/i.test(subject);
  const isSingleDeal = isNewDealKeyword && !isMultiDeal && !isAdditionalSlotNotice;

  // Extract link: from HTML href attributes and plain text URLs
  const candidateUrls: string[] = [];

  // 1. HTML href matches (preserves HTML hyperlink targets when plain text omits them)
  const hrefRegex = /href=["'](https?:\/\/[^"'>\s]+)["']/gi;
  let hrefMatch;
  while ((hrefMatch = hrefRegex.exec(body)) !== null) {
    candidateUrls.push(hrefMatch[1]);
  }

  // 2. Plain text URLs
  const urlRegex = /https?:\/\/[^\s<>"'()[\]]+/gi;
  const plainMatches = body.match(urlRegex) || [];
  candidateUrls.push(...plainMatches);
  
  let dealUrl: string | undefined;
  let canonicalDealId: string | undefined;

  for (const rawUrl of candidateUrls) {
    try {
      // Clean trailing punctuation
      const cleanUrl = rawUrl.replace(/[.,;>)]+$/, '');
      const parsed = new URL(cleanUrl);
      const host = parsed.hostname.toLowerCase();

      if (TRUSTED_DOMAINS.includes(host)) {
        // Look for /deals/DEAL_ID or /deal/DEAL_ID or /offer/DEAL_ID
        const match = parsed.pathname.match(/\/(?:deals?|offers?|item)\/([a-zA-Z0-9_-]+)/i);
        if (match && match[1]) {
          dealUrl = cleanUrl;
          canonicalDealId = match[1];
          break;
        }
      }
    } catch {
      // invalid URL skipped
    }
  }

  // Detect retailer from subject or body
  let retailer = 'Amazon';
  if (/best buy/i.test(subject) || /best buy/i.test(body)) retailer = 'Best Buy';
  else if (/target/i.test(subject) || /target/i.test(body)) retailer = 'Target';
  else if (/walmart/i.test(subject) || /walmart/i.test(body)) retailer = 'Walmart';
  else if (/b&h|bhphoto/i.test(subject) || /bhphoto/i.test(body)) retailer = 'B&H Photo';
  else if (/apple/i.test(subject) || /apple/i.test(body)) retailer = 'Apple Store';
  else if (/costco/i.test(subject) || /costco/i.test(body)) retailer = 'Costco';

  // Detect bundles
  const isBundle = /bundle/i.test(subject) || /bundle/i.test(body) || /\+\s*[a-zA-Z0-9]/i.test(subject);

  // Detect prices
  const payoutMatch = body.match(/Payout:?\s*\$([0-9,.]+)/i) || body.match(/Payout\s+Price:?\s*\$([0-9,.]+)/i);
  const retailMatch = body.match(/Retail:?\s*\$([0-9,.]+)/i) || body.match(/Retail\s+Price:?\s*\$([0-9,.]+)/i);

  const payoutPrice = payoutMatch ? parseFloat(payoutMatch[1].replace(/,/g, '')) : undefined;
  const retailPrice = retailMatch ? parseFloat(retailMatch[1].replace(/,/g, '')) : undefined;

  // Deal title
  let dealTitle = subject.replace(/^(?:(?:\[?[^\]]+\]?\s*)?new deal:?\s*)/i, '').trim();
  if (!dealTitle || dealTitle === subject) {
    dealTitle = subject;
  }

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
    dealUrl,
    canonicalDealId,
    dealTitle,
    retailer,
    isBundle,
    payoutPrice,
    retailPrice,
  };
}
