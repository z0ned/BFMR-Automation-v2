export interface MailHeader { name?: string | null; value?: string | null }
export type IntakeMode = 'production' | 'testing';
export function intakeMode(value: string | undefined): IntakeMode {
  if (value === undefined || value === 'production') return 'production';
  if (value === 'testing') return 'testing';
  throw new Error('BFMR_INTAKE_MODE must be production or testing.');
}
export function exactSender(value: string): string | null {
  const input = value.trim();
  const match = input.match(/^(?:[^<>\r\n]*<)?([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+)>?$/i);
  if (!match || (input.includes('<') !== input.endsWith('>'))) return null;
  return match[1].toLowerCase();
}
/** Only headers returned by the authenticated Gmail API may enter this verifier. */
export function authenticateGmailSender(sender: string, headers: MailHeader[], mode: IntakeMode): boolean {
  const address = exactSender(sender);
  if (address !== 'deals@buyformeretail.com' && !(mode === 'testing' && address === 'matt.ward@live.com')) return false;
  const from = headers.filter(header => header.name?.toLowerCase() === 'from');
  if (from.length !== 1 || exactSender(from[0].value ?? '') !== address) return false;
  const trusted = headers.filter(header => header.name?.toLowerCase() === 'authentication-results' &&
    /^\s*mx\.google\.com\s*;/i.test(header.value ?? ''));
  // Duplicate authserv IDs can be attacker-supplied; do not pick a convenient PASS.
  if (trusted.length !== 1 || !headers.some(header => header.name?.toLowerCase() === 'received' &&
    /\bby\s+mx\.google\.com\b/i.test(header.value ?? ''))) return false;
  const domain = address.split('@')[1];
  const clauses = (trusted[0].value ?? '').split(';').slice(1);
  const dmarc = clauses.some(clause => /^\s*dmarc=pass\b/i.test(clause) &&
    clause.match(/\bheader\.from=([^\s;()]+)/i)?.[1].toLowerCase() === domain);
  const dkim = clauses.some(clause => {
    const signer = clause.match(/\bheader\.d=([^\s;()]+)/i)?.[1].toLowerCase();
    // Gmail commonly supplies header.i instead of header.d.
    const identity = clause.match(/\bheader\.i=([^\s;()]+)/i)?.[1].toLowerCase().split('@').at(-1);
    const signingDomain = signer ?? identity;
    return /^\s*dkim=pass\b/i.test(clause) && !!signingDomain &&
      (signingDomain === domain || signingDomain.endsWith(`.${domain}`));
  });
  const spf = clauses.some(clause => /^\s*spf=pass\b/i.test(clause) &&
    clause.match(/\bsmtp\.mailfrom=([^\s;()]+)/i)?.[1].toLowerCase().split('@').at(-1) === domain);
  return dmarc && (dkim || spf);
}
